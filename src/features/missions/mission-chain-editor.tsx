import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Section } from '@/components/section';
import { MAX_MISSION_CHAIN_LENGTH, type MissionStep } from '@/domain/missions';
import {
  canAddMission,
  resolveRingChain,
  type AddMissionDenial,
  type MissionEntitlement,
} from '@/domain/missions-gating';
import { missionRegistry } from '@/domain/missions-registry';
import { useThemeColors } from '@/theme/tokens';

import { addStep, moveStep, removeStep, updateStepConfig } from './chain-edit';
import { getMissionUi } from './mission-ui';
import { ProBadge } from './pro-badge';

export interface MissionChainEditorProps {
  steps: MissionStep[];
  onChange: (steps: MissionStep[]) => void;
  /** Unknown/missing entitlement is treated as free. */
  entitlement?: MissionEntitlement;
  /** Called when the user taps something that needs Pro (open the paywall here). */
  onRequestUpgrade?: () => void;
  /** Maximum chain length (defaults to the domain maximum). */
  maxLength?: number;
}

const DENIAL_TEXT: Record<AddMissionDenial, string> = {
  pro_mission: 'This mission needs Pro.',
  pro_chain: 'Chaining several missions needs Pro.',
  chain_full: 'That’s the maximum number of missions.',
  unknown_mission: 'That mission isn’t available.',
};

function IconButton({
  name,
  label,
  onPress,
  disabled,
}: {
  name: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const colors = useThemeColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      className={`min-h-touch min-w-touch items-center justify-center active:opacity-60 ${disabled ? 'opacity-30' : ''}`}
    >
      <Ionicons name={name} size={22} color={colors.foreground} />
    </Pressable>
  );
}

/**
 * Edits an alarm's mission chain: add / remove / reorder, per-mission config, Pro badges.
 * Controlled; pure edits live in `chain-edit.ts`. Free users can hold one free mission.
 */
export function MissionChainEditor({
  steps,
  onChange,
  entitlement,
  onRequestUpgrade,
  maxLength = MAX_MISSION_CHAIN_LENGTH,
}: MissionChainEditorProps) {
  const colors = useThemeColors();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [denied, setDenied] = useState<AddMissionDenial | null>(null);

  const degraded = resolveRingChain(steps, entitlement).degraded;

  const tryAdd = (id: string) => {
    const verdict = canAddMission(steps, id, entitlement);
    if (!verdict.ok || steps.length >= maxLength) {
      setDenied(verdict.ok ? 'chain_full' : verdict.reason);
      if (!verdict.ok && verdict.reason !== 'chain_full') onRequestUpgrade?.();
      return;
    }
    setDenied(null);
    setPicking(false);
    onChange(addStep(steps, id));
    setExpanded(steps.length);
  };

  return (
    <View className="gap-4">
      <Section
        title="Wake missions"
        footer={
          steps.length === 0
            ? 'No mission: the alarm can be dismissed with a tap. Add one to prove you’re awake.'
            : steps.length > 1
              ? 'Missions run in this order. All must be completed to dismiss the alarm.'
              : 'Complete this mission to dismiss the alarm.'
        }
      >
        {steps.map((step, index) => {
          const definition = missionRegistry.get(step.missionId);
          const ui = getMissionUi(step.missionId);
          const open = expanded === index;
          const Editor = ui?.Editor;
          return (
            <View key={index} className={index > 0 ? 'border-t border-border' : ''}>
              <View className="flex-row items-center pl-4">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${definition?.title ?? step.missionId}, ${ui?.summary(step.config) ?? ''}`}
                  accessibilityState={{ expanded: open }}
                  onPress={() => setExpanded(open ? null : index)}
                  className="min-h-touch-lg flex-1 flex-row items-center gap-3 py-2 active:opacity-70"
                >
                  <Ionicons name={ui?.icon ?? 'help-circle'} size={24} color={colors.accent} />
                  <View className="flex-1 gap-0.5">
                    <View className="flex-row items-center gap-2">
                      <Text className="text-body text-foreground">
                        {definition?.title ?? step.missionId}
                      </Text>
                      {definition?.tier === 'pro' ? <ProBadge /> : null}
                    </View>
                    <Text className="text-footnote text-foreground-muted">
                      {ui?.summary(step.config) ?? 'Not available in this version'}
                    </Text>
                  </View>
                </Pressable>
                <IconButton
                  name="chevron-up"
                  label="Move up"
                  disabled={index === 0}
                  onPress={() => {
                    onChange(moveStep(steps, index, index - 1));
                    setExpanded(null);
                  }}
                />
                <IconButton
                  name="chevron-down"
                  label="Move down"
                  disabled={index === steps.length - 1}
                  onPress={() => {
                    onChange(moveStep(steps, index, index + 1));
                    setExpanded(null);
                  }}
                />
                <IconButton
                  name="close-circle"
                  label="Remove mission"
                  onPress={() => {
                    onChange(removeStep(steps, index));
                    setExpanded(null);
                  }}
                />
              </View>
              {open && Editor ? (
                <View className="px-4 pb-4 pt-1">
                  <Editor
                    config={step.config}
                    onChange={(config) => onChange(updateStepConfig(steps, index, config))}
                  />
                </View>
              ) : null}
            </View>
          );
        })}

        {steps.length < maxLength ? (
          <View className={steps.length > 0 ? 'border-t border-border' : ''}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: picking }}
              onPress={() => {
                setPicking(!picking);
                setDenied(null);
              }}
              className="min-h-touch flex-row items-center gap-3 px-4 py-3 active:bg-surface-muted"
            >
              <Ionicons name="add-circle" size={24} color={colors.accent} />
              <Text className="text-body text-accent">Add mission</Text>
            </Pressable>
            {picking
              ? missionRegistry.list().map((definition) => {
                  const ui = getMissionUi(definition.id);
                  return (
                    <Pressable
                      key={definition.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${definition.title}${definition.tier === 'pro' ? ', Pro' : ''}`}
                      onPress={() => tryAdd(definition.id)}
                      className="min-h-touch flex-row items-center gap-3 border-t border-border px-4 py-3 active:bg-surface-muted"
                    >
                      <Ionicons
                        name={ui?.icon ?? 'help-circle'}
                        size={24}
                        color={colors.foreground}
                      />
                      <View className="flex-1 gap-0.5">
                        <View className="flex-row items-center gap-2">
                          <Text className="text-body text-foreground">{definition.title}</Text>
                          {definition.tier === 'pro' ? <ProBadge /> : null}
                        </View>
                        <Text className="text-footnote text-foreground-muted">
                          {ui?.description}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })
              : null}
          </View>
        ) : null}
      </Section>

      {denied ? (
        <Text accessibilityLiveRegion="polite" className="px-4 text-callout text-danger">
          {DENIAL_TEXT[denied]}
        </Text>
      ) : null}
      {degraded.length > 0 ? (
        <Text className="rounded-control bg-warning px-4 py-3 text-footnote text-warning-foreground">
          Pro is needed for part of this chain. Without it, the alarm will fall back to a free Math
          mission — it will still ring and can still be dismissed.
        </Text>
      ) : null}
    </View>
  );
}
