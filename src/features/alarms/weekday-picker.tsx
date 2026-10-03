import { Pressable, Text, View } from 'react-native';

import type { Weekday } from '@/domain';

import { WEEKDAY_LETTERS, WEEKDAY_ORDER, weekdayShort } from './format';

export function WeekdayPicker({
  value,
  onChange,
}: {
  value: Weekday[];
  onChange: (value: Weekday[]) => void;
}) {
  return (
    <View className="flex-row justify-between px-3 py-3">
      {WEEKDAY_ORDER.map((day) => {
        const selected = value.includes(day);
        return (
          <Pressable
            key={day}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={weekdayShort(day)}
            onPress={() =>
              onChange(selected ? value.filter((d) => d !== day) : [...value, day].sort())
            }
            className={`h-11 w-11 items-center justify-center rounded-full ${
              selected ? 'bg-accent' : 'bg-surface-muted'
            }`}
          >
            <Text
              className={`text-headline ${selected ? 'text-accent-foreground' : 'text-foreground'}`}
            >
              {WEEKDAY_LETTERS[day]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
