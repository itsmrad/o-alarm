/**
 * Typed union of the PRODUCT.md key events (D12). Stored append-only in the local
 * `events` table; analytics/cloud consume from there.
 */

export type EngineKind = 'native' | 'preview';

export interface EventPayloads {
  alarm_created: { hour: number; minute: number; weekdays: number[]; oneTime: boolean };
  alarm_updated: { changed: string[] };
  /** Not in the PRODUCT.md list; needed so history/sync can explain a vanished alarm. */
  alarm_deleted: Record<string, never>;
  alarm_native_scheduled: { engine: EngineKind; scheduleId: string; fireAt: string };
  alarm_schedule_failed: { engine: EngineKind; code: string; message: string };
  alarm_expected: { fireAt: string };
  alarm_trigger_received: { scheduledFor: string; receivedAt: string; engine: EngineKind };
  alarm_snoozed: { snoozesUsed: number; nextFireAt: string };
  alarm_dismissed: { method: 'mission' | 'button' | 'system_stop' };
  mission_started: { missionId: string; stepIndex: number };
  mission_completed: { missionId: string; stepIndex: number; durationMs: number };
  mission_failed: { missionId: string; stepIndex: number; reason: string };
  wake_check_started: { attempt: number; checkAt: string };
  wake_check_passed: { attempt: number };
  wake_check_failed: { attempt: number; reason: 'no_response' | 'verification_failed' };
  alarm_retriggered: { reason: 'wake_check_failed' | 'stop_without_mission'; attempt: number };
}

export type EventType = keyof EventPayloads;

export const EVENT_TYPES = [
  'alarm_created',
  'alarm_updated',
  'alarm_deleted',
  'alarm_native_scheduled',
  'alarm_schedule_failed',
  'alarm_expected',
  'alarm_trigger_received',
  'alarm_snoozed',
  'alarm_dismissed',
  'mission_started',
  'mission_completed',
  'mission_failed',
  'wake_check_started',
  'wake_check_passed',
  'wake_check_failed',
  'alarm_retriggered',
] as const satisfies readonly EventType[];

export type AppEvent = {
  [K in EventType]: {
    id: string;
    type: K;
    occurredAt: string;
    alarmId: string | null;
    occurrenceKey: string | null;
    payload: EventPayloads[K];
  };
}[EventType];

/** Event input before id/timestamp are assigned. */
export type NewEvent = {
  [K in EventType]: {
    type: K;
    alarmId?: string | null;
    occurrenceKey?: string | null;
    payload: EventPayloads[K];
  };
}[EventType];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}
