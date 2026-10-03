import {
  alarmSchema,
  isEventType,
  sortWeekdays,
  type Alarm,
  type AlarmSound,
  type WakeCheckConfig,
} from '@/domain';
import { formatLocalDate, isValidLocalDate, localDateInZone, type Weekday } from '@/domain/time';
import type { WakeCheckState } from '@/domain/wake-check';
import type {
  AlarmRow,
  alarmOccurrences,
  EventRow,
  missionAttempts,
  morningCheckins,
  sleepSessions,
  wakeChecks,
  wakeSessions,
} from '@/db/schema';

import { isUuid, uuidV5 } from './uuid';

/**
 * Local ↔ cloud field mapping (D25). The local domain model is the source of truth; the
 * cloud schema (supabase/migrations, incl. 20261003000001_account_sync.sql) is shaped so that
 * every alarm the cloud accepts maps back to a valid local alarm.
 *
 * Alarms round-trip (push + pull). History tables are push-only for now: local history stays
 * the on-device record and the cloud copy feeds analytics/AI.
 */

type OccurrenceRow = typeof alarmOccurrences.$inferSelect;
type WakeSessionRow = typeof wakeSessions.$inferSelect;
type MissionAttemptRow = typeof missionAttempts.$inferSelect;
type WakeCheckRow = typeof wakeChecks.$inferSelect;
type SleepSessionRow = typeof sleepSessions.$inferSelect;
type MorningCheckinRow = typeof morningCheckins.$inferSelect;

/** Columns every client-written cloud row carries (updated_at/version are server-managed). */
interface CloudBase {
  id: string;
  user_id: string;
  device_id: string;
  created_at: string;
  deleted_at: string | null;
}

export interface CloudAlarm extends CloudBase {
  label: string;
  enabled: boolean;
  hour: number;
  minute: number;
  /** ISO weekdays, 1 = Monday .. 7 = Sunday. */
  weekdays: number[];
  one_time_date: string | null;
  timezone_policy: 'floating' | 'fixed';
  timezone: string | null;
  skip_date: string | null;
  override_date: string | null;
  override_hour: number | null;
  override_minute: number | null;
  sound: string | null;
  vibrate: boolean;
  gradual_volume: boolean;
  gradual_volume_ramp_seconds: number;
  snooze_enabled: boolean;
  snooze_minutes: number;
  snooze_limit: number;
  mission_chain: unknown[];
  mission_before_snooze: boolean;
  wake_check_enabled: boolean;
  wake_check_delay_minutes: number;
  wake_check_method: WakeCheckConfig['method'];
  wake_check_response_window_seconds: number;
  wake_check_max_retriggers: number;
  wake_check_mission_id: string | null;
  important: boolean;
}

/** A pulled alarm row: what we pushed plus the server-managed columns. */
export interface PulledAlarm extends CloudAlarm {
  updated_at: string;
  version: number;
}

export interface MapContext {
  userId: string;
  /** This installation's device id (fallback when a local row has no uuid device id). */
  deviceId: string;
  /** Device IANA zone, used to derive civil dates for history rows. */
  timeZone: string;
}

const base = (
  row: { id: string; createdAt: string; deletedAt: string | null; deviceId: string },
  ctx: MapContext,
  id: string = row.id,
): CloudBase => ({
  id,
  user_id: ctx.userId,
  device_id: isUuid(row.deviceId) ? row.deviceId : ctx.deviceId,
  created_at: row.createdAt,
  deleted_at: row.deletedAt,
});

// ---------------------------------------------------------------------------- alarms

/** Local 0 = Sunday .. 6 = Saturday → ISO 1 = Monday .. 7 = Sunday. */
export const toIsoWeekday = (day: Weekday): number => (day === 0 ? 7 : day);
export const fromIsoWeekday = (day: number): Weekday => (day === 7 ? 0 : day) as Weekday;

/** `{kind, id}` ↔ `'kind'` | `'kind:id'`. */
export function encodeSound(sound: AlarmSound): string {
  return sound.id === null ? sound.kind : `${sound.kind}:${sound.id}`;
}

export function decodeSound(value: string | null): AlarmSound {
  if (!value) return { kind: 'default', id: null };
  const split = value.indexOf(':');
  const kind = split === -1 ? value : value.slice(0, split);
  const id = split === -1 ? null : value.slice(split + 1);
  if (kind === 'default' || kind === 'system' || kind === 'custom') return { kind, id };
  return { kind: 'default', id: null };
}

/** Occurrence keys are `${alarmId}@${YYYY-MM-DD}` (src/domain/recurrence.ts). */
export function occurrenceDate(occurrenceKey: string): string | null {
  const date = occurrenceKey.slice(occurrenceKey.lastIndexOf('@') + 1);
  return isValidLocalDate(date) ? date : null;
}

const occurrenceKeyFor = (alarmId: string, date: string) => `${alarmId}@${date}`;

/** The cloud alarm row for a local alarm row (incl. tombstones). */
export function alarmToCloud(row: AlarmRow, alarm: Alarm, ctx: MapContext): CloudAlarm {
  // D32: missionBeforeSnooze joins the local model with the ringing task; map it when present.
  const extra = alarm as Alarm & { missionBeforeSnooze?: boolean };
  const override = alarm.oneOffOverride;
  const overrideDate = override ? occurrenceDate(override.occurrenceKey) : null;
  return {
    ...base(row, ctx),
    label: alarm.label,
    enabled: alarm.enabled,
    hour: alarm.hour,
    minute: alarm.minute,
    weekdays: alarm.weekdays.map(toIsoWeekday).sort((a, b) => a - b),
    one_time_date: alarm.date,
    timezone_policy: alarm.timezonePolicy,
    timezone: alarm.timeZone,
    skip_date: alarm.skipNext ? occurrenceDate(alarm.skipNext) : null,
    override_date: overrideDate,
    override_hour: override && overrideDate ? override.hour : null,
    override_minute: override && overrideDate ? override.minute : null,
    sound: encodeSound(alarm.sound),
    vibrate: alarm.vibration,
    gradual_volume: alarm.escalation.enabled,
    gradual_volume_ramp_seconds: alarm.escalation.rampSeconds,
    snooze_enabled: alarm.snooze.enabled,
    snooze_minutes: alarm.snooze.durationMin,
    snooze_limit: alarm.snooze.maxCount,
    mission_chain: alarm.missions,
    mission_before_snooze: extra.missionBeforeSnooze ?? false,
    wake_check_enabled: alarm.wakeCheck.enabled,
    wake_check_delay_minutes: alarm.wakeCheck.delayMin,
    wake_check_method: alarm.wakeCheck.method,
    wake_check_response_window_seconds: alarm.wakeCheck.responseWindowSec,
    wake_check_max_retriggers: alarm.wakeCheck.maxRetriggers,
    wake_check_mission_id: alarm.wakeCheck.missionId,
    important: alarm.important,
  };
}

/**
 * The local alarm for a pulled cloud row, validated against the local schema.
 * Returns null when the row cannot be a valid local alarm (it is then skipped, never applied).
 */
export function alarmFromCloud(row: CloudAlarm): Alarm | null {
  const candidate = {
    id: row.id,
    hour: row.hour,
    minute: row.minute,
    weekdays: sortWeekdays(row.weekdays.map(fromIsoWeekday)),
    date: row.one_time_date,
    timezonePolicy: row.timezone_policy,
    timeZone: row.timezone_policy === 'fixed' ? row.timezone : null,
    label: row.label,
    enabled: row.enabled,
    sound: decodeSound(row.sound),
    vibration: row.vibrate,
    escalation: { enabled: row.gradual_volume, rampSeconds: row.gradual_volume_ramp_seconds },
    snooze: {
      enabled: row.snooze_enabled,
      durationMin: row.snooze_minutes,
      maxCount: row.snooze_limit,
    },
    skipNext: row.skip_date ? occurrenceKeyFor(row.id, row.skip_date) : null,
    oneOffOverride:
      row.override_date && row.override_hour !== null && row.override_minute !== null
        ? {
            occurrenceKey: occurrenceKeyFor(row.id, row.override_date),
            hour: row.override_hour,
            minute: row.override_minute,
          }
        : null,
    missions: row.mission_chain,
    wakeCheck: {
      enabled: row.wake_check_enabled,
      delayMin: row.wake_check_delay_minutes,
      responseWindowSec: row.wake_check_response_window_seconds,
      method: row.wake_check_method,
      missionId: row.wake_check_mission_id,
      maxRetriggers: row.wake_check_max_retriggers,
    },
    important: row.important,
    // Kept by alarmSchema once the local model has it (D32), stripped until then.
    missionBeforeSnooze: row.mission_before_snooze,
  };
  const parsed = alarmSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------- history (push-only)

/** Mission catalog types the cloud accepts (public.missions). */
const CLOUD_MISSION_TYPES = new Set([
  'math',
  'shake',
  'steps',
  'qr',
  'memory',
  'typing',
  'squats',
  'nfc',
  'photo',
  'voice',
]);

/** Deterministic cloud id of an occurrence: devices converge on one row per occurrence key. */
export const occurrenceCloudId = (occurrenceKey: string) => uuidV5(`occurrence:${occurrenceKey}`);

export function occurrenceToCloud(row: OccurrenceRow, ctx: MapContext) {
  const date =
    occurrenceDate(row.occurrenceKey) ??
    formatLocalDate(localDateInZone(new Date(row.expectedAt), ctx.timeZone));
  const outcome = (
    {
      scheduled: 'pending',
      triggered: 'pending',
      snoozed: 'pending',
      dismissed: 'dismissed',
      missed: 'missed',
      skipped: 'skipped',
      cancelled: 'cancelled',
    } as const
  )[row.status];
  const dismissedAt =
    outcome === 'dismissed'
      ? (row.dismissedAt ?? row.triggeredAt ?? row.updatedAt)
      : row.dismissedAt;
  return {
    ...base(row, ctx, occurrenceCloudId(row.occurrenceKey)),
    alarm_id: row.alarmId,
    occurrence_key: row.occurrenceKey,
    local_date: date,
    expected_at: row.expectedAt,
    schedule_status:
      row.status === 'skipped' ? 'skipped' : row.status === 'cancelled' ? 'cancelled' : 'scheduled',
    triggered_at: row.triggeredAt,
    dismissed_at: dismissedAt,
    snooze_count: row.snoozeCount,
    outcome,
  };
}

export function wakeSessionToCloud(row: WakeSessionRow, ctx: MapContext) {
  const status =
    row.outcome === 'awake'
      ? 'success'
      : row.outcome === 'abandoned'
        ? 'abandoned'
        : row.outcome === 'retriggered' && row.endedAt
          ? 'failed'
          : 'active';
  return {
    ...base(row, ctx),
    alarm_occurrence_id: occurrenceCloudId(row.occurrenceKey),
    started_at: row.startedAt,
    ended_at: status === 'active' ? row.endedAt : (row.endedAt ?? row.updatedAt),
    status,
    retrigger_count: row.outcome === 'retriggered' ? 1 : 0,
  };
}

/** Null when the mission type is not in the cloud catalog (skipped). */
export function missionAttemptToCloud(row: MissionAttemptRow, ctx: MapContext) {
  if (!CLOUD_MISSION_TYPES.has(row.missionId)) return null;
  const metrics = row.details ?? {};
  return {
    ...base(row, ctx),
    wake_session_id: row.wakeSessionId,
    mission_type: row.missionId,
    position: row.stepIndex,
    purpose: 'dismiss',
    started_at: row.startedAt,
    ended_at: row.outcome ? (row.endedAt ?? row.updatedAt) : row.endedAt,
    outcome: row.outcome ?? 'in_progress',
    metrics: JSON.stringify(metrics).length <= 3500 ? metrics : {},
  };
}

export function wakeCheckToCloud(
  row: WakeCheckRow,
  ctx: MapContext,
  method: WakeCheckConfig['method'],
) {
  const state: WakeCheckState = row.state;
  const dueAt =
    state.status === 'armed'
      ? state.checkAt
      : state.status === 'pending_verification'
        ? state.deadline
        : state.status === 'idle'
          ? row.createdAt
          : state.at;
  const outcome =
    state.status === 'passed'
      ? 'passed'
      : state.status === 'failed'
        ? state.reason === 'no_response'
          ? 'no_response'
          : 'failed'
        : state.status === 'retriggered'
          ? 'failed'
          : 'pending';
  return {
    ...base(row, ctx),
    wake_session_id: row.wakeSessionId,
    check_number: Math.max(1, row.attempt),
    method,
    due_at: dueAt,
    responded_at: state.status === 'passed' ? state.at : null,
    outcome,
    retriggered: state.status === 'retriggered',
  };
}

export function sleepSessionToCloud(row: SleepSessionRow, ctx: MapContext) {
  const ended = row.endedAt && row.endedAt > row.startedAt ? row.endedAt : null;
  return {
    ...base(row, ctx),
    kind: 'night',
    started_at: row.startedAt,
    ended_at: ended,
    local_date: formatLocalDate(localDateInZone(new Date(ended ?? row.startedAt), ctx.timeZone)),
    source: row.source === 'estimated' ? 'inferred' : 'manual',
  };
}

/** Null until both ratings exist (the cloud requires them). One row per user per day. */
export function morningCheckinToCloud(row: MorningCheckinRow, ctx: MapContext) {
  if (row.energy === null || row.sleepQuality === null) return null;
  return {
    ...base(row, ctx, uuidV5(`checkin:${ctx.userId}:${row.date}`)),
    local_date: row.date,
    checked_in_at: row.createdAt,
    energy: row.energy,
    sleep_quality: row.sleepQuality,
  };
}

/** Null for event types the cloud does not accept. Events are append-only (no deleted_at). */
export function eventToCloud(row: EventRow, ctx: MapContext) {
  if (!isEventType(row.type)) return null;
  const withKey = row.occurrenceKey
    ? { ...row.payload, occurrenceKey: row.occurrenceKey }
    : row.payload;
  const properties = JSON.stringify(withKey).length <= 3500 ? withKey : {};
  const { deleted_at: _deleted, ...cloudBase } = base(row, ctx);
  return {
    ...cloudBase,
    name: row.type,
    occurred_at: row.occurredAt,
    alarm_id: isUuid(row.alarmId) ? row.alarmId : null,
    occurrence_id: row.occurrenceKey ? occurrenceCloudId(row.occurrenceKey) : null,
    properties,
  };
}
