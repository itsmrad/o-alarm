import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

/** Grouped section (HIG inset-grouped style). */
export function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {title ? (
        <Text className="px-4 text-footnote uppercase text-foreground-muted">{title}</Text>
      ) : null}
      <View className="overflow-hidden rounded-card bg-surface">{children}</View>
      {footer ? <Text className="px-4 text-footnote text-foreground-muted">{footer}</Text> : null}
    </View>
  );
}

export function Separator() {
  return <View className="ml-4 h-px bg-border" />;
}
