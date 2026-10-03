import { createAlarm, type Alarm } from './alarm';
import { buildNapAlarm } from './sleep-nap';
import {
  DEFAULT_SLEEP_PREFS,
  circularDiffMin,
  circularMeanMinutes,
  isNapAlarm,
  minuteOfDay,
  recommendBedtime,
  upcomingWakeTargets,
  type SleepPrefs,
} from './sleep';
import { computeNextFire } from './recurrence';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => d?.toISOString();
const prefs = (overrides: Partial<SleepPrefs> = {}): SleepPrefs => ({
  ...DEFAULT_SLEEP_PREFS,
  ...overrides,
});
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const;
const alarm = (overrides: Partial<Alarm> = {}) =>
  createAlarm({ id: 'a1', hour: 7, minute: 0, weekdays: [...EVERY_DAY], ...overrides });

describe('recommendBedtime — auto mode', () => {
  const now = at('2026-10-02T20:00:00Z'); // 16:00 EDT
  const wake = at('2026-10-03T11:00:00Z'); // 07:00 EDT

  it('works back from the wake time by desired sleep + latency', () => {
    const rec = recommendBedtime({ now, timeZone: NY, prefs: prefs(), wake });
    expect(rec.status).toBe('ok');
    // 8h + 15min latency before 07:00 → 22:45 EDT
    expect(iso(rec.bedtime)).toBe('2026-10-03T02:45:00.000Z');
    expect(iso(rec.windDownAt)).toBe('2026-10-03T02:00:00.000Z'); // 45 min earlier
    expect(rec.expectedSleepMin).toBe(480);
    expect(rec.shiftMin).toBe(0);
    expect(rec.rationale).toEqual(['from_next_alarm', 'includes_latency', 'no_history']);
  });

  it('latency of zero is not listed as a factor and shifts bedtime later', () => {
    const rec = recommendBedtime({ now, timeZone: NY, prefs: prefs({ latencyMin: 0 }), wake });
    expect(iso(rec.bedtime)).toBe('2026-10-03T03:00:00.000Z');
    expect(rec.rationale).not.toContain('includes_latency');
  });

  it('honors a different desired duration and wind-down lead', () => {
    const rec = recommendBedtime({
      now,
      timeZone: NY,
      prefs: prefs({ desiredSleepMin: 420, windDownMin: 60 }),
      wake,
    });
    expect(iso(rec.bedtime)).toBe('2026-10-03T03:45:00.000Z');
    expect(iso(rec.windDownAt)).toBe('2026-10-03T02:45:00.000Z');
  });

  it('flags a bedtime that has already passed', () => {
    const late = at('2026-10-03T05:00:00Z'); // 01:00 EDT
    const rec = recommendBedtime({ now: late, timeZone: NY, prefs: prefs(), wake });
    expect(rec.rationale).toContain('bedtime_passed');
    expect(iso(rec.bedtime)).toBe('2026-10-03T02:45:00.000Z');
  });

  it('has nothing to compute without an alarm', () => {
    const rec = recommendBedtime({ now, timeZone: NY, prefs: prefs(), wake: null });
    expect(rec).toMatchObject({
      status: 'no_alarm',
      bedtime: null,
      windDownAt: null,
      expectedSleepMin: null,
      rationale: ['no_alarm'],
    });
  });
});

describe('recommendBedtime — DST nights (elapsed time, not wall-clock arithmetic)', () => {
  it('fall back (extra hour): 8h15 of real time before 07:00 is 23:45 the evening before', () => {
    const rec = recommendBedtime({
      now: at('2026-10-31T20:00:00Z'),
      timeZone: NY,
      prefs: prefs(),
      wake: at('2026-11-01T12:00:00Z'), // 07:00 EST on the fall-back morning
    });
    expect(iso(rec.bedtime)).toBe('2026-11-01T03:45:00.000Z'); // 23:45 EDT
    expect(minuteOfDay(rec.bedtime!, NY)).toBe(23 * 60 + 45);
    expect(rec.expectedSleepMin).toBe(480);
  });

  it('spring forward (lost hour): bedtime is earlier on the clock, same real duration', () => {
    const rec = recommendBedtime({
      now: at('2026-03-07T20:00:00Z'),
      timeZone: NY,
      prefs: prefs(),
      wake: at('2026-03-08T11:00:00Z'), // 07:00 EDT on the spring-forward morning
    });
    expect(iso(rec.bedtime)).toBe('2026-03-08T02:45:00.000Z'); // 21:45 EST
    expect(minuteOfDay(rec.bedtime!, NY)).toBe(21 * 60 + 45);
    expect(rec.expectedSleepMin).toBe(480);
  });

  it('consistency compares wall-clock bedtimes across the DST change', () => {
    // Habit: 23:00 local. The DST night's ideal is 21:45 → capped to 22:30 (habit − 30).
    const history = ['2026-03-04', '2026-03-05', '2026-03-06'].map((d) => at(`${d}T04:00:00Z`)); // 23:00 EST
    const rec = recommendBedtime({
      now: at('2026-03-07T20:00:00Z'),
      timeZone: NY,
      prefs: prefs(),
      wake: at('2026-03-08T11:00:00Z'),
      recentBedtimes: history,
    });
    expect(rec.rationale).toContain('shift_capped');
    expect(minuteOfDay(rec.bedtime!, NY)).toBe(22 * 60 + 30);
  });
});

describe('recommendBedtime — consistency cap', () => {
  const now = at('2026-10-02T20:00:00Z');
  const wake = at('2026-10-03T11:00:00Z'); // ideal 22:45 EDT
  // Habitual bedtime: 00:30 local (04:30Z).
  const lateHabit = [1, 2, 3, 4].map((d) => at(`2026-09-${20 + d}T04:30:00Z`));

  it('moves an earlier-than-habit bedtime at most 30 minutes from the recent average', () => {
    const rec = recommendBedtime({
      now,
      timeZone: NY,
      prefs: prefs(),
      wake,
      recentBedtimes: lateHabit,
    });
    expect(rec.idealBedtime && minuteOfDay(rec.idealBedtime, NY)).toBe(22 * 60 + 45);
    expect(minuteOfDay(rec.bedtime!, NY)).toBe(0 * 60 + 0); // 00:30 − 30 = 00:00
    expect(rec.shiftMin).toBe(75);
    expect(rec.rationale).toContain('shift_capped');
    // The honest consequence is surfaced instead of hidden.
    expect(rec.expectedSleepMin).toBe(480 - 75);
    expect(rec.rationale).toContain('sleep_below_goal');
  });

  it('also caps a later-than-habit bedtime (moves earlier, never past the habit + 30)', () => {
    const earlyHabit = [1, 2, 3].map((d) => at(`2026-09-${20 + d}T01:30:00Z`)); // 21:30 EDT
    const rec = recommendBedtime({
      now,
      timeZone: NY,
      prefs: prefs({ desiredSleepMin: 360 }), // ideal 00:45 → 3h15 after the habit
      wake,
      recentBedtimes: earlyHabit,
    });
    expect(minuteOfDay(rec.bedtime!, NY)).toBe(22 * 60); // 21:30 + 30
    expect(rec.shiftMin).toBeLessThan(0);
    expect(rec.rationale).toContain('shift_capped');
    expect(rec.rationale).not.toContain('sleep_below_goal');
  });

  it('leaves the ideal alone when it is within the cap, and says so', () => {
    const habit = [1, 2, 3].map((d) => at(`2026-09-${20 + d}T03:00:00Z`)); // 23:00 EDT
    const rec = recommendBedtime({
      now,
      timeZone: NY,
      prefs: prefs(),
      wake,
      recentBedtimes: habit,
    });
    expect(rec.shiftMin).toBe(0);
    expect(rec.rationale).toContain('aligned_with_history');
    expect(rec.rationale).not.toContain('shift_capped');
  });

  it('ignores history until there are at least 3 bedtimes', () => {
    const rec = recommendBedtime({
      now,
      timeZone: NY,
      prefs: prefs(),
      wake,
      recentBedtimes: lateHabit.slice(0, 2),
    });
    expect(rec.shiftMin).toBe(0);
    expect(rec.rationale).toContain('no_history');
  });

  it('handles habits that straddle midnight (circular mean)', () => {
    const habit = ['T03:50:00Z', 'T04:10:00Z', 'T04:00:00Z'].map((t) => at(`2026-09-21${t}`)); // 23:50–00:10
    const rec = recommendBedtime({
      now,
      timeZone: NY,
      prefs: prefs({ desiredSleepMin: 420 }), // ideal 23:45 → within 30 of 00:00
      wake,
      recentBedtimes: habit,
    });
    expect(rec.shiftMin).toBe(0);
    expect(rec.rationale).toContain('aligned_with_history');
  });

  it('respects a custom cap', () => {
    const rec = recommendBedtime({
      now,
      timeZone: NY,
      prefs: prefs(),
      wake,
      recentBedtimes: lateHabit,
      maxShiftMin: 15,
    });
    expect(minuteOfDay(rec.bedtime!, NY)).toBe(0 * 60 + 15);
  });
});

describe('recommendBedtime — manual mode', () => {
  const manual = prefs({ mode: 'manual', manualBedtime: { hour: 23, minute: 0 } });

  it('uses the chosen clock time before the wake time and reports resulting sleep', () => {
    const rec = recommendBedtime({
      now: at('2026-10-02T20:00:00Z'),
      timeZone: NY,
      prefs: manual,
      wake: at('2026-10-03T11:00:00Z'),
      recentBedtimes: [at('2026-09-20T05:00:00Z')],
    });
    expect(iso(rec.bedtime)).toBe('2026-10-03T03:00:00.000Z'); // 23:00 EDT, history ignored
    expect(rec.idealBedtime).toBeNull();
    expect(rec.expectedSleepMin).toBe(465); // 8h − 15 min latency
    expect(rec.rationale).toEqual(['manual_target', 'sleep_below_goal']);
  });

  it('with no alarm, picks tonight (a bedtime from 30 min ago still counts)', () => {
    const rec = recommendBedtime({
      now: at('2026-10-03T03:30:00Z'), // 23:30 EDT
      timeZone: NY,
      prefs: manual,
      wake: null,
    });
    expect(rec.status).toBe('ok');
    expect(iso(rec.bedtime)).toBe('2026-10-03T03:00:00.000Z');
    expect(rec.expectedSleepMin).toBeNull();
    expect(rec.rationale).toContain('bedtime_passed');
  });

  it('with no alarm, rolls to the next evening once tonight is well over', () => {
    const rec = recommendBedtime({
      now: at('2026-10-03T08:00:00Z'), // 04:00 EDT
      timeZone: NY,
      prefs: manual,
      wake: null,
    });
    expect(iso(rec.bedtime)).toBe('2026-10-04T03:00:00.000Z');
  });
});

describe('upcomingWakeTargets', () => {
  const now = at('2026-10-02T20:00:00Z');

  it('returns the earliest alarm per day and skips disabled, skipped and nap alarms', () => {
    const early = alarm({ id: 'early', hour: 6, minute: 30 });
    const late = alarm({ id: 'late', hour: 7, minute: 30 });
    const off = alarm({ id: 'off', hour: 5, minute: 0, enabled: false });
    const nap = buildNapAlarm(now, 20, NY);
    const targets = upcomingWakeTargets([late, off, early, nap], now, NY, 2);
    expect(targets.map((t) => iso(t.fireAt))).toEqual([
      '2026-10-03T10:30:00.000Z',
      '2026-10-04T10:30:00.000Z',
    ]);
    expect(targets.every((t) => t.alarmId === 'early')).toBe(true);
  });

  it('honors skip-next so a skipped morning is not a bedtime target', () => {
    const a = alarm({ skipNext: 'a1@2026-10-03' });
    expect(upcomingWakeTargets([a], now, NY, 1)[0]?.localDate).toBe('2026-10-04');
  });

  it('is empty with no usable alarms (no-alarm case)', () => {
    expect(upcomingWakeTargets([], now, NY)).toEqual([]);
    expect(upcomingWakeTargets([buildNapAlarm(now, 20, NY)], now, NY)).toEqual([]);
  });
});

describe('nap alarms', () => {
  const now = at('2026-10-02T18:00:20Z'); // 14:00:20 EDT

  it('rings N minutes ahead, rounded up to a whole minute, as a labelled one-time alarm', () => {
    const nap = buildNapAlarm(now, 20, NY);
    expect(isNapAlarm(nap)).toBe(true);
    expect(nap).toMatchObject({ weekdays: [], date: '2026-10-02', hour: 14, minute: 21 });
    expect(nap.snooze.enabled).toBe(false);
    expect(iso(computeNextFire(nap, now, NY)?.fireAt ?? null)).toBe('2026-10-02T18:21:00.000Z');
  });

  it('rolls over midnight', () => {
    const nap = buildNapAlarm(at('2026-10-03T03:50:00Z'), 30, NY); // 23:50 EDT
    expect(nap).toMatchObject({ date: '2026-10-03', hour: 0, minute: 20 });
  });
});

describe('circular helpers', () => {
  it('wraps differences across midnight', () => {
    expect(circularDiffMin(23 * 60 + 50, 10)).toBe(20);
    expect(circularDiffMin(10, 23 * 60 + 50)).toBe(-20);
  });
  it('averages minutes around midnight', () => {
    expect(circularMeanMinutes([23 * 60 + 50, 10])).toBe(0);
    expect(circularMeanMinutes([])).toBeNull();
  });
});
