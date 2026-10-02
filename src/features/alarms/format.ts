import {
  compareLocalDates,
  localDateInZone,
  parseLocalDate,
  type Alarm,
  type Weekday,
} from '@/domain';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
/** Display order Monday-first. */
export const WEEKDAY_ORDER: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];

export function weekdayShort(day: Weekday): string {
  return WEEKDAY_SHORT[day];
}

/** "7:05" + "AM" (or "07:05" + "" in 24h locales). */
export function formatClock(
  hour: number,
  minute: number,
  locale?: string,
): { time: string; period: string } {
  const date = new Date(Date.UTC(2000, 0, 1, hour, minute));
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).formatToParts(date);
    const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
    const time = parts
      .filter((p) => p.type !== 'dayPeriod')
      .map((p) => p.value)
      .join('')
      .trim();
    return { time, period };
  } catch {
    return { time: `${hour}:${String(minute).padStart(2, '0')}`, period: '' };
  }
}

export function formatClockString(hour: number, minute: number, locale?: string): string {
  const { time, period } = formatClock(hour, minute, locale);
  return period ? `${time} ${period}` : time;
}

export function describeRepeat(
  alarm: Pick<Alarm, 'weekdays' | 'date'>,
  now: Date,
  timeZone: string,
): string {
  const days = [...alarm.weekdays].sort();
  if (days.length === 0) {
    if (!alarm.date) return 'Once';
    const diff = Math.round(
      compareLocalDates(parseLocalDate(alarm.date), localDateInZone(now, timeZone)) / 86_400_000,
    );
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff < 0) return 'Once (passed)';
    return `Once, ${alarm.date}`;
  }
  if (days.length === 7) return 'Every day';
  const key = days.join('');
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  return WEEKDAY_ORDER.filter((d) => days.includes(d))
    .map(weekdayShort)
    .join(', ');
}

/** "in 7 hr 12 min", "in 45 min", "in less than a minute". */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.ceil(ms / 60_000);
  if (ms <= 0) return 'now';
  if (totalMinutes <= 1 && ms < 60_000) return 'in less than a minute';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours) parts.push(`${hours} hr`);
  if (minutes && !days) parts.push(`${minutes} min`);
  return `in ${parts.join(' ')}`;
}

/** "Today", "Tomorrow" or weekday name for an instant in a zone. */
export function formatRelativeDay(instant: Date, now: Date, timeZone: string): string {
  const diff = Math.round(
    compareLocalDates(localDateInZone(instant, timeZone), localDateInZone(now, timeZone)) /
      86_400_000,
  );
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  const weekday = new Date(instant.getTime());
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone }).format(weekday);
  } catch {
    return weekdayShort(weekday.getDay() as Weekday);
  }
}
