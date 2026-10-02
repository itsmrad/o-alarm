import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { Stack, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Platform, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { HeaderButton } from '@/components/header-button';
import { ListRow } from '@/components/list-row';
import { NativeSwitch } from '@/components/native-switch';
import { Screen } from '@/components/screen';
import { Section, Separator } from '@/components/section';
import { deviceTimeZone, type SaveResult } from '@/db/alarm-service';
import { computeNextFire, createAlarm, nextDateForTime, type Alarm, type Weekday } from '@/domain';
import { useAppServices, useNow } from '@/lib/app-services';
import { useThemeColors } from '@/theme/tokens';

import { ChipSelect } from './chip-select';
import { describeRepeat, formatClockString, formatCountdown, formatRelativeDay } from './format';
import { WeekdayPicker } from './weekday-picker';

const SNOOZE_MINUTES = [5, 9, 10, 15, 20] as const;
const SNOOZE_LIMITS = [1, 2, 3, 5] as const;

type SnoozeMinutes = (typeof SNOOZE_MINUTES)[number];
type SnoozeLimit = (typeof SNOOZE_LIMITS)[number];

const pick = <T extends number>(options: readonly T[], value: number, fallback: T): T =>
  (options as readonly number[]).includes(value) ? (value as T) : fallback;

/** Create (no id) or edit an alarm. Saves through the D11 write path. */
export function AlarmEditor({ alarmId }: { alarmId?: string }) {
  const { alarms: service } = useAppServices();
  const colors = useThemeColors();
  const now = useNow();
  const existing = useMemo(() => (alarmId ? service.get(alarmId) : null), [alarmId, service]);
  const base =
    existing ?? createAlarm({ id: 'draft', hour: 7, minute: 0, weekdays: [1, 2, 3, 4, 5] });

  const [hour, setHour] = useState(base.hour);
  const [minute, setMinute] = useState(base.minute);
  const [weekdays, setWeekdays] = useState<Weekday[]>(base.weekdays);
  const [label, setLabel] = useState(base.label);
  const [snoozeEnabled, setSnoozeEnabled] = useState(base.snooze.enabled);
  const [snoozeMinutes, setSnoozeMinutes] = useState<SnoozeMinutes>(
    pick(SNOOZE_MINUTES, base.snooze.durationMin, 9),
  );
  const [snoozeLimit, setSnoozeLimit] = useState<SnoozeLimit>(
    pick(SNOOZE_LIMITS, base.snooze.maxCount, 3),
  );
  const [vibration, setVibration] = useState(base.vibration);
  const [important, setImportant] = useState(base.important);
  const [saving, setSaving] = useState(false);

  const timeZone = deviceTimeZone();
  const pickerValue = useMemo(() => {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    return d;
  }, [hour, minute]);

  const draft = (): Omit<Alarm, 'id'> & { id?: string } => {
    const { id: _ignored, ...rest } = base;
    const timeChanged = !existing || existing.hour !== hour || existing.minute !== minute;
    return {
      ...rest,
      id: existing?.id,
      hour,
      minute,
      weekdays,
      date: weekdays.length === 0 ? nextDateForTime(hour, minute, new Date(), timeZone) : null,
      label: label.trim(),
      enabled: true,
      snooze: {
        enabled: snoozeEnabled,
        durationMin: snoozeMinutes,
        maxCount: snoozeEnabled ? snoozeLimit : 0,
      },
      vibration,
      important,
      // A new regular time supersedes a pending one-off change.
      oneOffOverride: timeChanged ? null : rest.oneOffOverride,
    };
  };

  const preview = useMemo(() => {
    const candidate = createAlarm({ ...draft(), id: existing?.id ?? 'preview' });
    return computeNextFire(candidate, now, timeZone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hour, minute, weekdays, now, timeZone]);

  const report = (result: SaveResult) => {
    if (result.status.state === 'failed') {
      Alert.alert(
        'Saved, but not scheduled',
        `The alarm is saved on this device, but the system did not accept it: ${result.status.message}\n\nSee Settings → Reliability for details.`,
      );
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      report(await service.save(draft()));
      router.back();
    } catch (error) {
      Alert.alert('Could not save alarm', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const run = async (action: () => Promise<SaveResult>) => {
    try {
      report(await action());
      router.back();
    } catch (error) {
      Alert.alert('Could not update alarm', error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDelete = () => {
    if (!existing) return;
    Alert.alert('Delete alarm?', 'This alarm will stop ringing.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const status = await service.remove(existing.id);
          if (status.state === 'failed') {
            Alert.alert('Deleted, but the system still has it', status.message);
          }
          router.back();
        },
      },
    ]);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: existing ? 'Edit Alarm' : 'New Alarm',
          headerLeft: () => <HeaderButton label="Cancel" onPress={() => router.back()} />,
          headerRight: () => (
            <HeaderButton label="Save" emphasized disabled={saving} onPress={save} />
          ),
        }}
      />
      <Screen>
        <View className="items-center overflow-hidden rounded-card bg-surface py-2">
          <DateTimePicker
            mode="time"
            value={pickerValue}
            presentation="inline"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            accentColor={colors.accent}
            onValueChange={(_event, date) => {
              setHour(date.getHours());
              setMinute(date.getMinutes());
            }}
          />
        </View>

        <Text accessibilityLiveRegion="polite" className="px-4 text-callout text-foreground-muted">
          {preview
            ? `Rings ${formatRelativeDay(preview.fireAt, now, preview.timeZone).toLowerCase()} at ${formatClockString(preview.hour, preview.minute)}, ${formatCountdown(preview.fireAt.getTime() - now.getTime())}.`
            : 'This alarm has no upcoming ring.'}
        </Text>

        <Section
          title="Repeat"
          footer={
            weekdays.length === 0
              ? 'No days selected: rings once.'
              : describeRepeat({ weekdays, date: null }, now, timeZone)
          }
        >
          <WeekdayPicker value={weekdays} onChange={setWeekdays} />
        </Section>

        <Section title="Label">
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="Alarm"
            maxLength={60}
            accessibilityLabel="Alarm label"
            placeholderTextColor={colors['foreground-muted']}
            className="min-h-touch px-4 py-3 text-body text-foreground"
            returnKeyType="done"
          />
        </Section>

        <Section title="Snooze" footer="A limit keeps snooze from becoming a way to oversleep.">
          <ListRow
            title="Allow snooze"
            accessory={
              <NativeSwitch
                label="Allow snooze"
                value={snoozeEnabled}
                onValueChange={setSnoozeEnabled}
              />
            }
          />
          {snoozeEnabled ? (
            <>
              <Separator />
              <Text className="px-4 pt-3 text-footnote text-foreground-muted">Length</Text>
              <ChipSelect
                label="Snooze length"
                options={SNOOZE_MINUTES}
                value={snoozeMinutes}
                onChange={setSnoozeMinutes}
                format={(m) => `${m} min`}
              />
              <Text className="px-4 text-footnote text-foreground-muted">Limit</Text>
              <ChipSelect
                label="Snooze limit"
                options={SNOOZE_LIMITS}
                value={snoozeLimit}
                onChange={setSnoozeLimit}
                format={(n) => `${n}×`}
              />
            </>
          ) : null}
        </Section>

        <Section title="Sound & behavior">
          <ListRow title="Sound" value="Default" />
          <Separator />
          <ListRow
            title="Vibrate"
            accessory={
              <NativeSwitch label="Vibrate" value={vibration} onValueChange={setVibration} />
            }
          />
          <Separator />
          <ListRow
            title="Important"
            detail="Warn before weakening this alarm close to ring time"
            accessory={
              <NativeSwitch label="Important" value={important} onValueChange={setImportant} />
            }
          />
        </Section>

        <Section title="Wake-up" footer="Missions and Wake Check arrive in a later update.">
          <ListRow title="Missions" value="None" disabled />
          <Separator />
          <ListRow title="Wake Check" value="Off" disabled />
        </Section>

        {existing ? (
          <View className="gap-3">
            {existing.weekdays.length > 0 && existing.enabled ? (
              <Button
                variant="secondary"
                title={existing.skipNext ? 'Undo skip next' : 'Skip next alarm'}
                onPress={() => run(() => service.toggleSkipNext(existing.id))}
              />
            ) : null}
            <Button
              variant="secondary"
              title="Test alarm"
              accessibilityHint="Rings this alarm now"
              onPress={() => {
                service
                  .testAlarm(existing.id)
                  .catch((error: unknown) =>
                    Alert.alert(
                      'Test failed',
                      error instanceof Error ? error.message : String(error),
                    ),
                  );
              }}
            />
            <Button variant="destructive" title="Delete alarm" onPress={confirmDelete} />
          </View>
        ) : null}
      </Screen>
    </>
  );
}
