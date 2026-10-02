import { router } from 'expo-router';

import { Button } from '@/components/button';
import { ComingNext } from '@/components/coming-next';
import { Screen } from '@/components/screen';

export function PaywallScreen() {
  return (
    <Screen>
      <ComingNext
        step="O-Alarm Pro"
        title="O-Alarm Pro"
        description="Core alarm reliability is always free. Pro adds advanced missions, chains, insights and sync."
        bullets={['$1.99 / month', '$14.99 / year']}
      />
      <Button title="Close" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
