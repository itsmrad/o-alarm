import { ComingNext } from '@/components/coming-next';
import { Screen } from '@/components/screen';

export function InsightsScreen() {
  return (
    <Screen>
      <ComingNext
        step="insights"
        title="Insights"
        description="See what actually gets you up: snoozes, missions, Wake Check results and how you feel in the morning."
        bullets={['Wake success over time', 'Weekly wake report', 'Mission recommendations']}
      />
    </Screen>
  );
}
