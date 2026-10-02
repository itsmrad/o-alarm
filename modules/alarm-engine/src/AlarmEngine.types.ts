/**
 * Wire types shared by the JS contract (src/engine) and the native implementations.
 * All instants are ISO-8601 UTC strings; ids are deterministic (see src/domain).
 */

export type ScheduleKind = 'alarm' | 'snooze' | 'wake_check' | 'retrigger';

/**
 * D28: the wall-clock rule behind an `alarm` occurrence, so native can recompute it on
 * tz/time changes (D9 rules) and arm the next recurrence itself when JS never runs.
 * `hour`/`minute` are this occurrence's effective time (a one-off override applied), so
 * native should derive a next recurrence from the alarm's LATEST scheduled `alarm` entry.
 */
export interface WallClock {
  hour: number;
  minute: number;
  /** Civil date (YYYY-MM-DD) of this occurrence in its zone. */
  localDate: string;
  /** IANA zone for fixed-zone alarms; null = floating (device zone). */
  timeZone: string | null;
  /** 0 = Sunday … 6 = Saturday, ascending; empty = one-time. */
  weekdays: number[];
}

export interface AlarmScheduleSpec {
  /** Deterministic engine id, e.g. `<alarmId>@2026-10-02` or `…#snooze-1`. Upsert key. */
  id: string;
  alarmId: string;
  occurrenceKey: string;
  kind: ScheduleKind;
  fireAt: string;
  /** Present on kind `alarm` only; snooze/wake_check/retrigger are instant-only. */
  wallClock?: WallClock;
  label: string;
  sound: { kind: 'default' | 'system' | 'custom'; id: string | null };
  vibration: boolean;
  escalation: { enabled: boolean; rampSeconds: number };
  snooze: { enabled: boolean; durationMin: number; maxCount: number };
  /** Dismissal requires an in-app mission chain (D14 on iOS). */
  hasMissions: boolean;
  wakeCheck: boolean;
  important: boolean;
}

/** Read-back of what the engine actually holds (D10 native mirror). */
export interface ScheduledAlarm extends AlarmScheduleSpec {
  scheduledAt: string;
}

export type PermissionKind =
  'alarms' | 'notifications' | 'exact_alarm' | 'full_screen_intent' | 'battery_optimization';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export type ReadinessKind = 'engine' | PermissionKind | 'platform_limitation';

export type ReadinessStatus = 'ok' | 'warning' | 'blocking' | 'unknown';

export interface ReadinessItem {
  kind: ReadinessKind;
  status: ReadinessStatus;
  title: string;
  detail: string;
  /** What the user can do about it, if anything. */
  action:
    { type: 'request_permission'; permission: PermissionKind } | { type: 'open_settings' } | null;
}

export interface EngineReadiness {
  engine: 'native' | 'preview';
  /** False if any item is `blocking`: alarms will not ring reliably. */
  canRing: boolean;
  checkedAt: string;
  items: ReadinessItem[];
}

export interface AlarmEngineEventPayload {
  scheduleId: string;
  alarmId: string;
  occurrenceKey: string;
  kind: ScheduleKind;
  at: string;
}

export interface StopEventPayload extends AlarmEngineEventPayload {
  /** False when the system Stop button bypassed the in-app mission (D14). */
  missionCompleted: boolean;
}

export type AlarmEngineModuleEvents = {
  onTrigger: (event: AlarmEngineEventPayload) => void;
  onSnooze: (event: AlarmEngineEventPayload) => void;
  onDismiss: (event: AlarmEngineEventPayload) => void;
  onStop: (event: StopEventPayload) => void;
};

/** The alarm currently ringing (cold start / relaunch while ringing). */
export interface RingingState extends AlarmEngineEventPayload {
  firedAt: string;
  /** Snoozes already used for this occurrence. */
  snoozeCount: number;
  label: string;
  hasMissions: boolean;
  wakeCheck: boolean;
  important: boolean;
}

export interface DismissOptions {
  /** False when dismissal happened without the in-app mission chain (D14). */
  missionCompleted: boolean;
  /** If set, atomically schedule a `wake_check` alarm at this instant (D13). */
  wakeCheckAt?: string;
}

export interface DismissResult {
  wakeCheck?: ScheduledAlarm;
}

export type ObservedEngineEventType =
  | 'trigger_received'
  | 'snoozed'
  | 'dismissed'
  | 'stopped_from_system_ui'
  | 'retriggered'
  | 'schedule_restored_after_boot'
  | 'tz_change_rescheduled';

/**
 * Something the native layer did or saw while JS may not have been running.
 * Persisted natively until acknowledged: drain → record in the events table → ack.
 */
export interface ObservedEngineEvent {
  /** Unique, stable id (ack key). */
  id: string;
  type: ObservedEngineEventType;
  scheduleId: string;
  alarmId: string;
  occurrenceKey: string;
  at: string;
}
