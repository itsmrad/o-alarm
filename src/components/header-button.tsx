import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text } from 'react-native';

import { useThemeColors } from '@/theme/tokens';

export function HeaderButton({
  label,
  icon,
  onPress,
  emphasized,
  disabled,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  emphasized?: boolean;
  disabled?: boolean;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      className={`min-h-touch min-w-touch items-center justify-center px-1 ${disabled ? 'opacity-40' : ''}`}
    >
      {icon ? (
        <Ionicons name={icon} size={26} color={colors.accent} />
      ) : (
        <Text className={`text-body text-accent ${emphasized ? 'font-semibold' : ''}`}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
