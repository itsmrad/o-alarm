import * as Crypto from 'expo-crypto';

import { isOccurrenceScheduleId, isTestOccurrence } from '@/db/alarm-service';
import { createEventsRepository } from '@/db/repositories/events';
import { createOccurrencesRepository, type OccurrenceRow } from '@/db/repositories/occurrences';
import { createPreferencesRepository } from '@/db/repositories/preferences';
import type { AppDatabase, WriteContext } from '@/db/types';
import type { Alarm, EventPayloads, NewEvent } from '@/domain';
import type {
  AlarmEngineEventPayload,
  EngineKind,
  ObservedEngineEvent,
  ObservedEngineEventType,
  ScheduleKind,
} from '@/engine';
import type { MissionChainEvent } from '@/domain/missions-chain';
import { stableUuid } from '@/lib/stable-id';

/** A scheduled occurrence with no trigger this long after its time is `missed`. */
export const MISSED_GRACE_MS = 10 * 60_000;
/** How long a missed alarm stays surfaced on Home. */
export const MISSED_SURFACE_MS = 48 * 3_600_000;
const MISSED_ACK_KEY = 'reliability.missedAcknowledgedUntil';

/** D29 additions; accepted before the native contract type lists them. */
type ObservedType = ObservedEngineEventType | 'missed' | 'schedule_failed';
type Observed = Omit<ObservedEngineEvent, 'type'> & { type: ObservedType; detail?: string };

/** The ring an event is about (engine payload or ringing state). */
export type RingRef = Pick<
  AlarmEngineEventPayload,
  'scheduleId' | 'alarmId' | 'occurrenceKey' | 'kind'
>;

export interface LedgerDeps {
  db: AppDatabase;
  deviceId: string;
  engineKind: EngineKind;
  getAlarm: (id: string) => Alarm | null;
  clock?: () => Date;
  newId?: () => string;
}

/** Engine kind of a schedule id (observed events carry only the id). */
export function scheduleKindOf(scheduleId: string): ScheduleKind {
  if (scheduleId.includes('#snooze-')) return 'snooze';
  if (scheduleId.includes('#wake-check-')) return 'wake_check';
  if (scheduleId.includes('#retrigger')) return 'retrigger';
  return 'alarm';
}

/** One event per ring and type: the app and the engine's queue may both report it. */
const ringEventId = (type: NewEvent['type'], scheduleId: string) =>
  stableUuid(`${type}|${scheduleId}`);

/**
 * Expected-vs-observed tracking (D12): writes the key ring events and the
 * `alarm_occurrences` outcome rows. Every write is idempotent, so draining the engine's
 * observed queue twice (crash before ack) or recording an in-app action that the engine
 * also reports never duplicates anything.
 */
export function createReliabilityLedger(deps: LedgerDeps) {
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? Crypto.randomUUID;
  const events = createEventsRepository(deps.db, newId);
  const occurrences = createOccurrencesRepository(deps.db, newId);
  const preferences = createPreferencesRepository(deps.db, newId);
  const ctx = (): WriteContext => ({ now: clock(), deviceId: deps.deviceId });
  const engine = deps.engineKind;

  /** Ledger row for a real occurrence; null for test rings. */
  function occurrenceFor(ring: RingRef, at: string, write: WriteContext): OccurrenceRow | null {
    if (isTestOccurrence(ring.occurrenceKey) || !ring.occurrenceKey.includes('@')) return null;
    return occurrences.ensure(
      { alarmId: ring.alarmId, occurrenceKey: ring.occurrenceKey, expectedAt: at },
      write,
    );
  }

  function appendRing<K extends NewEvent['type']>(
    type: K,
    ring: RingRef,
    payload: EventPayloads[K],
    at: string,
    write: WriteContext,
  ): boolean {
    if (isTestOccurrence(ring.occurrenceKey)) return false;
    return events.appendOnce(
      { type, alarmId: ring.alarmId, occurrenceKey: ring.occurrenceKey, payload } as NewEvent,
      ringEventId(type, ring.scheduleId),
      write,
      at,
    );
  }

  function expected(row: OccurrenceRow, write: WriteContext): void {
    events.appendOnce(
      {
        type: 'alarm_expected',
        alarmId: row.alarmId,
        occurrenceKey: row.occurrenceKey,
        payload: { fireAt: row.expectedAt },
      },
      stableUuid(`alarm_expected|${row.occurrenceKey}`),
      write,
      row.expectedAt,
    );
  }

  const ledger = {
    /** A Wake Check prompt is not an alarm ring: the wake-check service logs it. */
    recordTrigger(ring: RingRef, at: string): boolean {
      if (ring.kind === 'wake_check') return false;
      return deps.db.transaction(() => {
        const write = ctx();
        const row = occurrenceFor(ring, at, write);
        if (row && ring.kind === 'alarm') expected(row, write);
        const scheduledFor = ring.kind === 'alarm' && row ? row.expectedAt : at;
        const added = appendRing(
          'alarm_trigger_received',
          ring,
          { scheduledFor, receivedAt: at, engine },
          at,
          write,
        );
        if (added && row) occurrences.markTriggered(row, at, write);
        return added;
      });
    },

    recordSnooze(
      ring: RingRef,
      at: string,
      details: Partial<EventPayloads['alarm_snoozed']> = {},
    ): boolean {
      return deps.db.transaction(() => {
        const write = ctx();
        const row = occurrenceFor(ring, at, write);
        const minutes = deps.getAlarm(ring.alarmId)?.snooze.durationMin ?? 9;
        const added = appendRing(
          'alarm_snoozed',
          ring,
          {
            snoozesUsed: details.snoozesUsed ?? (row ? row.snoozeCount + 1 : 1),
            nextFireAt:
              details.nextFireAt ?? new Date(Date.parse(at) + minutes * 60_000).toISOString(),
          },
          at,
          write,
        );
        if (added && row) occurrences.markSnoozed(row, at, write);
        return added;
      });
    },

    recordDismiss(
      ring: RingRef,
      at: string,
      method: EventPayloads['alarm_dismissed']['method'],
    ): boolean {
      if (ring.kind === 'wake_check') return false;
      return deps.db.transaction(() => {
        const write = ctx();
        const row = occurrenceFor(ring, at, write);
        const added = appendRing('alarm_dismissed', ring, { method }, at, write);
        if (added && row) occurrences.markDismissed(row, at, write);
        return added;
      });
    },

    /**
     * `wakeCheckAttempt`: the Wake Check attempt this re-ring answers (from the wake-check
     * service); without one, a system-UI stop (D14) or unknown cause is inferred.
     */
    recordRetrigger(ring: RingRef, at: string, wakeCheckAttempt?: number | null): boolean {
      return deps.db.transaction(() => {
        const write = ctx();
        const prior = events.list({ occurrenceKey: ring.occurrenceKey, limit: 200 });
        const stoppedFromSystem = prior.some(
          (e) => e.type === 'alarm_dismissed' && e.payload.method === 'system_stop',
        );
        const fromWakeCheck = wakeCheckAttempt != null || !stoppedFromSystem;
        return appendRing(
          'alarm_retriggered',
          ring,
          {
            reason: fromWakeCheck ? 'wake_check_failed' : 'stop_without_mission',
            attempt:
              wakeCheckAttempt ?? prior.filter((e) => e.type === 'alarm_retriggered').length + 1,
          },
          at,
          write,
        );
      });
    },

    /** Mission chain events (started/completed/failed) for the ringing occurrence. */
    recordMission(event: MissionChainEvent, ring: Pick<RingRef, 'alarmId' | 'occurrenceKey'>) {
      if (isTestOccurrence(ring.occurrenceKey)) return;
      events.append({ ...event, alarmId: ring.alarmId, occurrenceKey: ring.occurrenceKey }, ctx());
    },

    /**
     * Maps one engine-observed event onto D12 events + the ledger. Idempotent.
     * `wakeCheckAttempt`: from the wake-check service, for re-trigger rings.
     */
    recordObserved(raw: ObservedEngineEvent, wakeCheckAttempt?: number | null): void {
      const observed = raw as Observed;
      const event = { ...observed, kind: scheduleKindOf(observed.scheduleId) };
      const hasMissions = (deps.getAlarm(event.alarmId)?.missions.length ?? 0) > 0;
      switch (event.type) {
        case 'trigger_received':
          ledger.recordTrigger(event, event.at);
          if (event.kind === 'retrigger') {
            ledger.recordRetrigger(event, event.at, wakeCheckAttempt);
          }
          return;
        case 'snoozed':
          ledger.recordSnooze(event, event.at);
          return;
        case 'dismissed':
          ledger.recordDismiss(event, event.at, hasMissions ? 'mission' : 'button');
          return;
        case 'stopped_from_system_ui':
          ledger.recordDismiss(event, event.at, 'system_stop');
          return;
        case 'retriggered':
          ledger.recordRetrigger(event, event.at, wakeCheckAttempt);
          return;
        case 'missed':
          deps.db.transaction(() => {
            const write = ctx();
            const row = occurrenceFor(event, event.at, write);
            if (!row) return;
            expected(row, write);
            occurrences.markMissed(row, write);
          });
          return;
        case 'schedule_failed':
          events.appendOnce(
            {
              type: 'alarm_schedule_failed',
              alarmId: event.alarmId,
              occurrenceKey: event.occurrenceKey,
              payload: {
                engine,
                code: 'NATIVE_SCHEDULE_FAILED',
                message: event.detail ?? 'The system could not schedule this alarm.',
              },
            },
            stableUuid(`observed|${event.id}`),
            ctx(),
            event.at,
          );
          return;
        default:
          // schedule_restored_after_boot / tz_change_rescheduled: the reconcile that
          // follows every drain verifies the result; nothing to log in D12 terms.
          return;
      }
    },

    /**
     * Marks scheduled occurrences that never triggered (past the grace period) as
     * `missed`. Call after draining observed events so late-reported rings count.
     */
    detectMissed(now: Date = clock()): OccurrenceRow[] {
      return deps.db.transaction(() => {
        const write = ctx();
        const overdue = occurrences
          .listOverdue(new Date(now.getTime() - MISSED_GRACE_MS))
          .filter((row) => isOccurrenceScheduleId(row.occurrenceKey));
        for (const row of overdue) {
          expected(row, write);
          occurrences.markMissed(row, write);
        }
        return overdue.map((row) => ({ ...row, status: 'missed' as const }));
      });
    },

    /** Missed alarms in the last 48 h the user has not acknowledged (Home banner). */
    unacknowledgedMissed(now: Date = clock()): OccurrenceRow[] {
      const ackedUntil = preferences.get<string>(MISSED_ACK_KEY);
      return occurrences
        .listRecent({ since: new Date(now.getTime() - MISSED_SURFACE_MS), statuses: ['missed'] })
        .filter((row) => !ackedUntil || row.expectedAt > ackedUntil);
    },

    acknowledgeMissed(now: Date = clock()): void {
      preferences.set(MISSED_ACK_KEY, now.toISOString(), ctx());
    },

    /** Ledger history for Diagnostics, newest first. */
    recentOccurrences(limit = 20): OccurrenceRow[] {
      return occurrences.listRecent({ limit });
    },
  };
  return ledger;
}

export type ReliabilityLedger = ReturnType<typeof createReliabilityLedger>;
