import { setAudioModeAsync, useAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';

import type { AlarmSound, Escalation } from '@/domain';
import { soundOption } from '@/features/alarms/sounds';

/** Volume while a mission is on screen: still audible, but the user can think. */
export const DUCKED_VOLUME = 0.08;
/** Starting volume when gradual escalation is on. */
export const ESCALATION_START_VOLUME = 0.15;
const RAMP_TICK_MS = 500;
const VIBRATION_INTERVAL_MS = 1_200;

/** Sets a player's volume; a player already released on unmount is ignored. */
function setVolume(player: AudioPlayer, volume: number): void {
  try {
    player.volume = volume;
  } catch {
    // Released.
  }
}

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
 * `ducked` (a mission is on top) drops to a low volume and pauses haptics; un-ducking
 * restores the escalation curve where it would be.
 */
export function useRingingFeedback({
  active,
  sound,
  escalation,
  vibration,
  ducked = false,
}: {
  active: boolean;
  ducked?: boolean;
  sound: AlarmSound;
  escalation: Escalation;
  vibration: boolean;
}): void {
  const player = useAudioPlayer(soundOption(sound).asset);
  const duckedRef = useRef(ducked);
  const startedAtRef = useRef(0);

  useEffect(() => {
    duckedRef.current = ducked;
    if (!active) return;
    setVolume(
      player,
      ducked ? DUCKED_VOLUME : escalationVolume(escalation, Date.now() - startedAtRef.current),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ducked, active, player]);

  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    startedAtRef.current = startedAt;
    let stopped = false;
    const volumeNow = () =>
      duckedRef.current ? DUCKED_VOLUME : escalationVolume(escalation, Date.now() - startedAt);
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    })
      .catch(() => undefined)
      .finally(() => {
        if (stopped) return;
        player.loop = true;
        player.volume = volumeNow();
        player.play();
      });
    const ramp = setInterval(() => {
      player.volume = volumeNow();
    }, RAMP_TICK_MS);
    const buzz = vibration
      ? setInterval(() => {
          if (duckedRef.current) return;
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
