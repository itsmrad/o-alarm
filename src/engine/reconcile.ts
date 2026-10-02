import type { Alarm } from '@/domain';

import { desiredSpecs, specFingerprint } from './specs';
import type { AlarmEngine, AlarmScheduleSpec, ScheduledAlarm } from './types';
import { AlarmEngineError } from './types';

export interface ReconcilePlan {
  /** Desired but missing from the engine. */
  schedule: AlarmScheduleSpec[];
  /** Present but drifted (time/config changed) or duplicated → cancel + schedule. */
  reschedule: AlarmScheduleSpec[];
  /** Present but no longer wanted (deleted/disabled alarm, orphan, stale). */
  cancel: string[];
  unchanged: string[];
}

/**
 * Pure diff between what the DB wants and what the engine holds (D10).
 *
 * - `alarm` entries are owned by the plan: anything not desired is cancelled.
 * - `snooze` / `wake_check` / `retrigger` entries are owned by the ringing flow (D13):
 *   kept while their alarm is still active and they are in the future, else cancelled.
 * - If `scope` is given, only that alarm's entries are considered (single-alarm save).
 */
export function planReconcile(
  desired: readonly AlarmScheduleSpec[],
  actual: readonly ScheduledAlarm[],
  options: { activeAlarmIds: ReadonlySet<string>; now: Date; scope?: string },
): ReconcilePlan {
  const inScope = <T extends { alarmId: string }>(entry: T) =>
    options.scope === undefined || entry.alarmId === options.scope;
  const wanted = desired.filter(inScope);
  const present = actual.filter(inScope);

  const byId = new Map<string, ScheduledAlarm[]>();
  for (const entry of present) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);

  const plan: ReconcilePlan = { schedule: [], reschedule: [], cancel: [], unchanged: [] };
  const wantedIds = new Set<string>();
  for (const spec of wanted) {
    if (wantedIds.has(spec.id)) continue; // defensive: never schedule an id twice
    wantedIds.add(spec.id);
    const existing = byId.get(spec.id);
    if (!existing) plan.schedule.push(spec);
    else if (existing.length === 1 && specFingerprint(existing[0]!) === specFingerprint(spec)) {
      plan.unchanged.push(spec.id);
    } else plan.reschedule.push(spec);
  }

  for (const [id, entries] of byId) {
    if (wantedIds.has(id)) continue;
    const entry = entries[0]!;
    const keep =
      entry.kind !== 'alarm' &&
      options.activeAlarmIds.has(entry.alarmId) &&
      Date.parse(entry.fireAt) > options.now.getTime();
    if (keep && entries.length === 1) plan.unchanged.push(id);
    else plan.cancel.push(id);
  }
  return plan;
}

export interface ReconcileFailure {
  id: string;
  alarmId: string | null;
  operation: 'schedule' | 'cancel' | 'read';
  error: AlarmEngineError;
}

export interface ReconcileResult {
  plan: ReconcilePlan;
  failures: ReconcileFailure[];
  /** Read-back after applying; empty if the read failed. */
  scheduled: ScheduledAlarm[];
  /** True when the read-back matches the plan exactly (D11 verify step). */
  verified: boolean;
  /** Spec ids whose read-back is missing or differs from what was requested. */
  mismatches: string[];
}

/** Applies a plan. Continues past individual failures and reports each one. */
export async function applyPlan(
  plan: ReconcilePlan,
  engine: AlarmEngine,
  desired: readonly AlarmScheduleSpec[],
): Promise<ReconcileFailure[]> {
  const failures: ReconcileFailure[] = [];
  const alarmIdOf = (id: string) => desired.find((spec) => spec.id === id)?.alarmId ?? null;
  const attempt = async (
    id: string,
    operation: 'schedule' | 'cancel',
    fn: () => Promise<unknown>,
  ) => {
    try {
      await fn();
      return true;
    } catch (error) {
      failures.push({ id, alarmId: alarmIdOf(id), operation, error: AlarmEngineError.from(error) });
      return false;
    }
  };

  for (const id of plan.cancel) await attempt(id, 'cancel', () => engine.cancel(id));
  for (const spec of plan.reschedule) {
    if (await attempt(spec.id, 'cancel', () => engine.cancel(spec.id))) {
      await attempt(spec.id, 'schedule', () => engine.schedule(spec));
    }
  }
  for (const spec of plan.schedule) await attempt(spec.id, 'schedule', () => engine.schedule(spec));
  return failures;
}

/** Compares read-back against the desired specs and the cancelled ids. */
export function verifyReadBack(
  desired: readonly AlarmScheduleSpec[],
  cancelled: readonly string[],
  readBack: readonly ScheduledAlarm[],
): string[] {
  const mismatches: string[] = [];
  for (const spec of desired) {
    const matches = readBack.filter((entry) => entry.id === spec.id);
    if (matches.length !== 1 || specFingerprint(matches[0]!) !== specFingerprint(spec)) {
      mismatches.push(spec.id);
    }
  }
  for (const id of cancelled) {
    if (readBack.some((entry) => entry.id === id)) mismatches.push(id);
  }
  return mismatches;
}

export interface ReconcileOptions {
  now: Date;
  timeZone: string;
  occurrencesPerAlarm?: number;
  /** Limit to one alarm (used by the save path). */
  scope?: string;
}

/**
 * DB ↔ engine reconciliation: read → diff → apply → read back → verify.
 * Idempotent: running it twice in a row leaves the second plan with only `unchanged`.
 */
export async function reconcile(
  alarms: readonly Alarm[],
  engine: AlarmEngine,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const empty: ReconcilePlan = { schedule: [], reschedule: [], cancel: [], unchanged: [] };
  const desired = desiredSpecs(
    alarms,
    options.now,
    options.timeZone,
    options.occurrencesPerAlarm,
  ).filter((spec) => options.scope === undefined || spec.alarmId === options.scope);

  let actual: ScheduledAlarm[];
  try {
    actual = await engine.getScheduled();
  } catch (error) {
    return {
      plan: empty,
      failures: [
        {
          id: '*',
          alarmId: options.scope ?? null,
          operation: 'read',
          error: AlarmEngineError.from(error),
        },
      ],
      scheduled: [],
      verified: false,
      mismatches: desired.map((spec) => spec.id),
    };
  }

  const activeAlarmIds = new Set(alarms.filter((alarm) => alarm.enabled).map((alarm) => alarm.id));
  const plan = planReconcile(desired, actual, {
    activeAlarmIds,
    now: options.now,
    scope: options.scope,
  });
  const failures = await applyPlan(plan, engine, desired);

  let scheduled: ScheduledAlarm[] = [];
  let mismatches: string[];
  try {
    scheduled = await engine.getScheduled();
    mismatches = verifyReadBack(desired, plan.cancel, scheduled);
  } catch (error) {
    failures.push({
      id: '*',
      alarmId: options.scope ?? null,
      operation: 'read',
      error: AlarmEngineError.from(error),
    });
    mismatches = desired.map((spec) => spec.id);
  }
  return {
    plan,
    failures,
    scheduled,
    verified: failures.length === 0 && mismatches.length === 0,
    mismatches,
  };
}
