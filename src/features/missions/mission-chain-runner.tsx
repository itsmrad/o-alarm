import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { MissionAttemptResult, MissionStep } from '@/domain/missions';
import {
  advanceChain,
  createChainState,
  type ChainAction,
  type ChainState,
  type MissionChainEvent,
  type MissionFailReason,
} from '@/domain/missions-chain';
import { resolveRingChain, type MissionEntitlement } from '@/domain/missions-gating';
import { missionRegistry } from '@/domain/missions-registry';

import { missionHaptics } from './haptics';
import { getMissionUi } from './mission-ui';

export interface MissionChainRunnerProps {
  /** The alarm's configured chain. Resolved against `entitlement` once, on mount (D18). */
  steps: readonly MissionStep[];
  entitlement: MissionEntitlement;
  /** The caller logs these (adds alarmId/occurrenceKey and writes to the event log). */
  onEvent?: (event: MissionChainEvent) => void;
  /** Every step completed (also fires immediately for an empty chain). */
  onAllComplete: (attempts: MissionAttemptResult[]) => void;
  /**
   * The user left before finishing. This is NOT a dismissal: the alarm keeps ringing.
   * When omitted, no leave control is shown.
   */
  onAbandon?: (attempts: MissionAttemptResult[]) => void;
  /** Seed for mission randomness; defaults to the current time. */
  seed?: number;
  /** Clock override for tests. */
  now?: () => number;
}

const stepKey = (state: ChainState) => `${state.index}:${state.steps[state.index]?.missionId}`;

function KeepAwake() {
  useKeepAwake('mission-chain');
  return null;
}

const DEGRADE_NOTICE: Record<string, string> = {
  pro_required: 'This mission needs Pro, so you’ll do Math instead.',
  chain_requires_pro: 'Mission chains need Pro, so only the first mission runs.',
  not_configured: 'This mission isn’t set up, so you’ll do Math instead.',
  unknown_mission: 'This mission isn’t available, so you’ll do Math instead.',
};

/**
 * Runs an alarm's mission chain in order: progress header, one full-screen mission at a
 * time, haptics, screen kept awake while running. Missions that cannot run (denied
 * permission, missing sensor) fall back to Math with a `mission_failed` event.
 */
export function MissionChainRunner({
  steps,
  entitlement,
  onEvent,
  onAllComplete,
  onAbandon,
  seed,
  now = Date.now,
}: MissionChainRunnerProps) {
  const [{ resolved, baseSeed }] = useState(() => ({
    resolved: resolveRingChain(steps, entitlement),
    baseSeed: seed ?? Date.now() % 2147483647,
  }));
  const [chain, setChain] = useState(() => createChainState(resolved.steps));
  const chainRef = useRef(chain);

  const latest = useRef({ onEvent, onAllComplete, onAbandon, now });
  useEffect(() => {
    latest.current = { onEvent, onAllComplete, onAbandon, now };
  });

  const dispatch = useCallback((action: ChainAction) => {
    const before = chainRef.current;
    const { state, events } = advanceChain(before, action);
    if (state === before) return;
    chainRef.current = state;
    setChain(state);
    events.forEach((event) => latest.current.onEvent?.(event));
    if (state.status === 'complete' && before.status !== 'complete') {
      latest.current.onAllComplete(state.attempts);
    }
    if (state.status === 'abandoned') latest.current.onAbandon?.(state.attempts);
  }, []);

  useEffect(() => {
    dispatch({ type: 'start', now: latest.current.now() });
  }, [dispatch]);

  /** Late/duplicate callbacks from a step that is no longer current are ignored. */
  const completeStep = useCallback(
    (key: string) => {
      if (stepKey(chainRef.current) !== key) return;
      missionHaptics.success();
      dispatch({ type: 'complete', now: latest.current.now() });
    },
    [dispatch],
  );
  const failStep = useCallback(
    (key: string, reason: MissionFailReason) => {
      if (stepKey(chainRef.current) !== key) return;
      dispatch({ type: 'fail', now: latest.current.now(), reason });
    },
    [dispatch],
  );

  const current = chain.steps[chain.index];
  const ui = current ? getMissionUi(current.missionId) : undefined;
  const title = current ? (missionRegistry.get(current.missionId)?.title ?? current.missionId) : '';
  const total = chain.steps.length;

  if (chain.status === 'complete') {
    return (
      <View className="flex-1 items-center justify-center gap-2">
        <Text className="text-[64px]">✓</Text>
        <Text className="text-title2 text-foreground">Done</Text>
      </View>
    );
  }
  if (chain.status === 'abandoned') {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-title3 text-foreground-muted">Mission left</Text>
      </View>
    );
  }
  if (!current || !ui) return null;

  const key = stepKey(chain);
  const notice = resolved.degraded[0] ? DEGRADE_NOTICE[resolved.degraded[0].reason] : null;
  const MissionView = ui.View;
  return (
    <View className="flex-1 gap-4">
      <KeepAwake />
      <View className="gap-2">
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`Mission ${chain.index + 1} of ${total}`}
          className="flex-row gap-2"
        >
          {chain.steps.map((_, i) => (
            <View
              key={i}
              className={`h-2 flex-1 rounded-full ${i <= chain.index ? 'bg-accent' : 'bg-surface-muted'}`}
            />
          ))}
        </View>
        <Text className="text-center text-headline text-foreground-muted">
          {total > 1 ? `Mission ${chain.index + 1} of ${total} · ` : ''}
          {title}
        </Text>
        {notice ? (
          <Text className="rounded-control bg-warning px-3 py-2 text-center text-footnote text-warning-foreground">
            {notice}
          </Text>
        ) : null}
      </View>
      <View className="flex-1">
        <MissionView
          key={key}
          config={current.config}
          seed={baseSeed + chain.index}
          onComplete={() => completeStep(key)}
          onFail={(reason) => failStep(key, reason)}
        />
      </View>
      {onAbandon ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hold to leave mission"
          accessibilityHint="Press and hold. The alarm will keep ringing."
          delayLongPress={1500}
          onLongPress={() => dispatch({ type: 'abandon', now: latest.current.now() })}
          className="min-h-touch items-center justify-center rounded-control active:opacity-60"
        >
          <Text className="text-callout text-foreground-muted">Hold to leave</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
