import type { StructuredInsight, WakeAnalysis, WeekSummary } from './insights';
import type { BedtimeRationale, BedtimeRecommendation, SleepPrefs } from './sleep';
import type { SleepSummary } from './sleep-stats';

/**
 * The only shape that leaves the device for AI (D19). Built field by field from allowlisted
 * aggregates: never raw rows, alarm/occurrence ids, labels, free text, or anything finer than a
 * civil date. The server re-validates it with a strict schema
 * (supabase/functions/ai-insights/core.ts `aiRequestSchema`).
 */

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type ExplainTopic = 'bedtime_recommendation' | 'wake_pattern' | 'mission_recommendation';

export interface InsightPayload {
  id: string;
  kind: StructuredInsight['kind'];
  tone: StructuredInsight['tone'];
  confidence: StructuredInsight['confidence'];
  sampleSize: number;
  metrics: Record<string, number>;
  weekday?: (typeof WEEKDAY_NAMES)[number];
  chain?: string[];
}

export type WeekPayload = Omit<WeekSummary, 'enoughData'>;

export interface BedtimePayload {
  status: 'ok' | 'no_alarm';
  rationale: BedtimeRationale[];
  desiredSleepMin: number;
  latencyMin: number;
  shiftMin: number;
  expectedSleepMin: number | null;
  avgSleepMin: number | null;
  consistencyScore: number | null;
  nightsBelowGoal: number;
  nights: number;
}

interface Period {
  start: string;
  end: string;
}

export type InsightsAiRequest =
  | {
      schemaVersion: 1;
      kind: 'weekly_report';
      period: Period;
      week: WeekPayload;
      insights: InsightPayload[];
      bedtime: BedtimePayload | null;
    }
  | {
      schemaVersion: 1;
      kind: 'explain';
      topic: ExplainTopic;
      period: Period;
      insights: InsightPayload[];
      bedtime: BedtimePayload | null;
    };

const MAX_INSIGHTS = 12;
const MISSION_CODE = /^[a-z][a-z0-9_]{0,23}$/;
const METRIC_KEY = /^[a-zA-Z]{1,32}$/;
const finite = (value: number | null) => (value !== null && Number.isFinite(value) ? value : null);
const count = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

export function insightPayload(insight: StructuredInsight): InsightPayload {
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(insight.metrics)) {
    if (METRIC_KEY.test(key) && typeof value === 'number' && Number.isFinite(value)) {
      metrics[key] = value;
    }
  }
  return {
    id: insight.weekday === undefined ? insight.kind : `${insight.kind}:${insight.weekday}`,
    kind: insight.kind,
    tone: insight.tone,
    confidence: insight.confidence,
    sampleSize: count(insight.sampleSize),
    metrics,
    ...(insight.weekday === undefined ? {} : { weekday: WEEKDAY_NAMES[insight.weekday] }),
    ...(insight.chain?.length
      ? { chain: insight.chain.slice(0, 5).map((id) => (MISSION_CODE.test(id) ? id : 'other')) }
      : {}),
  };
}

export function weekPayload(week: WeekSummary): WeekPayload {
  return {
    start: week.start,
    end: week.end,
    mornings: count(week.mornings),
    successRate: finite(week.successRate),
    avgSnoozes: finite(week.avgSnoozes),
    medianDismissalMin: finite(week.medianDismissalMin),
    missed: count(week.missed),
    retriggerMornings: count(week.retriggerMornings),
    wakeChecksPassed: count(week.wakeChecksPassed),
    wakeChecksFailed: count(week.wakeChecksFailed),
    wakeCheckPassRate: finite(week.wakeCheckPassRate),
    sleepNights: count(week.sleepNights),
    avgSleepMin: finite(week.avgSleepMin),
    sleepConsistency: finite(week.sleepConsistency),
    avgEnergy: finite(week.avgEnergy),
    checkIns: count(week.checkIns),
  };
}

/** Bedtime math as codes and minute counts: the clock times themselves stay on the device. */
export function bedtimePayload(
  rec: BedtimeRecommendation,
  prefs: SleepPrefs,
  summary: SleepSummary,
): BedtimePayload {
  return {
    status: rec.status,
    rationale: [...rec.rationale],
    desiredSleepMin: count(prefs.desiredSleepMin),
    latencyMin: count(prefs.latencyMin),
    shiftMin: Number.isFinite(rec.shiftMin) ? rec.shiftMin : 0,
    expectedSleepMin: finite(rec.expectedSleepMin),
    avgSleepMin: summary.avgDurationMin === null ? null : Math.round(summary.avgDurationMin),
    consistencyScore: finite(summary.consistencyScore),
    nightsBelowGoal: count(summary.nightsBelowGoal),
    nights: count(summary.nights),
  };
}

const TOPIC_KINDS: Record<ExplainTopic, readonly StructuredInsight['kind'][]> = {
  bedtime_recommendation: ['consistency', 'sleep_energy'],
  wake_pattern: [
    'wake_success',
    'snoozing',
    'dismissal_time',
    'wake_check',
    'returned_to_sleep',
    'difficult_weekday',
    'sleep_energy',
    'consistency',
  ],
  mission_recommendation: ['mission_effectiveness', 'wake_success', 'returned_to_sleep'],
};

/** The Weekly Wake Report covers the last complete week. */
export function buildWeeklyReportRequest(
  analysis: WakeAnalysis,
  bedtime: BedtimePayload | null,
): InsightsAiRequest {
  return {
    schemaVersion: 1,
    kind: 'weekly_report',
    period: { start: analysis.lastWeek.start, end: analysis.lastWeek.end },
    week: weekPayload(analysis.lastWeek),
    insights: analysis.insights.slice(0, MAX_INSIGHTS).map(insightPayload),
    bedtime,
  };
}

/** One explanation per topic per week (the server stores it under this week's period). */
export function buildExplainRequest(
  topic: ExplainTopic,
  analysis: WakeAnalysis,
  bedtime: BedtimePayload | null,
): InsightsAiRequest {
  return {
    schemaVersion: 1,
    kind: 'explain',
    topic,
    period: { start: analysis.thisWeek.start, end: analysis.thisWeek.end },
    insights: analysis.insights
      .filter((i) => TOPIC_KINDS[topic].includes(i.kind))
      .slice(0, MAX_INSIGHTS)
      .map(insightPayload),
    bedtime: topic === 'bedtime_recommendation' ? bedtime : null,
  };
}
