import { formatDistanceToNowStrict } from 'date-fns';
import { router } from 'expo-router';

import { ListRow } from '@/components/list-row';
import { Section, Separator } from '@/components/section';
import { useNow } from '@/lib/app-services';
import { useSync } from '@/lib/sync';

const ago = (iso: string | null, now: Date) =>
  iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true }) : 'Never';

export function SyncSection() {
  const { availability, status, syncNow } = useSync();
  const now = useNow();

  if (availability === 'signed_out') return null;

  if (availability === 'not_configured') {
    return (
      <Section title="Cloud sync" footer="Cloud sync is not configured in this build.">
        <ListRow title="Cloud sync" value="Not configured" disabled />
      </Section>
    );
  }

  if (availability === 'free') {
    return (
      <Section
        title="Cloud sync"
        footer={
          status?.migratedAt
            ? 'Your history was backed up once when you signed in. Ongoing sync across devices is part of Pro.'
            : 'Ongoing sync across devices is part of Pro.'
        }
      >
        <ListRow title="Cloud sync" value="Pro" onPress={() => router.push('/paywall')} />
      </Section>
    );
  }

  const error = status?.lastError;
  return (
    <Section
      title="Cloud sync"
      footer="Sync runs in the background and never affects whether your alarms ring."
    >
      <ListRow
        title="Last synced"
        value={status?.running ? 'Syncing…' : ago(status?.lastSyncedAt ?? null, now)}
      />
      <Separator />
      <ListRow title="Pending changes" value={String(status?.pendingCount ?? 0)} />
      {error ? (
        <>
          <Separator />
          <ListRow
            title={status?.lastErrorKind === 'network' ? 'Offline — will retry' : 'Sync problem'}
            detail={error}
            destructive
          />
        </>
      ) : null}
      <Separator />
      <ListRow title="Sync now" disabled={status?.running} onPress={() => void syncNow()} />
    </Section>
  );
}
