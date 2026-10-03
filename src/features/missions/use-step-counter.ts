import { Pedometer } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';

import { initialStepState, stepStep, type StepState } from '@/domain/missions-steps';

import { useAccelerometer } from './use-accelerometer';

export type StepSource = 'pedometer' | 'accelerometer';

export interface StepCounter {
  steps: number;
  /** Where `steps` currently comes from; null until a source is ready. */
  source: StepSource | null;
  status: 'checking' | 'active' | 'unavailable';
  /** Honest explanation when running degraded (permission denied, no pedometer). */
  note: string | null;
}

/**
 * Counts steps since mount. Prefers the hardware pedometer (iOS Motion / Android
 * ACTIVITY_RECOGNITION) once it has reported; until then — or when it is unavailable or
 * permission is denied — the accelerometer step detector counts instead.
 */
export function useStepCounter(): StepCounter {
  const [pedometer, setPedometer] = useState<'checking' | 'ready' | 'unavailable' | 'denied'>(
    'checking',
  );
  const [pedometerSteps, setPedometerSteps] = useState<number | null>(null);
  const [accelSteps, setAccelSteps] = useState(0);
  const detector = useRef<StepState>(initialStepState);

  useEffect(() => {
    let cancelled = false;
    let subscription: { remove: () => void } | null = null;
    (async () => {
      try {
        if (!(await Pedometer.isAvailableAsync())) return !cancelled && setPedometer('unavailable');
        let permission = await Pedometer.getPermissionsAsync();
        if (!permission.granted) permission = await Pedometer.requestPermissionsAsync();
        if (!permission.granted) return !cancelled && setPedometer('denied');
        subscription = Pedometer.watchStepCount((result) => setPedometerSteps(result.steps));
        if (!cancelled) setPedometer('ready');
      } catch {
        if (!cancelled) setPedometer('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  const accelStatus = useAccelerometer((sample) => {
    detector.current = stepStep(detector.current, sample);
    setAccelSteps(detector.current.count);
  });

  const usingPedometer = pedometer === 'ready' && pedometerSteps !== null;

  let status: StepCounter['status'] = 'active';
  if (accelStatus === 'checking' || pedometer === 'checking') status = 'checking';
  if (accelStatus === 'unavailable' && pedometer !== 'ready') status = 'unavailable';

  let note: string | null = null;
  if (!usingPedometer && pedometer !== 'checking') {
    note =
      pedometer === 'denied'
        ? 'Motion permission is off, so steps are estimated from the motion sensor (less precise).'
        : pedometer === 'unavailable'
          ? 'No step counter on this device, so steps are estimated from the motion sensor.'
          : null;
  }

  return {
    steps: usingPedometer ? pedometerSteps : accelSteps,
    source: usingPedometer ? 'pedometer' : accelStatus === 'active' ? 'accelerometer' : null,
    status,
    note,
  };
}
