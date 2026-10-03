import type { AppEvent } from './events';
import {
  nightlySummaries,
  SHORT_NIGHT_MARGIN_MIN,
  summarizeSleep,
  type CheckInLike,
  type SleepSessionLike,
} from './sleep-stats';
import {
  addDays,
  formatLocalDate,
  localDateInZone,
  resolveWallClock,
  weekdayOf,
  type LocalDate,
  type Weekday,
} from './time';

/**
 * Deterministic wake analysis (PRODUCT.md AI pipeline, step 2):
 *
 *   events + occurrences + sleep  →  per-morning records  →  aggregates  →  StructuredInsight[]
 *
 * Pure, offline and free: the Insights tab renders these directly; Pro only adds an LLM
 * explanation of the same structured output (D19). Every insight carries its evidence count
 * and a confidence, and nothing is claimed below the minimum-data thresholds. Sleep vs energy
 * is reported as an association only, never as a cause.
 *
 * Weeks and windows are civil dates in the device zone (never millisecond arithmetic), so a
 * DST week is still exactly Monday..Sunday.
 */

const MINUTE_MS = 60_000;

/** Mornings in a week before its rates are shown. */
export const MIN_MORNINGS_WEEK = 3;
/** Mornings in the pattern window before any pattern is claimed. */
export const MIN_MORNINGS_PATTERN = 5;
/** Pattern window, in civil days ending today (6 weeks: up to 6 samples per weekday). */
export const PATTERN_WINDOW_DAYS = 42;
/** A weekday needs this many mornings, and the window MIN_MORNINGS_WEEKDAY_TOTAL overall. */
export const MIN_MORNINGS_WEEKDAY = 3;
export const MIN_MORNINGS_WEEKDAY_TOTAL = 10;
/** A weekday is "difficult" when its success rate trails the overall rate by this much… */
export const WEEKDAY_RATE_GAP = 0.25;
/** …or when it averages this many more snoozes than overall. */
export const WEEKDAY_SNOOZE_GAP = 1;
/** Uses before a mission or chain gets stats; uses before a chain can be recommended. */
export const MIN_MISSION_USES = 3;
export const MIN_CHAIN_USES_FOR_RECOMMENDATION = 4;
/** Success-rate lead a chain needs over the runner-up to be recommended. */
export const CHAIN_RECOMMENDATION_GAP = 0.2;
/** Check-ins needed after short nights AND after enough sleep before comparing energy. */
export const MIN_CHECKINS_PER_GROUP = 3;
/** Mean energy difference (1-5 scale) worth mentioning. */
export const MIN_ENERGY_DIFF = 0.5;
/** Completed nights before a consistency insight. */
export const MIN_NIGHTS_CONSISTENCY = 5;
/** Wake Check answers before a pass rate is shown. */
export const MIN_WAKE_CHECKS = 3;

export type OccurrenceStatusLike =
  'scheduled' | 'triggered' | 'snoozed' | 'dismissed' | 'missed' | 'skipped' | 'cancelled';

/** The reliability-ledger row shape the analysis reads (`alarm_occurrences`). */
export interface OccurrenceLike {
  alarmId: string;
  occurrenceKey: string;
  expectedAt: string;
  status: OccurrenceStatusLike;
  triggeredAt: string | null;
  dismissedAt: string | null;
  snoozeCount: number;
}

/** One resolved alarm morning. Local only: carries ids that never leave the device. */
export interface WakeMorning {
  alarmId: string;
  occurrenceKey: string;
  /** Civil date of the ring in the device zone (YYYY-MM-DD). */
  date: string;
  weekday: Weekday;
  /** woke = dismissed with no re-trigger; returned_to_sleep = needed a re-trigger. */
  outcome: 'woke' | 'returned_to_sleep' | 'missed';
  snoozes: number;
  /** Minutes from the first ring to the final dismissal (snoozes included). */
  dismissalMin: number | null;
  wakeChecksPassed: number;
  wakeChecksFailed: number;
  retriggers: number;
  /** Mission ids in step order (null: no mission ran). */
  chain: string[] | null;
  missionsCompleted: number;
  missionsFailed: number;
  /** Total time spent on completed missions, seconds. */
  missionSec: number | null;
}

export type InsightKind =
  | 'wake_success'
  | 'snoozing'
  | 'dismissal_time'
  | 'wake_check'
  | 'returned_to_sleep'
  | 'difficult_weekday'
  | 'mission_effectiveness'
  | 'sleep_energy'
  | 'consistency';

export type InsightTone = 'positive' | 'neutral' | 'attention';
export type InsightConfidence = 'low' | 'medium' | 'high';

export type InsightMetric =
  | 'successRate'
  | 'avgSnoozes'
  | 'medianDismissalMin'
  | 'passRate'
  | 'retriggerMornings'
  | 'retriggerRate'
  | 'weekdaySuccessRate'
  | 'weekdayAvgSnoozes'
  | 'overallSuccessRate'
  | 'overallAvgSnoozes'
  | 'uses'
  | 'avgCompleteSec'
  | 'retriggerAfterRate'
  | 'runnerUpSuccessRate'
  | 'runnerUpUses'
  | 'avgEnergyShortSleep'
  | 'avgEnergyEnoughSleep'
  | 'energyDiff'
  | 'shortNightCheckIns'
  | 'enoughNightCheckIns'
  | 'consistencyScore'
  | 'nights';

/** A deterministic finding. The only analysis shape (besides week aggregates) sent to AI. */
export interface StructuredInsight {
  /** Stable per kind (+ weekday): `difficult_weekday:1`. */
  id: string;
  kind: InsightKind;
  tone: InsightTone;
  confidence: InsightConfidence;
  /** Evidence count: mornings, nights or check-ins behind the claim. */
  sampleSize: number;
  metrics: Partial<Record<InsightMetric, number>>;
  weekday?: Weekday;
  /** Mission ids (sanitized codes), for mission insights. */
  chain?: string[];
}

export interface WeekSummary {
  /** Civil dates, Monday..Sunday. */
  start: string;
  end: string;
  mornings: number;
  /** Rates below are null until MIN_MORNINGS_WEEK mornings exist. */
  enoughData: boolean;
  successRate: number | null;
  avgSnoozes: number | null;
  medianDismissalMin: number | null;
  missed: number;
  retriggerMornings: number;
  wakeChecksPassed: number;
  wakeChecksFailed: number;
  wakeCheckPassRate: number | null;
  sleepNights: number;
  avgSleepMin: number | null;
  sleepConsistency: number | null;
  avgEnergy: number | null;
  checkIns: number;
}

export interface ChainStats {
  chain: string[];
  uses: number;
  successRate: number;
  avgCompleteSec: number | null;
  /** Share of mornings with this chain that still needed a re-trigger. */
  retriggerAfterRate: number;
}

export interface MissionStats {
  missionId: string;
  uses: number;
  /** completed / (completed + failed) attempts. */
  completionRate: number | null;
  /** Share of mornings including this mission that were a clean wake. */
  successRate: number;
  avgCompleteSec: number | null;
}

export type MissionRecommendation =
  | { status: 'insufficient_data' }
  | { status: 'no_clear_difference'; best: ChainStats }
  | { status: 'recommend'; best: ChainStats; runnerUp: ChainStats };

export interface EnergyBucket {
  label: '<6h' | '6-7h' | '7-8h' | '8h+';
  checkIns: number;
  avgEnergy: number | null;
}

/** Sleep vs next-morning energy. An association in this user's data, never a cause. */
export interface SleepEnergyAssociation {
  enoughData: boolean;
  shortNightThresholdMin: number;
  shortNightCheckIns: number;
  enoughNightCheckIns: number;
  avgEnergyShortSleep: number | null;
  avgEnergyEnoughSleep: number | null;
  /** enough − short (positive: more energy after enough sleep). Null below the guards. */
  energyDiff: number | null;
  buckets: EnergyBucket[];
}

export interface WakeAnalysis {
  today: string;
  thisWeek: WeekSummary;
  /** The last complete week: what the Weekly Wake Report covers. */
  lastWeek: WeekSummary;
  pattern: { start: string; end: string; mornings: number };
  insights: StructuredInsight[];
  chains: ChainStats[];
  missions: MissionStats[];
  missionRecommendation: MissionRecommendation;
  sleepEnergy: SleepEnergyAssociation;
  /** Alarm with the most mornings in the window: where a suggestion deep-links. Local only. */
  primaryAlarmId: string | null;
}

export interface WakeAnalysisInput {
  now: Date;
  timeZone: string;
  occurrences: readonly OccurrenceLike[];
  events: readonly AppEvent[];
  sleepSessions: readonly SleepSessionLike[];
  checkIns: readonly CheckInLike[];
  desiredSleepMin: number;
}

// ---------------------------------------------------------------------------- helpers

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const rate = (part: number, whole: number) => (whole > 0 ? round(part / whole, 2) : 0);

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** low below 2× the threshold, medium below 4×, high from there. */
export function confidenceFor(sampleSize: number, minimum: number): InsightConfidence {
  if (sampleSize >= minimum * 4) return 'high';
  if (sampleSize >= minimum * 2) return 'medium';
  return 'low';
}

/** Monday..Sunday containing `date` (civil, DST-proof). */
export function weekBounds(date: LocalDate): { start: LocalDate; end: LocalDate } {
  const start = addDays(date, -((weekdayOf(date) + 6) % 7));
  return { start, end: addDays(start, 6) };
}

const MISSION_CODE = /^[a-z][a-z0-9_]{0,23}$/;
/** Mission ids are registry codes; anything else is reported as `other`, never as text. */
export const sanitizeMissionId = (id: string): string => (MISSION_CODE.test(id) ? id : 'other');

const inRange = (date: string, start: string, end: string) => date >= start && date <= end;

// ---------------------------------------------------------------------------- mornings

/**
 * One record per resolved occurrence (dismissed or missed) that was due by `now`.
 * Still-ringing, skipped, cancelled and future occurrences are left out.
 */
export function buildMornings(
  occurrences: readonly OccurrenceLike[],
  events: readonly AppEvent[],
  options: { now: Date; timeZone: string },
): WakeMorning[] {
  const byKey = new Map<string, AppEvent[]>();
  for (const event of events) {
    if (!event.occurrenceKey) continue;
    byKey.set(event.occurrenceKey, [...(byKey.get(event.occurrenceKey) ?? []), event]);
  }

  const mornings: WakeMorning[] = [];
  for (const occ of occurrences) {
    if (occ.status !== 'dismissed' && occ.status !== 'missed') continue;
    const expected = new Date(occ.expectedAt);
    if (Number.isNaN(expected.getTime()) || expected.getTime() > options.now.getTime()) continue;
    const local = localDateInZone(expected, options.timeZone);
    const own = byKey.get(occ.occurrenceKey) ?? [];
    const count = (type: AppEvent['type']) => own.filter((e) => e.type === type).length;

    const steps = new Map<number, string>();
    let missionMs = 0;
    for (const e of own) {
      if (e.type === 'mission_started' && !steps.has(e.payload.stepIndex)) {
        steps.set(e.payload.stepIndex, sanitizeMissionId(e.payload.missionId));
      }
      if (e.type === 'mission_completed') missionMs += Math.max(0, e.payload.durationMs);
    }
    const chain = steps.size
      ? [...steps.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id)
      : null;
    const missionsCompleted = count('mission_completed');

    const retriggers = count('alarm_retriggered');
    const firstRing = occ.triggeredAt ?? occ.expectedAt;
    const dismissalMin =
      occ.status === 'dismissed' && occ.dismissedAt
        ? Math.max(0, (Date.parse(occ.dismissedAt) - Date.parse(firstRing)) / MINUTE_MS)
        : null;

    mornings.push({
      alarmId: occ.alarmId,
      occurrenceKey: occ.occurrenceKey,
      date: formatLocalDate(local),
      weekday: weekdayOf(local),
      outcome: occ.status === 'missed' ? 'missed' : retriggers > 0 ? 'returned_to_sleep' : 'woke',
      snoozes: Math.max(occ.snoozeCount, count('alarm_snoozed')),
      dismissalMin: dismissalMin === null || Number.isNaN(dismissalMin) ? null : dismissalMin,
      wakeChecksPassed: count('wake_check_passed'),
      wakeChecksFailed: count('wake_check_failed'),
      retriggers,
      chain,
      missionsCompleted,
      missionsFailed: count('mission_failed'),
      missionSec: missionsCompleted > 0 ? round(missionMs / 1000, 0) : null,
    });
  }
  return mornings.sort((a, b) => a.date.localeCompare(b.date));
}

const successRateOf = (mornings: readonly WakeMorning[]) =>
  rate(mornings.filter((m) => m.outcome === 'woke').length, mornings.length);
const avgSnoozesOf = (mornings: readonly WakeMorning[]) =>
  round(mean(mornings.map((m) => m.snoozes)) ?? 0, 1);
const medianDismissalOf = (mornings: readonly WakeMorning[]) => {
  const m = median(mornings.flatMap((x) => (x.dismissalMin === null ? [] : [x.dismissalMin])));
  return m === null ? null : round(m, 0);
};

// ---------------------------------------------------------------------------- weeks

export function summarizeWeek(
  mornings: readonly WakeMorning[],
  week: { start: LocalDate; end: LocalDate },
  sleep: {
    sessions: readonly SleepSessionLike[];
    checkIns: readonly CheckInLike[];
    timeZone: string;
    desiredSleepMin: number;
    now: Date;
  },
): WeekSummary {
  const start = formatLocalDate(week.start);
  const end = formatLocalDate(week.end);
  const own = mornings.filter((m) => inRange(m.date, start, end));
  const enoughData = own.length >= MIN_MORNINGS_WEEK;
  const passed = own.reduce((sum, m) => sum + m.wakeChecksPassed, 0);
  const failed = own.reduce((sum, m) => sum + m.wakeChecksFailed, 0);

  // Sleep stats for the 7 civil days ending on the week's last day (or today, mid-week).
  const endNoon = resolveWallClock(week.end, 12, 0, sleep.timeZone);
  const anchor = endNoon.getTime() < sleep.now.getTime() ? endNoon : sleep.now;
  const days =
    Math.round(
      (Date.parse(formatLocalDate(localDateInZone(anchor, sleep.timeZone))) - Date.parse(start)) /
        86_400_000,
    ) + 1;
  const summary = summarizeSleep(sleep.sessions, sleep.checkIns, {
    now: anchor,
    timeZone: sleep.timeZone,
    desiredSleepMin: sleep.desiredSleepMin,
    days: Math.max(1, Math.min(7, days)),
  });

  return {
    start,
    end,
    mornings: own.length,
    enoughData,
    successRate: enoughData ? successRateOf(own) : null,
    avgSnoozes: enoughData ? avgSnoozesOf(own) : null,
    medianDismissalMin: enoughData ? medianDismissalOf(own) : null,
    missed: own.filter((m) => m.outcome === 'missed').length,
    retriggerMornings: own.filter((m) => m.retriggers > 0).length,
    wakeChecksPassed: passed,
    wakeChecksFailed: failed,
    wakeCheckPassRate: passed + failed >= MIN_WAKE_CHECKS ? rate(passed, passed + failed) : null,
    sleepNights: summary.nights,
    avgSleepMin: summary.avgDurationMin === null ? null : round(summary.avgDurationMin, 0),
    sleepConsistency: summary.consistencyScore,
    avgEnergy: summary.avgEnergy,
    checkIns: summary.checkIns,
  };
}

// ---------------------------------------------------------------------------- missions

export function chainStats(mornings: readonly WakeMorning[]): ChainStats[] {
  const groups = new Map<string, WakeMorning[]>();
  for (const m of mornings) {
    if (!m.chain) continue;
    const key = m.chain.join('>');
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups.values()]
    .filter((group) => group.length >= MIN_MISSION_USES)
    .map((group) => {
      const secs = group.flatMap((m) => (m.missionSec === null ? [] : [m.missionSec]));
      const avg = mean(secs);
      return {
        chain: group[0]!.chain!,
        uses: group.length,
        successRate: successRateOf(group),
        avgCompleteSec: avg === null ? null : round(avg, 0),
        retriggerAfterRate: rate(group.filter((m) => m.retriggers > 0).length, group.length),
      };
    })
    .sort((a, b) => b.successRate - a.successRate || b.uses - a.uses);
}

export function missionStats(mornings: readonly WakeMorning[]): MissionStats[] {
  const ids = new Set(mornings.flatMap((m) => m.chain ?? []));
  return [...ids]
    .map((missionId) => {
      const group = mornings.filter((m) => m.chain?.includes(missionId));
      const completed = group.reduce((s, m) => s + m.missionsCompleted, 0);
      const failed = group.reduce((s, m) => s + m.missionsFailed, 0);
      const secs = group.flatMap((m) =>
        m.missionSec === null || m.chain!.length !== 1 ? [] : [m.missionSec],
      );
      const avg = mean(secs);
      return {
        missionId,
        uses: group.length,
        completionRate: completed + failed > 0 ? rate(completed, completed + failed) : null,
        successRate: successRateOf(group),
        avgCompleteSec: avg === null ? null : round(avg, 0),
      };
    })
    .filter((s) => s.uses >= MIN_MISSION_USES)
    .sort((a, b) => b.successRate - a.successRate || b.uses - a.uses);
}

/**
 * Recommends a chain only with a real comparison: both it and the runner-up have
 * MIN_CHAIN_USES_FOR_RECOMMENDATION mornings, and it leads by CHAIN_RECOMMENDATION_GAP.
 */
export function recommendMission(chains: readonly ChainStats[]): MissionRecommendation {
  const eligible = chains.filter((c) => c.uses >= MIN_CHAIN_USES_FOR_RECOMMENDATION);
  const [best, runnerUp] = eligible;
  if (!best) return { status: 'insufficient_data' };
  if (!runnerUp || best.successRate - runnerUp.successRate < CHAIN_RECOMMENDATION_GAP) {
    return { status: 'no_clear_difference', best };
  }
  return { status: 'recommend', best, runnerUp };
}

// ---------------------------------------------------------------------------- sleep vs energy

const BUCKETS: { label: EnergyBucket['label']; max: number }[] = [
  { label: '<6h', max: 360 },
  { label: '6-7h', max: 420 },
  { label: '7-8h', max: 480 },
  { label: '8h+', max: Infinity },
];

export function sleepEnergyAssociation(
  sessions: readonly SleepSessionLike[],
  checkIns: readonly CheckInLike[],
  options: { now: Date; timeZone: string; desiredSleepMin: number; days: number },
): SleepEnergyAssociation {
  const energy = new Map(
    checkIns.flatMap((c) => (c.energy === null ? [] : [[c.date, c.energy] as const])),
  );
  const pairs = nightlySummaries(sessions, {
    now: options.now,
    timeZone: options.timeZone,
    nights: options.days,
  }).flatMap((n) =>
    n.durationMin !== null && energy.has(n.date)
      ? [{ minutes: n.durationMin, energy: energy.get(n.date)! }]
      : [],
  );
  const threshold = options.desiredSleepMin - SHORT_NIGHT_MARGIN_MIN;
  const short = pairs.filter((p) => p.minutes < threshold).map((p) => p.energy);
  const enough = pairs.filter((p) => p.minutes >= threshold).map((p) => p.energy);
  const enoughData =
    short.length >= MIN_CHECKINS_PER_GROUP && enough.length >= MIN_CHECKINS_PER_GROUP;
  const avg = (values: number[]) => {
    const m = mean(values);
    return m === null ? null : round(m, 1);
  };
  const avgShort = avg(short);
  const avgEnough = avg(enough);
  let lower = 0;
  return {
    enoughData,
    shortNightThresholdMin: threshold,
    shortNightCheckIns: short.length,
    enoughNightCheckIns: enough.length,
    avgEnergyShortSleep: avgShort,
    avgEnergyEnoughSleep: avgEnough,
    energyDiff: enoughData ? round(avgEnough! - avgShort!, 1) : null,
    buckets: BUCKETS.map(({ label, max }) => {
      const inBucket = pairs.filter((p) => p.minutes >= lower && p.minutes < max);
      lower = max;
      return { label, checkIns: inBucket.length, avgEnergy: avg(inBucket.map((p) => p.energy)) };
    }),
  };
}

// ---------------------------------------------------------------------------- insights

function insight(
  kind: InsightKind,
  tone: InsightTone,
  sampleSize: number,
  minimum: number,
  metrics: StructuredInsight['metrics'],
  extra: Pick<StructuredInsight, 'weekday' | 'chain'> = {},
): StructuredInsight {
  const id = extra.weekday === undefined ? kind : `${kind}:${extra.weekday}`;
  return {
    id,
    kind,
    tone,
    confidence: confidenceFor(sampleSize, minimum),
    sampleSize,
    metrics,
    ...extra,
  };
}

function difficultWeekday(mornings: readonly WakeMorning[]): StructuredInsight | null {
  if (mornings.length < MIN_MORNINGS_WEEKDAY_TOTAL) return null;
  const overallRate = successRateOf(mornings);
  const overallSnoozes = avgSnoozesOf(mornings);
  const candidates = ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).flatMap((weekday) => {
    const group = mornings.filter((m) => m.weekday === weekday);
    if (group.length < MIN_MORNINGS_WEEKDAY) return [];
    const dayRate = successRateOf(group);
    const daySnoozes = avgSnoozesOf(group);
    const rateGap = overallRate - dayRate;
    const snoozeGap = daySnoozes - overallSnoozes;
    if (rateGap < WEEKDAY_RATE_GAP && snoozeGap < WEEKDAY_SNOOZE_GAP) return [];
    return [{ weekday, group, dayRate, daySnoozes, score: rateGap + snoozeGap / 4 }];
  });
  const worst = candidates.sort((a, b) => b.score - a.score)[0];
  if (!worst) return null;
  return insight(
    'difficult_weekday',
    'attention',
    worst.group.length,
    MIN_MORNINGS_WEEKDAY,
    {
      weekdaySuccessRate: worst.dayRate,
      weekdayAvgSnoozes: worst.daySnoozes,
      overallSuccessRate: overallRate,
      overallAvgSnoozes: overallSnoozes,
    },
    { weekday: worst.weekday },
  );
}

export function deriveInsights(
  mornings: readonly WakeMorning[],
  context: {
    recommendation: MissionRecommendation;
    sleepEnergy: SleepEnergyAssociation;
    consistencyScore: number | null;
    sleepNights: number;
  },
): StructuredInsight[] {
  const out: StructuredInsight[] = [];
  const n = mornings.length;

  if (n >= MIN_MORNINGS_PATTERN) {
    const successRate = successRateOf(mornings);
    out.push(
      insight(
        'wake_success',
        successRate >= 0.8 ? 'positive' : successRate < 0.6 ? 'attention' : 'neutral',
        n,
        MIN_MORNINGS_PATTERN,
        { successRate },
      ),
    );

    const avgSnoozes = avgSnoozesOf(mornings);
    if (avgSnoozes >= 1 || avgSnoozes < 0.3) {
      out.push(
        insight(
          'snoozing',
          avgSnoozes >= 1.5 ? 'attention' : avgSnoozes < 0.3 ? 'positive' : 'neutral',
          n,
          MIN_MORNINGS_PATTERN,
          { avgSnoozes },
        ),
      );
    }

    const dismissed = mornings.filter((m) => m.dismissalMin !== null);
    const medianDismissalMin = medianDismissalOf(dismissed);
    if (dismissed.length >= MIN_MORNINGS_PATTERN && medianDismissalMin !== null) {
      out.push(
        insight(
          'dismissal_time',
          medianDismissalMin >= 15 ? 'attention' : medianDismissalMin <= 3 ? 'positive' : 'neutral',
          dismissed.length,
          MIN_MORNINGS_PATTERN,
          { medianDismissalMin },
        ),
      );
    }

    const retriggerMornings = mornings.filter((m) => m.retriggers > 0).length;
    const retriggerRate = rate(retriggerMornings, n);
    if (retriggerMornings >= 2 && retriggerRate >= 0.2) {
      out.push(
        insight('returned_to_sleep', 'attention', n, MIN_MORNINGS_PATTERN, {
          retriggerMornings,
          retriggerRate,
        }),
      );
    }
  }

  const passed = mornings.reduce((s, m) => s + m.wakeChecksPassed, 0);
  const failed = mornings.reduce((s, m) => s + m.wakeChecksFailed, 0);
  if (passed + failed >= MIN_WAKE_CHECKS) {
    const passRate = rate(passed, passed + failed);
    out.push(
      insight(
        'wake_check',
        passRate >= 0.8 ? 'positive' : passRate < 0.5 ? 'attention' : 'neutral',
        passed + failed,
        MIN_WAKE_CHECKS,
        { passRate },
      ),
    );
  }

  const weekday = difficultWeekday(mornings);
  if (weekday) out.push(weekday);

  const rec = context.recommendation;
  if (rec.status !== 'insufficient_data') {
    const { best } = rec;
    out.push(
      insight(
        'mission_effectiveness',
        rec.status === 'recommend' ? 'positive' : 'neutral',
        best.uses,
        MIN_CHAIN_USES_FOR_RECOMMENDATION,
        {
          successRate: best.successRate,
          uses: best.uses,
          retriggerAfterRate: best.retriggerAfterRate,
          ...(best.avgCompleteSec === null ? {} : { avgCompleteSec: best.avgCompleteSec }),
          ...(rec.status === 'recommend'
            ? { runnerUpSuccessRate: rec.runnerUp.successRate, runnerUpUses: rec.runnerUp.uses }
            : {}),
        },
        { chain: best.chain },
      ),
    );
  }

  const se = context.sleepEnergy;
  if (se.enoughData && se.energyDiff !== null && Math.abs(se.energyDiff) >= MIN_ENERGY_DIFF) {
    out.push(
      insight(
        'sleep_energy',
        se.energyDiff > 0 ? 'attention' : 'neutral',
        se.shortNightCheckIns + se.enoughNightCheckIns,
        MIN_CHECKINS_PER_GROUP * 2,
        {
          avgEnergyShortSleep: se.avgEnergyShortSleep!,
          avgEnergyEnoughSleep: se.avgEnergyEnoughSleep!,
          energyDiff: se.energyDiff,
          shortNightCheckIns: se.shortNightCheckIns,
          enoughNightCheckIns: se.enoughNightCheckIns,
        },
      ),
    );
  }

  if (context.consistencyScore !== null && context.sleepNights >= MIN_NIGHTS_CONSISTENCY) {
    const score = context.consistencyScore;
    out.push(
      insight(
        'consistency',
        score >= 70 ? 'positive' : score < 40 ? 'attention' : 'neutral',
        context.sleepNights,
        MIN_NIGHTS_CONSISTENCY,
        { consistencyScore: score, nights: context.sleepNights },
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------- entry point

export function analyzeWake(input: WakeAnalysisInput): WakeAnalysis {
  const { now, timeZone } = input;
  const today = localDateInZone(now, timeZone);
  const all = buildMornings(input.occurrences, input.events, { now, timeZone });

  const patternStart = formatLocalDate(addDays(today, -(PATTERN_WINDOW_DAYS - 1)));
  const todayStr = formatLocalDate(today);
  const mornings = all.filter((m) => inRange(m.date, patternStart, todayStr));

  const sleep = {
    sessions: input.sleepSessions,
    checkIns: input.checkIns,
    timeZone,
    desiredSleepMin: input.desiredSleepMin,
    now,
  };
  const current = weekBounds(today);
  const previous = { start: addDays(current.start, -7), end: addDays(current.start, -1) };

  const chains = chainStats(mornings);
  const recommendation = recommendMission(chains);
  const sleepEnergy = sleepEnergyAssociation(input.sleepSessions, input.checkIns, {
    now,
    timeZone,
    desiredSleepMin: input.desiredSleepMin,
    days: PATTERN_WINDOW_DAYS,
  });
  const sleepSummary = summarizeSleep(input.sleepSessions, input.checkIns, {
    now,
    timeZone,
    desiredSleepMin: input.desiredSleepMin,
    days: 14,
  });

  const perAlarm = new Map<string, number>();
  for (const m of mornings) perAlarm.set(m.alarmId, (perAlarm.get(m.alarmId) ?? 0) + 1);
  const primaryAlarmId = [...perAlarm.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    today: todayStr,
    thisWeek: summarizeWeek(all, current, sleep),
    lastWeek: summarizeWeek(all, previous, sleep),
    pattern: { start: patternStart, end: todayStr, mornings: mornings.length },
    insights: deriveInsights(mornings, {
      recommendation,
      sleepEnergy,
      consistencyScore: sleepSummary.consistencyScore,
      sleepNights: sleepSummary.nights,
    }),
    chains,
    missions: missionStats(mornings),
    missionRecommendation: recommendation,
    sleepEnergy,
    primaryAlarmId,
  };
}
