import Ionicons from '@expo/vector-icons/Ionicons';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Separator } from '@/components/section';
import type { AlarmSound } from '@/domain';
import { useThemeColors } from '@/theme/tokens';

import { SOUND_OPTIONS, sameSound, type SoundOption } from './sounds';

/** Previews are short so a mis-tap never blares for long. */
const PREVIEW_MS = 4_000;

/**
 * Sound list with in-app preview: tapping a row selects it and plays a short sample;
 * tapping the playing row again stops it.
 */
export function SoundPicker({
  value,
  onChange,
}: {
  value: AlarmSound;
  onChange: (sound: AlarmSound) => void;
}) {
  const colors = useThemeColors();
  const player = useAudioPlayer(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPlaying(null);
    try {
      player.pause();
    } catch {
      // Released on unmount.
    }
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const select = (option: SoundOption) => {
    onChange(option.sound);
    if (playing === option.name) {
      stop();
      return;
    }
    stop();
    setPlaying(option.name);
    setAudioModeAsync({ playsInSilentMode: true })
      .catch(() => undefined)
      .finally(() => {
        player.replace(option.asset);
        player.loop = false;
        player.volume = 1;
        player.play();
      });
    timer.current = setTimeout(stop, PREVIEW_MS);
  };

  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Alarm sound">
      {SOUND_OPTIONS.map((option, index) => {
        const selected = sameSound(option.sound, value);
        const isPlaying = playing === option.name;
        return (
          <View key={option.name}>
            {index > 0 ? <Separator /> : null}
            <Pressable
              accessibilityRole="radio"
              accessibilityLabel={option.name}
              accessibilityState={{ selected }}
              accessibilityHint={isPlaying ? 'Stops the preview' : 'Selects and plays a preview'}
              onPress={() => select(option)}
              className="min-h-touch flex-row items-center gap-3 px-4 py-3 active:bg-surface-muted"
            >
              <Ionicons
                name={isPlaying ? 'stop-circle' : 'play-circle-outline'}
                size={24}
                color={colors.accent}
              />
              <Text className="flex-1 text-body text-foreground">{option.name}</Text>
              {selected ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : null}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
