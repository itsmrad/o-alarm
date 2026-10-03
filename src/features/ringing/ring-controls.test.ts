import { snoozeControl, stopLabel } from './ring-controls';
import { ESCALATION_START_VOLUME, escalationVolume } from './use-ringing-feedback';

const policy = { enabled: true, durationMin: 9, maxCount: 3 };
const base = { policy, snoozesUsed: 0, missionBeforeSnooze: false, hasMissions: false };

describe('snoozeControl', () => {
  it('shows the remaining snoozes', () => {
    expect(snoozeControl(base)).toEqual({
      visible: true,
      enabled: true,
      label: 'Snooze 9 min',
      detail: '3 snoozes left',
      requiresMission: false,
    });
    expect(snoozeControl({ ...base, snoozesUsed: 2 }).detail).toBe('1 snooze left');
  });

  it('is disabled with clear text at the limit', () => {
    const control = snoozeControl({ ...base, snoozesUsed: 3 });
    expect(control).toMatchObject({ visible: true, enabled: false });
    expect(control.detail).toBe('No snoozes left (3 of 3 used).');
    expect(snoozeControl({ ...base, snoozesUsed: 7 }).enabled).toBe(false);
  });

  it('is hidden when snooze is off for the alarm', () => {
    for (const off of [
      { ...policy, enabled: false },
      { ...policy, maxCount: 0 },
    ]) {
      expect(snoozeControl({ ...base, policy: off })).toMatchObject({
        visible: false,
        enabled: false,
        detail: 'Snooze is off for this alarm.',
      });
    }
  });

  it('routes through the mission only when the alarm has one (D32)', () => {
    expect(snoozeControl({ ...base, missionBeforeSnooze: true }).requiresMission).toBe(false);
    const gated = snoozeControl({ ...base, missionBeforeSnooze: true, hasMissions: true });
    expect(gated.requiresMission).toBe(true);
    expect(gated.detail).toBe('3 snoozes left · mission first');
  });

  it('labels the stop control by whether a mission gates it', () => {
    expect(stopLabel(false)).toBe('Hold to stop');
    expect(stopLabel(true)).toBe('Hold to start mission');
  });
});

describe('escalationVolume', () => {
  it('ramps linearly to full volume, then holds', () => {
    const ramp = { enabled: true, rampSeconds: 30 };
    expect(escalationVolume(ramp, 0)).toBe(ESCALATION_START_VOLUME);
    expect(escalationVolume(ramp, 15_000)).toBeCloseTo((ESCALATION_START_VOLUME + 1) / 2);
    expect(escalationVolume(ramp, 30_000)).toBe(1);
    expect(escalationVolume(ramp, 90_000)).toBe(1);
  });

  it('is full volume without escalation', () => {
    expect(escalationVolume({ enabled: false, rampSeconds: 30 }, 0)).toBe(1);
    expect(escalationVolume({ enabled: true, rampSeconds: 0 }, 0)).toBe(1);
  });
});
