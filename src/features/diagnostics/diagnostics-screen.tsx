import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ListRow } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import {
  AlarmEngineError,
  type EngineReadiness,
  type ReadinessItem,
  type ReconcileResult,
  type ScheduledAlarm,
} from '@/engine';
import type { AppEvent } from '@/domain';
import { useAppServices } from '@/lib/app-services';

const STATUS_LABEL: Record<ReadinessItem['status'], string> = {
  ok: 'OK',
  warning: 'Check',
  blocking: 'Blocking',
  unknown: 'Unknown',
};

const STATUS_CLASS: Record<ReadinessItem['status'], string> = {
  ok: 'text-success',
  warning: 'text-foreground',
  blocking: 'text-danger',
  unknown: 'text-foreground-muted',
};

/** D14 and other platform truths. Shown always; never claim what the OS cannot do. */
const PLATFORM_LIMITATIONS: ReadinessItem[] =
  Platform.OS === 'ios'
    ? [
        {
          kind: 'platform_limitation',
          status: 'warning',
          title: 'System Stop button',
          detail:
            "iOS shows its own Stop button on alarms. If it is used before your mission is done, O-Alarm schedules a follow-up alarm — it can't block the button itself.",
          action: null,
        },
      ]
    : [];

interface Snapshot {
  readiness: EngineReadiness | null;
  readinessError: string | null;
  scheduled: ScheduledAlarm[] | null;
  scheduledError: string | null;
  events: AppEvent[];
}

const describeError = (error: unknown) => {
  const e = AlarmEngineError.from(error);
  return `${e.code}: ${e.message}`;
};

/** Reliability diagnostics: engine readiness, what the OS holds vs the DB, recent events. */
export function DiagnosticsScreen() {
  const { engine, alarms } = useAppServices();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [lastRun, setLastRun] = useState<ReconcileResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.allSettled([engine.getReadiness(), engine.getScheduled()]).then(
      ([readiness, scheduled]) => {
        if (!active) return;
        setSnapshot({
          readiness: readiness.status === 'fulfilled' ? readiness.value : null,
          readinessError: readiness.status === 'rejected' ? describeError(readiness.reason) : null,
          scheduled: scheduled.status === 'fulfilled' ? scheduled.value : null,
          scheduledError: scheduled.status === 'rejected' ? describeError(scheduled.reason) : null,
          events: alarms.events.list({ limit: 20 }),
        });
      },
    );
    return () => {
      active = false;
    };
  }, [engine, alarms, refreshKey]);

  const reconcileNow = async () => {
    setBusy(true);
    try {
      setLastRun(await alarms.reconcileAll());
    } finally {
      setBusy(false);
      setRefreshKey((key) => key + 1);
    }
  };

  if (!snapshot) {
    return (
      <Screen>
        <ActivityIndicator />
      </Screen>
    );
  }

  const items = [
    ...(snapshot.readiness?.items ?? []),
    ...(snapshot.readinessError
      ? [
          {
            kind: 'engine',
            status: 'blocking',
            title: 'Alarm engine not responding',
            detail: snapshot.readinessError,
            action: null,
          } satisfies ReadinessItem,
        ]
      : []),
    ...PLATFORM_LIMITATIONS,
  ];
  const failing = alarms.list().filter((a) => alarms.getStatus(a.id)?.state === 'failed');

  return (
    <Screen>
      <Section
        title="Readiness"
        footer={
          snapshot.readiness?.canRing
            ? 'Your alarms can ring.'
            : 'Alarms may not ring until the blocking items are fixed.'
        }
      >
        {items.map((item, index) => (
          <View key={`${item.kind}-${index}`}>
            {index > 0 ? <Separator /> : null}
            <ListRow
              title={item.title}
              detail={item.detail}
              accessory={
                <Text className={`text-footnote font-semibold ${STATUS_CLASS[item.status]}`}>
                  {STATUS_LABEL[item.status]}
                </Text>
              }
            />
          </View>
        ))}
      </Section>

      <Section
        title={`Scheduled with the system (${engine.kind})`}
        footer="Each alarm keeps its next rings scheduled ahead. O-Alarm re-checks on launch, on return and when the time zone changes."
      >
        {snapshot.scheduledError ? (
          <ListRow title="Could not read the system schedule" detail={snapshot.scheduledError} />
        ) : snapshot.scheduled?.length ? (
          snapshot.scheduled
            .slice()
            .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))
            .map((entry, index) => (
              <View key={entry.id}>
                {index > 0 ? <Separator /> : null}
                <ListRow
                  title={new Date(entry.fireAt).toLocaleString()}
                  detail={`${entry.label} · ${entry.kind}`}
                />
              </View>
            ))
        ) : (
          <ListRow title="Nothing scheduled" />
        )}
      </Section>

      {failing.length > 0 ? (
        <Section title="Not scheduled">
          {failing.map((alarm) => {
            const status = alarms.getStatus(alarm.id);
            return (
              <ListRow
                key={alarm.id}
                title={alarm.label || `${alarm.hour}:${String(alarm.minute).padStart(2, '0')}`}
                detail={
                  status?.state === 'failed' ? `${status.code}: ${status.message}` : undefined
                }
              />
            );
          })}
        </Section>
      ) : null}

      <Button
        title={busy ? 'Checking…' : 'Re-check schedule'}
        disabled={busy}
        onPress={reconcileNow}
      />
      {lastRun ? (
        <Text className="px-4 text-footnote text-foreground-muted">
          {lastRun.verified ? 'Verified.' : 'Not verified.'} Scheduled{' '}
          {lastRun.plan.schedule.length}, updated {lastRun.plan.reschedule.length}, removed{' '}
          {lastRun.plan.cancel.length}, unchanged {lastRun.plan.unchanged.length}
          {lastRun.failures.length ? `, ${lastRun.failures.length} failed` : ''}.
        </Text>
      ) : null}

      <Section title="Recent events">
        {snapshot.events.length ? (
          snapshot.events.map((event, index) => (
            <View key={event.id}>
              {index > 0 ? <Separator /> : null}
              <ListRow title={event.type} detail={new Date(event.occurredAt).toLocaleString()} />
            </View>
          ))
        ) : (
          <ListRow title="No events yet" />
        )}
      </Section>
    </Screen>
  );
}
