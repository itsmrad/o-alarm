import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';

import { Button } from '@/components/button';
import { Section } from '@/components/section';
import { useThemeColors } from '@/theme/tokens';

import type { SleepService, SleepSession } from './sleep-service';

function PickerRow({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: Date;
  onChange: (date: Date) => void;
  max?: Date;
}) {
  const colors = useThemeColors();
  return (
    <View className="min-h-touch flex-row items-center justify-between gap-3 px-4 py-2">
      <Text className="text-body text-foreground">{label}</Text>
      <DateTimePicker
        mode="datetime"
        value={value}
        maximumDate={max}
        display={Platform.OS === 'ios' ? 'compact' : 'default'}
        accentColor={colors.accent}
        onValueChange={(_event, date) => onChange(date)}
      />
    </View>
  );
}

/** Edit when a night started/ended, or delete it. Validation lives in the service. */
export function SessionEditor({
  session,
  service,
  onClose,
}: {
  session: SleepSession;
  service: SleepService;
  onClose: () => void;
}) {
  const [start, setStart] = useState(() => new Date(session.startedAt));
  const [end, setEnd] = useState<Date | null>(() =>
    session.endedAt ? new Date(session.endedAt) : null,
  );
  const now = new Date();

  const save = () => {
    try {
      service.updateSession(session.id, { startedAt: start, endedAt: end });
      onClose();
    } catch (error) {
      Alert.alert('Could not save', error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDelete = () =>
    Alert.alert('Delete this night?', 'It will be removed from your sleep history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          service.deleteSession(session.id);
          onClose();
        },
      },
    ]);

  return (
    <Section title="Edit times">
      <PickerRow label="Bedtime" value={start} onChange={setStart} max={now} />
      {end ? <PickerRow label="Woke up" value={end} onChange={setEnd} max={now} /> : null}
      <View className="gap-3 p-4">
        <Button title="Save" onPress={save} />
        <Button title="Cancel" variant="secondary" onPress={onClose} />
        <Button title="Delete night" variant="destructive" onPress={confirmDelete} />
      </View>
    </Section>
  );
}
