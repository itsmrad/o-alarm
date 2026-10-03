import { Stack, router, useIsFocused } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_SNOOZE, type Alarm } from '@/domain';
import { AlarmEngineError, type RingingState } from '@/engine';
import { formatClock } from '@/features/alarms/format';
import { useAppServices, useNow } from '@/lib/app-services';
import { themeColors } from '@/theme/tokens';

import { HoldToConfirm } from './hold-to-confirm';
import { missionGateHref, type MissionPurpose } from './mission-gate';
import { snoozeControl, stopLabel } from './ring-controls';
import { useRingingFeedback } from './use-ringing-feedback';

/** Always dark: a bright screen at 6 AM is hostile, whatever the app theme is. */
const dark = themeColors('dark');
/** Deep accent so the white label stays readable as the hold fill passes under it. */
const HOLD_FILL = themeColors('light').accent;

type View_ =
  | { status: 'loading' }
  | { status: 'ringing'; ringing: RingingState; alarm: Alarm | null }
  | { status: 'ended' };

const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

const subtitleFor = (ringing: RingingState) => {
  if (ringing.occurrenceKey.includes('#test-')) return 'Test alarm';
  if (ringing.kind === 'snooze') return `Snoozed ${ringing.snoozeCount}×`;
  if (ringing.kind === 'wake_check') return 'Wake Check';
  if (ringing.kind === 'retrigger') return 'Ringing again — Wake Check missed';
  return null;
};

/**
 * The ringing alarm, for a half-awake user: huge time + label, high contrast, two
 * unambiguous controls. Snooze is a plain button (it is reversible); stopping needs a
 * press-and-hold. Reads the ringing state from the engine (not route params), so cold
 * start, re-triggers and a second alarm all render correctly. Closes itself when the
 * ring ends — from here, the mission screen, or the system UI.
 */
export function RingingScreen() {
  useKeepAwake();
  const { engine, alarms, ring } = useAppServices();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const now = useNow(1_000);
  const [view, setView] = useState<View_>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    engine
      .getActiveRinging()
      .catch(() => null)
      .then((ringing) =>
        setView(
          ringing
            ? { status: 'ringing', ringing, alarm: alarms.get(ringing.alarmId) }
            : { status: 'ended' },
        ),
      );
  }, [engine, alarms]);

  useEffect(() => {
    ring.setRingingScreenOpen(true);
    refresh();
    const unsubscribe = ring.subscribe(refresh);
    const subscriptions = (['trigger', 'snooze', 'dismiss', 'stop'] as const).map((type) =>
      engine.addListener(type, () => {
        refresh();
      }),
    );
    return () => {
      ring.setRingingScreenOpen(false);
      unsubscribe();
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [engine, ring, refresh]);

  // Close only while on top: the mission screen pops itself first, then this one goes.
  useEffect(() => {
    if (view.status === 'ended' && focused) close();
  }, [view.status, focused]);

  // A Wake Check prompt has its own screen.
  const isPrompt = view.status === 'ringing' && view.ringing.kind === 'wake_check';
  useEffect(() => {
    if (isPrompt && focused) router.replace('/wake-check');
  }, [isPrompt, focused]);

  const ringing = view.status === 'ringing' ? view.ringing : null;
  const alarm = view.status === 'ringing' ? view.alarm : null;
  // Re-rings after a missed Wake Check are never snoozable.
  const policy =
    ringing?.kind === 'retrigger' || ringing?.kind === 'wake_check'
      ? { ...DEFAULT_SNOOZE, enabled: false, maxCount: 0 }
      : (alarm?.snooze ?? DEFAULT_SNOOZE);

  // Expo Go only: the native engine plays its own sound (never double-play).
  useRingingFeedback({
    active: engine.kind === 'preview' && ringing !== null && !isPrompt,
    // A mission is on top: duck so the user can concentrate; restored on return.
    ducked: !focused,
    sound: alarm?.sound ?? { kind: 'default', id: null },
    escalation:
      ringing?.kind === 'retrigger'
        ? { enabled: false, rampSeconds: 0 }
        : (alarm?.escalation ?? { enabled: false, rampSeconds: 0 }),
    vibration: alarm?.vibration ?? true,
  });

  if (!ringing) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
        <StatusBar style="light" />
        <View style={{ flex: 1, backgroundColor: dark.background }} />
      </>
    );
  }

  const snooze = snoozeControl({
    policy,
    snoozesUsed: ringing.snoozeCount,
    missionBeforeSnooze: alarm?.missionBeforeSnooze ?? false,
    hasMissions: ringing.hasMissions,
  });
  const { time, period } = formatClock(now.getHours(), now.getMinutes());
  const subtitle = subtitleFor(ringing);

  const toMission = (purpose: MissionPurpose) =>
    router.push(
      missionGateHref({
        purpose,
        scheduleId: ringing.scheduleId,
        alarmId: ringing.alarmId,
        occurrenceKey: ringing.occurrenceKey,
      }),
    );

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (raw) {
      const failure = AlarmEngineError.from(raw);
      setError(
        failure.code === 'NOT_RINGING'
          ? null
          : failure.code === 'SNOOZE_LIMIT'
            ? 'No snoozes left. Hold Stop to turn the alarm off.'
            : `Something went wrong: ${failure.message}`,
      );
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onSnooze = () => {
    if (snooze.requiresMission) toMission('snooze');
    else act(() => ring.snooze(ringing.scheduleId));
  };
  const onStop = () => {
    if (ringing.hasMissions) toMission('dismiss');
    else act(() => ring.dismiss(ringing.scheduleId, 'button'));
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
        }}
      >
        {engine.kind === 'preview' ? (
          <Text
            accessibilityRole="alert"
            style={{ color: dark['warning-foreground'], fontSize: 15, textAlign: 'center' }}
          >
            Preview ring in Expo Go — real alarms need the development build.
          </Text>
        ) : null}

        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`Alarm ringing. ${alarm?.label || ringing.label || 'Alarm'}. It is ${time} ${period}.`}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text
              adjustsFontSizeToFit
              numberOfLines={1}
              style={{
                color: dark.foreground,
                fontSize: 104,
                fontWeight: '200',
                fontVariant: ['tabular-nums'],
              }}
            >
              {time}
            </Text>
            {period ? (
              <Text style={{ color: dark['foreground-muted'], fontSize: 28 }}>{period}</Text>
            ) : null}
          </View>
          <Text
            numberOfLines={2}
            style={{
              color: dark.foreground,
              fontSize: 28,
              fontWeight: '700',
              textAlign: 'center',
            }}
          >
            {alarm?.label || ringing.label || 'Alarm'}
          </Text>
          {subtitle ? (
            <Text style={{ color: dark['foreground-muted'], fontSize: 17 }}>{subtitle}</Text>
          ) : null}
        </View>

        <View style={{ gap: 20 }}>
          {error ? (
            <Text
              accessibilityRole="alert"
              style={{ color: dark.danger, fontSize: 17, textAlign: 'center' }}
            >
              {error}
            </Text>
          ) : null}

          <View style={{ gap: 8 }}>
            {snooze.visible ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={snooze.label}
                accessibilityHint={snooze.detail}
                accessibilityState={{ disabled: !snooze.enabled || busy }}
                disabled={!snooze.enabled || busy}
                onPress={onSnooze}
                style={({ pressed }) => ({
                  minHeight: 76,
                  borderRadius: 38,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: dark['surface-muted'],
                  opacity: !snooze.enabled ? 0.4 : pressed ? 0.7 : 1,
                })}
              >
                <Text style={{ color: dark.foreground, fontSize: 22, fontWeight: '700' }}>
                  {snooze.label}
                </Text>
              </Pressable>
            ) : null}
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: dark['foreground-muted'], fontSize: 17, textAlign: 'center' }}
            >
              {snooze.detail}
            </Text>
          </View>

          <HoldToConfirm
            label={stopLabel(ringing.hasMissions)}
            accessibilityHint={
              ringing.hasMissions
                ? 'Press and hold to open the mission that turns the alarm off'
                : 'Press and hold to turn the alarm off'
            }
            disabled={busy}
            onConfirm={onStop}
            colors={{ fill: HOLD_FILL, track: dark['surface-muted'], text: dark.foreground }}
          />
        </View>
      </View>
    </>
  );
}
