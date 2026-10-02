import { canSnooze, nextSnooze, remainingSnoozes, snoozeScheduleId } from './snooze';

const policy = { enabled: true, durationMin: 9, maxCount: 2 };

describe('snooze policy', () => {
  it('counts remaining snoozes and stops at the limit', () => {
    expect(remainingSnoozes(policy, 0)).toBe(2);
    expect(remainingSnoozes(policy, 2)).toBe(0);
    expect(remainingSnoozes(policy, 5)).toBe(0);
    expect(canSnooze(policy, 1)).toBe(true);
    expect(canSnooze(policy, 2)).toBe(false);
  });

  it('disabled or zero-count policies never allow snooze', () => {
    expect(canSnooze({ ...policy, enabled: false }, 0)).toBe(false);
    expect(canSnooze({ ...policy, maxCount: 0 }, 0)).toBe(false);
    expect(nextSnooze({ ...policy, enabled: false }, 0, new Date())).toBeNull();
  });

  it('schedules the next snooze as an absolute instant', () => {
    const now = new Date('2026-10-02T11:00:00Z');
    expect(nextSnooze(policy, 0, now)).toEqual({
      fireAt: new Date('2026-10-02T11:09:00Z'),
      snoozesUsed: 1,
      remaining: 1,
    });
    expect(nextSnooze(policy, 1, now)?.remaining).toBe(0);
    expect(nextSnooze(policy, 2, now)).toBeNull();
  });

  it('a snooze across a DST transition is exactly durationMin later', () => {
    // 2026-11-01 05:55Z = 01:55 EDT, the clock falls back at 06:00Z.
    const now = new Date('2026-11-01T05:55:00Z');
    expect(nextSnooze(policy, 0, now)?.fireAt.toISOString()).toBe('2026-11-01T06:04:00.000Z');
  });

  it('derives deterministic schedule ids', () => {
    expect(snoozeScheduleId('a1@2026-10-02', 2)).toBe('a1@2026-10-02#snooze-2');
  });
});
