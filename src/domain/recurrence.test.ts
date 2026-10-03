import { createAlarm, type Alarm } from './alarm';
import {
  clearOneOffOverride,
  computeNextFire,
  nextAlarmOccurrence,
  nextDateForTime,
  occurrenceKey,
  pruneTransientState,
  setOneOffOverride,
  toggleSkipNext,
  upcomingOccurrences,
} from './recurrence';
import type { Weekday } from './time';

const NY = 'America/New_York';
const LONDON = 'Europe/London';
const at = (iso: string) => new Date(iso);
const iso = (d: Date | undefined) => d?.toISOString();

const MON_FRI: Weekday[] = [1, 2, 3, 4, 5];
const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

function alarm(overrides: Partial<Alarm> = {}): Alarm {
  return createAlarm({ id: 'a1', hour: 7, minute: 0, weekdays: EVERY_DAY, ...overrides });
}

describe('computeNextFire', () => {
  it('returns later today when the time has not passed', () => {
    const next = computeNextFire(alarm(), at('2026-10-02T10:00:00Z'), NY); // 06:00 EDT
    expect(iso(next?.fireAt)).toBe('2026-10-02T11:00:00.000Z');
    expect(next?.occurrenceKey).toBe('a1@2026-10-02');
    expect(next?.localDate).toBe('2026-10-02');
  });

  it('rolls to tomorrow when today has passed, and never returns `now` itself', () => {
    const now = at('2026-10-02T11:00:00Z'); // exactly 07:00 EDT
    expect(iso(computeNextFire(alarm(), now, NY)?.fireAt)).toBe('2026-10-03T11:00:00.000Z');
  });

  it('weekday rollover: Friday evening → Monday for a weekday alarm', () => {
    const next = computeNextFire(alarm({ weekdays: MON_FRI }), at('2026-10-02T22:00:00Z'), NY);
    expect(next?.localDate).toBe('2026-10-05'); // Monday
    expect(iso(next?.fireAt)).toBe('2026-10-05T11:00:00.000Z');
  });

  it('weekday rollover across a week boundary: Saturday-only alarm on Sunday', () => {
    const next = computeNextFire(alarm({ weekdays: [6] }), at('2026-10-04T12:00:00Z'), NY);
    expect(next?.localDate).toBe('2026-10-10');
  });

  it('uses the local date, not the UTC date, near midnight', () => {
    // 2026-10-02 23:30 in New York is already 2026-10-03 in UTC.
    const next = computeNextFire(alarm({ hour: 23, minute: 45 }), at('2026-10-03T03:30:00Z'), NY);
    expect(next?.localDate).toBe('2026-10-02');
    expect(iso(next?.fireAt)).toBe('2026-10-03T03:45:00.000Z');
  });

  it('one-time alarm in the future fires on its date', () => {
    const a = alarm({ weekdays: [], date: '2026-10-05', hour: 6, minute: 30 });
    expect(iso(computeNextFire(a, at('2026-10-02T12:00:00Z'), NY)?.fireAt)).toBe(
      '2026-10-05T10:30:00.000Z',
    );
  });

  it('one-time alarm in the past never fires', () => {
    const a = alarm({ weekdays: [], date: '2026-10-01' });
    expect(computeNextFire(a, at('2026-10-02T12:00:00Z'), NY)).toBeNull();
    const today = alarm({ weekdays: [], date: '2026-10-02', hour: 7 });
    expect(computeNextFire(today, at('2026-10-02T12:00:00Z'), NY)).toBeNull();
  });

  it('disabled alarms never fire', () => {
    expect(computeNextFire(alarm({ enabled: false }), at('2026-10-02T00:00:00Z'), NY)).toBeNull();
  });

  describe('DST', () => {
    it('spring-forward gap: 02:30 alarm fires at 03:00 EDT that day, 02:30 the next', () => {
      const a = alarm({ hour: 2, minute: 30 });
      const [gapDay, nextDay] = upcomingOccurrences(a, at('2026-03-08T05:00:00Z'), NY, 2);
      expect(iso(gapDay?.fireAt)).toBe('2026-03-08T07:00:00.000Z');
      expect(gapDay?.localDate).toBe('2026-03-08');
      expect(iso(nextDay?.fireAt)).toBe('2026-03-09T06:30:00.000Z');
    });

    it('spring-forward: a 07:00 alarm keeps 07:00 local (offset changes)', () => {
      const a = alarm();
      const [before, after] = upcomingOccurrences(a, at('2026-03-07T00:00:00Z'), NY, 2);
      expect(iso(before?.fireAt)).toBe('2026-03-07T12:00:00.000Z'); // EST
      expect(iso(after?.fireAt)).toBe('2026-03-08T11:00:00.000Z'); // EDT
    });

    it('fall-back overlap: 01:30 alarm fires once, at the first 01:30', () => {
      const a = alarm({ hour: 1, minute: 30 });
      const occurrences = upcomingOccurrences(a, at('2026-11-01T04:00:00Z'), NY, 2);
      expect(occurrences.map((o) => iso(o.fireAt))).toEqual([
        '2026-11-01T05:30:00.000Z',
        '2026-11-02T06:30:00.000Z',
      ]);
    });

    it('fall-back overlap: after the first 01:30 has rung, the repeat 01:30 does not ring', () => {
      const a = alarm({ hour: 1, minute: 30 });
      // 06:15Z = 01:15 EST, inside the repeated hour, after the first 01:30 EDT.
      const next = computeNextFire(a, at('2026-11-01T06:15:00Z'), NY);
      expect(next?.localDate).toBe('2026-11-02');
    });
  });

  describe('time zone policy', () => {
    it('floating alarm follows the device zone after a tz change', () => {
      const a = alarm();
      const now = at('2026-10-02T05:00:00Z');
      expect(iso(computeNextFire(a, now, NY)?.fireAt)).toBe('2026-10-02T11:00:00.000Z');
      expect(iso(computeNextFire(a, now, LONDON)?.fireAt)).toBe('2026-10-02T06:00:00.000Z');
      expect(computeNextFire(a, now, LONDON)?.timeZone).toBe(LONDON);
    });

    it('fixed alarm keeps its zone regardless of the device zone', () => {
      const a = alarm({ timezonePolicy: 'fixed', timeZone: NY });
      const now = at('2026-10-02T05:00:00Z');
      expect(iso(computeNextFire(a, now, LONDON)?.fireAt)).toBe('2026-10-02T11:00:00.000Z');
      expect(iso(computeNextFire(a, now, 'Asia/Tokyo')?.fireAt)).toBe('2026-10-02T11:00:00.000Z');
    });

    it('tz change across the date line moves the local date', () => {
      // 2026-10-02T20:00Z is Oct 2 in NY (16:00) but Oct 3 in Tokyo (05:00).
      const now = at('2026-10-02T20:00:00Z');
      expect(computeNextFire(alarm(), now, NY)?.localDate).toBe('2026-10-03');
      const tokyo = computeNextFire(alarm(), now, 'Asia/Tokyo');
      expect(tokyo?.localDate).toBe('2026-10-03');
      expect(iso(tokyo?.fireAt)).toBe('2026-10-02T22:00:00.000Z');
    });
  });
});

describe('skip next', () => {
  const now = at('2026-10-02T05:00:00Z'); // Fri 01:00 EDT

  it('skips exactly the next occurrence, then resumes', () => {
    const skipped = toggleSkipNext(alarm({ weekdays: MON_FRI }), now, NY);
    expect(skipped.skipNext).toBe('a1@2026-10-02');
    const [first, second] = upcomingOccurrences(skipped, now, NY, 2);
    expect(first?.localDate).toBe('2026-10-05');
    expect(second?.localDate).toBe('2026-10-06');
  });

  it('toggling again un-skips', () => {
    const a = toggleSkipNext(toggleSkipNext(alarm(), now, NY), now, NY);
    expect(a.skipNext).toBeNull();
    expect(computeNextFire(a, now, NY)?.localDate).toBe('2026-10-02');
  });

  it('a skip on a one-time alarm leaves it with no occurrence', () => {
    const a = toggleSkipNext(alarm({ weekdays: [], date: '2026-10-03' }), now, NY);
    expect(computeNextFire(a, now, NY)).toBeNull();
  });

  it('stale skip markers are pruned and do not affect future occurrences', () => {
    const a = alarm({ skipNext: occurrenceKey('a1', '2026-09-30') });
    expect(computeNextFire(a, now, NY)?.localDate).toBe('2026-10-02');
    expect(pruneTransientState(a, now, NY).skipNext).toBeNull();
    const current = alarm({ skipNext: occurrenceKey('a1', '2026-10-02') });
    expect(pruneTransientState(current, now, NY).skipNext).toBe('a1@2026-10-02');
  });
});

describe('one-off override', () => {
  const now = at('2026-10-02T05:00:00Z'); // Fri 01:00 EDT

  it('changes only the next occurrence time', () => {
    const a = setOneOffOverride(alarm(), now, NY, { hour: 5, minute: 45 });
    expect(a.oneOffOverride).toEqual({ occurrenceKey: 'a1@2026-10-02', hour: 5, minute: 45 });
    const [first, second] = upcomingOccurrences(a, now, NY, 2);
    expect(iso(first?.fireAt)).toBe('2026-10-02T09:45:00.000Z');
    expect(first?.overridden).toBe(true);
    expect(first?.occurrenceKey).toBe('a1@2026-10-02');
    expect(iso(second?.fireAt)).toBe('2026-10-03T11:00:00.000Z');
    expect(second?.overridden).toBe(false);
  });

  it('can move the occurrence later on the same date', () => {
    const a = setOneOffOverride(alarm(), now, NY, { hour: 9, minute: 15 });
    expect(iso(computeNextFire(a, now, NY)?.fireAt)).toBe('2026-10-02T13:15:00.000Z');
  });

  it('targets the next non-skipped occurrence', () => {
    const skipped = toggleSkipNext(alarm(), now, NY);
    const a = setOneOffOverride(skipped, now, NY, { hour: 8, minute: 0 });
    expect(a.oneOffOverride?.occurrenceKey).toBe('a1@2026-10-03');
  });

  it('rejects an override time that has already passed', () => {
    const lateNow = at('2026-10-02T10:30:00Z'); // 06:30 EDT, next is 07:00 today
    expect(() => setOneOffOverride(alarm(), lateNow, NY, { hour: 6, minute: 0 })).toThrow();
  });

  it('clears', () => {
    const a = clearOneOffOverride(setOneOffOverride(alarm(), now, NY, { hour: 5, minute: 0 }));
    expect(computeNextFire(a, now, NY)?.overridden).toBe(false);
  });

  it('override into a DST gap follows the gap rule', () => {
    const a = setOneOffOverride(alarm(), at('2026-03-08T05:00:00Z'), NY, { hour: 2, minute: 15 });
    expect(iso(computeNextFire(a, at('2026-03-08T05:00:00Z'), NY)?.fireAt)).toBe(
      '2026-03-08T07:00:00.000Z',
    );
  });
});

describe('occurrence keys and multi-alarm', () => {
  it('keys are stable across edits of the time', () => {
    const now = at('2026-10-02T05:00:00Z');
    const before = computeNextFire(alarm({ hour: 7 }), now, NY);
    const after = computeNextFire(alarm({ hour: 8 }), now, NY);
    expect(before?.occurrenceKey).toBe(after?.occurrenceKey);
    expect(before?.fireAt).not.toEqual(after?.fireAt);
  });

  it('nextAlarmOccurrence picks the soonest enabled alarm', () => {
    const now = at('2026-10-02T05:00:00Z');
    const next = nextAlarmOccurrence(
      [
        alarm({ id: 'late', hour: 9 }),
        alarm({ id: 'off', hour: 2, enabled: false }),
        alarm({ id: 'soon', hour: 6 }),
      ],
      now,
      NY,
    );
    expect(next?.alarmId).toBe('soon');
    expect(nextAlarmOccurrence([], now, NY)).toBeNull();
  });

  it('upcomingOccurrences returns ordered occurrences up to the limit', () => {
    const list = upcomingOccurrences(
      alarm({ weekdays: [1, 3] }),
      at('2026-10-02T05:00:00Z'),
      NY,
      4,
    );
    expect(list.map((o) => o.localDate)).toEqual([
      '2026-10-05',
      '2026-10-07',
      '2026-10-12',
      '2026-10-14',
    ]);
  });
});

describe('nextDateForTime', () => {
  it('picks today when the time is ahead, tomorrow otherwise', () => {
    const now = at('2026-10-02T12:00:00Z'); // 08:00 EDT
    expect(nextDateForTime(9, 0, now, NY)).toBe('2026-10-02');
    expect(nextDateForTime(8, 0, now, NY)).toBe('2026-10-03');
    expect(nextDateForTime(7, 0, now, NY)).toBe('2026-10-03');
  });
});
