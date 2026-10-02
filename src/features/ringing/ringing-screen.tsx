import { Stack, router, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ClockText } from '@/components/clock-text';
import { ComingNext } from '@/components/coming-next';
import { Screen } from '@/components/screen';
import { useAppServices, useNow } from '@/lib/app-services';

/**
 * Ringing alarm (layout only). The real ringing flow — sound, snooze limits, mission
 * gating, events — is build step 3 and runs natively first (D13/D14).
 */
export function RingingScreen() {
  const { alarmId } = useLocalSearchParams<{ alarmId?: string; occurrenceKey?: string }>();
  const { alarms } = useAppServices();
  const now = useNow(1_000);
  const alarm = alarmId ? alarms.get(alarmId) : null;

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <Screen scroll={false}>
        <View className="flex-1 items-center justify-center gap-2">
          <ClockText hour={now.getHours()} minute={now.getMinutes()} size="display" />
          <Text className="text-title2 text-foreground">{alarm?.label || 'Alarm'}</Text>
        </View>
        <ComingNext
          step="ringing experience"
          title="Ringing screen preview"
          description="This is where the alarm rings. Sound, snooze limits and mission-gated dismissal are built next."
        />
        <View className="gap-3">
          <Button title="Snooze" size="lg" variant="secondary" disabled onPress={() => undefined} />
          <Button title="Close preview" size="lg" onPress={() => router.back()} />
        </View>
      </Screen>
    </>
  );
}
