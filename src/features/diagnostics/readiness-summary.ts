import type { ScheduleStatus } from '@/db/alarm-service';
import type { Occurrence } from '@/domain';
import type { EngineKind, EngineReadiness, ScheduledAlarm } from '@/engine';

export interface Cause {
  title: string;
  detail: string;
}

/**
 * Likely reasons an expected alarm did not ring, from what we can observe now. Never
 * claims certainty: the OS does not tell us why a ring did not happen.
 */
export function likelyMissCauses(
  engineKind: EngineKind,
  readiness: EngineReadiness | null,
): Cause[] {
  const causes: Cause[] = [];
  if (engineKind === 'preview') {
    causes.push({
      title: 'Preview mode',
      detail: 'Expo Go cannot ring alarms while the app is closed or in the background.',
    });
  }
  for (const item of readiness?.items ?? []) {
    if (item.kind === 'engine' && engineKind === 'preview') continue;
    if (item.status === 'blocking' || item.status === 'warning') {
      causes.push({ title: item.title, detail: item.detail });
    }
  }
  if (!readiness) {
    causes.push({
      title: 'Alarm engine not responding',
      detail: 'O-Alarm could not read the system alarm status.',
    });
  }
  if (causes.length === 0) {
    causes.push({
      title: 'No problem found right now',
      detail:
        'The phone may have been off or out of battery, or the system delayed or blocked the alarm at the time.',
    });
  }
  return causes;
}

export type ReadinessLevel = 'ready' | 'at_risk' | 'blocked' | 'none';

export interface NextAlarmReadiness {
  level: ReadinessLevel;
  headline: string;
  reasons: string[];
}

/** One-glance answer to "will my next alarm ring?" for the top of Diagnostics. */
export function nextAlarmReadiness(input: {
  next: Occurrence | null;
  status: ScheduleStatus | undefined;
  readiness: EngineReadiness | null;
  /** Engine read-back; null if it could not be read. */
  scheduled: ScheduledAlarm[] | null;
}): NextAlarmReadiness {
  const { next, status, readiness, scheduled } = input;
  if (!next) return { level: 'none', headline: 'No alarm set', reasons: [] };

  const blocking = (readiness?.items ?? []).filter((item) => item.status === 'blocking');
  const warnings = (readiness?.items ?? []).filter((item) => item.status === 'warning');
  const reasons: string[] = [];
  if (status?.state === 'failed') reasons.push(`Not scheduled: ${status.message}`);
  if (scheduled && !scheduled.some((entry) => entry.id === next.occurrenceKey)) {
    reasons.push('The system does not hold this alarm right now.');
  }
  if (!scheduled) reasons.push('Could not read what the system has scheduled.');
  if (!readiness) reasons.push('Could not check alarm permissions.');
  reasons.push(...blocking.map((item) => item.title));

  if (reasons.length > 0 || (readiness && !readiness.canRing)) {
    return { level: 'blocked', headline: 'Your next alarm may not ring', reasons };
  }
  if (warnings.length > 0) {
    return {
      level: 'at_risk',
      headline: 'Your next alarm is scheduled, with warnings',
      reasons: warnings.map((item) => item.title),
    };
  }
  return { level: 'ready', headline: 'Your next alarm is ready', reasons: [] };
}
