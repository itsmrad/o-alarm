import { Stack, router } from 'expo-router';
import { Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ClockText } from '@/components/clock-text';
import { HeaderButton } from '@/components/header-button';
import { ListRow } from '@/components/list-row';
import { NativeSwitch } from '@/components/native-switch';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import { deviceTimeZone, type ScheduleStatus } from '@/db/alarm-service';
import { computeNextFire, nextAlarmOccurrence, type Alarm } from '@/domain';
import { useAlarms, useAppServices, useNow } from '@/lib/app-services';

import {
  describeRepeat,
  formatClock,
  formatClockString,
  formatCountdown,
  formatRelativeDay,
} from './format';

export function HomeScreen() {
  const alarms = useAlarms();
  const { alarms: service } = useAppServices();
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
            onValueChange={(enabled) => {
              service.setEnabled(alarm.id, enabled).catch(() => undefined);
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
