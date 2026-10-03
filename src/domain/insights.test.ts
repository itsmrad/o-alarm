import type { AppEvent, NewEvent } from './events';
import {
  analyzeWake,
  buildMornings,
  chainStats,
  confidenceFor,
  MIN_MORNINGS_PATTERN,
  missionStats,
  recommendMission,
  sanitizeMissionId,
  sleepEnergyAssociation,
  weekBounds,
  type OccurrenceLike,
  type WakeMorning,
} from './insights';
import { addDays, formatLocalDate, parseLocalDate, resolveWallClock } from './time';

const TZ = 'Europe/Berlin';
let seq = 0;

interface MorningSpec {
  hour?: number;
  minute?: number;
  alarmId?: string;
  snoozes?: number;
  dismissAfterMin?: number;
  missed?: boolean;
  retriggers?: number;
  chain?: string[];
  missionSec?: number;
  missionFailures?: number;
  wakeChecksPassed?: number;
  wakeChecksFailed?: number;
  status?: OccurrenceLike['status'];
}

/** One alarm morning on a civil date in `tz`: its ledger row + the events it logged. */
function morning(date: string, spec: MorningSpec = {}, tz = TZ) {
  const key = `occ-${++seq}`;
  const at = resolveWallClock(parseLocalDate(date), spec.hour ?? 7, spec.minute ?? 0, tz);
  const iso = (offsetMin: number) => new Date(at.getTime() + offsetMin * 60_000).toISOString();
  const status = spec.status ?? (spec.missed ? 'missed' : 'dismissed');
  const occ: OccurrenceLike = {
    alarmId: spec.alarmId ?? 'alarm-1',
    occurrenceKey: key,
    expectedAt: at.toISOString(),
    status,
    triggeredAt: spec.missed ? null : at.toISOString(),
    dismissedAt: status === 'dismissed' ? iso(spec.dismissAfterMin ?? 2) : null,
    snoozeCount: spec.snoozes ?? 0,
  };
  const events: AppEvent[] = [];
  const add = (event: NewEvent) =>
    events.push({
      id: `e-${++seq}`,
      occurredAt: iso(1),
      alarmId: occ.alarmId,
      occurrenceKey: key,
      ...event,
    } as AppEvent);
  (spec.chain ?? []).forEach((missionId, stepIndex) => {
    add({ type: 'mission_started', payload: { missionId, stepIndex } });
    for (let i = 0; i < (spec.missionFailures ?? 0); i++) {
      add({ type: 'mission_failed', payload: { missionId, stepIndex, reason: 'wrong' } });
    }
    add({
      type: 'mission_completed',
      payload: {
        missionId,
        stepIndex,
        durationMs: ((spec.missionSec ?? 30) * 1000) / spec.chain!.length,
      },
    });
  });
  for (let i = 0; i < (spec.retriggers ?? 0); i++) {
    add({ type: 'alarm_retriggered', payload: { reason: 'wake_check_failed', attempt: i + 1 } });
  }
  for (let i = 0; i < (spec.wakeChecksPassed ?? 0); i++) {
    add({ type: 'wake_check_passed', payload: { attempt: 1 } });
  }
  for (let i = 0; i < (spec.wakeChecksFailed ?? 0); i++) {
    add({ type: 'wake_check_failed', payload: { attempt: 1, reason: 'no_response' } });
  }
  return { occ, events };
}

function build(mornings: ReturnType<typeof morning>[]) {
  return {
    occurrences: mornings.map((m) => m.occ),
    events: mornings.flatMap((m) => m.events),
  };
}

/** Consecutive civil dates ending (inclusive) at `end`. */
const days = (end: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    formatLocalDate(addDays(parseLocalDate(end), i - count + 1)),
  );

const NOW = resolveWallClock(parseLocalDate('2026-10-14'), 18, 0, TZ); // Wednesday evening

function analyze(
  mornings: ReturnType<typeof morning>[],
  extra: Partial<Parameters<typeof analyzeWake>[0]> = {},
) {
  return analyzeWake({
    now: NOW,
    timeZone: TZ,
    ...build(mornings),
    sleepSessions: [],
    checkIns: [],
    desiredSleepMin: 480,
    ...extra,
  });
}

describe('buildMornings', () => {
  it('classifies outcomes, snoozes, dismissal time, Wake Checks and the mission chain', () => {
    const data = build([
      morning('2026-10-12', {
        snoozes: 2,
        dismissAfterMin: 20,
        chain: ['math', 'shake'],
        wakeChecksPassed: 1,
      }),
      morning('2026-10-13', { retriggers: 1, wakeChecksFailed: 1, wakeChecksPassed: 1 }),
      morning('2026-10-14', { missed: true, hour: 6 }),
    ]);
    const [a, b, c] = buildMornings(data.occurrences, data.events, { now: NOW, timeZone: TZ });
    expect(a).toMatchObject({
      date: '2026-10-12',
      weekday: 1,
      outcome: 'woke',
      snoozes: 2,
      dismissalMin: 20,
      chain: ['math', 'shake'],
      missionsCompleted: 2,
      missionSec: 30,
      wakeChecksPassed: 1,
    });
    expect(b).toMatchObject({
      outcome: 'returned_to_sleep',
      retriggers: 1,
      wakeChecksFailed: 1,
      chain: null,
    });
    expect(c).toMatchObject({ outcome: 'missed', dismissalMin: null });
  });

  it('counts snoozes from events when the ledger row lags behind', () => {
    const m = morning('2026-10-12');
    m.events.push(
      ...[1, 2, 3].map(
        (n) =>
          ({
            id: `s${n}`,
            type: 'alarm_snoozed',
            occurredAt: m.occ.expectedAt,
            alarmId: 'alarm-1',
            occurrenceKey: m.occ.occurrenceKey,
            payload: { snoozesUsed: n, nextFireAt: m.occ.expectedAt },
          }) as AppEvent,
      ),
    );
    expect(buildMornings([m.occ], m.events, { now: NOW, timeZone: TZ })[0]!.snoozes).toBe(3);
  });

  it('leaves out unresolved, withdrawn and future occurrences', () => {
    const data = build([
      morning('2026-10-12', { status: 'triggered' }),
      morning('2026-10-12', { status: 'skipped' }),
      morning('2026-10-13', { status: 'cancelled' }),
      morning('2026-10-15'), // tomorrow
    ]);
    expect(buildMornings(data.occurrences, data.events, { now: NOW, timeZone: TZ })).toEqual([]);
  });

  it('reports mission ids as codes only (free text becomes "other")', () => {
    expect(sanitizeMissionId('qr')).toBe('qr');
    expect(sanitizeMissionId('Call Mom at 7')).toBe('other');
    const data = build([morning('2026-10-12', { chain: ['steps', 'my secret label'] })]);
    expect(
      buildMornings(data.occurrences, data.events, { now: NOW, timeZone: TZ })[0]!.chain,
    ).toEqual(['steps', 'other']);
  });
});

describe('minimum-data thresholds', () => {
  it('claims nothing on two nights of data', () => {
    const result = analyze([
      morning('2026-10-13', { snoozes: 3 }),
      morning('2026-10-14', { retriggers: 2 }),
    ]);
    expect(result.insights).toEqual([]);
    expect(result.thisWeek).toMatchObject({
      mornings: 2,
      enoughData: false,
      successRate: null,
      avgSnoozes: null,
    });
    expect(result.missionRecommendation).toEqual({ status: 'insufficient_data' });
    expect(result.sleepEnergy.enoughData).toBe(false);
  });

  it('starts with low-confidence patterns at the threshold and fills the week at 3 mornings', () => {
    const result = analyze(
      days('2026-10-14', MIN_MORNINGS_PATTERN).map((d) => morning(d, { snoozes: 2 })),
    );
    const success = result.insights.find((i) => i.kind === 'wake_success')!;
    expect(success).toMatchObject({
      sampleSize: 5,
      confidence: 'low',
      metrics: { successRate: 1 },
    });
    expect(result.insights.find((i) => i.kind === 'snoozing')).toMatchObject({
      tone: 'attention',
      metrics: { avgSnoozes: 2 },
    });
    expect(result.thisWeek).toMatchObject({
      start: '2026-10-12',
      end: '2026-10-18',
      mornings: 3,
      enoughData: true,
    });
    expect(result.thisWeek.successRate).toBe(1);
    expect(result.lastWeek).toMatchObject({
      start: '2026-10-05',
      end: '2026-10-11',
      mornings: 2,
      enoughData: false,
    });
  });

  it('scales confidence with evidence', () => {
    expect(confidenceFor(5, 5)).toBe('low');
    expect(confidenceFor(10, 5)).toBe('medium');
    expect(confidenceFor(20, 5)).toBe('high');
  });

  it('flags returning to sleep only when it recurs', () => {
    const once = analyze(
      days('2026-10-14', 10).map((d, i) => morning(d, { retriggers: i === 0 ? 1 : 0 })),
    );
    expect(once.insights.some((i) => i.kind === 'returned_to_sleep')).toBe(false);
    const often = analyze(
      days('2026-10-14', 10).map((d, i) => morning(d, { retriggers: i % 3 === 0 ? 1 : 0 })),
    );
    expect(often.insights.find((i) => i.kind === 'returned_to_sleep')).toMatchObject({
      metrics: { retriggerMornings: 4, retriggerRate: 0.4 },
    });
  });

  it('needs 3 Wake Check answers before a pass rate', () => {
    const two = analyze([
      morning('2026-10-13', { wakeChecksPassed: 1 }),
      morning('2026-10-14', { wakeChecksFailed: 1 }),
    ]);
    expect(two.thisWeek.wakeCheckPassRate).toBeNull();
    expect(two.insights.some((i) => i.kind === 'wake_check')).toBe(false);
  });
});

describe('difficult weekdays', () => {
  // Six weeks of weekday alarms; Mondays keep needing a re-trigger.
  const sixWeeks = () =>
    days('2026-10-14', 42)
      .filter((d) => ![0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()))
      .map((d) => morning(d, { retriggers: new Date(`${d}T12:00:00Z`).getUTCDay() === 1 ? 1 : 0 }));

  it('finds the weekday that trails the overall rate', () => {
    const result = analyze(sixWeeks());
    const weekday = result.insights.find((i) => i.kind === 'difficult_weekday')!;
    expect(weekday).toMatchObject({ id: 'difficult_weekday:1', weekday: 1, tone: 'attention' });
    expect(weekday.metrics.weekdaySuccessRate).toBe(0);
    expect(weekday.metrics.overallSuccessRate).toBeGreaterThan(0.7);
    expect(weekday.sampleSize).toBe(6);
  });

  it('needs enough mornings overall and per weekday', () => {
    const few = analyze(
      days('2026-10-14', 9).map((d) => morning(d, { retriggers: d === '2026-10-12' ? 1 : 0 })),
    );
    expect(few.insights.some((i) => i.kind === 'difficult_weekday')).toBe(false);
    // Plenty of mornings, but the bad weekday only appears twice.
    const twoMondays = analyze(
      days('2026-10-14', 14).map((d) =>
        morning(d, { retriggers: ['2026-10-05', '2026-10-12'].includes(d) ? 1 : 0 }),
      ),
    );
    expect(twoMondays.insights.some((i) => i.kind === 'difficult_weekday')).toBe(false);
  });

  it('also catches a weekday with far more snoozing', () => {
    const result = analyze(
      days('2026-10-14', 28).map((d) =>
        morning(d, { snoozes: new Date(`${d}T12:00:00Z`).getUTCDay() === 5 ? 3 : 0 }),
      ),
    );
    expect(result.insights.find((i) => i.kind === 'difficult_weekday')).toMatchObject({
      weekday: 5,
      metrics: { weekdayAvgSnoozes: 3 },
    });
  });
});

describe('week boundaries across DST', () => {
  it('keeps a Sunday-night alarm in its own week when the clocks go back (Europe/Berlin)', () => {
    // 2026-10-25 is the fall-back Sunday: that week is 169 hours long.
    const now = resolveWallClock(parseLocalDate('2026-10-26'), 9, 0, TZ);
    const sunday = morning('2026-10-25', { hour: 23, minute: 30 });
    const monday = morning('2026-10-26', { hour: 0, minute: 15 });
    const others = ['2026-10-20', '2026-10-21'].map((d) => morning(d));
    const result = analyzeWake({
      now,
      timeZone: TZ,
      ...build([sunday, monday, ...others]),
      sleepSessions: [],
      checkIns: [],
      desiredSleepMin: 480,
    });
    expect(result.lastWeek).toMatchObject({ start: '2026-10-19', end: '2026-10-25', mornings: 3 });
    expect(result.thisWeek).toMatchObject({ start: '2026-10-26', end: '2026-11-01', mornings: 1 });
  });

  it('handles the spring-forward week (America/New_York)', () => {
    const tz = 'America/New_York';
    const now = resolveWallClock(parseLocalDate('2026-03-09'), 12, 0, tz);
    const result = analyzeWake({
      now,
      timeZone: tz,
      ...build([
        morning('2026-03-02', { hour: 0, minute: 30 }, tz),
        morning('2026-03-08', { hour: 23, minute: 45 }, tz),
        morning('2026-03-09', { hour: 0, minute: 5 }, tz),
      ]),
      sleepSessions: [],
      checkIns: [],
      desiredSleepMin: 480,
    });
    expect(result.lastWeek).toMatchObject({ start: '2026-03-02', end: '2026-03-08', mornings: 2 });
    expect(result.thisWeek).toMatchObject({ start: '2026-03-09', mornings: 1 });
  });

  it('weeks run Monday to Sunday from any day', () => {
    expect(weekBounds(parseLocalDate('2026-11-01'))).toEqual({
      start: parseLocalDate('2026-10-26'),
      end: parseLocalDate('2026-11-01'),
    });
    expect(weekBounds(parseLocalDate('2026-10-26')).start).toEqual(parseLocalDate('2026-10-26'));
  });
});

describe('mission effectiveness', () => {
  const ms = (outcomes: [chain: string[], ok: boolean][]) =>
    outcomes.map(([chain, ok], i): WakeMorning => ({
      alarmId: 'a',
      occurrenceKey: `k${i}`,
      date: '2026-10-01',
      weekday: 4,
      outcome: ok ? 'woke' : 'returned_to_sleep',
      snoozes: 0,
      dismissalMin: 1,
      wakeChecksPassed: 0,
      wakeChecksFailed: 0,
      retriggers: ok ? 0 : 1,
      chain,
      missionsCompleted: chain.length,
      missionsFailed: 0,
      missionSec: 20 * chain.length,
    }));
  const repeat = <T>(n: number, value: T) => Array.from({ length: n }, () => value);

  it('recommends a chain that clearly beats the runner-up', () => {
    const chains = chainStats(
      ms([
        ...repeat<[string[], boolean]>(5, [['math', 'shake'], true]),
        ...repeat<[string[], boolean]>(2, [['shake'], true]),
        ...repeat<[string[], boolean]>(3, [['shake'], false]),
      ]),
    );
    expect(chains[0]).toMatchObject({
      chain: ['math', 'shake'],
      uses: 5,
      successRate: 1,
      avgCompleteSec: 40,
    });
    expect(chains[1]).toMatchObject({
      chain: ['shake'],
      uses: 5,
      successRate: 0.4,
      retriggerAfterRate: 0.6,
    });
    const rec = recommendMission(chains);
    expect(rec.status).toBe('recommend');
    expect(rec.status === 'recommend' && rec.runnerUp.chain).toEqual(['shake']);
  });

  it('does not recommend without a clear gap or a second chain to compare', () => {
    const close = chainStats(
      ms([
        ...repeat<[string[], boolean]>(4, [['math'], true]),
        ...repeat<[string[], boolean]>(5, [['qr'], true]),
        [['qr'], false],
      ]),
    );
    expect(recommendMission(close).status).toBe('no_clear_difference');
    const single = chainStats(ms(repeat<[string[], boolean]>(6, [['math'], true])));
    expect(recommendMission(single).status).toBe('no_clear_difference');
    const tooFew = chainStats(ms(repeat<[string[], boolean]>(3, [['math'], true])));
    expect(recommendMission(tooFew)).toEqual({ status: 'insufficient_data' });
    expect(chainStats(ms(repeat<[string[], boolean]>(2, [['math'], true])))).toEqual([]);
  });

  it('summarizes each mission: completion, mornings and time to complete', () => {
    const data = build(
      days('2026-10-14', 4).map((d, i) =>
        morning(d, { chain: ['math'], missionSec: 30, missionFailures: i === 0 ? 2 : 0 }),
      ),
    );
    const stats = missionStats(
      buildMornings(data.occurrences, data.events, { now: NOW, timeZone: TZ }),
    );
    expect(stats).toEqual([
      { missionId: 'math', uses: 4, completionRate: 0.67, successRate: 1, avgCompleteSec: 30 },
    ]);
  });

  it('feeds the recommendation into a mission insight', () => {
    const result = analyze([
      ...days('2026-10-14', 5).map((d) => morning(d, { chain: ['math'] })),
      ...days('2026-10-09', 5).map((d) => morning(d, { chain: ['shake'], retriggers: 1 })),
    ]);
    expect(result.insights.find((i) => i.kind === 'mission_effectiveness')).toMatchObject({
      chain: ['math'],
      tone: 'positive',
      metrics: { successRate: 1, uses: 5, runnerUpSuccessRate: 0, runnerUpUses: 5 },
    });
  });
});

describe('sleep vs energy (association only)', () => {
  /** A night ending on `date` at 07:00 after `hours` of sleep, plus that morning's energy. */
  const night = (date: string, hours: number, energy: number) => {
    const end = resolveWallClock(parseLocalDate(date), 7, 0, TZ);
    return {
      session: {
        startedAt: new Date(end.getTime() - hours * 3_600_000).toISOString(),
        endedAt: end.toISOString(),
      },
      checkIn: { date, energy, sleepQuality: null },
    };
  };
  const run = (nights: ReturnType<typeof night>[]) =>
    sleepEnergyAssociation(
      nights.map((n) => n.session),
      nights.map((n) => n.checkIn),
      { now: NOW, timeZone: TZ, desiredSleepMin: 480, days: 42 },
    );

  it('stays silent until both groups have 3 check-ins', () => {
    const result = run([
      night('2026-10-10', 5, 2),
      night('2026-10-11', 5, 2),
      ...days('2026-10-14', 3).map((d) => night(d, 8, 4)),
    ]);
    expect(result).toMatchObject({
      enoughData: false,
      energyDiff: null,
      shortNightCheckIns: 2,
      enoughNightCheckIns: 3,
    });
  });

  it('compares mean energy after short vs enough sleep, with buckets', () => {
    const result = run([
      ...days('2026-10-08', 3).map((d) => night(d, 5.5, 2)),
      ...days('2026-10-14', 4).map((d) => night(d, 7.5, 4)),
    ]);
    expect(result).toMatchObject({
      enoughData: true,
      shortNightThresholdMin: 420,
      avgEnergyShortSleep: 2,
      avgEnergyEnoughSleep: 4,
      energyDiff: 2,
    });
    expect(result.buckets).toEqual([
      { label: '<6h', checkIns: 3, avgEnergy: 2 },
      { label: '6-7h', checkIns: 0, avgEnergy: null },
      { label: '7-8h', checkIns: 4, avgEnergy: 4 },
      { label: '8h+', checkIns: 0, avgEnergy: null },
    ]);
  });

  it('only becomes an insight when the difference is meaningful', () => {
    const nights = [
      ...days('2026-10-08', 3).map((d) => night(d, 5.5, 3)),
      ...days('2026-10-14', 3).map((d) => night(d, 8, 3)),
    ];
    const flat = analyze([], {
      sleepSessions: nights.map((n) => n.session),
      checkIns: nights.map((n) => n.checkIn),
    });
    expect(flat.sleepEnergy.energyDiff).toBe(0);
    expect(flat.insights.some((i) => i.kind === 'sleep_energy')).toBe(false);
  });
});

describe('analyzeWake', () => {
  it('points suggestions at the alarm with the most mornings', () => {
    const result = analyze([
      ...days('2026-10-14', 3).map((d) => morning(d, { alarmId: 'weekday' })),
      morning('2026-10-11', { alarmId: 'weekend' }),
    ]);
    expect(result.primaryAlarmId).toBe('weekday');
    expect(analyze([]).primaryAlarmId).toBeNull();
  });
});
