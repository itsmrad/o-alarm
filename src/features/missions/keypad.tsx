import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import type { KeypadKey } from '@/domain/missions-math';
import { useThemeColors } from '@/theme/tokens';

const ROWS: readonly (readonly (KeypadKey | 'submit')[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['back', '0', 'submit'],
];

/**
 * Large in-app numeric keypad (no system keyboard: it would cover the screen, slow a
 * half-awake user down and offer autofill/suggestions).
 */
export function Keypad({
  onKey,
  onSubmit,
  canSubmit,
}: {
  onKey: (key: KeypadKey) => void;
  onSubmit: () => void;
  canSubmit: boolean;
}) {
  const colors = useThemeColors();
  return (
    <View className="gap-3">
      {ROWS.map((row) => (
        <View key={row.join('')} className="flex-row gap-3">
          {row.map((key) => {
            if (key === 'submit') {
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityLabel="Submit answer"
                  accessibilityState={{ disabled: !canSubmit }}
                  disabled={!canSubmit}
                  onPress={onSubmit}
                  className={`h-20 flex-1 items-center justify-center rounded-control bg-accent active:opacity-70 ${
                    canSubmit ? '' : 'opacity-40'
                  }`}
                >
                  <Ionicons name="checkmark" size={36} color={colors['accent-foreground']} />
                </Pressable>
              );
            }
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                accessibilityLabel={key === 'back' ? 'Delete' : key}
                onPress={() => onKey(key)}
                className="h-20 flex-1 items-center justify-center rounded-control bg-surface-muted active:opacity-60"
              >
                {key === 'back' ? (
                  <Ionicons name="backspace-outline" size={32} color={colors.foreground} />
                ) : (
                  <Text className="text-[34px] font-semibold text-foreground">{key}</Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
