import * as Crypto from 'expo-crypto';

import {
  alarmSchema,
  computeNextFire,
  setOneOffOverride as applyOneOffOverride,
  clearOneOffOverride,
  toggleSkipNext as applyToggleSkipNext,
  type Alarm,
  type EngineKind,
  type Occurrence,
} from '@/domain';
import { reconcile, type AlarmEngine, type ReconcileResult } from '@/engine';

import { createAlarmsRepository } from './repositories/alarms';
import { createEventsRepository } from './repositories/events';
import { createOccurrencesRepository } from './repositories/occurrences';
import { createOutboxRepository } from './repositories/outbox';
import type { AppDatabase, WriteContext } from './types';

export type ScheduleStatus =
  | { state: 'scheduled'; engine: EngineKind; nextFire: Occurrence }
  /** Disabled, or no upcoming occurrence (one-time in the past / skipped). */
  | { state: 'inactive' }
  | {
      state: 'failed';
      engine: EngineKind;
      nextFire: Occurrence | null;
      code: string;
      message: string;
    };

export interface SaveResult {
  alarm: Alarm;
  status: ScheduleStatus;
}

export type AlarmDraft = Omit<Alarm, 'id'> & { id?: string };

export interface AlarmServiceDeps {
  db: AppDatabase;
  engine: AlarmEngine;
  deviceId: string;
  clock?: () => Date;
  /** Device IANA zone, read at call time so tz changes are picked up (D9). */
  timeZone?: () => string;
  newId?: () => string;
}

export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const changedFields = (before: Alarm, after: Alarm) =>
  (Object.keys(after) as (keyof Alarm)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );

/**
 * The alarm write path (D11):
 *   persist locally → schedule with the engine → read back & verify → emit events
 *   → enqueue sync (outbox) → notify UI.
 * Scheduling failures are returned, logged as `alarm_schedule_failed`, and kept in
 * `getStatus()` for the UI/diagnostics. Never silent.
 */
export function createAlarmService(deps: AlarmServiceDeps) {
  const clock = deps.clock ?? (() => new Date());
  const timeZone = deps.timeZone ?? deviceTimeZone;
  const newId = deps.newId ?? Crypto.randomUUID;
  const alarmsRepo = createAlarmsRepository(deps.db);
  const eventsRepo = createEventsRepository(deps.db, newId);
  const outboxRepo = createOutboxRepository(deps.db, newId);
  const occurrencesRepo = createOccurrencesRepository(deps.db, newId);
  const statuses = new Map<string, ScheduleStatus>();
  const listeners = new Set<() => void>();
  const ctx = (): WriteContext => ({ now: clock(), deviceId: deps.deviceId });
  const notify = () => listeners.forEach((listener) => listener());

  /** Turns a reconcile result into per-alarm status + events + expected occurrences. */
  function record(alarms: readonly Alarm[], result: ReconcileResult, now: Date): void {
    const write = ctx();
    const engine = deps.engine.kind;
    const changed = new Set([...result.plan.schedule, ...result.plan.reschedule].map((s) => s.id));
    const readFailure = result.failures.find((f) => f.operation === 'read');

    for (const alarm of alarms) {
      const nextFire = computeNextFire(alarm, now, timeZone());
      const failure = readFailure ?? result.failures.find((f) => f.alarmId === alarm.id);
      const mismatch = result.mismatches.some((id) => id.startsWith(`${alarm.id}@`));
      if (failure || mismatch) {
        const code = failure?.error.code ?? 'VERIFY_MISMATCH';
        const message =
          failure?.error.message ?? 'The OS did not report the alarm as scheduled after saving.';
        statuses.set(alarm.id, { state: 'failed', engine, nextFire, code, message });
        eventsRepo.append(
          { type: 'alarm_schedule_failed', alarmId: alarm.id, payload: { engine, code, message } },
          write,
        );
        continue;
      }
      if (!nextFire) {
        statuses.set(alarm.id, { state: 'inactive' });
        continue;
      }
      statuses.set(alarm.id, { state: 'scheduled', engine, nextFire });
      for (const entry of result.scheduled) {
        if (entry.alarmId !== alarm.id || entry.kind !== 'alarm') continue;
        occurrencesRepo.upsertScheduled(
          { alarmId: alarm.id, occurrenceKey: entry.occurrenceKey, expectedAt: entry.fireAt },
          write,
        );
        if (changed.has(entry.id)) {
          eventsRepo.append(
            {
              type: 'alarm_native_scheduled',
              alarmId: alarm.id,
              occurrenceKey: entry.occurrenceKey,
              payload: { engine, scheduleId: entry.id, fireAt: entry.fireAt },
            },
            write,
          );
        }
      }
    }
  }

  async function scheduleOne(alarm: Alarm): Promise<ScheduleStatus> {
    const now = clock();
    const result = await reconcile([alarm], deps.engine, {
      now,
      timeZone: timeZone(),
      scope: alarm.id,
    });
    record([alarm], result, now);
    return statuses.get(alarm.id)!;
  }

  const service = {
    list: (): Alarm[] => alarmsRepo.list(),
    get: (id: string): Alarm | null => alarmsRepo.get(id),
    getStatus: (id: string): ScheduleStatus | undefined => statuses.get(id),
    events: eventsRepo,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async save(draft: AlarmDraft): Promise<SaveResult> {
      const alarm = alarmSchema.parse({ ...draft, id: draft.id ?? newId() });
      const before = alarmsRepo.get(alarm.id);

      // 1. Persist locally (row + created/updated event) atomically.
      const row = deps.db.transaction(() => {
        const write = ctx();
        const saved = alarmsRepo.upsert(alarm, write);
        if (before) {
          eventsRepo.append(
            {
              type: 'alarm_updated',
              alarmId: alarm.id,
              payload: { changed: changedFields(before, alarm) },
            },
            write,
          );
        } else {
          eventsRepo.append(
            {
              type: 'alarm_created',
              alarmId: alarm.id,
              payload: {
                hour: alarm.hour,
                minute: alarm.minute,
                weekdays: alarm.weekdays,
                oneTime: alarm.weekdays.length === 0,
              },
            },
            write,
          );
        }
        return saved;
      });

      // 2-4. Schedule, read back, verify, emit scheduled/failed events.
      const status = await scheduleOne(alarm);

      // 5. Enqueue cloud sync. Never blocks or affects the local alarm.
      outboxRepo.enqueue(
        { entity: 'alarms', entityId: alarm.id, op: 'upsert', payload: row },
        clock(),
      );
      notify();
      return { alarm, status };
    },

    async setEnabled(id: string, enabled: boolean): Promise<SaveResult> {
      return service.save({ ...requireAlarm(id), enabled });
    },

    async toggleSkipNext(id: string): Promise<SaveResult> {
      return service.save(applyToggleSkipNext(requireAlarm(id), clock(), timeZone()));
    },

    async setOneOffOverride(id: string, time: { hour: number; minute: number }) {
      return service.save(applyOneOffOverride(requireAlarm(id), clock(), timeZone(), time));
    },

    async clearOneOffOverride(id: string): Promise<SaveResult> {
      return service.save(clearOneOffOverride(requireAlarm(id)));
    },

    /** Soft-deletes, cancels every engine entry of the alarm, enqueues a delete. */
    async remove(id: string): Promise<ScheduleStatus> {
      const row = deps.db.transaction(() => {
        const write = ctx();
        const deleted = alarmsRepo.softDelete(id, write);
        if (deleted) eventsRepo.append({ type: 'alarm_deleted', alarmId: id, payload: {} }, write);
        return deleted;
      });
      const now = clock();
      const result = await reconcile([], deps.engine, { now, timeZone: timeZone(), scope: id });
      const failure = result.failures[0];
      let status: ScheduleStatus = { state: 'inactive' };
      if (failure || result.mismatches.length > 0) {
        const code = failure?.error.code ?? 'VERIFY_MISMATCH';
        const message = failure?.error.message ?? 'The OS still reports this alarm as scheduled.';
        status = { state: 'failed', engine: deps.engine.kind, nextFire: null, code, message };
        eventsRepo.append(
          {
            type: 'alarm_schedule_failed',
            alarmId: id,
            payload: { engine: deps.engine.kind, code, message },
          },
          ctx(),
        );
      }
      statuses.delete(id);
      if (row) {
        outboxRepo.enqueue({ entity: 'alarms', entityId: id, op: 'delete', payload: row }, now);
      }
      notify();
      return status;
    },

    /** D10: DB ↔ engine reconciliation (app start, foreground, tz change). */
    async reconcileAll(): Promise<ReconcileResult> {
      const now = clock();
      const alarms = alarmsRepo.list();
      const result = await reconcile(alarms, deps.engine, { now, timeZone: timeZone() });
      record(alarms, result, now);
      notify();
      return result;
    },

    /** Rings a test alarm now (preview engine: in-app only). */
    async testAlarm(id: string): Promise<void> {
      const alarm = requireAlarm(id);
      const now = clock();
      await deps.engine.previewAlarm({
        id: `${alarm.id}#test`,
        alarmId: alarm.id,
        occurrenceKey: `${alarm.id}#test`,
        kind: 'alarm',
        fireAt: now.toISOString(),
        label: alarm.label.trim() || 'Test alarm',
        sound: alarm.sound,
        vibration: alarm.vibration,
        escalation: alarm.escalation,
        snooze: alarm.snooze,
        hasMissions: alarm.missions.length > 0,
        wakeCheck: alarm.wakeCheck.enabled,
        important: alarm.important,
      });
    },
  };

  function requireAlarm(id: string): Alarm {
    const alarm = alarmsRepo.get(id);
    if (!alarm) throw new Error(`Alarm ${id} not found`);
    return alarm;
  }

  return service;
}

export type AlarmService = ReturnType<typeof createAlarmService>;
