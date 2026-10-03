import { DEFAULT_SLEEP_PREFS, upcomingWakeTargets, type SleepPrefs } from './sleep';
import { createAlarm } from './alarm';
import {
  DEFAULT_REMINDER_PREFS,
  planReminders,
  shouldPromptCheckInAt,
  type ReminderPrefs,
} from './sleep-reminders';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);
const now = at('2026-10-02T12:00:00Z'); // 08:00 EDT
const alarm = createAlarm({ id: 'a1', hour: 7, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6] });
const targets = upcomingWakeTargets([alarm], now, NY, 3);
const all: ReminderPrefs = {
  bedtime: true,
  windDown: true,
  caffeine: true,
  caffeineCutoffHours: 8,
  morningLight: true,
  morningMovement: true,
};
const plan = (reminderPrefs: ReminderPrefs, prefs: Partial<SleepPrefs> = {}, t = targets) =>
  planReminders({
    now,
    timeZone: NY,
    prefs: { ...DEFAULT_SLEEP_PREFS, ...prefs },
    reminderPrefs,
    targets: t,
    recentBedtimes: [],
  });

describe('planReminders', () => {
  it('plans nothing when every reminder is off (default)', () => {
    expect(plan(DEFAULT_REMINDER_PREFS)).toEqual([]);
  });

  it('plans one reminder per enabled kind per night, soonest first, with stable ids', () => {
    const first = plan(all).filter((r) => r.id.endsWith('2026-10-02'));
    expect(first.map((r) => [r.kind, r.fireAt.toISOString()])).toEqual([
      ['caffeine', '2026-10-02T18:45:00.000Z'], // 8h before 22:45
      ['windDown', '2026-10-03T02:00:00.000Z'],
      ['bedtime', '2026-10-03T02:45:00.000Z'],
      ['morningLight', '2026-10-03T11:10:00.000Z'],
      ['morningMovement', '2026-10-03T11:30:00.000Z'],
    ]);
    expect(first.map((r) => r.id)).toEqual([
      'sleep.caffeine.2026-10-02',
      'sleep.windDown.2026-10-02',
      'sleep.bedtime.2026-10-02',
      'sleep.morningLight.2026-10-02',
      'sleep.morningMovement.2026-10-02',
    ]);
  });

  it('is deterministic: the same inputs give the identical plan', () => {
    expect(plan(all)).toEqual(plan(all));
  });

  it('only includes what is enabled, honoring the caffeine cutoff', () => {
    const list = plan({ ...DEFAULT_REMINDER_PREFS, caffeine: true, caffeineCutoffHours: 10 });
    expect(new Set(list.map((r) => r.kind))).toEqual(new Set(['caffeine']));
    expect(list[0]?.fireAt.toISOString()).toBe('2026-10-02T16:45:00.000Z'); // 10h before 22:45
  });

  it('never schedules reminders in the past or at the alarm time', () => {
    const list = planReminders({
      now: at('2026-10-03T02:30:00Z'), // wind-down already passed tonight
      timeZone: NY,
      prefs: DEFAULT_SLEEP_PREFS,
      reminderPrefs: all,
      targets,
      recentBedtimes: [],
    });
    expect(list.every((r) => r.fireAt.getTime() > at('2026-10-03T02:30:00Z').getTime())).toBe(true);
    expect(list.some((r) => r.id === 'sleep.windDown.2026-10-02')).toBe(false);
    expect(list.some((r) => r.fireAt.getTime() === targets[0]!.fireAt.getTime())).toBe(false);
  });

  it('has no bedtime reminders without an alarm in auto mode (no-alarm case)', () => {
    expect(plan(all, {}, [])).toEqual([]);
  });

  it('manual mode plans the chosen bedtime even with no alarm, and skips morning reminders', () => {
    const list = plan(all, { mode: 'manual', manualBedtime: { hour: 23, minute: 0 } }, []);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map((r) => r.kind))).toEqual(new Set(['bedtime', 'windDown', 'caffeine']));
    expect(list.find((r) => r.kind === 'bedtime')?.fireAt.toISOString()).toBe(
      '2026-10-03T03:00:00.000Z',
    );
  });

  it('manual mode attaches the next alarm for morning reminders', () => {
    const list = plan(all, { mode: 'manual', manualBedtime: { hour: 23, minute: 0 } });
    expect(list.find((r) => r.kind === 'morningLight')?.fireAt.toISOString()).toBe(
      '2026-10-03T11:10:00.000Z',
    );
  });

  it('plans at most 3 nights', () => {
    const nights = new Set(plan(all).map((r) => r.id.split('.')[2]));
    expect(nights.size).toBeLessThanOrEqual(3);
  });
});

describe('shouldPromptCheckInAt', () => {
  it('prompts on a morning with no entry yet', () => {
    expect(
      shouldPromptCheckInAt({
        now: at('2026-10-03T11:30:00Z'),
        timeZone: NY,
        hasEntryToday: false,
      }),
    ).toBe(true);
  });
  it('does not prompt again once answered or skipped', () => {
    expect(
      shouldPromptCheckInAt({ now: at('2026-10-03T11:30:00Z'), timeZone: NY, hasEntryToday: true }),
    ).toBe(false);
  });
  it('does not prompt in the evening or the dead of night', () => {
    expect(
      shouldPromptCheckInAt({
        now: at('2026-10-03T23:00:00Z'),
        timeZone: NY,
        hasEntryToday: false,
      }),
    ).toBe(false); // 19:00
    expect(
      shouldPromptCheckInAt({
        now: at('2026-10-03T05:00:00Z'),
        timeZone: NY,
        hasEntryToday: false,
      }),
    ).toBe(false); // 01:00
  });
});
