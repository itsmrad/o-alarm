import Constants from 'expo-constants';
import { router } from 'expo-router';

import { ListRow } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import { AccountSection } from '@/features/account/account-section';
import { SyncSection } from '@/features/account/sync-section';
import { useAppServices } from '@/lib/app-services';

import { DataSection } from './data-section';
import { PrivacySection } from './privacy-section';

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
      <AccountSection />
      <SyncSection />
      <Section title="O-Alarm Pro">
        <ListRow title="Upgrade to Pro" onPress={() => router.push('/paywall')} />
      </Section>
      <PrivacySection />
      <DataSection />
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
