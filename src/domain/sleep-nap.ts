import { createAlarm, type Alarm } from './alarm';
import { NAP_LABEL } from './sleep';
import { formatLocalDate, wallClockInZone } from './time';

export const NAP_MINUTES = [10, 20, 30, 45, 90] as const;

/**
 * A one-time alarm `minutes` from now, rounded UP to the next whole minute (alarms have
 * minute precision, and rounding down could land in the past). Saved through the normal
 * alarm write path; it is a plain alarm, never a notification.
 */
export function buildNapAlarm(now: Date, minutes: number, timeZone: string): Alarm {
  const target = new Date(Math.ceil((now.getTime() + minutes * 60_000) / 60_000) * 60_000);
  const { date, hour, minute } = wallClockInZone(target, timeZone);
  return createAlarm({
    id: `nap-${target.getTime()}`,
    hour,
    minute,
    date: formatLocalDate(date),
    label: NAP_LABEL,
    // A nap that snoozes is no longer a nap.
    snooze: { enabled: false, durationMin: 9, maxCount: 0 },
  });
}
