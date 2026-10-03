import { router } from 'expo-router';
import { Alert } from 'react-native';

import { ListRow } from '@/components/list-row';
import { Section, Separator } from '@/components/section';
import { useAccount } from '@/lib/auth';

import { confirm } from './confirm';

export function AccountSection() {
  const account = useAccount();

  if (!account.configured) {
    return (
      <Section
        title="Account"
        footer="Sign-in is not configured in this build. Your alarms work fully without an account."
      >
        <ListRow title="Account" value="Not configured" disabled />
      </Section>
    );
  }

  if (!account.signedIn) {
    return (
      <Section
        title="Account"
        footer="Your alarms work without an account. Sign in to back up your history and sync with Pro."
      >
        <ListRow title="Sign in" onPress={() => router.push('/sign-in')} />
      </Section>
    );
  }

  const signOut = async () => {
    const ok = await confirm(
      'Sign out?',
      'Your alarms stay on this device and keep ringing as set.',
      'Sign out',
      'default',
    );
    if (!ok) return;
    try {
      await account.signOut();
    } catch (error) {
      Alert.alert('Could not sign out', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Section title="Account">
      <ListRow
        title={account.displayName || account.email || 'Signed in'}
        detail={account.displayName && account.email ? account.email : 'Signed in'}
      />
      <Separator />
      <ListRow title="Sign out" onPress={signOut} />
    </Section>
  );
}
