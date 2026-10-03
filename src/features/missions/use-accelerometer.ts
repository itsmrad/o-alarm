import { Accelerometer } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';

import type { AccelSample } from '@/domain/missions-shake';

export type SensorStatus = 'checking' | 'active' | 'unavailable';

/** Streams accelerometer samples (in g, ms timestamps) to `onSample` while `enabled`. */
export function useAccelerometer(
  onSample: (sample: AccelSample) => void,
  { enabled = true, intervalMs = 20 }: { enabled?: boolean; intervalMs?: number } = {},
): SensorStatus {
  const [status, setStatus] = useState<SensorStatus>('checking');
  const handler = useRef(onSample);
  useEffect(() => {
    handler.current = onSample;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let subscription: { remove: () => void } | null = null;
    (async () => {
      try {
        if (!(await Accelerometer.isAvailableAsync())) throw new Error('unavailable');
        Accelerometer.setUpdateInterval(intervalMs);
        subscription = Accelerometer.addListener((m) => {
          handler.current({ x: m.x, y: m.y, z: m.z, t: m.timestamp * 1000 });
        });
        if (!cancelled) setStatus('active');
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled, intervalMs]);

  return status;
}
