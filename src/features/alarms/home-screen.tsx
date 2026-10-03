import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useIsFocused } from 'expo-router';
import { useEffect } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ClockText } from '@/components/clock-text';
import { HeaderButton } from '@/components/header-button';
import { ListRow } from '@/components/list-row';
import { NativeSwitch } from '@/components/native-switch';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import { deviceTimeZone, type ScheduleStatus } from '@/db/alarm-service';
import { computeNextFire, nextAlarmOccurrence, type Alarm } from '@/domain';
import { useAlarms, useAppServices, useNow, useRingState } from '@/lib/app-services';
import { useThemeColors } from '@/theme/tokens';

import {
  describeOccurrence,
  describeRepeat,
  formatClock,
  formatClockString,
  formatCountdown,
  formatRelativeDay,
} from './format';
import { confirmWeakening, detectWeakening } from './important-guard';

export function HomeScreen() {
  const alarms = useAlarms();
  const { alarms: service, ring } = useAppServices();
  const focused = useIsFocused();

  // Morning check-in queued by the final wake-up: shown once the alarm screens are gone.
  useEffect(() => {
    if (!focused) return;
    const open = () => {
      if (ring.takeCheckIn()) router.push('/checkin');
    };
    open();
    return ring.subscribe(open);
  }, [focused, ring]);
  const now = useNow();
  const timeZone = deviceTimeZone();
  const next = nextAlarmOccurrence(alarms, now, timeZone);
  const nextAlarm = next ? alarms.find((a) => a.id === next.alarmId) : undefined;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton label="Add alarm" icon="add" onPress={() => router.push('/alarm/new')} />
          ),
        }}
      />
      <Screen>
        <MissedBanner />
        <View className="gap-1 rounded-card bg-surface p-5" accessibilityRole="summary">
          <Text className="text-footnote font-semibold uppercase text-foreground-muted">
            Next alarm
          </Text>
          {next && nextAlarm ? (
            <>
              <ClockText hour={next.hour} minute={next.minute} size="display" />
              <Text className="text-headline text-foreground">
                {formatRelativeDay(next.fireAt, now, next.timeZone)} ·{' '}
                {formatCountdown(next.fireAt.getTime() - now.getTime())}
              </Text>
              {nextAlarm.label ? (
                <Text className="text-callout text-foreground-muted">{nextAlarm.label}</Text>
              ) : null}
              <StatusLine status={service.getStatus(nextAlarm.id)} />
            </>
          ) : (
            <Text className="py-2 text-title2 text-foreground">No alarm set</Text>
          )}
        </View>

        {alarms.length === 0 ? (
          <View className="gap-4 rounded-card bg-surface p-5">
            <Text className="text-body text-foreground-muted">
              Set when you need to wake up. No account needed.
            </Text>
            <Button title="Add alarm" size="lg" onPress={() => router.push('/alarm/new')} />
          </View>
        ) : (
          <Section title="Alarms">
            {alarms.map((alarm, index) => (
              <View key={alarm.id}>
                {index > 0 ? <Separator /> : null}
                <AlarmRow alarm={alarm} now={now} timeZone={timeZone} />
              </View>
            ))}
          </Section>
        )}
      </Screen>
    </>
  );
}

function AlarmRow({ alarm, now, timeZone }: { alarm: Alarm; now: Date; timeZone: string }) {
  const { alarms: service } = useAppServices();
  const status = service.getStatus(alarm.id);
  const next = computeNextFire(alarm, now, timeZone);
  const notes = [describeRepeat(alarm, now, timeZone)];
  if (alarm.label) notes.unshift(alarm.label);
  if (alarm.enabled && alarm.skipNext) notes.push('Skipping next');
  if (alarm.enabled && next?.overridden) {
    notes.push(`Next at ${formatClockString(next.hour, next.minute)}`);
  }
  const { time, period } = formatClock(alarm.hour, alarm.minute);

  return (
    <ListRow
      title={period ? `${time} ${period}` : time}
      detail={notes.join(' · ')}
      onPress={() => router.push({ pathname: '/alarm/[id]', params: { id: alarm.id } })}
      accessory={
        <View className="flex-row items-center gap-2">
          {alarm.enabled && status?.state === 'failed' ? (
            <Text className="text-footnote font-semibold text-danger">Not scheduled</Text>
          ) : null}
          <NativeSwitch
            label={`${alarm.enabled ? 'Disable' : 'Enable'} alarm ${time} ${period}`}
            value={alarm.enabled}
            onValueChange={async (enabled) => {
              const weakening = detectWeakening(alarm, { ...alarm, enabled }, new Date(), timeZone);
              const proceed = await confirmWeakening(weakening, (occurrence) =>
                describeOccurrence(occurrence, new Date()),
              );
              if (!proceed) return;
              // Never silent (D11): a failed schedule or write is surfaced right here.
              try {
                const result = await service.setEnabled(alarm.id, enabled);
                if (result.status.state === 'failed') {
                  Alert.alert(
                    'Saved, but not scheduled',
                    `The system did not accept this alarm: ${result.status.message}\n\nSee Settings → Reliability for details.`,
                  );
                }
              } catch (error) {
                Alert.alert(
                  'Could not update alarm',
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          />
        </View>
      }
    />
  );
}

function StatusLine({ status }: { status: ScheduleStatus | undefined }) {
  if (!status) return null;
  if (status.state === 'failed') {
    return (
      <Text className="pt-1 text-footnote font-semibold text-danger">
        Not scheduled with the system: {status.message}
      </Text>
    );
  }
  if (status.state === 'scheduled' && status.engine === 'preview') {
    return (
      <Text className="pt-1 text-footnote text-foreground-muted">
        Saved in preview only — it will not ring in Expo Go.
      </Text>
    );
  }
  return null;
}

/**
 * Reliability ledger on Home: an expected ring that never triggered. Honest wording —
 * "may not have rung" — because we only know the engine never reported it.
 */
function MissedBanner() {
  const { ledger, ring } = useAppServices();
  const colors = useThemeColors();
  const missed = useRingState((services) => services.ledger.unacknowledgedMissed());
  if (missed.length === 0) return null;
  const latest = new Date(missed[0]!.expectedAt);
  const message =
    missed.length === 1
      ? `An alarm may not have rung at ${formatClockString(latest.getHours(), latest.getMinutes())}`
      : `${missed.length} alarms may not have rung`;

  return (
    <View accessibilityRole="alert" className="gap-2 rounded-card bg-warning p-4">
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens reliability diagnostics"
        onPress={() => router.push('/settings/diagnostics')}
        className="flex-row items-start gap-3 active:opacity-70"
      >
        <Ionicons name="alert-circle" size={22} color={colors['warning-foreground']} />
        <Text className="flex-1 text-body font-semibold text-warning-foreground">
          {message} — see why
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          ledger.acknowledgeMissed();
          ring.notify();
        }}
        className="min-h-touch justify-center self-end px-2"
      >
        <Text className="text-subhead font-semibold text-warning-foreground">Dismiss</Text>
      </Pressable>
    </View>
  );
}
