import {
  consistencyScore,
  nightlySummaries,
  recentBedtimes,
  sessionDurationMin,
  summarizeSleep,
  type SleepSessionLike,
} from './sleep-stats';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);

/** Session from `bed` (local EDT, evening before) to `up` (local EDT). */
const session = (start: string, end: string | null): SleepSessionLike => ({
  startedAt: start,
  endedAt: end,
});
// 23:00 EDT → 07:00 EDT
const night = (day: number, bedOffsetMin = 0, wakeOffsetMin = 0) => {
  const d = String(day).padStart(2, '0');
  const start = new Date(Date.parse(`2026-10-${d}T03:00:00Z`) + bedOffsetMin * 60_000);
  const end = new Date(Date.parse(`2026-10-${d}T11:00:00Z`) + wakeOffsetMin * 60_000);
  return session(start.toISOString(), end.toISOString());
};

describe('sessionDurationMin', () => {
  it('is whole minutes for completed sessions', () => {
    expect(sessionDurationMin(night(3))).toBe(480);
  });
  it('is null for open, inverted or implausibly long sessions', () => {
    expect(sessionDurationMin(session('2026-10-03T03:00:00Z', null))).toBeNull();
    expect(sessionDurationMin(session('2026-10-03T11:00:00Z', '2026-10-03T03:00:00Z'))).toBeNull();
    expect(sessionDurationMin(session('2026-10-02T03:00:00Z', '2026-10-03T03:00:00Z'))).toBeNull();
  });
});

describe('consistencyScore', () => {
  it('is 100 for identical bed and wake times', () => {
    expect(consistencyScore([night(1), night(2), night(3)], NY)).toBe(100);
  });
  it('needs at least 3 completed sessions', () => {
    expect(consistencyScore([night(1), night(2)], NY)).toBeNull();
    expect(
      consistencyScore([night(1), night(2), session('2026-10-03T03:00:00Z', null)], NY),
    ).toBeNull();
  });
  it('drops as times scatter, and reaches 0 for very irregular sleep', () => {
    const mild = consistencyScore([night(1, -30, -30), night(2, 30, 30), night(3)], NY)!;
    const wild = consistencyScore(
      [night(1, -240, -240), night(2, 240, 240), night(3, -120, 120), night(4, 180, -180)],
      NY,
    )!;
    expect(mild).toBeLessThan(100);
    expect(mild).toBeGreaterThan(wild);
    expect(wild).toBeLessThanOrEqual(10);
  });
  it('treats 23:50 and 00:10 bedtimes as 20 minutes apart, not 23h 40m', () => {
    const score = consistencyScore([night(1, 50), night(2, 70), night(3, 60)], NY)!;
    expect(score).toBeGreaterThan(90);
  });
});

describe('nightlySummaries', () => {
  const now = at('2026-10-05T14:00:00Z'); // 10:00 EDT, 5 Oct

  it('returns one entry per morning for the window, oldest first, nulls for missing nights', () => {
    const list = nightlySummaries([night(3), night(5)], { now, timeZone: NY, nights: 4 });
    expect(list.map((n) => n.date)).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
    expect(list.map((n) => n.durationMin)).toEqual([null, 480, null, 480]);
    expect(list[1]?.bedtime?.toISOString()).toBe('2026-10-03T03:00:00.000Z');
  });

  it('sums sessions that ended the same morning and ignores open ones', () => {
    const split = [
      session('2026-10-05T03:00:00Z', '2026-10-05T07:00:00Z'), // 4h
      session('2026-10-05T07:30:00Z', '2026-10-05T10:30:00Z'), // 3h
      session('2026-10-05T12:00:00Z', null),
    ];
    const last = nightlySummaries(split, { now, timeZone: NY, nights: 1 })[0]!;
    expect(last.durationMin).toBe(420);
    expect(last.bedtime?.toISOString()).toBe('2026-10-05T03:00:00.000Z');
  });

  it('defaults to 14 nights', () => {
    expect(nightlySummaries([], { now, timeZone: NY })).toHaveLength(14);
  });
});

describe('summarizeSleep', () => {
  const now = at('2026-10-06T14:00:00Z');
  const sessions = [night(2), night(3), night(4, 0, -180), night(5)]; // night 4 → 5h
  const checkIns = [
    { date: '2026-10-02', energy: 4, sleepQuality: 4 },
    { date: '2026-10-03', energy: 5, sleepQuality: 5 },
    { date: '2026-10-04', energy: 2, sleepQuality: 2 },
    { date: '2026-10-05', energy: null, sleepQuality: null }, // skipped
  ];

  it('aggregates durations, times and energy; relates short sleep to energy', () => {
    const s = summarizeSleep(sessions, checkIns, { now, timeZone: NY, desiredSleepMin: 480 });
    expect(s).toMatchObject({
      windowDays: 14,
      nights: 4,
      avgDurationMin: 435,
      avgBedtimeMinuteOfDay: 23 * 60,
      nightsBelowGoal: 1,
      checkIns: 4,
      avgEnergy: 3.7,
      avgSleepQuality: 3.7,
      avgEnergyAfterShortSleep: 2,
      avgEnergyAfterEnoughSleep: 4.5,
    });
    expect(s.consistencyScore).not.toBeNull();
  });

  it('returns nulls, not zeros, when there is no data', () => {
    const s = summarizeSleep([], [], { now, timeZone: NY, desiredSleepMin: 480 });
    expect(s).toMatchObject({
      nights: 0,
      avgDurationMin: null,
      avgBedtimeMinuteOfDay: null,
      consistencyScore: null,
      avgEnergy: null,
      avgEnergyAfterShortSleep: null,
    });
  });

  it('is aggregate-only: no raw timestamps leave the summary', () => {
    const s = summarizeSleep(sessions, checkIns, { now, timeZone: NY, desiredSleepMin: 480 });
    expect(JSON.stringify(s)).not.toMatch(/2026-/);
  });
});

describe('recentBedtimes', () => {
  it('returns the newest completed session starts first', () => {
    const result = recentBedtimes(
      [night(2), night(4), session('2026-10-09T03:00:00Z', null), night(3)],
      2,
    );
    expect(result.map((d) => d.toISOString())).toEqual([
      '2026-10-04T03:00:00.000Z',
      '2026-10-03T03:00:00.000Z',
    ]);
  });
});
