import { Stack, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlarmEngineError } from '@/engine';
import type { MissionGateParams } from '@/features/ringing/mission-gate';
import { useAppServices } from '@/lib/app-services';

import { useMissionEntitlement } from './entitlement';
import { MissionChainRunner } from './mission-chain-runner';

/**
 * The mission between a ringing alarm and stopping/snoozing it (mission-gate.ts).
 * Success → `ring.completeMission` (the only path that calls engine dismiss/snooze for an
 * alarm with missions) → back. Leaving is never a dismissal: back to the ringing screen,
 * which keeps ringing. Pro steps degrade at ring time (D18) inside the runner.
 */
export function GatedMission({ params }: { params: MissionGateParams }) {
  const { alarms, ledger, ring, engine } = useAppServices();
  const entitlement = useMissionEntitlement();
  const insets = useSafeAreaInsets();
  const [steps] = useState(() => alarms.get(params.alarmId)?.missions ?? []);
  const [error, setError] = useState<string | null>(null);
  const left = useRef(false);
  const completing = useRef(false);

  const leave = () => {
    if (left.current) return;
    left.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  // The alarm stopped some other way (system Stop, re-trigger took over): nothing to gate.
  useEffect(() => {
    const check = () => {
      engine
        .getActiveRinging()
        .catch(() => null)
        .then((ringing) => {
          if (completing.current) return;
          if (!ringing || ringing.scheduleId !== params.scheduleId) leave();
        });
    };
    check();
    return ring.subscribe(check);
  }, [engine, ring, params.scheduleId]);

  const complete = async () => {
    completing.current = true;
    try {
      await ring.completeMission(params);
      leave();
    } catch (raw) {
      const failure = AlarmEngineError.from(raw);
      if (failure.code === 'NOT_RINGING') leave();
      else {
        completing.current = false;
        setError(
          failure.code === 'SNOOZE_LIMIT'
            ? 'No snoozes left. Go back and hold Stop.'
            : `Something went wrong: ${failure.message}`,
        );
      }
    }
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View
        className="flex-1 gap-3 bg-background px-4"
        style={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }}
      >
        <Text accessibilityRole="header" className="text-center text-title3 text-foreground">
          {params.purpose === 'snooze' ? 'Mission to snooze' : 'Mission to stop the alarm'}
        </Text>
        {error ? (
          <Text accessibilityRole="alert" className="text-center text-body text-danger">
            {error}
          </Text>
        ) : null}
        <MissionChainRunner
          steps={steps}
          entitlement={entitlement}
          onEvent={(event) => ledger.recordMission(event, params)}
          onAllComplete={complete}
          onAbandon={leave}
        />
      </View>
    </>
  );
}
