import { router } from 'expo-router';
import { Text } from 'react-native';

import { ListRow } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Section } from '@/components/section';
import { deviceTimeZone } from '@/db/alarm-service';
import { civilDate } from '@/domain/sleep';
import { shouldPromptCheckInAt } from '@/domain/sleep-reminders';
import { useAlarms, useNow } from '@/lib/app-services';

import { HistorySection } from './history-section';
import { NapSection } from './nap-section';
import { RemindersSection } from './reminders-section';
import { SleepSettingsSection } from './settings-section';
import { TonightSection } from './tonight-section';
import { useSleepData, type SleepData } from './use-sleep-data';
import { useSleepReminderSync } from './use-sleep-reminders';

export function BedtimeScreen() {
  const data = useSleepData();
  // Keep tonight's reminders in step with the next alarm while this tab is in use.
  useSleepReminderSync();
  return (
    <Screen>
      {data ? (
        <Content data={data} />
      ) : (
        <Text className="text-body text-foreground-muted">Loading…</Text>
      )}
    </Screen>
  );
}

function Content({ data }: { data: SleepData }) {
  const alarms = useAlarms();
  const now = useNow();
  const timeZone = deviceTimeZone();
  const promptCheckIn = shouldPromptCheckInAt({
    now,
    timeZone,
    hasEntryToday: data.service.hasCheckInEntry(civilDate(now, timeZone)),
  });

  return (
    <>
      <TonightSection data={data} alarms={alarms} now={now} />
      {promptCheckIn ? (
        <Section>
          <ListRow
            title="How did you wake up?"
            detail="A 10-second morning check-in"
            onPress={() => router.push('/checkin')}
          />
        </Section>
      ) : null}
      <SleepSettingsSection data={data} />
      <RemindersSection data={data} />
      <NapSection alarms={alarms} now={now} />
      <HistorySection data={data} now={now} />
    </>
  );
}
