import { Pressable, Text } from 'react-native';

type Variant = 'primary' | 'secondary' | 'destructive';

const containers: Record<Variant, string> = {
  primary: 'bg-accent',
  secondary: 'bg-surface-muted',
  destructive: 'bg-surface-muted',
};
const labels: Record<Variant, string> = {
  primary: 'text-accent-foreground',
  secondary: 'text-foreground',
  destructive: 'text-danger',
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  size?: 'md' | 'lg';
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      className={`items-center justify-center rounded-control px-5 active:opacity-70 ${
        size === 'lg' ? 'min-h-touch-lg' : 'min-h-touch'
      } ${containers[variant]} ${disabled ? 'opacity-40' : ''}`}
    >
      <Text className={`${size === 'lg' ? 'text-title3' : 'text-headline'} ${labels[variant]}`}>
        {title}
      </Text>
    </Pressable>
  );
}
