import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useMemo } from 'react';
import { Platform, Text, View } from 'react-native';

import { ListRow } from '@/components/list-row';
import { Section, Separator } from '@/components/section';
import { ChipSelect } from '@/features/alarms/chip-select';
import { OptionChips } from '@/features/missions/option-chips';
import { useThemeColors } from '@/theme/tokens';

import { formatDuration } from './format';
import type { SleepData } from './use-sleep-data';

const SLEEP_GOALS = [360, 390, 420, 450, 480, 510, 540] as const;
const LATENCIES = [5, 10, 15, 20, 30, 45] as const;
const WIND_DOWNS = [15, 30, 45, 60, 90] as const;

/** Sleep goal, time to fall asleep, wind-down lead and bedtime target (auto / manual). */
export function SleepSettingsSection({ data }: { data: SleepData }) {
  const { service, prefs } = data;
  const colors = useThemeColors();
  const manualValue = useMemo(() => {
    const d = new Date();
    d.setHours(prefs.manualBedtime.hour, prefs.manualBedtime.minute, 0, 0);
    return d;
  }, [prefs.manualBedtime.hour, prefs.manualBedtime.minute]);

  return (
    <>
      <Section
        title="Bedtime target"
        footer={
          prefs.mode === 'auto'
            ? 'Bedtime is worked out from your next alarm.'
            : 'You pick the bedtime. O-Alarm shows how much sleep it leaves before your alarm.'
        }
      >
        <View className="p-4">
          <OptionChips
            label="Target"
            value={prefs.mode}
            onChange={(mode) => service.setSleepPrefs({ mode })}
            options={[
              { value: 'auto', label: 'From my alarm' },
              { value: 'manual', label: 'Manual' },
            ]}
          />
        </View>
        {prefs.mode === 'manual' ? (
          <>
            <Separator />
            <View className="min-h-touch flex-row items-center justify-between gap-3 px-4 py-2">
              <Text className="text-body text-foreground">Bedtime</Text>
              <DateTimePicker
                mode="time"
                value={manualValue}
                display={Platform.OS === 'ios' ? 'compact' : 'default'}
                accentColor={colors.accent}
                onValueChange={(_event, date) =>
                  service.setSleepPrefs({
                    manualBedtime: { hour: date.getHours(), minute: date.getMinutes() },
                  })
                }
              />
            </View>
          </>
        ) : null}
      </Section>

      <Section title="Sleep goal">
        <ListRow title="Sleep you need" value={formatDuration(prefs.desiredSleepMin)} />
        <ChipSelect
          label="Sleep you need"
          options={SLEEP_GOALS}
          value={nearest(SLEEP_GOALS, prefs.desiredSleepMin)}
          onChange={(desiredSleepMin) => service.setSleepPrefs({ desiredSleepMin })}
          format={(m) => `${m / 60} hr`}
        />
        <Separator />
        <ListRow title="Time to fall asleep" value={`${prefs.latencyMin} min`} />
        <ChipSelect
          label="Time to fall asleep"
          options={LATENCIES}
          value={nearest(LATENCIES, prefs.latencyMin)}
          onChange={(latencyMin) => service.setSleepPrefs({ latencyMin })}
          format={(m) => `${m} min`}
        />
        <Separator />
        <ListRow title="Wind-down" value={`${prefs.windDownMin} min before`} />
        <ChipSelect
          label="Wind-down lead time"
          options={WIND_DOWNS}
          value={nearest(WIND_DOWNS, prefs.windDownMin)}
          onChange={(windDownMin) => service.setSleepPrefs({ windDownMin })}
          format={(m) => `${m} min`}
        />
      </Section>
    </>
  );
}

function nearest<T extends number>(options: readonly T[], value: number): T {
  return options.reduce((best, o) => (Math.abs(o - value) < Math.abs(best - value) ? o : best));
}
