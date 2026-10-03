import { z } from 'zod';

import type { Alarm } from './alarm';
import { upcomingOccurrences } from './recurrence';
import {
  addDays,
  formatLocalDate,
  localDateInZone,
  resolveWallClock,
  wallClockInZone,
} from './time';

/**
 * Deterministic bedtime math (D19: AI may only explain these results, never compute them).
 *
 *   ideal bedtime   = required wake − desired sleep − sleep latency        (elapsed time)
 *   recommendation  = ideal, moved toward the recent average bedtime so it never differs
 *                     from it by more than MAX_BEDTIME_SHIFT_MIN (consistency rule)
 *
 * Elapsed time is used for the subtraction, so a DST night is correct by construction:
 * the sleep window is always the real number of hours, only its wall-clock labels move.
 */

export const MAX_BEDTIME_SHIFT_MIN = 30;
/** Recent bedtimes needed before consistency adjusts anything. */
export const MIN_HISTORY_FOR_CONSISTENCY = 3;

const MINUTE_MS = 60_000;
const DAY_MIN = 1440;

export const sleepPrefsSchema = z.object({
  /** `auto`: work back from the next alarm. `manual`: the user's fixed bedtime. */
  mode: z.enum(['auto', 'manual']),
  manualBedtime: z.object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  desiredSleepMin: z.number().int().min(240).max(720),
  /** Typical time to fall asleep after getting into bed. */
  latencyMin: z.number().int().min(0).max(120),
  /** Lead time of the wind-down reminder before bedtime. */
  windDownMin: z.number().int().min(0).max(180),
});
export type SleepPrefs = z.infer<typeof sleepPrefsSchema>;

export const DEFAULT_SLEEP_PREFS: SleepPrefs = {
  mode: 'auto',
  manualBedtime: { hour: 23, minute: 0 },
  desiredSleepMin: 480,
  latencyMin: 15,
  windDownMin: 45,
};

/** Why a recommendation came out the way it did. The UI/AI turn these into words. */
export type BedtimeRationale =
  | 'from_next_alarm'
  | 'manual_target'
  | 'includes_latency'
  | 'no_history'
  | 'aligned_with_history'
  | 'shift_capped'
  | 'sleep_below_goal'
  | 'bedtime_passed'
  | 'no_alarm';

export interface BedtimeRecommendation {
  /** `no_alarm`: auto mode with nothing to wake up for, so there is no bedtime to compute. */
  status: 'ok' | 'no_alarm';
  /** The wake instant the recommendation works back from (null: manual with no alarm). */
  wakeAt: Date | null;
  bedtime: Date | null;
  windDownAt: Date | null;
  /** Bedtime before the consistency rule (null in manual mode). */
  idealBedtime: Date | null;
  /** Minutes the recommendation was moved from ideal (positive = later). */
  shiftMin: number;
  /** Expected sleep at the recommended bedtime, after latency (null without a wake time). */
  expectedSleepMin: number | null;
  rationale: BedtimeRationale[];
}

export interface BedtimeInput {
  now: Date;
  /** Zone bedtimes are habitually kept in: the device zone. */
  timeZone: string;
  prefs: SleepPrefs;
  /** Next required wake instant (see `upcomingWakeTargets`), or null if there is none. */
  wake: Date | null;
  /** Start instants of recent sleep sessions (used only in auto mode). */
  recentBedtimes?: readonly Date[];
  maxShiftMin?: number;
}

/** Minute of day (0-1439) of an instant on the wall clock of `timeZone`. */
export function minuteOfDay(instant: Date, timeZone: string): number {
  const { hour, minute } = wallClockInZone(instant, timeZone);
  return hour * 60 + minute;
}

/** Signed shortest distance a → b on the 24h circle, in (-720, 720]. */
export function circularDiffMin(from: number, to: number): number {
  const diff = (((to - from) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return diff > DAY_MIN / 2 ? diff - DAY_MIN : diff;
}

/** Circular mean of minutes-of-day, rounded to a whole minute; null for no data. */
export function circularMeanMinutes(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const { sin, cos } = values.reduce(
    (acc, v) => {
      const angle = (v / DAY_MIN) * 2 * Math.PI;
      return { sin: acc.sin + Math.sin(angle), cos: acc.cos + Math.cos(angle) };
    },
    { sin: 0, cos: 0 },
  );
  if (Math.hypot(sin, cos) < 1e-9) return null; // evenly spread: no meaningful mean
  const angle = Math.atan2(sin, cos);
  const minutes = Math.round((angle / (2 * Math.PI)) * DAY_MIN);
  return ((minutes % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

/**
 * Manual target: the latest occurrence of the chosen clock time that still leaves the
 * user time to fall asleep before `wake`; with no alarm, the occurrence nearest ahead
 * (a bedtime that passed up to 3 h ago still counts as "tonight").
 */
function manualBedtime(input: BedtimeInput): Date {
  const { now, timeZone, prefs, wake } = input;
  const { hour, minute } = prefs.manualBedtime;
  const today = localDateInZone(wake ?? now, timeZone);
  const candidates = [-1, 0, 1].map((offset) =>
    resolveWallClock(addDays(today, offset), hour, minute, timeZone),
  );
  if (wake) {
    const before = candidates.filter(
      (c) => c.getTime() + input.prefs.latencyMin * MINUTE_MS < wake.getTime(),
    );
    return before[before.length - 1] ?? candidates[0]!;
  }
  const floor = now.getTime() - 3 * 60 * MINUTE_MS;
  const upcoming = [...candidates, resolveWallClock(addDays(today, 2), hour, minute, timeZone)];
  return upcoming.find((c) => c.getTime() >= floor) ?? upcoming[upcoming.length - 1]!;
}

export function recommendBedtime(input: BedtimeInput): BedtimeRecommendation {
  const { now, timeZone, prefs, wake } = input;
  const maxShift = input.maxShiftMin ?? MAX_BEDTIME_SHIFT_MIN;
  const rationale: BedtimeRationale[] = [];

  if (prefs.mode === 'manual') {
    const bedtime = manualBedtime(input);
    rationale.push('manual_target');
    const expectedSleepMin = wake
      ? Math.round((wake.getTime() - bedtime.getTime()) / MINUTE_MS) - prefs.latencyMin
      : null;
    if (expectedSleepMin !== null && expectedSleepMin < prefs.desiredSleepMin) {
      rationale.push('sleep_below_goal');
    }
    if (bedtime.getTime() <= now.getTime()) rationale.push('bedtime_passed');
    return {
      status: 'ok',
      wakeAt: wake,
      bedtime,
      windDownAt: new Date(bedtime.getTime() - prefs.windDownMin * MINUTE_MS),
      idealBedtime: null,
      shiftMin: 0,
      expectedSleepMin,
      rationale,
    };
  }

  if (!wake) {
    return {
      status: 'no_alarm',
      wakeAt: null,
      bedtime: null,
      windDownAt: null,
      idealBedtime: null,
      shiftMin: 0,
      expectedSleepMin: null,
      rationale: ['no_alarm'],
    };
  }

  rationale.push('from_next_alarm');
  if (prefs.latencyMin > 0) rationale.push('includes_latency');
  const ideal = new Date(wake.getTime() - (prefs.desiredSleepMin + prefs.latencyMin) * MINUTE_MS);
  let bedtime = ideal;

  const history = (input.recentBedtimes ?? []).map((d) => minuteOfDay(d, timeZone));
  const average =
    history.length >= MIN_HISTORY_FOR_CONSISTENCY ? circularMeanMinutes(history) : null;
  if (average === null) {
    rationale.push('no_history');
  } else {
    const shift = circularDiffMin(average, minuteOfDay(ideal, timeZone));
    const clamped = Math.max(-maxShift, Math.min(maxShift, shift));
    if (clamped !== shift) {
      bedtime = new Date(ideal.getTime() + (clamped - shift) * MINUTE_MS);
      rationale.push('shift_capped');
    } else {
      rationale.push('aligned_with_history');
    }
  }

  const expectedSleepMin =
    Math.round((wake.getTime() - bedtime.getTime()) / MINUTE_MS) - prefs.latencyMin;
  if (expectedSleepMin < prefs.desiredSleepMin) rationale.push('sleep_below_goal');
  if (bedtime.getTime() <= now.getTime()) rationale.push('bedtime_passed');

  return {
    status: 'ok',
    wakeAt: wake,
    bedtime,
    windDownAt: new Date(bedtime.getTime() - prefs.windDownMin * MINUTE_MS),
    idealBedtime: ideal,
    shiftMin: Math.round((bedtime.getTime() - ideal.getTime()) / MINUTE_MS),
    expectedSleepMin,
    rationale,
  };
}

/** Label of alarms created by nap mode; they are never a morning wake target. */
export const NAP_LABEL = 'Nap';

export function isNapAlarm(alarm: Pick<Alarm, 'label' | 'weekdays'>): boolean {
  return alarm.weekdays.length === 0 && alarm.label === NAP_LABEL;
}

export interface WakeTarget {
  alarmId: string;
  occurrenceKey: string;
  /** The instant the alarm will ring (skip-next and one-off overrides applied). */
  fireAt: Date;
  /** Civil date of the ring in its own zone. */
  localDate: string;
  timeZone: string;
}

/**
 * The next required wake instants, earliest first, one per civil date (the earliest
 * alarm that day is the one sleep has to serve). Disabled alarms, skipped occurrences
 * and nap alarms are ignored. Reads only existing alarm domain functions.
 */
export function upcomingWakeTargets(
  alarms: readonly Alarm[],
  now: Date,
  deviceTimeZone: string,
  limit = 3,
): WakeTarget[] {
  const all = alarms
    .filter((alarm) => alarm.enabled && !isNapAlarm(alarm))
    .flatMap((alarm) => upcomingOccurrences(alarm, now, deviceTimeZone, limit))
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  const seen = new Set<string>();
  const targets: WakeTarget[] = [];
  for (const occurrence of all) {
    if (seen.has(occurrence.localDate)) continue;
    seen.add(occurrence.localDate);
    targets.push({
      alarmId: occurrence.alarmId,
      occurrenceKey: occurrence.occurrenceKey,
      fireAt: occurrence.fireAt,
      localDate: occurrence.localDate,
      timeZone: occurrence.timeZone,
    });
    if (targets.length >= limit) break;
  }
  return targets;
}

/** Civil date (YYYY-MM-DD) of an instant in a zone. */
export const civilDate = (instant: Date, timeZone: string): string =>
  formatLocalDate(localDateInZone(instant, timeZone));
