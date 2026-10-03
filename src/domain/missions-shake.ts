import { z } from 'zod';

export const SHAKE_SENSITIVITIES = ['gentle', 'normal', 'vigorous'] as const;
export type ShakeSensitivity = (typeof SHAKE_SENSITIVITIES)[number];

/** Peak deviation from 1 g (in g) a sample must exceed to count as a shake. */
export const SHAKE_THRESHOLDS: Record<ShakeSensitivity, number> = {
  gentle: 0.9,
  normal: 1.5,
  vigorous: 2.2,
};

export const shakeConfigSchema = z.object({
  targetCount: z.number().int().min(5).max(100).default(20),
  sensitivity: z.enum(SHAKE_SENSITIVITIES).default('normal'),
});
export type ShakeConfig = z.infer<typeof shakeConfigSchema>;

export const defaultShakeConfig: ShakeConfig = { targetCount: 20, sensitivity: 'normal' };

/** Accelerometer reading in g; `t` in milliseconds on any monotonic clock. */
export interface AccelSample {
  x: number;
  y: number;
  z: number;
  t: number;
}

export interface ShakeParams {
  threshold: number;
  /** Minimum time between two counted shakes. */
  debounceMs: number;
}

export const DEFAULT_SHAKE_DEBOUNCE_MS = 250;

export interface ShakeState {
  count: number;
  /** False while a jolt is still above the re-arm level, so one jolt counts once. */
  armed: boolean;
  lastShakeAt: number | null;
}

export const initialShakeState: ShakeState = { count: 0, armed: true, lastShakeAt: null };

export function shakeParamsFor(config: ShakeConfig): ShakeParams {
  return { threshold: SHAKE_THRESHOLDS[config.sensitivity], debounceMs: DEFAULT_SHAKE_DEBOUNCE_MS };
}

/** One shake-detector step: threshold + hysteresis (re-arm at half) + debounce. */
export function shakeStep(state: ShakeState, sample: AccelSample, params: ShakeParams): ShakeState {
  const delta = Math.abs(Math.hypot(sample.x, sample.y, sample.z) - 1);
  if (!state.armed) {
    return delta < params.threshold / 2 ? { ...state, armed: true } : state;
  }
  if (delta < params.threshold) return state;
  const debounced = state.lastShakeAt !== null && sample.t - state.lastShakeAt < params.debounceMs;
  return {
    count: debounced ? state.count : state.count + 1,
    armed: false,
    lastShakeAt: debounced ? state.lastShakeAt : sample.t,
  };
}
