import { addDays, formatLocalDate, localDateInZone } from './time';
import { circularMeanMinutes, minuteOfDay } from './sleep';

/**
 * Sleep statistics from local sessions + check-ins. Pure and deterministic.
 * `SleepSummary` is the only shape meant to leave the device for AI (D19): aggregates
 * only, never the raw session list.
 */

const MINUTE_MS = 60_000;
const DAY_MIN = 1440;

/** Longest believable single sleep. Anything longer is a forgotten "going to bed" tap. */
export const MAX_SESSION_MIN = 16 * 60;
export const MIN_SESSIONS_FOR_CONSISTENCY = 3;
/** Circular SD (minutes) at which the consistency score reaches 0. */
export const CONSISTENCY_ZERO_SD_MIN = 120;
/** A night this far under the goal counts as "short" in the stats. */
export const SHORT_NIGHT_MARGIN_MIN = 60;

export interface SleepSessionLike {
  startedAt: string;
  endedAt: string | null;
}

export interface CheckInLike {
  /** Civil date of the morning (YYYY-MM-DD). */
  date: string;
  energy: number | null;
  sleepQuality: number | null;
}

/** Whole minutes between start and end; null for open, inverted or implausibly long sessions. */
export function sessionDurationMin(session: SleepSessionLike): number | null {
  if (!session.endedAt) return null;
  const minutes = Math.round(
    (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / MINUTE_MS,
  );
  return minutes > 0 && minutes <= MAX_SESSION_MIN ? minutes : null;
}

const completed = <T extends SleepSessionLike>(sessions: readonly T[]) =>
  sessions.filter((s) => sessionDurationMin(s) !== null);

/** Circular standard deviation of minutes-of-day, in minutes. */
export function circularSdMinutes(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const sin = values.reduce((sum, v) => sum + Math.sin((v / DAY_MIN) * 2 * Math.PI), 0);
  const cos = values.reduce((sum, v) => sum + Math.cos((v / DAY_MIN) * 2 * Math.PI), 0);
  const r = Math.min(1, Math.hypot(sin, cos) / values.length);
  if (r <= 0) return DAY_MIN / 2;
  return (Math.sqrt(-2 * Math.log(r)) * DAY_MIN) / (2 * Math.PI);
}

/**
 * Consistency 0-100: how regular bedtime and wake time are. The mean of the circular SD
 * of the two (minutes) maps linearly: 0 min → 100, CONSISTENCY_ZERO_SD_MIN (2 h) or more
 * → 0. Needs MIN_SESSIONS_FOR_CONSISTENCY completed sessions, otherwise null.
 */
export function consistencyScore(
  sessions: readonly SleepSessionLike[],
  timeZone: string,
): number | null {
  const done = completed(sessions);
  if (done.length < MIN_SESSIONS_FOR_CONSISTENCY) return null;
  const startSd = circularSdMinutes(done.map((s) => minuteOfDay(new Date(s.startedAt), timeZone)));
  const endSd = circularSdMinutes(done.map((s) => minuteOfDay(new Date(s.endedAt!), timeZone)));
  if (startSd === null || endSd === null) return null;
  const sd = (startSd + endSd) / 2;
  return Math.round(100 * Math.max(0, 1 - sd / CONSISTENCY_ZERO_SD_MIN));
}

export interface NightSummary {
  /** Civil date of the morning the night ended (YYYY-MM-DD). */
  date: string;
  /** Total sleep that ended on that morning (null: nothing recorded). */
  durationMin: number | null;
  /** Earliest bedtime of that night. */
  bedtime: Date | null;
  wake: Date | null;
}

/**
 * One entry per morning for the last `nights` civil days ending today (oldest first).
 * Sessions are filed under the date they ended; several on one morning are summed.
 */
export function nightlySummaries(
  sessions: readonly SleepSessionLike[],
  options: { now: Date; timeZone: string; nights?: number },
): NightSummary[] {
  const { now, timeZone } = options;
  const nights = options.nights ?? 14;
  const today = localDateInZone(now, timeZone);
  const byDate = new Map<string, SleepSessionLike[]>();
  for (const session of completed(sessions)) {
    const key = formatLocalDate(localDateInZone(new Date(session.endedAt!), timeZone));
    byDate.set(key, [...(byDate.get(key) ?? []), session]);
  }
  return Array.from({ length: nights }, (_, i) => {
    const date = formatLocalDate(addDays(today, i - (nights - 1)));
    const group = byDate.get(date) ?? [];
    if (group.length === 0) return { date, durationMin: null, bedtime: null, wake: null };
    const starts = group.map((s) => new Date(s.startedAt).getTime());
    const ends = group.map((s) => new Date(s.endedAt!).getTime());
    return {
      date,
      durationMin: group.reduce((sum, s) => sum + sessionDurationMin(s)!, 0),
      bedtime: new Date(Math.min(...starts)),
      wake: new Date(Math.max(...ends)),
    };
  });
}

const average = (values: readonly number[]): number | null =>
  values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;

/** Aggregates for the bedtime recommendation explainer and insights. No raw sessions. */
export interface SleepSummary {
  windowDays: number;
  nights: number;
  avgDurationMin: number | null;
  avgBedtimeMinuteOfDay: number | null;
  avgWakeMinuteOfDay: number | null;
  consistencyScore: number | null;
  desiredSleepMin: number;
  nightsBelowGoal: number;
  checkIns: number;
  avgEnergy: number | null;
  avgSleepQuality: number | null;
  /** Mean morning energy after short vs. adequate nights (correlation, not causation). */
  avgEnergyAfterShortSleep: number | null;
  avgEnergyAfterEnoughSleep: number | null;
}

export function summarizeSleep(
  sessions: readonly SleepSessionLike[],
  checkIns: readonly CheckInLike[],
  options: { now: Date; timeZone: string; desiredSleepMin: number; days?: number },
): SleepSummary {
  const { now, timeZone, desiredSleepMin } = options;
  const days = options.days ?? 14;
  const nights = nightlySummaries(sessions, { now, timeZone, nights: days });
  const recorded = nights.filter((n) => n.durationMin !== null);
  const windowDates = new Set(nights.map((n) => n.date));
  const inWindow = completed(sessions).filter((s) =>
    windowDates.has(formatLocalDate(localDateInZone(new Date(s.endedAt!), timeZone))),
  );
  const energyByDate = new Map(
    checkIns
      .filter((c) => c.energy !== null && windowDates.has(c.date))
      .map((c) => [c.date, c.energy as number]),
  );
  const isShort = (n: NightSummary) => n.durationMin! < desiredSleepMin - SHORT_NIGHT_MARGIN_MIN;
  const energyAfter = (pick: (n: NightSummary) => boolean) =>
    average(recorded.filter(pick).flatMap((n) => energyByDate.get(n.date) ?? []));
  const windowCheckIns = checkIns.filter((c) => windowDates.has(c.date));

  return {
    windowDays: days,
    nights: recorded.length,
    avgDurationMin: average(recorded.map((n) => n.durationMin!)),
    avgBedtimeMinuteOfDay: circularMeanMinutes(
      inWindow.map((s) => minuteOfDay(new Date(s.startedAt), timeZone)),
    ),
    avgWakeMinuteOfDay: circularMeanMinutes(
      inWindow.map((s) => minuteOfDay(new Date(s.endedAt!), timeZone)),
    ),
    consistencyScore: consistencyScore(inWindow, timeZone),
    desiredSleepMin,
    nightsBelowGoal: recorded.filter((n) => n.durationMin! < desiredSleepMin).length,
    checkIns: windowCheckIns.length,
    avgEnergy: average(windowCheckIns.flatMap((c) => (c.energy === null ? [] : [c.energy]))),
    avgSleepQuality: average(
      windowCheckIns.flatMap((c) => (c.sleepQuality === null ? [] : [c.sleepQuality])),
    ),
    avgEnergyAfterShortSleep: energyAfter(isShort),
    avgEnergyAfterEnoughSleep: energyAfter((n) => !isShort(n)),
  };
}

/** Start instants of the most recent completed sessions (input to `recommendBedtime`). */
export function recentBedtimes(sessions: readonly SleepSessionLike[], limit = 7): Date[] {
  return completed(sessions)
    .map((s) => new Date(s.startedAt))
    .sort((a, b) => b.getTime() - a.getTime())
    .slice(0, limit);
}
