import { Alert } from 'react-native';

import { computeNextFire, type Alarm, type Occurrence } from '@/domain';

/** An important alarm ringing within this window is "imminent" and protected. */
export const IMPORTANT_PROTECTION_MS = 12 * 3_600_000;

export interface Weakening {
  /** The protected ring that the change would weaken. */
  nextFire: Occurrence;
  reasons: string[];
}

const lenientSnooze = (before: Alarm['snooze'], after: Alarm['snooze']) =>
  after.enabled &&
  after.maxCount > 0 &&
  (!before.enabled ||
    before.maxCount === 0 ||
    after.maxCount > before.maxCount ||
    after.durationMin > before.durationMin);

const lenientWakeCheck = (before: Alarm['wakeCheck'], after: Alarm['wakeCheck']) =>
  after.delayMin > before.delayMin ||
  after.responseWindowSec > before.responseWindowSec ||
  after.maxRetriggers < before.maxRetriggers ||
  (before.method !== 'confirm' && after.method === 'confirm');

/**
 * Anti-oversleep protection (PRODUCT.md): does changing an imminent important alarm from
 * `before` to `after` (null = delete) make it less likely to wake the user? Pure.
 */
export function detectWeakening(
  before: Alarm,
  after: Alarm | null,
  now: Date,
  timeZone: string,
  windowMs = IMPORTANT_PROTECTION_MS,
): Weakening | null {
  if (!before.important) return null;
  const nextFire = computeNextFire(before, now, timeZone);
  if (!nextFire || nextFire.fireAt.getTime() - now.getTime() > windowMs) return null;

  const reasons: string[] = [];
  if (!after) reasons.push('deletes it');
  else if (!after.enabled) reasons.push('turns it off');
  else {
    const next = computeNextFire(after, now, timeZone);
    if (after.skipNext === nextFire.occurrenceKey) reasons.push('skips this ring');
    else if (!next || next.fireAt.getTime() > nextFire.fireAt.getTime()) {
      reasons.push('moves it later');
    }
    if (!after.important) reasons.push('removes the Important protection');
    if (lenientSnooze(before.snooze, after.snooze)) reasons.push('allows more or longer snoozes');
    if (after.missions.length < before.missions.length) reasons.push('removes a mission');
    if (before.missionBeforeSnooze && !after.missionBeforeSnooze) {
      reasons.push('lets you snooze without the mission');
    }
    if (before.wakeCheck.enabled && !after.wakeCheck.enabled) reasons.push('turns off Wake Check');
    else if (before.wakeCheck.enabled && lenientWakeCheck(before.wakeCheck, after.wakeCheck)) {
      reasons.push('makes Wake Check easier');
    }
  }
  return reasons.length ? { nextFire, reasons } : null;
}

const joinReasons = (reasons: string[]) =>
  reasons.length === 1
    ? reasons[0]!
    : `${reasons.slice(0, -1).join(', ')} and ${reasons[reasons.length - 1]}`;

/**
 * Confirm sheet for weakening an imminent important alarm. Resolves true to proceed.
 * No weakening → resolves true immediately.
 */
export function confirmWeakening(
  weakening: Weakening | null,
  describeTime: (occurrence: Occurrence) => string,
): Promise<boolean> {
  if (!weakening) return Promise.resolve(true);
  return new Promise((resolve) => {
    Alert.alert(
      'This is an important alarm',
      `It rings ${describeTime(weakening.nextFire)}. This change ${joinReasons(weakening.reasons)}.`,
      [
        { text: 'Keep alarm', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Change anyway', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
