/**
 * Wire types shared by the JS contract (src/engine) and the native implementations.
 * All instants are ISO-8601 UTC strings; ids are deterministic (see src/domain).
 */

export type ScheduleKind = 'alarm' | 'snooze' | 'wake_check' | 'retrigger';

export interface AlarmScheduleSpec {
  /** Deterministic engine id, e.g. `<alarmId>@2026-10-02` or `…#snooze-1`. Upsert key. */
  id: string;
  alarmId: string;
  occurrenceKey: string;
  kind: ScheduleKind;
  fireAt: string;
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
