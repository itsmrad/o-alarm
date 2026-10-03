import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ListRow } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import { deviceTimeZone } from '@/db/alarm-service';
import type { OccurrenceRow } from '@/db/repositories/occurrences';
import { nextAlarmOccurrence, type AppEvent } from '@/domain';
import {
  AlarmEngineError,
  type EngineReadiness,
  type ReadinessItem,
  type ScheduledAlarm,
} from '@/engine';
import { formatClockString } from '@/features/alarms/format';
import { useAlarms, useAppServices, useRingState } from '@/lib/app-services';

import { likelyMissCauses, nextAlarmReadiness, type ReadinessLevel } from './readiness-summary';

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

const LEVEL_CLASS: Record<ReadinessLevel, string> = {
  ready: 'text-success',
  at_risk: 'text-foreground',
  blocked: 'text-danger',
  none: 'text-foreground-muted',
};

const OUTCOME_LABEL: Record<OccurrenceRow['status'], string> = {
  scheduled: 'Scheduled',
  triggered: 'Rang',
  snoozed: 'Snoozed',
  dismissed: 'Stopped',
  missed: 'May not have rung',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
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

const clockOf = (iso: string) => {
  const date = new Date(iso);
  return formatClockString(date.getHours(), date.getMinutes());
};

const dayAndClock = (iso: string) =>
  `${new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${clockOf(iso)}`;

/**
 * Reliability diagnostics: will the next alarm ring, what the system holds vs the DB
 * (last reconcile), alarms that may not have rung and why, and a real test alarm.
 */
export function DiagnosticsScreen() {
  const { engine, alarms, ring } = useAppServices();
  const alarmList = useAlarms();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<'check' | 'test' | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastReconcile = useRingState((services) => services.ring.getLastReconcile());
  const history = useRingState((services) => services.ledger.recentOccurrences(10));

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
  }, [engine, alarms, refreshKey, lastReconcile]);

  const recheck = async () => {
    setBusy('check');
    try {
      await ring.sync('manual');
    } finally {
      setBusy(null);
      setRefreshKey((key) => key + 1);
    }
  };

  const testInOneMinute = async () => {
    setBusy('test');
    try {
      const entry = await alarms.scheduleTestAlarm(60_000);
      Alert.alert(
        'Test alarm set',
        engine.kind === 'preview'
          ? `It rings at ${clockOf(entry.fireAt)} — keep O-Alarm open: preview mode cannot ring in the background.`
          : `It rings at ${clockOf(entry.fireAt)}. Lock your phone to check it rings like a real alarm.`,
      );
    } catch (error) {
      Alert.alert('Could not set a test alarm', describeError(error));
    } finally {
      setBusy(null);
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
  const timeZone = deviceTimeZone();
  const next = nextAlarmOccurrence(alarmList, new Date(), timeZone);
  const summary = nextAlarmReadiness({
    next,
    status: next ? alarms.getStatus(next.alarmId) : undefined,
    readiness: snapshot.readiness,
    scheduled: snapshot.scheduled,
  });
  const labelOf = (alarmId: string | null) => {
    const alarm = alarmId ? alarms.get(alarmId) : null;
    return alarm ? alarm.label || formatClockString(alarm.hour, alarm.minute) : 'Deleted alarm';
  };
  const missed = history.filter((row) => row.status === 'missed');
  const causes = likelyMissCauses(engine.kind, snapshot.readiness);
  const failing = alarmList.filter((a) => alarms.getStatus(a.id)?.state === 'failed');
  const result = lastReconcile?.result;
  const repaired = result
    ? result.plan.schedule.length + result.plan.reschedule.length + result.plan.cancel.length
    : 0;

  return (
    <Screen>
      <Section title="Next alarm">
        <View className="gap-1 px-4 py-3" accessible accessibilityRole="summary">
          <Text className={`text-headline ${LEVEL_CLASS[summary.level]}`}>{summary.headline}</Text>
          {next ? (
            <Text className="text-subhead text-foreground-muted">
              {labelOf(next.alarmId)} · {dayAndClock(next.fireAt.toISOString())}
            </Text>
          ) : null}
          {summary.reasons.map((reason) => (
            <Text key={reason} className="text-footnote text-foreground-muted">
              • {reason}
            </Text>
          ))}
        </View>
      </Section>

      <Button
        title={busy === 'test' ? 'Setting test alarm…' : 'Run test alarm in 1 minute'}
        disabled={busy !== null}
        onPress={testInOneMinute}
      />

      {missed.length > 0 ? (
        <Section
          title="May not have rung"
          footer="O-Alarm expected these alarms but the system never reported them ringing."
        >
          {missed.map((row, index) => (
            <View key={row.id}>
              {index > 0 ? <Separator /> : null}
              <ListRow title={dayAndClock(row.expectedAt)} detail={labelOf(row.alarmId)} />
            </View>
          ))}
          <Separator />
          <View className="gap-2 px-4 py-3">
            <Text className="text-subhead font-semibold text-foreground">Likely causes</Text>
            {causes.map((cause) => (
              <View key={cause.title} className="gap-0.5">
                <Text className="text-subhead text-foreground">{cause.title}</Text>
                <Text className="text-footnote text-foreground-muted">{cause.detail}</Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}

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
        title="This device ↔ system"
        footer="O-Alarm compares its alarms with what the system holds on launch, on return, after each ring and when the time zone changes, and repairs any difference."
      >
        {result ? (
          <>
            <ListRow
              title={result.verified ? 'In sync' : 'Mismatch found'}
              detail={`Checked ${clockOf(lastReconcile.at)}${repaired ? ` · repaired: ${result.plan.schedule.length} missing, ${result.plan.reschedule.length} changed, ${result.plan.cancel.length} stale` : ''}`}
              accessory={
                <Text
                  className={`text-footnote font-semibold ${result.verified ? 'text-success' : 'text-danger'}`}
                >
                  {result.verified ? 'OK' : 'Check'}
                </Text>
              }
            />
            {result.failures.map((failure) => (
              <View key={`${failure.operation}-${failure.id}`}>
                <Separator />
                <ListRow
                  title={`${labelOf(failure.alarmId)}: could not ${failure.operation}`}
                  detail={`${failure.error.code}: ${failure.error.message}`}
                />
              </View>
            ))}
            {result.mismatches.map((id) => (
              <View key={`mismatch-${id}`}>
                <Separator />
                <ListRow
                  title={`${labelOf(id.split('@')[0] ?? null)}: system differs`}
                  detail={`After repair, the system still reports ${id} differently.`}
                />
              </View>
            ))}
          </>
        ) : (
          <ListRow title="Not checked yet" />
        )}
      </Section>

      {failing.length > 0 ? (
        <Section title="Not scheduled">
          {failing.map((alarm) => {
            const status = alarms.getStatus(alarm.id);
            return (
              <ListRow
                key={alarm.id}
                title={labelOf(alarm.id)}
                detail={
                  status?.state === 'failed' ? `${status.code}: ${status.message}` : undefined
                }
              />
            );
          })}
        </Section>
      ) : null}

      <Button
        variant="secondary"
        title={busy === 'check' ? 'Checking…' : 'Re-check now'}
        disabled={busy !== null}
        onPress={recheck}
      />

      <Section
        title={`Scheduled with the system (${engine.kind})`}
        footer="Each alarm keeps its next rings scheduled ahead."
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
                  title={dayAndClock(entry.fireAt)}
                  detail={`${entry.label} · ${entry.kind}`}
                />
              </View>
            ))
        ) : (
          <ListRow title="Nothing scheduled" />
        )}
      </Section>

      <Section title="Alarm history">
        {history.length ? (
          history.map((row, index) => (
            <View key={row.id}>
              {index > 0 ? <Separator /> : null}
              <ListRow
                title={dayAndClock(row.expectedAt)}
                detail={`${labelOf(row.alarmId)}${row.snoozeCount ? ` · snoozed ${row.snoozeCount}×` : ''}`}
                value={OUTCOME_LABEL[row.status]}
              />
            </View>
          ))
        ) : (
          <ListRow title="No alarms yet" />
        )}
      </Section>

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
