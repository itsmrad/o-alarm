import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useThemeColors } from '@/theme/tokens';

export function ListRow({
  title,
  detail,
  value,
  accessory,
  onPress,
  destructive,
  disabled,
}: {
  title: string;
  detail?: string;
  value?: string;
  accessory?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const colors = useThemeColors();
  const content = (
    <View
      className={`min-h-touch flex-row items-center gap-3 px-4 py-3 ${disabled ? 'opacity-50' : ''}`}
    >
      <View className="flex-1 gap-0.5">
        <Text className={`text-body ${destructive ? 'text-danger' : 'text-foreground'}`}>
          {title}
        </Text>
        {detail ? <Text className="text-footnote text-foreground-muted">{detail}</Text> : null}
      </View>
      {value ? <Text className="text-body text-foreground-muted">{value}</Text> : null}
      {accessory}
      {onPress && !accessory ? (
        <Ionicons name="chevron-forward" size={18} color={colors['foreground-muted']} />
      ) : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="active:bg-surface-muted"
    >
      {content}
    </Pressable>
  );
}
