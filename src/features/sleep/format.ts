import { formatLocalDate, localDateInZone, parseLocalDate, wallClockInZone } from '@/domain/time';
import type { BedtimeRationale, BedtimeRecommendation, SleepPrefs } from '@/domain/sleep';
import { formatClockString } from '@/features/alarms/format';

/** "7 hr 30 min", "45 min", "8 hr". */
export function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** Wall-clock time of an instant in `timeZone`, locale formatted ("10:45 PM"). */
export function formatTime(instant: Date, timeZone: string): string {
  const { hour, minute } = wallClockInZone(instant, timeZone);
  return formatClockString(hour, minute);
}

export function formatMinuteOfDay(minute: number): string {
  return formatClockString(Math.floor(minute / 60), minute % 60);
}

/** "Mon 29" for a civil date. */
export function formatNightLabel(date: string): string {
  const { year, month, day } = parseLocalDate(date);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
  return `${weekday} ${day}`;
}

export const todayCivil = (now: Date, timeZone: string): string =>
  formatLocalDate(localDateInZone(now, timeZone));

export function describeConsistency(score: number | null): string {
  if (score === null) return 'Log 3 nights to see how regular your sleep is.';
  if (score >= 80) return 'Very regular bed and wake times.';
  if (score >= 60) return 'Fairly regular. A steadier bedtime would help.';
  return 'Irregular. Aim for similar times each day.';
}

/** Plain-language reasons behind a recommendation (the codes come from the domain). */
export function describeRationale(
  code: BedtimeRationale,
  rec: BedtimeRecommendation,
  prefs: SleepPrefs,
  timeZone: string,
): string {
  switch (code) {
    case 'from_next_alarm':
      return rec.wakeAt
        ? `Works back from your ${formatTime(rec.wakeAt, timeZone)} alarm.`
        : 'Works back from your next alarm.';
    case 'includes_latency':
      return `Allows ${prefs.latencyMin} min to fall asleep.`;
    case 'manual_target':
      return 'The bedtime you chose.';
    case 'no_history':
      return 'Log a few nights and bedtime will also adapt to your routine.';
    case 'aligned_with_history':
      return 'In line with your recent bedtimes.';
    case 'shift_capped':
      return rec.idealBedtime
        ? `Ideal would be ${formatTime(rec.idealBedtime, timeZone)}, but bedtime moves at most 30 min from your usual so the change stays gradual.`
        : 'Moved at most 30 min from your usual bedtime so the change stays gradual.';
    case 'sleep_below_goal':
      return rec.expectedSleepMin !== null
        ? `That leaves about ${formatDuration(rec.expectedSleepMin)} of sleep, under your ${formatDuration(prefs.desiredSleepMin)} goal.`
        : 'That is under your sleep goal.';
    case 'bedtime_passed':
      return 'This bedtime has passed. The sooner you are in bed, the more sleep you get.';
    case 'no_alarm':
      return 'No alarm to plan around. Set one, or choose a manual bedtime below.';
  }
}
