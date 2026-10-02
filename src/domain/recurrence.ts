import type { Alarm } from './alarm';
import {
  addDays,
  compareLocalDates,
  formatLocalDate,
  localDateInZone,
  parseLocalDate,
  resolveWallClock,
  weekdayOf,
  type LocalDate,
} from './time';

/** One concrete, schedulable ring of an alarm. */
export interface Occurrence {
  alarmId: string;
  /** Stable id for this occurrence: survives edits, overrides, DST and tz changes. */
  occurrenceKey: string;
  /** Civil date of the occurrence in `timeZone` (YYYY-MM-DD). */
  localDate: string;
  /** Effective wall-clock time (override applied). */
  hour: number;
  minute: number;
  timeZone: string;
  fireAt: Date;
  overridden: boolean;
}

/** D10: occurrences are keyed by alarm id + civil date, so re-planning is idempotent. */
export function occurrenceKey(alarmId: string, localDate: string): string {
  return `${alarmId}@${localDate}`;
}

export function effectiveTimeZone(
  alarm: Pick<Alarm, 'timezonePolicy' | 'timeZone'>,
  deviceTimeZone: string,
): string {
  return alarm.timezonePolicy === 'fixed' && alarm.timeZone ? alarm.timeZone : deviceTimeZone;
}

interface ScanOptions {
  /** Ignore `skipNext` (used to find the occurrence a skip/override should target). */
  ignoreSkip?: boolean;
  /** Ignore `oneOffOverride`. */
  ignoreOverride?: boolean;
}

/** Days scanned for recurring alarms; a weekly rule always matches within 8 days (+1 skip). */
const MAX_SCAN_DAYS = 15;

function* candidateDates(alarm: Alarm, today: LocalDate): Generator<LocalDate> {
  if (alarm.weekdays.length === 0) {
    if (alarm.date === null) return;
    const date = parseLocalDate(alarm.date);
    if (compareLocalDates(date, today) >= 0) yield date;
    return;
  }
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const date = addDays(today, i);
    if (alarm.weekdays.includes(weekdayOf(date))) yield date;
  }
}

function* scan(
  alarm: Alarm,
  now: Date,
  deviceTimeZone: string,
  options: ScanOptions = {},
): Generator<Occurrence> {
  const timeZone = effectiveTimeZone(alarm, deviceTimeZone);
  const today = localDateInZone(now, timeZone);
  // Start one day early: an override on yesterday's date can never be in the future,
  // but this keeps the scan correct for zones whose transitions cross midnight.
  for (const date of candidateDates(alarm, addDays(today, -1))) {
    const localDate = formatLocalDate(date);
    const key = occurrenceKey(alarm.id, localDate);
    if (!options.ignoreSkip && alarm.skipNext === key) continue;
    const override =
      !options.ignoreOverride && alarm.oneOffOverride?.occurrenceKey === key
        ? alarm.oneOffOverride
        : null;
    const hour = override ? override.hour : alarm.hour;
    const minute = override ? override.minute : alarm.minute;
    const fireAt = resolveWallClock(date, hour, minute, timeZone);
    if (fireAt.getTime() <= now.getTime()) continue;
    yield {
      alarmId: alarm.id,
      occurrenceKey: key,
      localDate,
      hour,
      minute,
      timeZone,
      fireAt,
      overridden: override !== null,
    };
  }
}

/**
 * Next occurrences strictly after `now`, in chronological order, honoring
 * skip-next and the one-off override. Disabled alarms have none.
 */
export function upcomingOccurrences(
  alarm: Alarm,
  now: Date,
  deviceTimeZone: string,
  limit: number,
): Occurrence[] {
  if (!alarm.enabled || limit <= 0) return [];
  const result: Occurrence[] = [];
  for (const occurrence of scan(alarm, now, deviceTimeZone)) {
    result.push(occurrence);
    if (result.length >= limit) break;
  }
  return result.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

/** The next instant this alarm will ring, or null (disabled / one-time in the past). */
export function computeNextFire(
  alarm: Alarm,
  now: Date,
  deviceTimeZone: string,
): Occurrence | null {
  return upcomingOccurrences(alarm, now, deviceTimeZone, 1)[0] ?? null;
}

/** Soonest occurrence across alarms (the Home "next alarm"). */
export function nextAlarmOccurrence(
  alarms: readonly Alarm[],
  now: Date,
  deviceTimeZone: string,
): Occurrence | null {
  let best: Occurrence | null = null;
  for (const alarm of alarms) {
    const next = computeNextFire(alarm, now, deviceTimeZone);
    if (next && (!best || next.fireAt < best.fireAt)) best = next;
  }
  return best;
}

function nextBaseOccurrence(alarm: Alarm, now: Date, deviceTimeZone: string): Occurrence | null {
  return scan(alarm, now, deviceTimeZone, { ignoreSkip: true }).next().value ?? null;
}

/** Skip the next upcoming occurrence (recurring alarms). Calling again un-skips it. */
export function toggleSkipNext(alarm: Alarm, now: Date, deviceTimeZone: string): Alarm {
  const next = nextBaseOccurrence(alarm, now, deviceTimeZone);
  if (!next) return { ...alarm, skipNext: null };
  return { ...alarm, skipNext: alarm.skipNext === next.occurrenceKey ? null : next.occurrenceKey };
}

/**
 * Temporarily change the time of the next occurrence only. The override is bound to
 * that occurrence's key, so following occurrences keep the regular time.
 */
export function setOneOffOverride(
  alarm: Alarm,
  now: Date,
  deviceTimeZone: string,
  time: { hour: number; minute: number },
): Alarm {
  const next = scan(alarm, now, deviceTimeZone, { ignoreOverride: true }).next().value;
  if (!next) throw new Error('This alarm has no upcoming occurrence to change');
  const fireAt = resolveWallClock(
    parseLocalDate(next.localDate),
    time.hour,
    time.minute,
    next.timeZone,
  );
  if (fireAt.getTime() <= now.getTime()) {
    throw new Error('That time has already passed for the next occurrence');
  }
  return { ...alarm, oneOffOverride: { occurrenceKey: next.occurrenceKey, ...time } };
}

export function clearOneOffOverride(alarm: Alarm): Alarm {
  return { ...alarm, oneOffOverride: null };
}

/** Drop skip/override markers whose occurrence date has passed (housekeeping). */
export function pruneTransientState(alarm: Alarm, now: Date, deviceTimeZone: string): Alarm {
  const today = formatLocalDate(localDateInZone(now, effectiveTimeZone(alarm, deviceTimeZone)));
  // Keys end in a YYYY-MM-DD date, which compares correctly as a string.
  const isPast = (key: string | null | undefined) =>
    key != null && key.slice(key.lastIndexOf('@') + 1) < today;
  return {
    ...alarm,
    skipNext: isPast(alarm.skipNext) ? null : alarm.skipNext,
    oneOffOverride: isPast(alarm.oneOffOverride?.occurrenceKey) ? null : alarm.oneOffOverride,
  };
}
