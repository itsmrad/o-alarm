import { Pressable, Text, View } from 'react-native';

/** Small single-choice control for numeric options (snooze length, limits). */
export function ChipSelect<T extends number>({
  options,
  value,
  onChange,
  format,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  format: (value: T) => string;
  label: string;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      className="flex-row flex-wrap gap-2 px-4 pb-3"
    >
      {options.map((option) => {
        const selected = option === value;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(option)}
            className={`min-h-touch min-w-touch items-center justify-center rounded-control px-3 ${
              selected ? 'bg-accent' : 'bg-surface-muted'
            }`}
          >
            <Text
              className={`text-callout ${selected ? 'text-accent-foreground' : 'text-foreground'}`}
            >
              {format(option)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
