import { deviceTimeZone, type AlarmService } from '@/db/alarm-service';
import type { OccurrenceRow } from '@/db/repositories/occurrences';
import { canSnooze } from '@/domain';
import {
  AlarmEngineError,
  PreviewAlarmEngine,
  type AlarmEngine,
  type AlarmEngineEventPayload,
  type DismissResult,
  type EngineSubscription,
  type ReconcileResult,
  type RingingState,
  type ScheduledAlarm,
} from '@/engine';
import type { MissionGateParams } from '@/features/ringing/mission-gate';

import type { ReliabilityLedger } from './reliability-ledger';

export type SyncReason = 'start' | 'foreground' | 'timezone' | 'ring_ended' | 'manual';

export interface SyncReport {
  reason: SyncReason;
  at: string;
  timeZone: string;
  /** Observed engine events persisted and acknowledged in this run. */
  ingested: number;
  /** Null when reconcile threw, or was held back because an alarm is ringing. */
  reconcile: ReconcileResult | null;
  /** Occurrences newly marked missed in this run. */
  missed: OccurrenceRow[];
  ringing: RingingState | null;
  error: string | null;
}

export type DismissMethod = 'button' | 'mission';

export interface RingLifecycleDeps {
  engine: AlarmEngine;
  alarms: AlarmService;
  ledger: ReliabilityLedger;
  /** Opens the ringing screen. Not called while it is already open. */
  showRinging: (ring: AlarmEngineEventPayload) => void;
  clock?: () => Date;
  timeZone?: () => string;
}

/**
 * App-root ring/reconcile lifecycle (D10–D13):
 *
 * - engine `trigger` → ringing screen; `snooze`/`dismiss`/`stop` → persist what happened.
 * - start / foreground / time-zone change → `sync`: route to an alarm that is already
 *   ringing (cold start), drain → persist → ack observed engine events, reconcile
 *   DB ↔ engine, mark overdue occurrences `missed`.
 * - In-app snooze/dismiss go through here so domain rules (snooze limit, mission gate)
 *   run before the engine and every action is logged exactly once.
 *
 * Runs are serialized; every step is idempotent, so overlapping triggers never duplicate.
 */
export function createRingLifecycle(deps: RingLifecycleDeps) {
  const clock = deps.clock ?? (() => new Date());
  const timeZone = deps.timeZone ?? deviceTimeZone;
  const { engine, alarms, ledger } = deps;
  const listeners = new Set<() => void>();
  let subscriptions: EngineSubscription[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  let lastZone = timeZone();
  let ringingScreenOpen = false;
  let lastSync: SyncReport | null = null;
  let lastReconcile: { at: string; result: ReconcileResult } | null = null;

  const notify = () => listeners.forEach((listener) => listener());

  /** Serializes async work so drains/reconciles never interleave. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function show(ring: AlarmEngineEventPayload): void {
    if (ringingScreenOpen) return;
    deps.showRinging(ring);
  }

  /** Drain → persist → ack. A crash before ack replays the same events: all no-ops. */
  async function ingest(): Promise<number> {
    const observed = await engine.drainObservedEvents();
    if (observed.length === 0) return 0;
    for (const event of observed) ledger.recordObserved(event);
    await engine.ackObservedEvents(observed.map((event) => event.id));
    return observed.length;
  }

  async function requireRinging(scheduleId: string): Promise<RingingState> {
    const ring = await engine.getActiveRinging();
    if (!ring || ring.scheduleId !== scheduleId) {
      throw new AlarmEngineError('NOT_RINGING', `"${scheduleId}" is not ringing`);
    }
    return ring;
  }

  const lifecycle = {
    start(): void {
      if (subscriptions.length) return;
      subscriptions = [
        engine.addListener('trigger', (event) => {
          show(event);
          serial(async () => {
            ledger.recordTrigger(event, event.at);
            await ingest();
          })
            .catch(() => undefined)
            .finally(notify);
        }),
        // A ring ended (in-app, system UI or native): persist it, then catch up on the
        // reconcile that was held back while it rang.
        ...(['snooze', 'dismiss', 'stop'] as const).map((type) =>
          engine.addListener(type, () => {
            lifecycle.sync('ring_ended').catch(() => undefined);
          }),
        ),
      ];
      lifecycle.sync('start').catch(() => undefined);
    },

    stop(): void {
      subscriptions.forEach((subscription) => subscription.remove());
      subscriptions = [];
    },

    /** Call on every AppState change; foreground runs a sync (tz change detected here). */
    onAppStateChange(state: string): void {
      if (state !== 'active') return;
      const reason: SyncReason = timeZone() !== lastZone ? 'timezone' : 'foreground';
      lifecycle.sync(reason).catch(() => undefined);
    },

    /** Poll target while foregrounded; JS gets no time-zone event. True if it changed. */
    checkTimeZone(): boolean {
      if (timeZone() === lastZone) return false;
      lifecycle.sync('timezone').catch(() => undefined);
      return true;
    },

    sync(reason: SyncReason): Promise<SyncReport> {
      return serial(async () => {
        lastZone = timeZone();
        const report: SyncReport = {
          reason,
          at: clock().toISOString(),
          timeZone: lastZone,
          ingested: 0,
          reconcile: null,
          missed: [],
          ringing: null,
          error: null,
        };
        const errors: string[] = [];
        const step = async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (error) {
            errors.push(AlarmEngineError.from(error).message);
          }
        };
        // Preview timers may have been suspended in the background.
        if (engine instanceof PreviewAlarmEngine) engine.checkDue();
        // Ringing first: a half-awake user must see the alarm before anything else.
        await step(async () => {
          report.ringing = await engine.getActiveRinging();
          if (report.ringing) show(report.ringing);
        });
        await step(async () => {
          report.ingested = await ingest();
        });
        // Never reconcile under a ringing alarm: its own entry is no longer "desired"
        // and must not be cancelled mid-ring. The sync after it ends catches up.
        if (!report.ringing) {
          await step(async () => {
            report.reconcile = await alarms.reconcileAll();
            lastReconcile = { at: report.at, result: report.reconcile };
          });
        }
        await step(async () => {
          report.missed = ledger.detectMissed(clock());
        });
        report.error = errors.length ? errors.join('; ') : null;
        lastSync = report;
        notify();
        return report;
      });
    },

    /** Snooze the ringing alarm: limit enforced here first, then by the engine (D13). */
    snooze(scheduleId: string): Promise<ScheduledAlarm> {
      return serial(async () => {
        const ring = await requireRinging(scheduleId);
        const policy = alarms.get(ring.alarmId)?.snooze;
        if (policy && !canSnooze(policy, ring.snoozeCount)) {
          throw new AlarmEngineError('SNOOZE_LIMIT', 'No snoozes left for this alarm');
        }
        const entry = await engine.snooze(scheduleId);
        ledger.recordSnooze(ring, clock().toISOString(), {
          snoozesUsed: ring.snoozeCount + 1,
          nextFireAt: entry.fireAt,
        });
        await ingest().catch(() => 0);
        notify();
        return entry;
      });
    },

    /**
     * Stop the ringing alarm. An alarm with missions can only be dismissed with
     * `method: 'mission'` (after the chain succeeded) — see mission-gate.ts.
     */
    dismiss(scheduleId: string, method: DismissMethod): Promise<DismissResult> {
      return serial(async () => {
        const ring = await requireRinging(scheduleId);
        if (ring.hasMissions && method !== 'mission') {
          throw new AlarmEngineError('INVALID_SPEC', 'Complete the mission to stop this alarm');
        }
        // Wake Check scheduling (wakeCheckAt) is wired by the Wake Check integration.
        const result = await engine.dismiss(scheduleId, { missionCompleted: method === 'mission' });
        ledger.recordDismiss(ring, clock().toISOString(), method);
        await ingest().catch(() => 0);
        notify();
        return result;
      });
    },

    /** Mission hook point: the mission screen calls this after the chain succeeded. */
    async completeMission(params: MissionGateParams): Promise<void> {
      if (params.purpose === 'snooze') await lifecycle.snooze(params.scheduleId);
      else await lifecycle.dismiss(params.scheduleId, 'mission');
    },

    /** The ringing screen registers itself so triggers don't stack a second copy. */
    setRingingScreenOpen(open: boolean): void {
      ringingScreenOpen = open;
    },

    getLastSync: (): SyncReport | null => lastSync,
    /** Latest local ↔ engine comparison (Diagnostics mismatch report). */
    getLastReconcile: () => lastReconcile,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Re-render hook for ledger readers (e.g. after acknowledging a missed alarm). */
    notify,
  };
  return lifecycle;
}

export type RingLifecycle = ReturnType<typeof createRingLifecycle>;
