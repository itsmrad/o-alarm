import * as Crypto from 'expo-crypto';

import { isTestOccurrence } from '@/db/alarm-service';
import { createEventsRepository } from '@/db/repositories/events';
import { createWakeChecksRepository } from '@/db/repositories/wake-checks';
import type { AppDatabase, WriteContext } from '@/db/types';
import {
  initialWakeCheckState,
  retriggerScheduleId,
  wakeCheckReducer,
  type Alarm,
  type NewEvent,
  type WakeCheckEvent,
  type WakeCheckState,
} from '@/domain';
import {
  AlarmEngineError,
  type AlarmEngine,
  type AlarmEngineEventPayload,
  type AlarmScheduleSpec,
  type ObservedEngineEvent,
} from '@/engine';
import { stableUuid } from '@/lib/stable-id';

import { scheduleKindOf } from './reliability-ledger';

/** An unanswered check this long past its deadline with no re-ring observed is stale. */
export const STALE_CHECK_MS = 10 * 60_000;

type Ring = Pick<AlarmEngineEventPayload, 'scheduleId' | 'alarmId' | 'occurrenceKey' | 'kind'>;

export interface WakeCheckDeps {
  db: AppDatabase;
  deviceId: string;
  engine: AlarmEngine;
  getAlarm: (id: string) => Alarm | null;
  clock?: () => Date;
  newId?: () => string;
}

export type ArmedWakeCheck = Extract<WakeCheckState, { status: 'armed' }>;

/** What a pass attempt resulted in. `late`: the deadline passed, the alarm re-rings. */
export type PassResult = 'passed' | 'late' | 'not_pending';

/**
 * The full-alarm re-ring that fires if wake check `attempt` gets no answer (D13). A native
 * alarm, so it rings with the app killed. No snooze and full volume at once: the user
 * already failed to stay up.
 */
export function retriggerSpec(
  alarm: Alarm,
  occurrenceKey: string,
  attempt: number,
  fireAt: string,
): AlarmScheduleSpec {
  return {
    id: retriggerScheduleId(occurrenceKey, attempt),
    alarmId: alarm.id,
    occurrenceKey,
    kind: 'retrigger',
    fireAt,
    label: alarm.label.trim() || 'Alarm',
    sound: alarm.sound,
    vibration: alarm.vibration,
    escalation: { enabled: false, rampSeconds: 0 },
    snooze: { enabled: false, durationMin: alarm.snooze.durationMin, maxCount: 0 },
    hasMissions: alarm.missions.length > 0,
    wakeCheck: true,
    important: alarm.important,
  };
}

/**
 * Wake Check orchestration (PRODUCT.md Wake Check, D13):
 *
 *   dismiss ─arm→ engine.dismiss(…, wakeCheckAt) + engine.schedule(retrigger @ respondBy)
 *   wake_check alarm rings → prompt (pending) ─pass→ cancel retrigger, stop prompt
 *                                            └ no answer → retrigger rings as a full alarm
 *   retrigger dismissed → arm again, until `maxRetriggers` re-rings.
 *
 * State lives in `wake_checks` (survives app kill) and is advanced both by in-app actions
 * and by the engine's observed events. Every step is idempotent: reducer no-ops on
 * repeats, stable schedule ids (upsert) and stable event ids.
 */
export function createWakeCheckService(deps: WakeCheckDeps) {
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? Crypto.randomUUID;
  const repo = createWakeChecksRepository(deps.db, newId);
  const events = createEventsRepository(deps.db, newId);
  const ctx = (): WriteContext => ({ now: clock(), deviceId: deps.deviceId });

  const stateOf = (occurrenceKey: string): WakeCheckState =>
    repo.get(occurrenceKey)?.state ?? initialWakeCheckState;

  function log(event: NewEvent, key: string, at?: string): void {
    events.appendOnce(event, stableUuid(key), ctx(), at);
  }

  /** Applies reducer events in order and persists the result. Returns [before, after]. */
  function apply(ring: Pick<Ring, 'alarmId' | 'occurrenceKey'>, steps: WakeCheckEvent[]) {
    const before = stateOf(ring.occurrenceKey);
    const after = steps.reduce(wakeCheckReducer, before);
    if (after !== before) {
      repo.save({ alarmId: ring.alarmId, occurrenceKey: ring.occurrenceKey, state: after }, ctx());
    }
    return [before, after] as const;
  }

  function logFailed(ring: Pick<Ring, 'alarmId' | 'occurrenceKey'>, state: WakeCheckState) {
    if (state.status !== 'failed') return;
    log(
      {
        type: 'wake_check_failed',
        alarmId: ring.alarmId,
        occurrenceKey: ring.occurrenceKey,
        payload: { attempt: state.attempt, reason: state.reason },
      },
      `wake_check_failed|${ring.occurrenceKey}|${state.attempt}`,
      state.at,
    );
  }

  /** Stops the prompt alarm if it is the one ringing (it is not a dismissal of the alarm). */
  async function stopPrompt(occurrenceKey: string, missionCompleted: boolean) {
    const ringing = await deps.engine.getActiveRinging().catch(() => null);
    if (ringing?.kind === 'wake_check' && ringing.occurrenceKey === occurrenceKey) {
      await deps.engine.dismiss(ringing.scheduleId, { missionCompleted });
    }
  }

  const service = {
    state: stateOf,

    /**
     * Before `engine.dismiss`: the check to arm for this dismissal, or null (Wake Check
     * off, test ring, the prompt itself, or re-trigger limit reached). Does not write.
     */
    planArm(ring: Ring, now: Date = clock()): ArmedWakeCheck | null {
      if (ring.kind === 'wake_check' || isTestOccurrence(ring.occurrenceKey)) return null;
      const alarm = deps.getAlarm(ring.alarmId);
      if (!alarm?.wakeCheck.enabled) return null;
      const before = stateOf(ring.occurrenceKey);
      const next = wakeCheckReducer(before, { type: 'ARM', now, config: alarm.wakeCheck });
      return next !== before && next.status === 'armed' ? next : null;
    },

    /**
     * After `engine.dismiss(…, { wakeCheckAt: armed.checkAt })` succeeded: persist, log and
     * schedule the native re-trigger. A failed re-trigger is logged, never silent; the
     * prompt alarm still fires.
     */
    async commitArm(ring: Ring, armed: ArmedWakeCheck): Promise<void> {
      const alarm = deps.getAlarm(ring.alarmId);
      if (!alarm) return;
      const current = stateOf(ring.occurrenceKey);
      if (!(current.status === 'armed' && current.attempt >= armed.attempt)) {
        repo.save(
          { alarmId: ring.alarmId, occurrenceKey: ring.occurrenceKey, state: armed },
          ctx(),
        );
      }
      log(
        {
          type: 'wake_check_started',
          alarmId: ring.alarmId,
          occurrenceKey: ring.occurrenceKey,
          payload: { attempt: armed.attempt, checkAt: armed.checkAt },
        },
        `wake_check_started|${ring.occurrenceKey}|${armed.attempt}`,
      );
      try {
        await deps.engine.schedule(
          retriggerSpec(alarm, ring.occurrenceKey, armed.attempt, armed.respondBy),
        );
      } catch (error) {
        const failure = AlarmEngineError.from(error);
        events.append(
          {
            type: 'alarm_schedule_failed',
            alarmId: ring.alarmId,
            occurrenceKey: ring.occurrenceKey,
            payload: { engine: deps.engine.kind, code: failure.code, message: failure.message },
          },
          ctx(),
        );
      }
    },

    /** The prompt alarm rang: start the response window. */
    onCheckDue(ring: Ring, at: string): void {
      apply(ring, [{ type: 'CHECK_DUE', now: new Date(at) }]);
    },

    /**
     * The user proved they are awake. Cancels the re-trigger first (so a crash right after
     * still leaves no re-ring), then stops the prompt. A pass after the deadline is a fail.
     */
    async pass(ring: Pick<Ring, 'alarmId' | 'occurrenceKey'>): Promise<PassResult> {
      const now = clock();
      const [before, after] = apply(ring, [{ type: 'VERIFY_PASSED', now }]);
      if (before.status !== 'pending_verification') return 'not_pending';
      if (after.status === 'failed') {
        logFailed(ring, after);
        return 'late';
      }
      await deps.engine.cancel(retriggerScheduleId(ring.occurrenceKey, before.attempt));
      log(
        {
          type: 'wake_check_passed',
          alarmId: ring.alarmId,
          occurrenceKey: ring.occurrenceKey,
          payload: { attempt: before.attempt },
        },
        `wake_check_passed|${ring.occurrenceKey}|${before.attempt}`,
      );
      repo.endSession(ring.occurrenceKey, 'awake', now.toISOString(), ctx());
      await stopPrompt(ring.occurrenceKey, true);
      return 'passed';
    },

    /**
     * No answer by the deadline: record the failure and stop the prompt so the native
     * re-trigger (already scheduled for this instant) can ring. True if it timed out.
     */
    async timeout(ring: Pick<Ring, 'alarmId' | 'occurrenceKey'>): Promise<boolean> {
      const [, after] = apply(ring, [{ type: 'RESPONSE_TIMEOUT', now: clock() }]);
      if (after.status !== 'failed') return false;
      logFailed(ring, after);
      await stopPrompt(ring.occurrenceKey, false);
      return true;
    },

    /**
     * The re-trigger rang (in-app trigger or observed). Resolves any state it skipped
     * (app killed before the prompt / timeout) to `retriggered`. Returns the attempt it
     * belongs to, or null when no wake check backs this occurrence.
     */
    onRetrigger(ring: Ring, at: string): number | null {
      const before = stateOf(ring.occurrenceKey);
      if (before.status === 'idle' || before.status === 'passed') return null;
      const now = new Date(at);
      const deadline =
        before.status === 'armed'
          ? Date.parse(before.respondBy)
          : before.status === 'pending_verification'
            ? Date.parse(before.deadline)
            : now.getTime();
      const failAt = new Date(Math.max(now.getTime(), deadline));
      const failed = [
        ...(before.status === 'armed' ? [{ type: 'CHECK_DUE', now } as const] : []),
        { type: 'RESPONSE_TIMEOUT', now: failAt } as const,
      ].reduce(wakeCheckReducer, before);
      const after = wakeCheckReducer(failed, { type: 'RETRIGGER', now });
      if (after !== before) {
        repo.save(
          { alarmId: ring.alarmId, occurrenceKey: ring.occurrenceKey, state: after },
          ctx(),
        );
      }
      if (before.status !== 'failed') logFailed(ring, failed);
      return after.status === 'retriggered' ? after.attempt : null;
    },

    /** Engine-observed events while JS may not have run (drain on start/foreground). */
    onObserved(event: ObservedEngineEvent): number | null {
      const ring: Ring = { ...event, kind: scheduleKindOf(event.scheduleId) };
      if (event.type === 'trigger_received' && ring.kind === 'wake_check') {
        service.onCheckDue(ring, event.at);
      } else if (
        (event.type === 'trigger_received' && ring.kind === 'retrigger') ||
        event.type === 'retriggered'
      ) {
        return service.onRetrigger(ring, event.at);
      }
      return null;
    },

    /**
     * Housekeeping on sync: an answer window that ended while the app was backgrounded
     * times out (so the re-trigger can ring); checks long past any re-ring are closed.
     */
    async expireDue(now: Date = clock()): Promise<void> {
      for (const row of repo.listOpen()) {
        const target = {
          alarmId: repo.session(row.occurrenceKey)?.alarmId ?? '',
          occurrenceKey: row.occurrenceKey,
        };
        const state = row.state;
        if (
          state.status === 'pending_verification' &&
          Date.parse(state.deadline) <= now.getTime()
        ) {
          await service.timeout(target);
        } else if (
          state.status === 'armed' &&
          Date.parse(state.respondBy) + STALE_CHECK_MS < now.getTime()
        ) {
          const [, after] = apply(target, [
            { type: 'CHECK_DUE', now },
            { type: 'RESPONSE_TIMEOUT', now },
          ]);
          logFailed(target, after);
          repo.endSession(row.occurrenceKey, 'abandoned', now.toISOString(), ctx());
        }
      }
    },
  };
  return service;
}

export type WakeCheckService = ReturnType<typeof createWakeCheckService>;
