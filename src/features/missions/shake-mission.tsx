import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import {
  initialShakeState,
  shakeParamsFor,
  shakeStep,
  type ShakeConfig,
} from '@/domain/missions-shake';

import { missionHaptics } from './haptics';
import { ProgressBar } from './progress-bar';
import type { MissionViewProps } from './types';
import { useAccelerometer } from './use-accelerometer';

export function ShakeMission({ config, onComplete, onFail }: MissionViewProps<ShakeConfig>) {
  const [count, setCount] = useState(0);
  const state = useRef(initialShakeState);
  const done = useRef(false);
  const params = shakeParamsFor(config);

  const status = useAccelerometer((sample) => {
    if (done.current) return;
    const next = shakeStep(state.current, sample, params);
    const counted = next.count > state.current.count;
    state.current = next;
    if (!counted) return;
    setCount(next.count);
    if (next.count >= config.targetCount) {
      done.current = true;
      onComplete();
    } else {
      missionHaptics.tap();
    }
  });

  useEffect(() => {
    if (status === 'unavailable') onFail('sensor_unavailable');
  }, [status, onFail]);

  const remaining = Math.max(0, config.targetCount - count);
  return (
    <View className="flex-1 items-center justify-center gap-6">
      <Text className="text-title2 text-foreground">Shake your phone</Text>
      <Text
        accessibilityLiveRegion="polite"
        className="text-[120px] font-bold leading-[130px] text-foreground"
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {remaining}
      </Text>
      <Text className="text-headline text-foreground-muted">
        {remaining === 1 ? 'shake to go' : 'shakes to go'}
      </Text>
      <ProgressBar value={count} max={config.targetCount} label="Shake progress" />
      {status === 'checking' ? (
        <Text className="text-callout text-foreground-muted">Starting motion sensor…</Text>
      ) : null}
    </View>
  );
}
