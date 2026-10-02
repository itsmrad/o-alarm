import { tzOffset } from '@date-fns/tz';

/** 0 = Sunday … 6 = Saturday (matches `Date#getDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** A civil calendar date with no time zone attached. `month` is 1-12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function parseLocalDate(value: string): LocalDate {
  const match = LOCAL_DATE_RE.exec(value);
  if (!match) throw new Error(`Invalid local date "${value}" (expected YYYY-MM-DD)`);
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const roundTrip = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (roundTrip.getUTCMonth() !== date.month - 1 || roundTrip.getUTCDate() !== date.day) {
    throw new Error(`Invalid local date "${value}"`);
  }
  return date;
}

export function isValidLocalDate(value: string): boolean {
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

export function formatLocalDate({ year, month, day }: LocalDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function civilToUtcMs({ year, month, day }: LocalDate): number {
  return Date.UTC(year, month - 1, day);
}

function utcMsToCivil(ms: number): LocalDate {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return utcMsToCivil(civilToUtcMs(date) + days * DAY_MS);
}

export function weekdayOf(date: LocalDate): Weekday {
  return new Date(civilToUtcMs(date)).getUTCDay() as Weekday;
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return civilToUtcMs(a) - civilToUtcMs(b);
}

function offsetMs(timeZone: string, instantMs: number): number {
  const minutes = tzOffset(timeZone, new Date(instantMs));
  if (Number.isNaN(minutes)) throw new Error(`Unknown time zone "${timeZone}"`);
  return minutes * MINUTE_MS;
}

/** The civil date an instant falls on in `timeZone`. */
export function localDateInZone(instant: Date, timeZone: string): LocalDate {
  const ms = instant.getTime();
  return utcMsToCivil(ms + offsetMs(timeZone, ms));
}

/** Wall-clock hour/minute of an instant in `timeZone`. */
export function wallClockInZone(
  instant: Date,
  timeZone: string,
): { date: LocalDate; hour: number; minute: number } {
  const ms = instant.getTime();
  const local = new Date(ms + offsetMs(timeZone, ms));
  return {
    date: { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() },
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
  };
}

/**
 * Resolves a wall-clock time on a civil date in `timeZone` to an instant (D9).
 *
 * - Normal: the unique instant.
 * - DST overlap (fall back, the wall time happens twice): the FIRST occurrence.
 * - DST gap (spring forward, the wall time never happens): the first valid
 *   instant after the gap, i.e. the transition instant.
 */
export function resolveWallClock(
  date: LocalDate,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = civilToUtcMs(date) + (hour * 60 + minute) * MINUTE_MS;
  // Offsets that bracket any transition near this wall time (zones change at most once a day).
  const before = offsetMs(timeZone, naive - DAY_MS);
  const after = offsetMs(timeZone, naive + DAY_MS);
  const candidates = [...new Set([before, after])]
    .map((offset) => naive - offset)
    .filter((instant) => naive - offsetMs(timeZone, instant) === instant)
    .sort((a, b) => a - b);
  if (candidates.length > 0) return new Date(candidates[0]!);

  // Gap: the wall time is skipped. Find the transition instant (first instant on the
  // post-transition offset) between the two candidate interpretations.
  let lo = Math.min(naive - before, naive - after);
  let hi = Math.max(naive - before, naive - after);
  // Invariant: offset(lo) === before, offset(hi) === after. Search at minute resolution.
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.max(1, Math.floor((hi - lo) / 2 / MINUTE_MS)) * MINUTE_MS;
    if (offsetMs(timeZone, mid) === after) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}
