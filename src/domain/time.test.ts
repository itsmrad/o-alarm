import {
  addDays,
  formatLocalDate,
  isValidTimeZone,
  localDateInZone,
  parseLocalDate,
  resolveWallClock,
  wallClockInZone,
  weekdayOf,
} from './time';

const NY = 'America/New_York';

describe('local dates', () => {
  it('parses, formats and validates', () => {
    expect(parseLocalDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
    expect(formatLocalDate({ year: 2026, month: 3, day: 1 })).toBe('2026-03-01');
    expect(() => parseLocalDate('2026-02-30')).toThrow();
    expect(() => parseLocalDate('26-2-3')).toThrow();
  });

  it('adds days across month/year boundaries and leap days', () => {
    expect(formatLocalDate(addDays(parseLocalDate('2028-02-28'), 1))).toBe('2028-02-29');
    expect(formatLocalDate(addDays(parseLocalDate('2026-12-31'), 1))).toBe('2027-01-01');
  });

  it('computes weekdays', () => {
    expect(weekdayOf(parseLocalDate('2026-10-02'))).toBe(5); // Friday
    expect(weekdayOf(parseLocalDate('2026-10-04'))).toBe(0); // Sunday
  });

  it('validates time zones', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('finds the civil date of an instant in a zone', () => {
    const instant = new Date('2026-10-02T23:30:00Z');
    expect(formatLocalDate(localDateInZone(instant, 'UTC'))).toBe('2026-10-02');
    expect(formatLocalDate(localDateInZone(instant, 'Asia/Tokyo'))).toBe('2026-10-03');
    expect(formatLocalDate(localDateInZone(instant, NY))).toBe('2026-10-02');
  });
});

describe('resolveWallClock (D9)', () => {
  it('resolves an ordinary wall time', () => {
    expect(resolveWallClock(parseLocalDate('2026-07-01'), 7, 0, NY).toISOString()).toBe(
      '2026-07-01T11:00:00.000Z',
    );
  });

  it('DST gap: fires at the first valid instant after the gap', () => {
    // 2026-03-08 02:00 EST → 03:00 EDT: 02:30 never happens.
    const fire = resolveWallClock(parseLocalDate('2026-03-08'), 2, 30, NY);
    expect(fire.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(wallClockInZone(fire, NY)).toMatchObject({ hour: 3, minute: 0 });
  });

  it('DST gap edge: the first minute of the gap and the first valid minute', () => {
    expect(resolveWallClock(parseLocalDate('2026-03-08'), 2, 0, NY).toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    expect(resolveWallClock(parseLocalDate('2026-03-08'), 3, 0, NY).toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    expect(resolveWallClock(parseLocalDate('2026-03-08'), 1, 59, NY).toISOString()).toBe(
      '2026-03-08T06:59:00.000Z',
    );
  });

  it('DST overlap: fires at the first occurrence', () => {
    // 2026-11-01 02:00 EDT → 01:00 EST: 01:30 happens twice; EDT one is first.
    expect(resolveWallClock(parseLocalDate('2026-11-01'), 1, 30, NY).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('handles European transitions and half-hour zones', () => {
    // London spring forward 2026-03-29 01:00 GMT → 02:00 BST.
    expect(
      resolveWallClock(parseLocalDate('2026-03-29'), 1, 15, 'Europe/London').toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
    // London fall back 2026-10-25 02:00 BST → 01:00 GMT; 01:30 first = BST.
    expect(
      resolveWallClock(parseLocalDate('2026-10-25'), 1, 30, 'Europe/London').toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
    expect(resolveWallClock(parseLocalDate('2026-10-02'), 7, 0, 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-02T01:30:00.000Z',
    );
  });

  it('throws for an unknown zone instead of guessing', () => {
    expect(() => resolveWallClock(parseLocalDate('2026-10-02'), 7, 0, 'Nope/Zone')).toThrow();
  });
});
