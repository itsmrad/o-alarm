import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';

import type { AlarmSound, Escalation } from '@/domain';
import { soundOption } from '@/features/alarms/sounds';

/** Starting volume when gradual escalation is on. */
export const ESCALATION_START_VOLUME = 0.15;
const RAMP_TICK_MS = 500;
const VIBRATION_INTERVAL_MS = 1_200;

/** Volume `elapsedMs` into a ring: linear ramp to full over `rampSeconds`, else full. */
export function escalationVolume(escalation: Escalation, elapsedMs: number): number {
  if (!escalation.enabled || escalation.rampSeconds <= 0) return 1;
  const progress = Math.min(1, elapsedMs / (escalation.rampSeconds * 1_000));
  return ESCALATION_START_VOLUME + (1 - ESCALATION_START_VOLUME) * progress;
}

/**
 * In-app alarm sound + haptics, for the preview engine only (Expo Go, D6). The native
 * engine plays sound/vibration itself, so `active` must be false there — never both.
 * Loops the alarm's sound, escalates volume if configured, stops when inactive/unmounted.
 */
export function useRingingFeedback({
  active,
  sound,
  escalation,
  vibration,
}: {
  active: boolean;
  sound: AlarmSound;
  escalation: Escalation;
  vibration: boolean;
}): void {
  const player = useAudioPlayer(soundOption(sound).asset);

  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    let stopped = false;
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    })
      .catch(() => undefined)
      .finally(() => {
        if (stopped) return;
        player.loop = true;
        player.volume = escalationVolume(escalation, 0);
        player.play();
      });
    const ramp = setInterval(() => {
      player.volume = escalationVolume(escalation, Date.now() - startedAt);
    }, RAMP_TICK_MS);
    const buzz = vibration
      ? setInterval(() => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
            () => undefined,
          );
        }, VIBRATION_INTERVAL_MS)
      : null;
    return () => {
      stopped = true;
      clearInterval(ramp);
      if (buzz) clearInterval(buzz);
      try {
        player.pause();
      } catch {
        // Player already released on unmount.
      }
    };
    // Restart only when the ring itself changes, not on every escalation object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, player, vibration, escalation.enabled, escalation.rampSeconds]);
}
