import { Linking, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { ListRow } from '@/components/list-row';
import { NativeSwitch } from '@/components/native-switch';
import { Section, Separator } from '@/components/section';
import type { ReminderPrefs } from '@/domain/sleep-reminders';
import { ChipSelect } from '@/features/alarms/chip-select';

import type { SleepData } from './use-sleep-data';
import { useReminderPermission } from './use-sleep-reminders';

const CUTOFF_HOURS = [6, 8, 10] as const;

type ToggleKey = 'bedtime' | 'windDown' | 'caffeine' | 'morningLight' | 'morningMovement';

const ROWS: { key: ToggleKey; title: string; detail: string }[] = [
  { key: 'bedtime', title: 'Bedtime reminder', detail: 'A nudge when it is time to be in bed' },
  { key: 'windDown', title: 'Wind-down reminder', detail: 'Before bedtime, to start slowing down' },
  { key: 'caffeine', title: 'Caffeine cutoff', detail: 'Last call for coffee and tea' },
  { key: 'morningLight', title: 'Morning light', detail: '10 minutes after your alarm' },
  { key: 'morningMovement', title: 'Morning movement', detail: '30 minutes after your alarm' },
];

export function RemindersSection({ data }: { data: SleepData }) {
  const { service, reminderPrefs } = data;
  const { permission, request } = useReminderPermission();

  const toggle = (key: ToggleKey, value: boolean) => {
    service.setReminderPrefs({ [key]: value } as Partial<ReminderPrefs>);
    // Ask only now, in response to the user turning a reminder on.
    if (value && permission === 'undetermined') request().catch(() => undefined);
  };

  const anyOn = ROWS.some((row) => reminderPrefs[row.key]);

  return (
    <Section
      title="Reminders"
      footer="Reminders are gentle nudges. They will not ring through silent mode or Focus, and they never replace your alarm."
    >
      {ROWS.map((row, index) => (
        <View key={row.key}>
          {index > 0 ? <Separator /> : null}
          <ListRow
            title={row.title}
            detail={row.detail}
            accessory={
              <NativeSwitch
                label={row.title}
                value={reminderPrefs[row.key]}
                onValueChange={(value) => toggle(row.key, value)}
              />
            }
          />
          {row.key === 'caffeine' && reminderPrefs.caffeine ? (
            <ChipSelect
              label="Caffeine cutoff"
              options={CUTOFF_HOURS}
              value={
                (CUTOFF_HOURS as readonly number[]).includes(reminderPrefs.caffeineCutoffHours)
                  ? (reminderPrefs.caffeineCutoffHours as (typeof CUTOFF_HOURS)[number])
                  : 8
              }
              onChange={(caffeineCutoffHours) => service.setReminderPrefs({ caffeineCutoffHours })}
              format={(h) => `${h} hr before bed`}
            />
          ) : null}
        </View>
      ))}
      {anyOn && permission && permission !== 'granted' ? (
        <>
          <Separator />
          <PermissionNotice permission={permission} onRequest={request} />
        </>
      ) : null}
    </Section>
  );
}

function PermissionNotice({
  permission,
  onRequest,
}: {
  permission: 'denied' | 'undetermined' | 'unavailable';
  onRequest: () => Promise<unknown>;
}) {
  return (
    <View className="gap-3 p-4" accessibilityLiveRegion="polite">
      <Text className="text-callout font-semibold text-warning-foreground">
        {permission === 'unavailable'
          ? 'Reminders cannot be scheduled here.'
          : 'Reminders are not being delivered.'}
      </Text>
      <Text className="text-footnote text-foreground-muted">
        {permission === 'denied'
          ? 'Notifications are turned off for O-Alarm. Allow them in Settings to get these reminders.'
          : permission === 'undetermined'
            ? 'Allow notifications so these reminders can appear.'
            : 'Notifications are not available in this environment.'}
      </Text>
      {permission === 'denied' ? (
        <Button title="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} />
      ) : permission === 'undetermined' ? (
        <Button title="Allow notifications" onPress={() => void onRequest()} />
      ) : null}
    </View>
  );
}
