import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { ListRow } from '@/components/list-row';
import { NativeSwitch } from '@/components/native-switch';
import { Section, Separator } from '@/components/section';
import type { WakeCheckConfig } from '@/domain';
import { hasPro, type MissionEntitlement } from '@/domain/missions-gating';
import { ChipSelect } from '@/features/alarms/chip-select';
import { ProBadge } from '@/features/missions/pro-badge';
import { useThemeColors } from '@/theme/tokens';

import { isProMethod } from './verification';

const DELAYS = [3, 5, 10] as const;
const WINDOWS = [30, 60, 120] as const;
const RETRIGGERS = [1, 2, 3, 5] as const;
/** Missions offered for the "mini mission" check (QR needs setup, so it is left out). */
const CHECK_MISSIONS = [
  { id: 'math', name: 'Math' },
  { id: 'shake', name: 'Shake' },
] as const;

const METHODS: { value: WakeCheckConfig['method']; title: string; detail: string }[] = [
  { value: 'confirm', title: 'Confirm', detail: 'Tap “I’m awake”.' },
  { value: 'movement', title: 'Movement', detail: 'Take a few steps.' },
  { value: 'mission', title: 'Mini mission', detail: 'A short Math or Shake mission.' },
];

const snap = <T extends number>(options: readonly T[], value: number): T =>
  options.reduce((best, option) =>
    Math.abs(option - value) < Math.abs(best - value) ? option : best,
  );

/**
 * Wake Check settings for the alarm editor. The free check is a confirmation; movement
 * and mission checks are Pro (badge, paywall on tap) and degrade to the confirmation at
 * ring time if the entitlement lapses (D18).
 */
export function WakeCheckEditor({
  value,
  onChange,
  entitlement,
  onRequestUpgrade,
}: {
  value: WakeCheckConfig;
  onChange: (value: WakeCheckConfig) => void;
  entitlement: MissionEntitlement;
  onRequestUpgrade?: () => void;
}) {
  const colors = useThemeColors();
  const set = (patch: Partial<WakeCheckConfig>) => onChange({ ...value, ...patch });
  const pro = hasPro(entitlement);

  return (
    <Section
      title="Wake Check"
      footer={
        value.enabled
          ? `${value.delayMin} min after you stop the alarm, O-Alarm checks you’re up. No answer within ${value.responseWindowSec} s and it rings again (up to ${value.maxRetriggers}×).`
          : 'Checks you’re still up a few minutes after you stop the alarm.'
      }
    >
      <ListRow
        title="Wake Check"
        accessory={
          <NativeSwitch
            label="Wake Check"
            value={value.enabled}
            onValueChange={(enabled) => set({ enabled })}
          />
        }
      />
      {value.enabled ? (
        <>
          <Separator />
          <Text className="px-4 pt-3 text-footnote text-foreground-muted">Check after</Text>
          <ChipSelect
            label="Check after"
            options={DELAYS}
            value={snap(DELAYS, value.delayMin)}
            onChange={(delayMin) => set({ delayMin })}
            format={(m) => `${m} min`}
          />
          <Text className="px-4 text-footnote text-foreground-muted">Time to answer</Text>
          <ChipSelect
            label="Time to answer"
            options={WINDOWS}
            value={snap(WINDOWS, value.responseWindowSec)}
            onChange={(responseWindowSec) => set({ responseWindowSec })}
            format={(s) => (s < 60 ? `${s} s` : `${s / 60} min`)}
          />
          <Text className="px-4 text-footnote text-foreground-muted">Ring again at most</Text>
          <ChipSelect
            label="Ring again at most"
            options={RETRIGGERS}
            value={snap(RETRIGGERS, value.maxRetriggers)}
            onChange={(maxRetriggers) => set({ maxRetriggers })}
            format={(n) => `${n}×`}
          />
          <Separator />
          <View accessibilityRole="radiogroup" accessibilityLabel="Check method">
            {METHODS.map((method, index) => {
              const selected = value.method === method.value;
              const locked = isProMethod(method.value) && !pro;
              return (
                <View key={method.value}>
                  {index > 0 ? <Separator /> : null}
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityLabel={method.title}
                    accessibilityHint={locked ? 'Needs O-Alarm Pro' : method.detail}
                    accessibilityState={{ selected }}
                    onPress={() => {
                      if (locked) onRequestUpgrade?.();
                      else
                        set({
                          method: method.value,
                          missionId:
                            method.value === 'mission' ? (value.missionId ?? 'math') : null,
                        });
                    }}
                    className="min-h-touch flex-row items-center gap-3 px-4 py-3 active:bg-surface-muted"
                  >
                    <View className="flex-1 gap-0.5">
                      <View className="flex-row items-center gap-2">
                        <Text className="text-body text-foreground">{method.title}</Text>
                        {isProMethod(method.value) ? <ProBadge /> : null}
                      </View>
                      <Text className="text-footnote text-foreground-muted">{method.detail}</Text>
                    </View>
                    {selected ? (
                      <Ionicons name="checkmark" size={20} color={colors.accent} />
                    ) : null}
                  </Pressable>
                </View>
              );
            })}
          </View>
          {value.method === 'mission' ? (
            <View className="flex-row gap-2 px-4 pb-3">
              {CHECK_MISSIONS.map((mission) => {
                const selected = (value.missionId ?? 'math') === mission.id;
                return (
                  <Pressable
                    key={mission.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => set({ missionId: mission.id })}
                    className={`min-h-touch items-center justify-center rounded-control px-4 ${selected ? 'bg-accent' : 'bg-surface-muted'}`}
                  >
                    <Text
                      className={`text-callout ${selected ? 'text-accent-foreground' : 'text-foreground'}`}
                    >
                      {mission.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
