import { Text, View } from 'react-native';

import { formatClock } from '@/features/alarms/format';

/** Alarm time with locale-aware AM/PM and tabular digits. */
export function ClockText({
  hour,
  minute,
  size,
}: {
  hour: number;
  minute: number;
  size: 'display' | 'title';
}) {
  const { time, period } = formatClock(hour, minute);
  return (
    <View className="flex-row items-baseline gap-2">
      <Text
        className={`${size === 'display' ? 'text-display' : 'text-title1'} text-foreground`}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {time}
      </Text>
      {period ? <Text className="text-title3 text-foreground-muted">{period}</Text> : null}
    </View>
  );
}
