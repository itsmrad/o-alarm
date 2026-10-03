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
import {
  computeNextFire,
  createAlarm,
  nextDateForTime,
  setOneOffOverride,
  toggleSkipNext,
  type Alarm,
  type AlarmSound,
  type Occurrence,
  type Weekday,
} from '@/domain';
import { useAppServices, useNow } from '@/lib/app-services';
import { useThemeColors } from '@/theme/tokens';

import { ChipSelect } from './chip-select';
import { describeOccurrence, describeRepeat, formatClockString, formatCountdown } from './format';
import { confirmWeakening, detectWeakening } from './important-guard';
import { SoundPicker } from './sound-picker';
import { soundOption } from './sounds';
import { WeekdayPicker } from './weekday-picker';

const SNOOZE_MINUTES = [5, 9, 10, 15, 20] as const;
const SNOOZE_LIMITS = [1, 2, 3, 5, 10] as const;
const RAMP_SECONDS = [15, 30, 60, 120] as const;

type SnoozeMinutes = (typeof SNOOZE_MINUTES)[number];
type SnoozeLimit = (typeof SNOOZE_LIMITS)[number];
type RampSeconds = (typeof RAMP_SECONDS)[number];

const pick = <T extends number>(options: readonly T[], value: number, fallback: T): T =>
  (options as readonly number[]).includes(value) ? (value as T) : fallback;

/** Leaves the editor; falls back to Home when opened directly (deep link). */
const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

const timeOf = (hour: number, minute: number) => {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
};

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
  const [sound, setSound] = useState<AlarmSound>(base.sound);
  const [soundOpen, setSoundOpen] = useState(false);
  const [vibration, setVibration] = useState(base.vibration);
  const [escalate, setEscalate] = useState(base.escalation.enabled);
  const [rampSeconds, setRampSeconds] = useState<RampSeconds>(
    pick(RAMP_SECONDS, base.escalation.rampSeconds, 30),
  );
  const [snoozeEnabled, setSnoozeEnabled] = useState(base.snooze.enabled);
  const [snoozeMinutes, setSnoozeMinutes] = useState<SnoozeMinutes>(
    pick(SNOOZE_MINUTES, base.snooze.durationMin, 9),
  );
  const [snoozeLimit, setSnoozeLimit] = useState<SnoozeLimit>(
    pick(SNOOZE_LIMITS, base.snooze.maxCount, 3),
  );
  const [missionBeforeSnooze, setMissionBeforeSnooze] = useState(base.missionBeforeSnooze);
  const [important, setImportant] = useState(base.important);
  const [saving, setSaving] = useState(false);

  const timeZone = deviceTimeZone();
  const describe = (occurrence: Occurrence) => describeOccurrence(occurrence, new Date());

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
      sound,
      vibration,
      escalation: { enabled: escalate, rampSeconds },
      // Snooze is core reliability: every setting here is free (no Pro gating).
      snooze: {
        enabled: snoozeEnabled,
        durationMin: snoozeMinutes,
        maxCount: snoozeEnabled ? snoozeLimit : 0,
      },
      // Missions + Wake Check are kept as stored until the mission editor slot is wired.
      missionBeforeSnooze: missionBeforeSnooze && rest.missions.length > 0,
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

  /** Important-alarm protection: confirm before weakening an imminent ring. */
  const guarded = async (after: Alarm | null) =>
    !existing || confirmWeakening(detectWeakening(existing, after, new Date(), timeZone), describe);

  const save = async () => {
    const next = draft();
    if (!(await guarded(createAlarm({ ...next, id: existing?.id ?? 'draft' })))) return;
    setSaving(true);
    try {
      report(await service.save(next));
      close();
    } catch (error) {
      Alert.alert('Could not save alarm', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const run = async (after: Alarm | null, action: () => Promise<SaveResult>) => {
    if (!(await guarded(after))) return;
    try {
      report(await action());
      close();
    } catch (error) {
      Alert.alert('Could not update alarm', error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDelete = async () => {
    if (!existing || !(await guarded(null))) return;
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
          close();
        },
      },
    ]);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: existing ? 'Edit Alarm' : 'New Alarm',
          headerLeft: () => <HeaderButton label="Cancel" onPress={() => close()} />,
          headerRight: () => (
            <HeaderButton label="Save" emphasized disabled={saving} onPress={save} />
          ),
        }}
      />
      <Screen>
        <View className="items-center overflow-hidden rounded-card bg-surface py-2">
          <DateTimePicker
            mode="time"
            value={timeOf(hour, minute)}
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
            ? `Rings ${describeOccurrence(preview, now)}, ${formatCountdown(preview.fireAt.getTime() - now.getTime())}.`
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

        <Section
          title="Sound"
          footer={
            sound.kind === 'default'
              ? "Default uses your device's alarm tone; the preview here plays Classic."
              : undefined
          }
        >
          <ListRow
            title="Sound"
            value={soundOption(sound).name}
            onPress={() => setSoundOpen((open) => !open)}
          />
          {soundOpen ? (
            <>
              <Separator />
              <SoundPicker value={sound} onChange={setSound} />
            </>
          ) : null}
          <Separator />
          <ListRow
            title="Vibrate"
            accessory={
              <NativeSwitch label="Vibrate" value={vibration} onValueChange={setVibration} />
            }
          />
          <Separator />
          <ListRow
            title="Gradually louder"
            detail="Starts quiet and rises to full volume"
            accessory={
              <NativeSwitch label="Gradually louder" value={escalate} onValueChange={setEscalate} />
            }
          />
          {escalate ? (
            <ChipSelect
              label="Time to full volume"
              options={RAMP_SECONDS}
              value={rampSeconds}
              onChange={setRampSeconds}
              format={(s) => (s < 60 ? `${s} s` : `${s / 60} min`)}
            />
          ) : null}
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

        {/*
         * ── MISSION CHAIN + WAKE CHECK SLOT ─────────────────────────────────────────────
         * Integration task: render `MissionChainEditor` (src/features/missions) here,
         * bound to `alarm.missions` (MissionStep[]), plus the Wake Check config editor
         * bound to `alarm.wakeCheck`. Until then the stored values are preserved as-is by
         * `draft()`; only `missionBeforeSnooze` (D32) is editable.
         */}
        <Section
          title="Wake-up"
          footer={
            base.missions.length === 0
              ? 'Add a mission to require it before stopping or snoozing.'
              : 'Stopping always requires the mission.'
          }
        >
          <ListRow
            title="Missions"
            value={base.missions.length ? `${base.missions.length}` : 'None'}
            disabled
          />
          <Separator />
          <ListRow
            title="Mission before snooze"
            accessory={
              <NativeSwitch
                label="Mission before snooze"
                value={missionBeforeSnooze && base.missions.length > 0}
                onValueChange={setMissionBeforeSnooze}
                disabled={base.missions.length === 0}
              />
            }
          />
          <Separator />
          <ListRow title="Wake Check" value={base.wakeCheck.enabled ? 'On' : 'Off'} disabled />
        </Section>

        <Section
          title="Protection"
          footer="When this alarm rings within 12 hours, turning it off, deleting, skipping or moving it later asks you to confirm."
        >
          <ListRow
            title="Important"
            accessory={
              <NativeSwitch label="Important" value={important} onValueChange={setImportant} />
            }
          />
        </Section>

        {existing ? (
          <ExistingAlarmActions
            alarm={existing}
            now={now}
            timeZone={timeZone}
            onRun={run}
            onDelete={confirmDelete}
          />
        ) : null}
      </Screen>
    </>
  );
}

/** Next-occurrence-only changes, test ring and delete (saved alarms only). */
function ExistingAlarmActions({
  alarm,
  now,
  timeZone,
  onRun,
  onDelete,
}: {
  alarm: Alarm;
  now: Date;
  timeZone: string;
  onRun: (after: Alarm | null, action: () => Promise<SaveResult>) => Promise<void>;
  onDelete: () => void;
}) {
  const { alarms: service } = useAppServices();
  const colors = useThemeColors();
  const next = computeNextFire(alarm, now, timeZone);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideTime, setOverrideTime] = useState(() =>
    next ? { hour: next.hour, minute: next.minute } : { hour: alarm.hour, minute: alarm.minute },
  );

  const applyOverride = () => {
    let after: Alarm;
    try {
      after = setOneOffOverride(alarm, new Date(), timeZone, overrideTime);
    } catch (error) {
      Alert.alert('Cannot change', error instanceof Error ? error.message : String(error));
      return;
    }
    onRun(after, () => service.setOneOffOverride(alarm.id, overrideTime));
  };

  return (
    <View className="gap-4">
      {alarm.enabled && next ? (
        <Section
          title="Next alarm only"
          footer={
            next.overridden
              ? `Moved to ${formatClockString(next.hour, next.minute)} once; later alarms keep ${formatClockString(alarm.hour, alarm.minute)}.`
              : `Change only ${describeOccurrence(next, now)}. Later alarms are unchanged.`
          }
        >
          <ListRow
            title={next.overridden ? 'Change again' : 'Change next alarm time'}
            onPress={() => setOverrideOpen((open) => !open)}
          />
          {overrideOpen ? (
            <>
              <View className="items-center py-2">
                <DateTimePicker
                  mode="time"
                  value={timeOf(overrideTime.hour, overrideTime.minute)}
                  presentation="inline"
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  accentColor={colors.accent}
                  onValueChange={(_event, date) =>
                    setOverrideTime({ hour: date.getHours(), minute: date.getMinutes() })
                  }
                />
              </View>
              <View className="px-4 pb-3">
                <Button
                  title={`Ring once at ${formatClockString(overrideTime.hour, overrideTime.minute)}`}
                  onPress={applyOverride}
                />
              </View>
            </>
          ) : null}
          {next.overridden ? (
            <>
              <Separator />
              <ListRow
                title="Restore regular time"
                onPress={() =>
                  onRun({ ...alarm, oneOffOverride: null }, () =>
                    service.clearOneOffOverride(alarm.id),
                  )
                }
              />
            </>
          ) : null}
        </Section>
      ) : null}

      {alarm.weekdays.length > 0 && alarm.enabled ? (
        <Button
          variant="secondary"
          title={alarm.skipNext ? 'Undo skip next' : 'Skip next alarm'}
          onPress={() =>
            onRun(toggleSkipNext(alarm, new Date(), timeZone), () =>
              service.toggleSkipNext(alarm.id),
            )
          }
        />
      ) : null}
      <Button
        variant="secondary"
        title="Test alarm"
        accessibilityHint="Rings this alarm now"
        onPress={() => {
          service
            .testAlarm(alarm.id)
            .catch((error: unknown) =>
              Alert.alert('Test failed', error instanceof Error ? error.message : String(error)),
            );
        }}
      />
      <Button variant="destructive" title="Delete alarm" onPress={onDelete} />
    </View>
  );
}
