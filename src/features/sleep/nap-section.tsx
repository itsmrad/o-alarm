import { useState } from 'react';
import { Alert, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ListRow } from '@/components/list-row';
import { Section, Separator } from '@/components/section';
import { deviceTimeZone } from '@/db/alarm-service';
import { computeNextFire, type Alarm } from '@/domain';
import { isNapAlarm } from '@/domain/sleep';
import { NAP_MINUTES, buildNapAlarm } from '@/domain/sleep-nap';
import { ChipSelect } from '@/features/alarms/chip-select';
import { formatClockString, formatCountdown } from '@/features/alarms/format';
import { useAppServices } from '@/lib/app-services';

type NapMinutes = (typeof NAP_MINUTES)[number];

/** Nap mode: a one-time alarm N minutes from now, saved through the normal alarm path. */
export function NapSection({ alarms, now }: { alarms: readonly Alarm[]; now: Date }) {
  const { alarms: service } = useAppServices();
  const [minutes, setMinutes] = useState<NapMinutes>(20);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const timeZone = deviceTimeZone();

  const naps = alarms
    .filter((a) => a.enabled && isNapAlarm(a))
    .flatMap((a) => {
      const next = computeNextFire(a, now, timeZone);
      return next ? [{ alarm: a, next }] : [];
    });

  const start = async () => {
    setBusy(true);
    try {
      const result = await service.save(buildNapAlarm(new Date(), minutes, timeZone));
      if (result.status.state === 'failed') {
        Alert.alert(
          'Saved, but not scheduled',
          `The system did not accept the nap alarm: ${result.status.message}\n\nSee Settings → Reliability for details.`,
        );
        setNotice(null);
      } else if (result.status.state === 'scheduled' && result.status.engine === 'preview') {
        setNotice('Preview mode: this nap alarm will not ring in Expo Go.');
      } else {
        setNotice(null);
      }
    } catch (error) {
      Alert.alert('Could not set nap', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Nap" footer="A one-time alarm, with no snooze. It rings like any other alarm.">
      {naps.map(({ alarm, next }) => (
        <View key={alarm.id}>
          <ListRow
            title={`Nap alarm at ${formatClockString(next.hour, next.minute)}`}
            detail={formatCountdown(next.fireAt.getTime() - now.getTime())}
            accessory={
              <Button
                title="Cancel"
                variant="secondary"
                onPress={async () => {
                  // Never silent (D11): if the OS still holds it, the nap would still ring.
                  try {
                    const status = await service.remove(alarm.id);
                    if (status.state === 'failed') {
                      Alert.alert('Cancelled, but the system still has it', status.message);
                    }
                  } catch (error) {
                    Alert.alert(
                      'Could not cancel nap',
                      error instanceof Error ? error.message : String(error),
                    );
                  }
                }}
              />
            }
          />
          <Separator />
        </View>
      ))}
      <Text className="px-4 pt-3 text-footnote text-foreground-muted">Wake me in</Text>
      <ChipSelect
        label="Nap length"
        options={NAP_MINUTES}
        value={minutes}
        onChange={setMinutes}
        format={(m) => `${m} min`}
      />
      <View className="px-4 pb-4">
        <Button title="Start nap alarm" disabled={busy} onPress={start} />
      </View>
      {notice ? (
        <Text
          accessibilityLiveRegion="polite"
          className="px-4 pb-4 text-footnote text-warning-foreground"
        >
          {notice}
        </Text>
      ) : null}
    </Section>
  );
}
