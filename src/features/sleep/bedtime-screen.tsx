import { ComingNext } from '@/components/coming-next';
import { Screen } from '@/components/screen';

export function BedtimeScreen() {
  return (
    <Screen>
      <ComingNext
        step="bedtime & sleep"
        title="Bedtime"
        description="Pick how much sleep you want; O-Alarm works back from your next alarm."
        bullets={['Bedtime target and reminder', 'Wind-down reminder', 'Morning energy check-in']}
      />
    </Screen>
  );
}
