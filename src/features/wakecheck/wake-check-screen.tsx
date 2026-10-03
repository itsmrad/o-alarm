import { Stack, router, useIsFocused } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Alarm, WakeCheckState } from '@/domain';
import type { RingingState } from '@/engine';
import { RINGING_READ_RETRY_MS } from '@/features/ringing/ringing-screen';
import { useMissionEntitlement } from '@/features/missions/entitlement';
import { MissionChainRunner } from '@/features/missions/mission-chain-runner';
import { useAppServices, useNow } from '@/lib/app-services';
import { themeColors } from '@/theme/tokens';

import { verificationFor } from './verification';

const dark = themeColors('dark');

type Prompt = { ringing: RingingState; alarm: Alarm | null; state: WakeCheckState };
type ViewState = { status: 'loading' } | { status: 'prompt'; prompt: Prompt } | { status: 'ended' };

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

const deadlineOf = (state: WakeCheckState) =>
  state.status === 'pending_verification'
    ? Date.parse(state.deadline)
    : state.status === 'armed'
      ? Date.parse(state.respondBy)
      : null;

/**
 * Wake Check prompt (a `wake_check` alarm rang a few minutes after dismissal): one calm
 * question and one big target. Passing cancels the native re-trigger; no answer by the
 * deadline lets it ring as a full alarm. Driven by engine state, so it also works after
 * a cold start.
 */
export function WakeCheckScreen() {
  useKeepAwake();
  const { engine, ring, alarms, wakeChecks } = useAppServices();
  const entitlement = useMissionEntitlement();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const now = useNow(1_000);
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timedOut = useRef(false);

  const [readFailures, setReadFailures] = useState(0);

  const refresh = useCallback(() => {
    engine.getActiveRinging().then(
      (ringing) => {
        if (ringing && ringing.kind !== 'wake_check') {
          // The re-trigger (or another alarm) took over: that is a full ring.
          router.replace('/ringing');
          return;
        }
        setView(
          ringing
            ? {
                status: 'prompt',
                prompt: {
                  ringing,
                  alarm: alarms.get(ringing.alarmId),
                  state: wakeChecks.state(ringing.occurrenceKey),
                },
              }
            : { status: 'ended' },
        );
      },
      // A failed read is not "the prompt ended": keep the screen up and read again.
      () => setReadFailures((n) => n + 1),
    );
  }, [engine, alarms, wakeChecks]);

  useEffect(() => {
    if (readFailures === 0) return;
    const id = setTimeout(refresh, RINGING_READ_RETRY_MS);
    return () => clearTimeout(id);
  }, [readFailures, refresh]);

  useEffect(() => {
    ring.setRingingScreenOpen(true);
    refresh();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    const unsubscribe = ring.subscribe(refresh);
    const subscriptions = (['trigger', 'dismiss', 'stop'] as const).map((type) =>
      engine.addListener(type, () => refresh()),
    );
    return () => {
      ring.setRingingScreenOpen(false);
      unsubscribe();
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [engine, ring, refresh]);

  useEffect(() => {
    if (view.status === 'ended' && focused) close();
  }, [view.status, focused]);

  const prompt = view.status === 'prompt' ? view.prompt : null;
  const deadline = prompt ? deadlineOf(prompt.state) : null;
  const secondsLeft =
    deadline === null ? null : Math.max(0, Math.ceil((deadline - now.getTime()) / 1000));

  // No answer in time: stop the prompt so the native re-trigger rings.
  useEffect(() => {
    if (!prompt || secondsLeft !== 0 || timedOut.current) return;
    timedOut.current = true;
    // Best effort: the re-trigger is already a native alarm (D13) and rings even if this fails.
    ring.timeoutWakeCheck(prompt.ringing).catch(() => undefined);
  }, [prompt, secondsLeft, ring]);

  if (!prompt) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
        <View style={{ flex: 1, backgroundColor: dark.background }} />
      </>
    );
  }

  const verification = verificationFor(prompt.alarm?.wakeCheck, entitlement);
  const pass = async () => {
    setBusy(true);
    try {
      const result = await ring.passWakeCheck(prompt.ringing);
      if (result === 'late') setMessage('Too late — the alarm will ring again.');
    } catch (error) {
      setMessage(`Something went wrong: ${error instanceof Error ? error.message : error}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <StatusBar style="light" />
      <View
        style={{
          flex: 1,
          backgroundColor: dark.background,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 24,
          gap: 16,
        }}
      >
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Text
            accessibilityRole="header"
            style={{ color: dark.foreground, fontSize: 34, fontWeight: '700', textAlign: 'center' }}
          >
            Still awake?
          </Text>
          <Text style={{ color: dark['foreground-muted'], fontSize: 17, textAlign: 'center' }}>
            {verification.kind === 'confirm'
              ? 'Tap below so your alarm doesn’t ring again.'
              : 'Finish this quick mission so your alarm doesn’t ring again.'}
          </Text>
          {secondsLeft !== null ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: dark.foreground, fontSize: 22, fontVariant: ['tabular-nums'] }}
            >
              {secondsLeft > 0 ? `${secondsLeft} s left` : 'Time is up'}
            </Text>
          ) : null}
          {verification.degraded ? (
            <Text style={{ color: dark['warning-foreground'], fontSize: 15, textAlign: 'center' }}>
              This check needs Pro, so a simple confirmation is used.
            </Text>
          ) : null}
          {message ? (
            <Text accessibilityRole="alert" style={{ color: dark.danger, fontSize: 17 }}>
              {message}
            </Text>
          ) : null}
        </View>

        {verification.kind === 'confirm' ? (
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="I’m awake"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={pass}
              style={({ pressed }) => ({
                minHeight: 160,
                borderRadius: 32,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: themeColors('light').accent,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ color: '#fff', fontSize: 32, fontWeight: '700' }}>I’m awake</Text>
            </Pressable>
          </View>
        ) : (
          <View className="flex-1 rounded-card bg-background p-3">
            <MissionChainRunner
              steps={verification.steps}
              entitlement={entitlement}
              onAllComplete={pass}
            />
          </View>
        )}
      </View>
    </>
  );
}
