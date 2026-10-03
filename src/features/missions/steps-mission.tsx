import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';

import type { StepsConfig } from '@/domain/missions-steps';

import { missionHaptics } from './haptics';
import { ProgressBar } from './progress-bar';
import type { MissionViewProps } from './types';
import { useStepCounter } from './use-step-counter';

export function StepsMission({ config, onComplete, onFail }: MissionViewProps<StepsConfig>) {
  const { steps, source, status, note } = useStepCounter();
  const done = useRef(false);
  const lastBuzz = useRef(0);

  useEffect(() => {
    if (status === 'unavailable') onFail('sensor_unavailable');
  }, [status, onFail]);

  useEffect(() => {
    if (done.current) return;
    if (steps >= config.targetSteps) {
      done.current = true;
      onComplete();
    } else if (steps >= lastBuzz.current + 10) {
      lastBuzz.current = steps - (steps % 10);
      missionHaptics.tap();
    }
  }, [steps, config.targetSteps, onComplete]);

  const remaining = Math.max(0, config.targetSteps - steps);
  return (
    <View className="flex-1 items-center justify-center gap-6">
      <Text className="text-title2 text-foreground">Get up and walk</Text>
      <Text
        accessibilityLiveRegion="polite"
        className="text-[120px] font-bold leading-[130px] text-foreground"
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {remaining}
      </Text>
      <Text className="text-headline text-foreground-muted">
        {remaining === 1 ? 'step to go' : 'steps to go'}
      </Text>
      <ProgressBar value={steps} max={config.targetSteps} label="Step progress" />
      <Text className="text-center text-callout text-foreground-muted">
        {status === 'checking'
          ? 'Starting step counter…'
          : (note ??
            (source === 'pedometer'
              ? 'Counting with your phone’s step counter'
              : 'Counting steps'))}
      </Text>
    </View>
  );
}
