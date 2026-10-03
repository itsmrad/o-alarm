import {
  initialShakeState,
  shakeParamsFor,
  shakeStep,
  shakeConfigSchema,
  type AccelSample,
  type ShakeState,
} from './missions-shake';

const params = shakeParamsFor({ targetCount: 20, sensitivity: 'normal' });

/** Resting flat: 1 g on z. A jolt of `g` adds to the magnitude along z. */
const rest = (t: number): AccelSample => ({ x: 0, y: 0, z: 1, t });
const jolt = (t: number, g = 2.5): AccelSample => ({ x: 0, y: 0, z: 1 + g, t });

function run(samples: AccelSample[], p = params): ShakeState {
  return samples.reduce((s, sample) => shakeStep(s, sample, p), initialShakeState);
}

/** A shake = one jolt followed by rest, 20 ms sample spacing. */
function shakes(count: number, periodMs: number, g = 2.5): AccelSample[] {
  const out: AccelSample[] = [];
  for (let i = 0; i < count; i++) {
    const t0 = i * periodMs;
    for (let k = 0; k < periodMs / 20; k++)
      out.push(k < 2 ? jolt(t0 + k * 20, g) : rest(t0 + k * 20));
  }
  return out;
}

describe('shake detector', () => {
  it('counts nothing while at rest or on small jitter', () => {
    const jitter = Array.from({ length: 500 }, (_, i) => ({
      x: 0.05 * Math.sin(i),
      y: 0.05 * Math.cos(i),
      z: 1 + 0.05 * Math.sin(i * 3),
      t: i * 20,
    }));
    expect(run(jitter).count).toBe(0);
    expect(run(Array.from({ length: 100 }, (_, i) => rest(i * 20))).count).toBe(0);
  });

  it('counts one shake per jolt', () => {
    expect(run(shakes(10, 400)).count).toBe(10);
  });

  it('counts a sustained jolt once (hysteresis)', () => {
    const sustained = Array.from({ length: 50 }, (_, i) => jolt(i * 20));
    expect(run(sustained).count).toBe(1);
  });

  it('debounces jolts closer than the debounce window', () => {
    // jolt, brief rest below re-arm level, jolt again 100 ms later
    const samples = [jolt(0), rest(20), rest(40), jolt(100), rest(120)];
    expect(run(samples).count).toBe(1);
    expect(run([jolt(0), rest(20), jolt(300), rest(320)]).count).toBe(2);
  });

  it('respects sensitivity thresholds', () => {
    const gentle = shakeParamsFor({ targetCount: 20, sensitivity: 'gentle' });
    const vigorous = shakeParamsFor({ targetCount: 20, sensitivity: 'vigorous' });
    const medium = shakes(5, 400, 1.2);
    expect(run(medium, gentle).count).toBe(5);
    expect(run(medium, vigorous).count).toBe(0);
  });

  it('detects shakes in any axis direction (magnitude based)', () => {
    const samples = [
      { x: 3, y: 0, z: 0, t: 0 },
      rest(20),
      { x: 0, y: -3, z: 0, t: 400 },
      rest(420),
    ];
    expect(run(samples).count).toBe(2);
  });

  it('config defaults and bounds', () => {
    expect(shakeConfigSchema.parse({})).toEqual({ targetCount: 20, sensitivity: 'normal' });
    expect(shakeConfigSchema.safeParse({ targetCount: 1 }).success).toBe(false);
  });
});
