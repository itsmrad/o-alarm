import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { PREVIEW_MODE_MESSAGE } from '@/engine';
import { useAppServices } from '@/lib/app-services';
import { useThemeColors } from '@/theme/tokens';

/**
 * D6: persistent, non-dismissable notice whenever the preview engine is active.
 * Rendered by every screen via <Screen>, so it is visible everywhere in Expo Go.
 */
export function PreviewBanner() {
  const { engine } = useAppServices();
  const colors = useThemeColors();
  if (engine.kind !== 'preview') return null;
  return (
    <View
      accessibilityRole="alert"
      className="flex-row items-start gap-3 rounded-control bg-warning px-4 py-3"
    >
      <Ionicons name="warning" size={20} color={colors['warning-foreground']} />
      <Text className="flex-1 text-subhead font-semibold text-warning-foreground">
        {PREVIEW_MODE_MESSAGE}
      </Text>
    </View>
  );
}
