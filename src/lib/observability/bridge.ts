import * as Crypto from 'expo-crypto';

import type { AlarmService } from '@/db/alarm-service';
import { createEventsRepository } from '@/db/repositories/events';
import { createPreferencesRepository } from '@/db/repositories/preferences';
import type { AppDatabase } from '@/db/types';
import type { RingLifecycle } from '@/services/ring-lifecycle';

import { track } from './analytics';
import { toProductEvent, type Tier } from './event-map';
import { captureIssue } from './sentry';

/** Insertion position of the last event handed to analytics/Sentry. Local-only bookkeeping. */
export const CURSOR_KEY = 'observability.events_cursor';
/** Coalesces bursts of writes; also keeps reporting off the moment of any user action. */
export const FLUSH_DELAY_MS = 2_000;
const BATCH = 200;

export interface BridgeDeps {
  db: AppDatabase;
  deviceId: string;
  alarms: AlarmService;
  ring: RingLifecycle;
  tier: () => Tier;
  clock?: () => Date;
  newId?: () => string;
}

/**
 * Tails the local append-only event log (D12) into PostHog (coarse product events) and
 * Sentry (reliability issues), plus reconcile results from the ring lifecycle. Runs
 * deferred after writes, never inline on the ring path (D20); every step swallows errors,
 * so observability being down has zero effect on alarms.
 */
export function createObservabilityBridge(deps: BridgeDeps) {
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? Crypto.randomUUID;
  const events = createEventsRepository(deps.db, newId);
  const preferences = createPreferencesRepository(deps.db, newId);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribes: (() => void)[] = [];
  let lastReconcileAt: string | null = null;
  let lastEngineErrorAt: string | null = null;

  const cursor = () => preferences.get<number>(CURSOR_KEY);
  const saveCursor = (rowId: number) =>
    preferences.set(CURSOR_KEY, rowId, { now: clock(), deviceId: deps.deviceId });

  function flushEvents(): number {
    let position = cursor();
    // First run: start at "now"; history before observability existed is not replayed.
    if (position === null) {
      saveCursor(events.lastRowId());
      return 0;
    }
    let sent = 0;
    for (;;) {
      const batch = events.listAfter(position, deps.deviceId, BATCH);
      if (batch.length === 0) break;
      for (const { event } of batch) {
        sent += 1;
        if (event.type === 'alarm_schedule_failed') {
          captureIssue('alarm_schedule_failed', {
            code: String(event.payload.code),
            engine: String(event.payload.engine),
          });
          continue;
        }
        track(
          toProductEvent(event, {
            tier: deps.tier(),
            alarm: event.alarmId ? deps.alarms.get(event.alarmId) : null,
          }),
        );
      }
      position = batch[batch.length - 1]!.rowId;
      saveCursor(position);
      if (batch.length < BATCH) break;
    }
    return sent;
  }

  function reportSync(): void {
    const last = deps.ring.getLastReconcile();
    if (last && last.at !== lastReconcileAt) {
      lastReconcileAt = last.at;
      const { result } = last;
      if (!result.verified) {
        captureIssue('reconcile_mismatch', {
          mismatches: result.mismatches.length,
          failures: result.failures.length,
          codes: [...new Set(result.failures.map((f) => f.error.code))].sort().join(','),
        });
      }
    }
    const report = deps.ring.getLastSync();
    if (report?.error && report.at !== lastEngineErrorAt) {
      lastEngineErrorAt = report.at;
      // Codes only: engine messages can contain schedule ids.
      captureIssue('engine_error', { reason: report.reason });
    }
  }

  const bridge = {
    /** One pass: new events + latest sync/reconcile. Returns events processed. */
    flush(): number {
      try {
        reportSync();
        return flushEvents();
      } catch {
        return 0;
      }
    },

    /** Deferred flush (coalesced). */
    schedule(): void {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        bridge.flush();
      }, FLUSH_DELAY_MS);
    },

    start(): void {
      if (unsubscribes.length) return;
      unsubscribes = [deps.alarms.subscribe(bridge.schedule), deps.ring.subscribe(bridge.schedule)];
      bridge.schedule();
    },

    stop(): void {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      unsubscribes = [];
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return bridge;
}

export type ObservabilityBridge = ReturnType<typeof createObservabilityBridge>;
