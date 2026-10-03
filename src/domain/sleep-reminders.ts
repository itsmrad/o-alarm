import { z } from 'zod';

import { recommendBedtime, type SleepPrefs, type WakeTarget, civilDate } from './sleep';
import { addDays, localDateInZone, resolveWallClock, wallClockInZone } from './time';

/**
 * Which local reminders exist for the coming nights and when they fire. Pure planning;
 * `src/lib/reminders` turns the plan into expo-notifications. Reminders are gentle
 * nudges (D4/D30): they never ring alarms and never replace one.
 */

export const reminderPrefsSchema = z.object({
  bedtime: z.boolean(),
  windDown: z.boolean(),
  caffeine: z.boolean(),
  /** Hours before bedtime that the last caffeine should be. */
  caffeineCutoffHours: z.number().int().min(4).max(12),
  morningLight: z.boolean(),
  morningMovement: z.boolean(),
});
export type ReminderPrefs = z.infer<typeof reminderPrefsSchema>;

/** Opt-in: nothing is scheduled (or asked of the OS) until the user turns one on. */
export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {
  bedtime: false,
  windDown: false,
  caffeine: false,
  caffeineCutoffHours: 8,
  morningLight: false,
  morningMovement: false,
};

export const anyReminderEnabled = (prefs: ReminderPrefs): boolean =>
  prefs.bedtime || prefs.windDown || prefs.caffeine || prefs.morningLight || prefs.morningMovement;

export type ReminderKind = 'bedtime' | 'windDown' | 'caffeine' | 'morningLight' | 'morningMovement';

export interface PlannedReminder {
  /** Stable per kind + night, so rescheduling replaces instead of duplicating. */
  id: string;
  kind: ReminderKind;
  fireAt: Date;
  title: string;
  body: string;
}

/** Every notification identifier this feature owns starts with this. */
export const REMINDER_ID_PREFIX = 'sleep.';
/** Nights planned ahead, so reminders still arrive if the app is not opened for a while. */
export const PLAN_NIGHTS = 3;
/** Morning reminders fire after waking, never at the alarm time itself. */
export const MORNING_LIGHT_DELAY_MIN = 10;
export const MORNING_MOVEMENT_DELAY_MIN = 30;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Do not schedule things about to fire (or already firing) while we compute. */
const MIN_LEAD_MS = 30_000;
const HORIZON_MS = (PLAN_NIGHTS + 1) * 24 * HOUR_MS;

function clock(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(instant);
  } catch {
    return instant.toISOString().slice(11, 16);
  }
}

export interface ReminderPlanInput {
  now: Date;
  timeZone: string;
  prefs: SleepPrefs;
  reminderPrefs: ReminderPrefs;
  targets: readonly WakeTarget[];
  recentBedtimes: readonly Date[];
}

/**
 * Reminders for the next PLAN_NIGHTS nights, soonest first. Auto mode plans one night per
 * wake target; manual mode plans the chosen bedtime for the next nights and attaches the
 * wake target that follows each (for the morning reminders).
 */
export function planReminders(input: ReminderPlanInput): PlannedReminder[] {
  const { now, timeZone, prefs, reminderPrefs, targets } = input;
  if (!anyReminderEnabled(reminderPrefs)) return [];

  const nights: { bedtime: Date; wake: Date | null }[] = [];
  if (prefs.mode === 'manual') {
    const today = localDateInZone(now, timeZone);
    for (let i = -1; i < PLAN_NIGHTS; i++) {
      const bedtime = resolveWallClock(
        addDays(today, i),
        prefs.manualBedtime.hour,
        prefs.manualBedtime.minute,
        timeZone,
      );
      const wake =
        targets.find(
          (t) =>
            t.fireAt.getTime() > bedtime.getTime() &&
            t.fireAt.getTime() - bedtime.getTime() <= 16 * HOUR_MS,
        )?.fireAt ?? null;
      nights.push({ bedtime, wake });
    }
  } else {
    for (const target of targets.slice(0, PLAN_NIGHTS)) {
      const rec = recommendBedtime({
        now,
        timeZone,
        prefs,
        wake: target.fireAt,
        recentBedtimes: input.recentBedtimes,
      });
      if (rec.bedtime) nights.push({ bedtime: rec.bedtime, wake: target.fireAt });
    }
  }

  const planned: PlannedReminder[] = [];
  for (const { bedtime, wake } of nights) {
    const night = civilDate(bedtime, timeZone);
    const id = (kind: ReminderKind) => `${REMINDER_ID_PREFIX}${kind}.${night}`;
    const wakeNote = wake ? ` Your alarm is set for ${clock(wake, timeZone)}.` : '';

    if (reminderPrefs.bedtime) {
      planned.push({
        id: id('bedtime'),
        kind: 'bedtime',
        fireAt: bedtime,
        title: 'Time for bed',
        body: `Aim to be in bed now.${wakeNote}`,
      });
    }
    if (reminderPrefs.windDown && prefs.windDownMin > 0) {
      planned.push({
        id: id('windDown'),
        kind: 'windDown',
        fireAt: new Date(bedtime.getTime() - prefs.windDownMin * MINUTE_MS),
        title: 'Start winding down',
        body: `Bedtime is at ${clock(bedtime, timeZone)}. Dim the lights and put the day away.`,
      });
    }
    if (reminderPrefs.caffeine) {
      planned.push({
        id: id('caffeine'),
        kind: 'caffeine',
        fireAt: new Date(bedtime.getTime() - reminderPrefs.caffeineCutoffHours * HOUR_MS),
        title: 'Caffeine cutoff',
        body: `Caffeine now can linger into the night. Bedtime is at ${clock(bedtime, timeZone)}.`,
      });
    }
    if (wake && reminderPrefs.morningLight) {
      planned.push({
        id: id('morningLight'),
        kind: 'morningLight',
        fireAt: new Date(wake.getTime() + MORNING_LIGHT_DELAY_MIN * MINUTE_MS),
        title: 'Get some daylight',
        body: 'A few minutes of bright light helps you feel awake.',
      });
    }
    if (wake && reminderPrefs.morningMovement) {
      planned.push({
        id: id('morningMovement'),
        kind: 'morningMovement',
        fireAt: new Date(wake.getTime() + MORNING_MOVEMENT_DELAY_MIN * MINUTE_MS),
        title: 'Move for a few minutes',
        body: 'A short walk or stretch keeps you from drifting back to sleep.',
      });
    }
  }

  return planned
    .filter((r) => {
      const lead = r.fireAt.getTime() - now.getTime();
      return lead > MIN_LEAD_MS && lead <= HORIZON_MS;
    })
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime() || a.id.localeCompare(b.id));
}

/**
 * Whether to offer the morning check-in: no check-in (or skip) recorded for today's civil
 * date, and it is morning/early afternoon locally (03:00-13:59).
 */
export function shouldPromptCheckInAt(input: {
  now: Date;
  timeZone: string;
  hasEntryToday: boolean;
}): boolean {
  if (input.hasEntryToday) return false;
  const { hour } = wallClockInZone(input.now, input.timeZone);
  return hour >= 3 && hour < 14;
}
