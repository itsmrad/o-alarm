import { Text, View } from 'react-native';

/**
 * Honest placeholder for screens owned by later build steps (PRODUCT.md "Build Priority").
 * Shows the real layout intent without pretending the feature works.
 */
export function ComingNext({
  title,
  description,
  step,
  bullets = [],
}: {
  title: string;
  description: string;
  step: string;
  bullets?: string[];
}) {
  return (
    <View className="gap-3 rounded-card bg-surface p-5">
      <Text className="text-caption font-semibold uppercase text-accent">Coming next · {step}</Text>
      <Text className="text-title3 text-foreground">{title}</Text>
      <Text className="text-body text-foreground-muted">{description}</Text>
      {bullets.map((bullet) => (
        <Text key={bullet} className="text-callout text-foreground">
          • {bullet}
        </Text>
      ))}
    </View>
  );
}
