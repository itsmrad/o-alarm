import { remainingSnoozes, type SnoozePolicy } from '@/domain';

export interface SnoozeControl {
  /** False when snooze is off for this alarm: no button, only `detail`. */
  visible: boolean;
  enabled: boolean;
  label: string;
  /** Always-visible line under the button; says why it is disabled. */
  detail: string;
  /** Route through the mission before snoozing (D32). */
  requiresMission: boolean;
}

/**
 * What the Snooze control shows for a half-awake user. The ring lifecycle and the engine
 * enforce the same limit again (defense in depth); this only decides the UI.
 */
export function snoozeControl(input: {
  policy: SnoozePolicy;
  snoozesUsed: number;
  missionBeforeSnooze: boolean;
  hasMissions: boolean;
}): SnoozeControl {
  const { policy, snoozesUsed } = input;
  const requiresMission = input.missionBeforeSnooze && input.hasMissions;
  if (!policy.enabled || policy.maxCount === 0) {
    return {
      visible: false,
      enabled: false,
      label: 'Snooze',
      detail: 'Snooze is off for this alarm.',
      requiresMission,
    };
  }
  const remaining = remainingSnoozes(policy, snoozesUsed);
  const label = `Snooze ${policy.durationMin} min`;
  if (remaining === 0) {
    return {
      visible: true,
      enabled: false,
      label,
      detail: `No snoozes left (${policy.maxCount} of ${policy.maxCount} used).`,
      requiresMission,
    };
  }
  const left = `${remaining} ${remaining === 1 ? 'snooze' : 'snoozes'} left`;
  return {
    visible: true,
    enabled: true,
    label,
    detail: requiresMission ? `${left} · mission first` : left,
    requiresMission,
  };
}

/** Label of the hold-to-stop control: missions gate dismissal (D14). */
export function stopLabel(hasMissions: boolean): string {
  return hasMissions ? 'Hold to start mission' : 'Hold to stop';
}
