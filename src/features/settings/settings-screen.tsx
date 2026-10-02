import Constants from 'expo-constants';
import { router } from 'expo-router';

import { ListRow } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import { useAppServices } from '@/lib/app-services';

export function SettingsScreen() {
  const { engine } = useAppServices();
  return (
    <Screen>
      <Section title="Reliability">
        <ListRow
          title="Alarm reliability"
          detail="Permissions, system schedule and diagnostics"
          onPress={() => router.push('/settings/diagnostics')}
        />
      </Section>
      <Section title="O-Alarm Pro">
        <ListRow title="Upgrade to Pro" onPress={() => router.push('/paywall')} />
      </Section>
      <Section title="Account" footer="Your alarms work without an account.">
        <ListRow title="Sign in" value="Coming next" disabled />
      </Section>
      <Section title="About">
        <ListRow title="Version" value={Constants.expoConfig?.version ?? 'unknown'} />
        <Separator />
        <ListRow
          title="Alarm engine"
          value={engine.kind === 'native' ? 'Native' : 'Preview (will not ring)'}
        />
      </Section>
    </Screen>
  );
}
