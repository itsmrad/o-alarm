import { Text, View } from 'react-native';

export function ProBadge() {
  return (
    <View accessibilityLabel="Pro" className="rounded-full bg-accent px-2 py-0.5" accessible>
      <Text className="text-caption font-semibold text-accent-foreground">PRO</Text>
    </View>
  );
}
