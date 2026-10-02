import {
  describeRepeat,
  formatClock,
  formatClockString,
  formatCountdown,
  formatRelativeDay,
} from './format';

const NY = 'America/New_York';
const now = new Date('2026-10-02T05:00:00Z'); // Fri 01:00 EDT

describe('alarm formatting', () => {
  it('formats clock times per locale', () => {
    expect(formatClock(7, 5, 'en-US')).toEqual({ time: '7:05', period: 'AM' });
    expect(formatClockString(19, 30, 'en-US')).toBe('7:30 PM');
    expect(formatClock(19, 30, 'en-GB')).toEqual({ time: '19:30', period: '' });
  });

  it('describes repeat rules', () => {
    expect(describeRepeat({ weekdays: [1, 2, 3, 4, 5], date: null }, now, NY)).toBe('Weekdays');
    expect(describeRepeat({ weekdays: [0, 6], date: null }, now, NY)).toBe('Weekends');
    expect(describeRepeat({ weekdays: [0, 1, 2, 3, 4, 5, 6], date: null }, now, NY)).toBe(
      'Every day',
    );
    expect(describeRepeat({ weekdays: [0, 1, 3], date: null }, now, NY)).toBe('Mon, Wed, Sun');
    expect(describeRepeat({ weekdays: [], date: '2026-10-02' }, now, NY)).toBe('Today');
    expect(describeRepeat({ weekdays: [], date: '2026-10-03' }, now, NY)).toBe('Tomorrow');
    expect(describeRepeat({ weekdays: [], date: '2026-10-01' }, now, NY)).toBe('Once (passed)');
  });

  it('formats countdowns', () => {
    expect(formatCountdown(30_000)).toBe('in less than a minute');
    expect(formatCountdown(45 * 60_000)).toBe('in 45 min');
    expect(formatCountdown((7 * 60 + 12) * 60_000)).toBe('in 7 hr 12 min');
    expect(formatCountdown(3 * 60 * 60_000)).toBe('in 3 hr');
    expect(formatCountdown((26 * 60 + 5) * 60_000)).toBe('in 1 day 2 hr');
  });

  it('formats the relative day in the alarm zone', () => {
    expect(formatRelativeDay(new Date('2026-10-02T11:00:00Z'), now, NY)).toBe('Today');
    expect(formatRelativeDay(new Date('2026-10-03T11:00:00Z'), now, NY)).toBe('Tomorrow');
    expect(formatRelativeDay(new Date('2026-10-05T11:00:00Z'), now, NY)).toBe('Monday');
  });
});
