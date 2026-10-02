import { Host, Switch } from '@expo/ui';

/** Native toggle (SwiftUI / Compose via @expo/ui; runs in Expo Go). */
export function NativeSwitch({
  value,
  onValueChange,
  label,
  disabled,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  /** Accessibility label; visually hidden. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <Host matchContents accessibilityLabel={label}>
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
    </Host>
  );
}
