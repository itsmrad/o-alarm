import { router } from 'expo-router';

import { Button } from '@/components/button';
import { ComingNext } from '@/components/coming-next';
import { Screen } from '@/components/screen';

export function MissionScreen() {
  return (
    <Screen>
      <ComingNext
        step="wake missions"
        title="Missions"
        description="Prove you're awake before the alarm stops. Missions can be chained."
        bullets={[
          'Math (free)',
          'Shake (free)',
          'Steps (free)',
          'QR / barcode (Pro)',
          'Mission chains (Pro)',
        ]}
      />
      <Button title="Close" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
