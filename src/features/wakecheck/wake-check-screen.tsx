import { router } from 'expo-router';

import { Button } from '@/components/button';
import { ComingNext } from '@/components/coming-next';
import { Screen } from '@/components/screen';

export function WakeCheckScreen() {
  return (
    <Screen>
      <ComingNext
        step="wake check"
        title="Wake Check"
        description="A few minutes after you dismiss, O-Alarm checks that you're still up. No answer and the alarm rings again."
        bullets={['Confirm, movement or a short mission', 'Re-rings even if the app was closed']}
      />
      <Button title="Close" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
