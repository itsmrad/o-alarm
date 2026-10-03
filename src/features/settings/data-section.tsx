import { useState } from 'react';
import { Alert, Share } from 'react-native';

import { ListRow } from '@/components/list-row';
import { Section, Separator } from '@/components/section';
import { confirm } from '@/features/account/confirm';
import { useAccount } from '@/lib/auth';
import { useAppServices } from '@/lib/app-services';
import { useSync, wipeLocalData } from '@/lib/sync';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Export / delete my data (docs/PRODUCT.md "support export/delete"). */
export function DataSection() {
  const services = useAppServices();
  const account = useAccount();
  const { cloud } = useSync();
  const [busy, setBusy] = useState<'export' | 'delete' | 'wipe' | null>(null);

  const eraseDevice = async () => {
    setBusy('wipe');
    try {
      await wipeLocalData(services);
    } catch (error) {
      Alert.alert('Could not erase this device', message(error));
    } finally {
      setBusy(null);
    }
  };

  const exportData = async () => {
    if (!cloud) return;
    setBusy('export');
    try {
      const data = await cloud.exportMyData();
      await Share.share({ title: 'O-Alarm data export', message: JSON.stringify(data, null, 2) });
    } catch (error) {
      Alert.alert('Export failed', `${message(error)}\n\nCheck your connection and try again.`);
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    if (!cloud) return;
    const first = await confirm(
      'Delete your account?',
      'This permanently deletes your account and all of your data in the cloud.',
      'Continue',
    );
    if (!first) return;
    const second = await confirm(
      'Are you absolutely sure?',
      'This cannot be undone. A subscription is not cancelled by deleting your account — manage it in your store settings.',
      'Delete account',
    );
    if (!second) return;
    setBusy('delete');
    try {
      await cloud.deleteMyData();
      await account.deleteUser();
    } catch (error) {
      setBusy(null);
      Alert.alert('Deletion failed', `${message(error)}\n\nNothing on this device was changed.`);
      return;
    }
    setBusy(null);
    const wipe = await confirm(
      'Account deleted',
      'Also erase alarms and history on this device? If you keep them, your alarms keep ringing as set.',
      'Erase this device',
    );
    if (wipe) await eraseDevice();
  };

  const confirmErase = async () => {
    const first = await confirm(
      'Erase data on this device?',
      'Deletes every alarm, its system schedule, and all history stored on this device.',
      'Continue',
    );
    if (!first) return;
    const second = await confirm(
      'Erase everything?',
      'Your alarms will no longer ring. This cannot be undone.',
      'Erase',
    );
    if (second) await eraseDevice();
  };

  const signedInCloud = account.signedIn && cloud;
  return (
    <Section
      title="Your data"
      footer={
        signedInCloud
          ? 'Export downloads everything stored in the cloud for your account as JSON.'
          : 'Everything you create is stored only on this device until you sign in.'
      }
    >
      {signedInCloud ? (
        <>
          <ListRow
            title={busy === 'export' ? 'Exporting…' : 'Export my data'}
            disabled={busy !== null}
            onPress={() => void exportData()}
          />
          <Separator />
          <ListRow
            title={busy === 'delete' ? 'Deleting…' : 'Delete account and cloud data'}
            destructive
            disabled={busy !== null}
            onPress={() => void deleteAccount()}
          />
          <Separator />
        </>
      ) : null}
      <ListRow
        title={busy === 'wipe' ? 'Erasing…' : 'Erase data on this device'}
        destructive
        disabled={busy !== null}
        onPress={() => void confirmErase()}
      />
    </Section>
  );
}
