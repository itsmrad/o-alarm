import type { Alarm, Weekday } from '@/domain';

/** Snooze limits the editor offers (also the steps a suggestion can move between). */
export const SNOOZE_LIMITS = [1, 2, 3, 5, 10] as const;

/**
 * Values an Insights suggestion can fill in when it opens the alarm editor. They only seed
 * the editor's initial state: nothing is saved until the user taps Save (D19: AI never
 * edits alarms; it only suggests).
 */
export interface AlarmEditorPrefill {
  hour?: number;
  minute?: number;
  weekdays?: Weekday[];
  label?: string;
  snoozeMaxCount?: (typeof SNOOZE_LIMITS)[number];
  wakeCheck?: boolean;
}

/** Route search params as Expo Router delivers them. */
export type RouteParams = Record<string, string | string[] | undefined>;

const PREFIX = 'prefill_';
const LABEL_MAX = 60;

const intIn = (raw: string | undefined, min: number, max: number): number | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
};

/** Serializes a prefill into route params (`prefill_*`), to merge into an editor href. */
export function prefillParams(prefill: AlarmEditorPrefill): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(prefill)) {
    if (value === undefined) continue;
    params[PREFIX + key] = Array.isArray(value)
      ? value.join(',')
      : typeof value === 'boolean'
        ? value
          ? '1'
          : '0'
        : String(value);
  }
  return params;
}

/** Parses `prefill_*` route params. Anything malformed is dropped (never guessed). */
export function parsePrefill(params: RouteParams): AlarmEditorPrefill {
  const get = (key: keyof AlarmEditorPrefill) => {
    const raw = params[PREFIX + key];
    return Array.isArray(raw) ? raw[0] : raw;
  };
  const prefill: AlarmEditorPrefill = {};
  const hour = intIn(get('hour'), 0, 23);
  const minute = intIn(get('minute'), 0, 59);
  if (hour !== undefined && minute !== undefined) {
    prefill.hour = hour;
    prefill.minute = minute;
  }
  const weekdays = get('weekdays');
  if (weekdays !== undefined) {
    const days = weekdays === '' ? [] : weekdays.split(',').map((d) => intIn(d, 0, 6));
    if (days.every((d) => d !== undefined)) {
      prefill.weekdays = [...new Set(days as Weekday[])].sort((a, b) => a - b);
    }
  }
  const label = get('label');
  if (label !== undefined && label.trim().length <= LABEL_MAX) prefill.label = label.trim();
  const snooze = intIn(get('snoozeMaxCount'), 1, 10);
  if (snooze !== undefined && (SNOOZE_LIMITS as readonly number[]).includes(snooze)) {
    prefill.snoozeMaxCount = snooze as AlarmEditorPrefill['snoozeMaxCount'];
  }
  const wakeCheck = get('wakeCheck');
  if (wakeCheck === '1' || wakeCheck === '0') prefill.wakeCheck = wakeCheck === '1';
  return prefill;
}

export const hasPrefill = (prefill: AlarmEditorPrefill) => Object.keys(prefill).length > 0;

/** The alarm the editor starts from: `alarm` with the prefill applied (not saved). */
export function applyPrefill(alarm: Alarm, prefill: AlarmEditorPrefill): Alarm {
  return {
    ...alarm,
    ...(prefill.hour !== undefined && prefill.minute !== undefined
      ? { hour: prefill.hour, minute: prefill.minute }
      : {}),
    ...(prefill.weekdays ? { weekdays: prefill.weekdays } : {}),
    ...(prefill.label !== undefined ? { label: prefill.label } : {}),
    ...(prefill.snoozeMaxCount !== undefined
      ? { snooze: { ...alarm.snooze, enabled: true, maxCount: prefill.snoozeMaxCount } }
      : {}),
    ...(prefill.wakeCheck !== undefined
      ? { wakeCheck: { ...alarm.wakeCheck, enabled: prefill.wakeCheck } }
      : {}),
  };
}
