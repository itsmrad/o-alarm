import type { AccelSample } from './missions-shake';
import { initialStepState, stepStep, stepsConfigSchema, type StepState } from './missions-steps';

const HZ = 50;

function run(samples: AccelSample[]): StepState {
  return samples.reduce((s, sample) => stepStep(s, sample, undefined), initialStepState);
}

/** Vertical bounce at `cadence` steps/s with the given amplitude (g) on top of 1 g. */
function walking(seconds: number, cadence: number, amplitude: number, noise = 0): AccelSample[] {
  return Array.from({ length: seconds * HZ }, (_, i) => {
    const t = (i * 1000) / HZ;
    const bounce = amplitude * Math.sin(2 * Math.PI * cadence * (t / 1000));
    return { x: noise * Math.sin(i * 1.7), y: noise * Math.cos(i * 2.3), z: 1 + bounce, t };
  });
}

describe('step detector', () => {
  it('counts ~cadence × duration for normal walking', () => {
    const state = run(walking(20, 2, 0.3));
    expect(Math.abs(state.count - 40)).toBeLessThanOrEqual(2);
  });

  it('counts slow walking', () => {
    const state = run(walking(20, 1.5, 0.22));
    expect(Math.abs(state.count - 30)).toBeLessThanOrEqual(2);
  });

  it('counts nothing when the phone lies still or jitters slightly', () => {
    expect(run(walking(30, 2, 0)).count).toBe(0);
    expect(run(walking(30, 2, 0, 0.03)).count).toBe(0);
  });

  it('is robust to a tilt (gravity redistributed across axes)', () => {
    const tilted = walking(20, 2, 0.3).map((s) => ({
      ...s,
      x: s.z * Math.sin(0.8),
      z: s.z * Math.cos(0.8),
    }));
    expect(Math.abs(run(tilted).count - 40)).toBeLessThanOrEqual(2);
  });

  it('caps cadence with the minimum step interval', () => {
    // 8 Hz bounce is not walking; must not count 8 steps/s.
    const state = run(walking(10, 8, 0.5));
    expect(state.count).toBeLessThanOrEqual(10 * 3.6);
  });

  it('config defaults and bounds', () => {
    expect(stepsConfigSchema.parse({})).toEqual({ targetSteps: 30 });
    expect(stepsConfigSchema.safeParse({ targetSteps: 3 }).success).toBe(false);
  });
});
