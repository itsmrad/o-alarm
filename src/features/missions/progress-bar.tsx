import { View } from 'react-native';

/** Thick high-contrast progress bar for half-awake glances. */
export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max, now: Math.min(value, max) }}
      className="h-5 w-full overflow-hidden rounded-full bg-surface-muted"
    >
      <View className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </View>
  );
}
