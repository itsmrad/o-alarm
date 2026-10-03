import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { Screen } from '@/components/screen';
import { deviceTimeZone } from '@/db/alarm-service';

import { todayCivil } from './format';
import { useSleepService } from './use-sleep-data';

const ENERGY = ['Drained', 'Low', 'Okay', 'Good', 'Great'] as const;
const QUALITY = ['Awful', 'Poor', 'Fair', 'Good', 'Excellent'] as const;

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

function RatingRow({
  title,
  labels,
  value,
  onChange,
}: {
  title: string;
  labels: readonly string[];
  value: number | null;
  onChange: (value: number) => void;
}) {
  return (
    <View className="gap-3 rounded-card bg-surface p-5">
      <Text className="text-title3 text-foreground">{title}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={title} className="flex-row gap-2">
        {labels.map((label, index) => {
          const rating = index + 1;
          const selected = value === rating;
          return (
            <Pressable
              key={label}
              accessibilityRole="radio"
              accessibilityLabel={`${rating} of 5, ${label}`}
              accessibilityState={{ selected }}
              onPress={() => onChange(rating)}
              className={`min-h-touch-lg flex-1 items-center justify-center gap-1 rounded-control ${
                selected ? 'bg-accent' : 'bg-surface-muted'
              }`}
            >
              <Text
                className={`text-title2 ${selected ? 'text-accent-foreground' : 'text-foreground'}`}
              >
                {rating}
              </Text>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                className={`px-1 text-caption ${selected ? 'text-accent-foreground' : 'text-foreground-muted'}`}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Morning check-in: energy + sleep quality, one screen, skippable. */
export function CheckInScreen() {
  const service = useSleepService();
  const { wakeSessionId } = useLocalSearchParams<{ wakeSessionId?: string }>();
  const [energy, setEnergy] = useState<number | null>(null);
  const [quality, setQuality] = useState<number | null>(null);
  const date = todayCivil(new Date(), deviceTimeZone());

  const save = () => {
    if (!service) return;
    try {
      service.saveCheckIn({ date, energy, sleepQuality: quality, wakeSessionId });
      close();
    } catch (error) {
      Alert.alert('Could not save', error instanceof Error ? error.message : String(error));
    }
  };

  const skip = () => {
    try {
      service?.skipCheckIn(date, wakeSessionId);
    } finally {
      close();
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Good morning', presentation: 'modal' }} />
      <Screen>
        <Text className="px-1 text-callout text-foreground-muted">
          Two quick taps help O-Alarm learn what a good night looks like for you. Stays on your
          device.
        </Text>
        <RatingRow
          title="How is your energy?"
          labels={ENERGY}
          value={energy}
          onChange={setEnergy}
        />
        <RatingRow
          title="How did you sleep?"
          labels={QUALITY}
          value={quality}
          onChange={setQuality}
        />
        <Button
          title="Save"
          size="lg"
          disabled={!service || (energy === null && quality === null)}
          onPress={save}
        />
        <Button title="Skip" variant="secondary" onPress={skip} />
      </Screen>
    </>
  );
}
