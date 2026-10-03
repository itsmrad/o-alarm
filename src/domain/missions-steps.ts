import { z } from 'zod';

import type { AccelSample } from './missions-shake';

export const stepsConfigSchema = z.object({
  targetSteps: z.number().int().min(10).max(200).default(30),
});
export type StepsConfig = z.infer<typeof stepsConfigSchema>;

export const defaultStepsConfig: StepsConfig = { targetSteps: 30 };

export interface StepParams {
  /** Smoothed deviation from the gravity baseline (g) that starts a step. */
  threshold: number;
  /** Deviation below which the detector re-arms. */
  releaseThreshold: number;
  /** Minimum time between steps (caps cadence at ~3.5 steps/s). */
  minIntervalMs: number;
  smoothingMs: number;
  baselineMs: number;
}

export const DEFAULT_STEP_PARAMS: StepParams = {
  threshold: 0.12,
  releaseThreshold: 0.05,
  minIntervalMs: 280,
  smoothingMs: 60,
  baselineMs: 1000,
};

export interface StepState {
  count: number;
  smooth: number | null;
  baseline: number | null;
  lastT: number | null;
  armed: boolean;
  lastStepAt: number | null;
}

export const initialStepState: StepState = {
  count: 0,
  smooth: null,
  baseline: null,
  lastT: null,
  armed: true,
  lastStepAt: null,
};

/**
 * Accelerometer step detector (fallback when no hardware pedometer is available):
 * smooth |a|, subtract a slow gravity baseline, count rising threshold crossings with
 * hysteresis and a minimum step interval.
 */
export function stepStep(
  state: StepState,
  sample: AccelSample,
  params: StepParams = DEFAULT_STEP_PARAMS,
): StepState {
  const magnitude = Math.hypot(sample.x, sample.y, sample.z);
  if (state.smooth === null || state.baseline === null || state.lastT === null) {
    return { ...state, smooth: magnitude, baseline: magnitude, lastT: sample.t };
  }
  const dt = Math.max(0, sample.t - state.lastT);
  const smooth =
    state.smooth + (1 - Math.exp(-dt / params.smoothingMs)) * (magnitude - state.smooth);
  const baseline =
    state.baseline + (1 - Math.exp(-dt / params.baselineMs)) * (magnitude - state.baseline);
  const next = { ...state, smooth, baseline, lastT: sample.t };

  const deviation = smooth - baseline; // positive peaks only: one step per bounce
  if (!state.armed) {
    return deviation < params.releaseThreshold ? { ...next, armed: true } : next;
  }
  if (deviation < params.threshold) return next;
  const tooSoon = state.lastStepAt !== null && sample.t - state.lastStepAt < params.minIntervalMs;
  return {
    ...next,
    armed: false,
    count: tooSoon ? state.count : state.count + 1,
    lastStepAt: tooSoon ? state.lastStepAt : sample.t,
  };
}
