import type { SnoozePolicy } from './alarm';

const MINUTE_MS = 60_000;

/** Snoozes still available for the current occurrence. */
export function remainingSnoozes(policy: SnoozePolicy, snoozesUsed: number): number {
  if (!policy.enabled) return 0;
  return Math.max(0, policy.maxCount - snoozesUsed);
}

export function canSnooze(policy: SnoozePolicy, snoozesUsed: number): boolean {
  return remainingSnoozes(policy, snoozesUsed) > 0;
}

export interface SnoozeDecision {
  /** Absolute instant (not wall-clock) so a DST change mid-snooze cannot shift it. */
  fireAt: Date;
  /** Snooze count after this snooze. */
  snoozesUsed: number;
  remaining: number;
}

/** Next snooze re-trigger, or null when the limit is reached (the user must dismiss). */
export function nextSnooze(
  policy: SnoozePolicy,
  snoozesUsed: number,
  now: Date,
): SnoozeDecision | null {
  if (!canSnooze(policy, snoozesUsed)) return null;
  const used = snoozesUsed + 1;
  return {
    fireAt: new Date(now.getTime() + policy.durationMin * MINUTE_MS),
    snoozesUsed: used,
    remaining: remainingSnoozes(policy, used),
  };
}

/** Engine schedule id for the n-th snooze re-trigger of an occurrence (D13). */
export function snoozeScheduleId(occurrenceKey: string, snoozeNumber: number): string {
  return `${occurrenceKey}#snooze-${snoozeNumber}`;
}
