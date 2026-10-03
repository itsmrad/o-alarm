import { DEFAULT_WAKE_CHECK } from '@/domain';

import { MOVEMENT_STEPS, isProMethod, verificationFor } from './verification';

const config = (patch: Partial<typeof DEFAULT_WAKE_CHECK>) => ({
  ...DEFAULT_WAKE_CHECK,
  enabled: true,
  ...patch,
});

describe('verificationFor', () => {
  it('uses the free confirmation by default', () => {
    expect(verificationFor(config({}), { pro: false })).toEqual({
      kind: 'confirm',
      degraded: false,
    });
    expect(verificationFor(undefined, null)).toEqual({ kind: 'confirm', degraded: false });
  });

  it('runs movement / mission checks with Pro', () => {
    expect(verificationFor(config({ method: 'movement' }), { pro: true })).toEqual({
      kind: 'mission',
      steps: [{ missionId: 'steps', config: { targetSteps: MOVEMENT_STEPS } }],
      degraded: false,
    });
    expect(
      verificationFor(config({ method: 'mission', missionId: 'shake' }), { pro: true }),
    ).toMatchObject({ kind: 'mission', steps: [{ missionId: 'shake' }] });
  });

  it('degrades Pro methods to the confirmation without the entitlement (D18)', () => {
    for (const entitlement of [{ pro: false }, null, undefined]) {
      expect(verificationFor(config({ method: 'movement' }), entitlement)).toEqual({
        kind: 'confirm',
        degraded: true,
      });
    }
  });

  it('marks only the confirmation as free', () => {
    expect(isProMethod('confirm')).toBe(false);
    expect(isProMethod('movement')).toBe(true);
    expect(isProMethod('mission')).toBe(true);
  });
});
