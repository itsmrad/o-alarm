import { upcomingOccurrences, type Alarm, type Occurrence } from '@/domain';

import type { AlarmScheduleSpec, ScheduledAlarm } from './types';

export function specForOccurrence(alarm: Alarm, occurrence: Occurrence): AlarmScheduleSpec {
  return {
    id: occurrence.occurrenceKey,
    alarmId: alarm.id,
    occurrenceKey: occurrence.occurrenceKey,
    kind: 'alarm',
    fireAt: occurrence.fireAt.toISOString(),
    label: alarm.label.trim() || 'Alarm',
    sound: alarm.sound,
    vibration: alarm.vibration,
    escalation: alarm.escalation,
    snooze: alarm.snooze,
    hasMissions: alarm.missions.length > 0,
    wakeCheck: alarm.wakeCheck.enabled,
    important: alarm.important,
  };
}

/**
 * Occurrences scheduled ahead per alarm. Two means a daily alarm keeps tomorrow's ring
 * scheduled even if JS never runs after today's (native also re-plans, D10).
 */
export const DEFAULT_OCCURRENCES_PER_ALARM = 2;

export function desiredSpecs(
  alarms: readonly Alarm[],
  now: Date,
  timeZone: string,
  occurrencesPerAlarm = DEFAULT_OCCURRENCES_PER_ALARM,
): AlarmScheduleSpec[] {
  return alarms.flatMap((alarm) =>
    upcomingOccurrences(alarm, now, timeZone, occurrencesPerAlarm).map((occurrence) =>
      specForOccurrence(alarm, occurrence),
    ),
  );
}

/** Fields that must match between DB intent and engine read-back. */
export function specFingerprint(spec: AlarmScheduleSpec | ScheduledAlarm): string {
  return JSON.stringify([
    spec.id,
    spec.alarmId,
    spec.occurrenceKey,
    spec.kind,
    Date.parse(spec.fireAt),
    spec.label,
    spec.sound.kind,
    spec.sound.id,
    spec.vibration,
    spec.escalation.enabled,
    spec.escalation.rampSeconds,
    spec.snooze.enabled,
    spec.snooze.durationMin,
    spec.snooze.maxCount,
    spec.hasMissions,
    spec.wakeCheck,
    spec.important,
  ]);
}
