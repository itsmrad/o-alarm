import type { AppEvent } from '@/domain/events';
import { analyzeWake, type OccurrenceLike } from '@/domain/insights';
import {
  bedtimePayload,
  buildExplainRequest,
  buildWeeklyReportRequest,
  type InsightsAiRequest,
} from '@/domain/insights-payload';
import { DEFAULT_SLEEP_PREFS, recommendBedtime } from '@/domain/sleep';
import { summarizeSleep } from '@/domain/sleep-stats';

import { aiRequestSchema, type AiRequest } from './contract';

/**
 * Property test: whatever is in the local history, the payload sent to the AI function holds
 * only allowlisted aggregates. No ids, labels, free text or timestamps finer than a day.
 */

/** Deterministic PRNG (mulberry32) so failures reproduce from the seed. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECRETS = [
  'Gym with Alex',
  'Take pills 💊',
  'call mom',
  'Flight LH400 to Berlin',
  'secret@example.com',
  '<script>',
];
const TZS = ['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney', 'UTC'];
const MISSIONS = ['math', 'shake', 'qr', 'steps', ...SECRETS];

function randomHistory(seed: number) {
  const r = rng(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(r() * items.length)]!;
  const timeZone = pick(TZS);
  const now = new Date(
    Date.UTC(2026, 9, 1) + Math.floor(r() * 120) * 86_400_000 + r() * 86_400_000,
  );
  const occurrences: OccurrenceLike[] = [];
  const events: AppEvent[] = [];
  const secretIds: string[] = [];
  const mornings = Math.floor(r() * 60);
  for (let i = 0; i < mornings; i++) {
    const alarmId = `${pick(SECRETS)}-${Math.floor(r() * 3)}`;
    const occurrenceKey = `${alarmId}:${i}:${pick(SECRETS)}`;
    secretIds.push(alarmId, occurrenceKey);
    const expected = new Date(now.getTime() - r() * 50 * 86_400_000);
    const missed = r() < 0.1;
    occurrences.push({
      alarmId,
      occurrenceKey,
      expectedAt: expected.toISOString(),
      status: missed ? 'missed' : pick(['dismissed', 'dismissed', 'dismissed', 'skipped'] as const),
      triggeredAt: missed ? null : expected.toISOString(),
      dismissedAt: missed ? null : new Date(expected.getTime() + r() * 3_600_000).toISOString(),
      snoozeCount: Math.floor(r() * 4),
    });
    const base = { alarmId, occurrenceKey, occurredAt: expected.toISOString() };
    const chainLength = Math.floor(r() * 3);
    for (let step = 0; step < chainLength; step++) {
      const missionId = pick(MISSIONS);
      events.push({
        ...base,
        id: `e${i}-${step}a`,
        type: 'mission_started',
        payload: { missionId, stepIndex: step },
      });
      events.push({
        ...base,
        id: `e${i}-${step}b`,
        type: r() < 0.8 ? 'mission_completed' : 'mission_failed',
        payload: { missionId, stepIndex: step, durationMs: r() * 90_000, reason: pick(SECRETS) },
      } as AppEvent);
    }
    if (r() < 0.3) {
      events.push({
        ...base,
        id: `e${i}-r`,
        type: 'alarm_retriggered',
        payload: { reason: 'wake_check_failed', attempt: 1 },
      });
    }
    if (r() < 0.5) {
      events.push({
        ...base,
        id: `e${i}-w`,
        type: r() < 0.7 ? 'wake_check_passed' : 'wake_check_failed',
        payload: { attempt: 1, reason: 'no_response' },
      } as AppEvent);
    }
  }
  const sessions = Array.from({ length: Math.floor(r() * 40) }, () => {
    const end = new Date(now.getTime() - r() * 45 * 86_400_000);
    return {
      startedAt: new Date(end.getTime() - (4 + r() * 6) * 3_600_000).toISOString(),
      endedAt: end.toISOString(),
    };
  });
  const checkIns = sessions.map((s) => ({
    date: s.endedAt.slice(0, 10),
    energy: r() < 0.8 ? 1 + Math.floor(r() * 5) : null,
    sleepQuality: null,
  }));
  return { timeZone, now, occurrences, events, sessions, checkIns, secretIds };
}

function requestsFor(seed: number): { requests: InsightsAiRequest[]; secretIds: string[] } {
  const h = randomHistory(seed);
  const analysis = analyzeWake({
    now: h.now,
    timeZone: h.timeZone,
    occurrences: h.occurrences,
    events: h.events,
    sleepSessions: h.sessions,
    checkIns: h.checkIns,
    desiredSleepMin: 480,
  });
  const rec = recommendBedtime({
    now: h.now,
    timeZone: h.timeZone,
    prefs: DEFAULT_SLEEP_PREFS,
    wake: new Date(h.now.getTime() + 10 * 3_600_000),
    recentBedtimes: h.sessions.map((s) => new Date(s.startedAt)),
  });
  const bedtime = bedtimePayload(
    rec,
    DEFAULT_SLEEP_PREFS,
    summarizeSleep(h.sessions, h.checkIns, {
      now: h.now,
      timeZone: h.timeZone,
      desiredSleepMin: 480,
    }),
  );
  return {
    secretIds: h.secretIds,
    requests: [
      buildWeeklyReportRequest(analysis, bedtime),
      buildExplainRequest('bedtime_recommendation', analysis, bedtime),
      buildExplainRequest('wake_pattern', analysis, bedtime),
      buildExplainRequest('mission_recommendation', analysis, bedtime),
    ],
  };
}

const FORBIDDEN_KEYS = new Set([
  'alarmId',
  'occurrenceKey',
  'label',
  'occurredAt',
  'expectedAt',
  'triggeredAt',
  'dismissedAt',
  'startedAt',
  'endedAt',
  'payload',
  'events',
  'deviceId',
  'userId',
  'bedtime_at',
  'wakeAt',
  'idealBedtime',
  'windDownAt',
  'primaryAlarmId',
  'reason',
  'notes',
]);
/** Every string value must be one of these shapes: enum codes, civil dates, insight ids. */
const SAFE_STRING =
  /^([a-z][a-z0-9_]*(:[0-6])?|\d{4}-\d{2}-\d{2}|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/;

function walk(
  value: unknown,
  visit: (key: string | null, value: unknown) => void,
  key: string | null = null,
) {
  visit(key, value);
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, visit, k);
  }
}

describe('AI payload builder never sends forbidden fields (property test)', () => {
  const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

  it.each(SEEDS.map((s) => [s]))('seed %i', (seed) => {
    const { requests, secretIds } = requestsFor(seed);
    for (const request of requests) {
      const text = JSON.stringify(request);
      // Accepted verbatim by the server's strict schema (and type-compatible with it).
      const typed: AiRequest = request;
      expect(aiRequestSchema.safeParse(typed).success).toBe(true);

      walk(request, (key, value) => {
        if (key !== null) expect(FORBIDDEN_KEYS.has(key)).toBe(false);
        if (typeof value === 'string') expect(value).toMatch(SAFE_STRING);
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      });
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T|\d{1,2}:\d{2}/);
      for (const secret of [...SECRETS, ...secretIds]) expect(text).not.toContain(secret);
    }
  });

  it('the generated histories exercise rich payloads (not just empty ones)', () => {
    const weekly = SEEDS.map((seed) => requestsFor(seed).requests[0]!);
    const kinds = new Set(weekly.flatMap((r) => r.insights.map((i) => i.kind)));
    expect(kinds.size).toBeGreaterThanOrEqual(6);
    expect(weekly.filter((r) => r.insights.length >= 3).length).toBeGreaterThan(SEEDS.length / 4);
    expect(weekly.some((r) => r.insights.some((i) => i.chain?.includes('other')))).toBe(true);
  });
});
