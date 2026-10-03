import { Pressable, Text, View } from 'react-native';

/** Single-choice chips used by the per-mission config editors. */
export function OptionChips<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="text-footnote uppercase text-foreground-muted">{label}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        className="flex-row flex-wrap gap-2"
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={String(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.value)}
              className={`min-h-touch min-w-touch items-center justify-center rounded-control px-4 ${
                selected ? 'bg-accent' : 'bg-surface-muted'
              }`}
            >
              <Text
                className={`text-callout ${selected ? 'text-accent-foreground' : 'text-foreground'}`}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
