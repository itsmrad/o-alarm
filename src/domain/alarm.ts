import { z } from 'zod';

import { MAX_MISSION_CHAIN_LENGTH, missionStepSchema } from './missions';
import { isValidLocalDate, isValidTimeZone, type Weekday } from './time';

const hourSchema = z.number().int().min(0).max(23);
const minuteSchema = z.number().int().min(0).max(59);
const weekdaySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
const localDateSchema = z.string().refine(isValidLocalDate, 'Expected a YYYY-MM-DD date');

export const timezonePolicySchema = z.enum(['floating', 'fixed']);
/** D9: `floating` follows the device time zone (default); `fixed` pins an IANA zone. */
export type TimezonePolicy = z.infer<typeof timezonePolicySchema>;

export const soundSchema = z.object({
  kind: z.enum(['default', 'system', 'custom']),
  /** Platform sound identifier / bundled asset name; null for `default`. */
  id: z.string().nullable(),
});
export type AlarmSound = z.infer<typeof soundSchema>;

export const escalationSchema = z.object({
  /** Gradually raise volume where the platform supports it. */
  enabled: z.boolean(),
  rampSeconds: z.number().int().min(0).max(600),
});
export type Escalation = z.infer<typeof escalationSchema>;

export const snoozePolicySchema = z.object({
  enabled: z.boolean(),
  durationMin: z.number().int().min(1).max(60),
  /** Maximum snoozes per occurrence. 0 = snooze disabled. Never unlimited. */
  maxCount: z.number().int().min(0).max(10),
});
export type SnoozePolicy = z.infer<typeof snoozePolicySchema>;

export const wakeCheckConfigSchema = z.object({
  enabled: z.boolean(),
  /** Minutes after dismissal before verifying the user is awake. */
  delayMin: z.number().int().min(1).max(60),
  /** Seconds the user has to respond before the alarm re-triggers. */
  responseWindowSec: z.number().int().min(15).max(600),
  method: z.enum(['confirm', 'movement', 'mission']),
  /** Mission used when `method === 'mission'`. */
  missionId: z.string().nullable(),
  /** Safety bound on re-trigger cycles for one occurrence. */
  maxRetriggers: z.number().int().min(1).max(10),
});
export type WakeCheckConfig = z.infer<typeof wakeCheckConfigSchema>;

export const oneOffOverrideSchema = z.object({
  /** The single occurrence this override applies to. */
  occurrenceKey: z.string().min(1),
  hour: hourSchema,
  minute: minuteSchema,
});
export type OneOffOverride = z.infer<typeof oneOffOverrideSchema>;

export const alarmSchema = z
  .object({
    id: z.string().min(1),
    hour: hourSchema,
    minute: minuteSchema,
    /** Recurring days. Empty → one-time alarm on `date`. */
    weekdays: z.array(weekdaySchema).max(7),
    /** One-time alarm's civil date (YYYY-MM-DD); null for recurring alarms. */
    date: localDateSchema.nullable(),
    timezonePolicy: timezonePolicySchema,
    /** IANA zone for `fixed`; null for `floating`. */
    timeZone: z.string().nullable(),
    label: z.string().max(60),
    enabled: z.boolean(),
    sound: soundSchema,
    vibration: z.boolean(),
    escalation: escalationSchema,
    snooze: snoozePolicySchema,
    /** occurrenceKey of the single upcoming occurrence to skip, if any. */
    skipNext: z.string().nullable(),
    oneOffOverride: oneOffOverrideSchema.nullable(),
    missions: z.array(missionStepSchema).max(MAX_MISSION_CHAIN_LENGTH),
    wakeCheck: wakeCheckConfigSchema,
    /** Protect against weakening this alarm shortly before it rings. */
    important: z.boolean(),
  })
  .superRefine((alarm, ctx) => {
    if (new Set(alarm.weekdays).size !== alarm.weekdays.length) {
      ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Duplicate weekday' });
    }
    if (alarm.weekdays.length === 0 && alarm.date === null) {
      ctx.addIssue({ code: 'custom', path: ['date'], message: 'One-time alarms need a date' });
    }
    if (alarm.weekdays.length > 0 && alarm.date !== null) {
      ctx.addIssue({ code: 'custom', path: ['date'], message: 'Recurring alarms have no date' });
    }
    if (alarm.timezonePolicy === 'fixed' && !(alarm.timeZone && isValidTimeZone(alarm.timeZone))) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeZone'],
        message: 'Fixed alarms need a valid IANA zone',
      });
    }
    if (alarm.timezonePolicy === 'floating' && alarm.timeZone !== null) {
      ctx.addIssue({ code: 'custom', path: ['timeZone'], message: 'Floating alarms have no zone' });
    }
    if (alarm.wakeCheck.method === 'mission' && !alarm.wakeCheck.missionId) {
      ctx.addIssue({ code: 'custom', path: ['wakeCheck', 'missionId'], message: 'Pick a mission' });
    }
  });

/** D9 alarm model: wall-clock time + recurrence + ring behavior. Pure data. */
export type Alarm = z.infer<typeof alarmSchema>;

export const DEFAULT_SNOOZE: SnoozePolicy = { enabled: true, durationMin: 9, maxCount: 3 };

export const DEFAULT_WAKE_CHECK: WakeCheckConfig = {
  enabled: false,
  delayMin: 5,
  responseWindowSec: 60,
  method: 'confirm',
  missionId: null,
  maxRetriggers: 3,
};

export function createAlarm(
  fields: Pick<Alarm, 'id' | 'hour' | 'minute'> & Partial<Omit<Alarm, 'id' | 'hour' | 'minute'>>,
): Alarm {
  const { weekdays = [], ...rest } = fields;
  return alarmSchema.parse({
    date: null,
    timezonePolicy: 'floating',
    timeZone: null,
    label: '',
    enabled: true,
    sound: { kind: 'default', id: null },
    vibration: true,
    escalation: { enabled: true, rampSeconds: 30 },
    snooze: DEFAULT_SNOOZE,
    skipNext: null,
    oneOffOverride: null,
    missions: [],
    wakeCheck: DEFAULT_WAKE_CHECK,
    important: false,
    ...rest,
    weekdays: sortWeekdays(weekdays),
  });
}

export function isRecurring(alarm: Pick<Alarm, 'weekdays'>): boolean {
  return alarm.weekdays.length > 0;
}

export function sortWeekdays(weekdays: readonly Weekday[]): Weekday[] {
  return [...new Set(weekdays)].sort((a, b) => a - b);
}
