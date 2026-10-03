import { Alert } from 'react-native';

import { createAlarm, setOneOffOverride, toggleSkipNext, type Alarm } from '@/domain';

import { IMPORTANT_PROTECTION_MS, confirmWeakening, detectWeakening } from './important-guard';

const NY = 'America/New_York';
// Friday 05:00 in New York; the 07:00 weekday alarm is 2 h away.
const NOW = new Date('2026-10-02T09:00:00Z');

const alarm = (patch: Partial<Alarm> = {}) =>
  createAlarm({
    id: 'a1',
    hour: 7,
    minute: 0,
    weekdays: [1, 2, 3, 4, 5],
    important: true,
    ...patch,
  });

describe('detectWeakening', () => {
  it('flags delete, disable, skip and moving later of an imminent important alarm', () => {
    const before = alarm();
    expect(detectWeakening(before, null, NOW, NY)?.reasons).toEqual(['deletes it']);
    expect(detectWeakening(before, { ...before, enabled: false }, NOW, NY)?.reasons).toEqual([
      'turns it off',
    ]);
    expect(detectWeakening(before, toggleSkipNext(before, NOW, NY), NOW, NY)?.reasons).toEqual([
      'skips this ring',
    ]);
    expect(detectWeakening(before, { ...before, hour: 8 }, NOW, NY)?.reasons).toEqual([
      'moves it later',
    ]);
    const override = setOneOffOverride(before, NOW, NY, { hour: 7, minute: 30 });
    expect(detectWeakening(before, override, NOW, NY)?.reasons).toEqual(['moves it later']);
  });

  it('flags removing safeguards', () => {
    const before = alarm({
      snooze: { enabled: true, durationMin: 5, maxCount: 1 },
      missions: [{ missionId: 'math', config: {} }],
      missionBeforeSnooze: true,
    });
    const after: Alarm = {
      ...before,
      important: false,
      snooze: { enabled: true, durationMin: 10, maxCount: 1 },
      missions: [],
      missionBeforeSnooze: false,
    };
    expect(detectWeakening(before, after, NOW, NY)?.reasons).toEqual([
      'removes the Important protection',
      'allows more or longer snoozes',
      'removes a mission',
      'lets you snooze without the mission',
    ]);
  });

  it('allows strengthening changes and edits outside the protection window', () => {
    const before = alarm();
    expect(detectWeakening(before, { ...before, hour: 6 }, NOW, NY)).toBeNull();
    expect(detectWeakening(before, { ...before, label: 'Flight' }, NOW, NY)).toBeNull();
    expect(
      detectWeakening(
        before,
        { ...before, snooze: { enabled: false, durationMin: 9, maxCount: 0 } },
        NOW,
        NY,
      ),
    ).toBeNull();
    const farAway = new Date(Date.parse('2026-10-02T11:00:00Z') - IMPORTANT_PROTECTION_MS - 1);
    expect(detectWeakening(before, null, farAway, NY)).toBeNull();
  });

  it('never applies to alarms that are not important', () => {
    expect(detectWeakening(alarm({ important: false }), null, NOW, NY)).toBeNull();
  });
});

describe('confirmWeakening', () => {
  const alertSpy = jest.spyOn(Alert, 'alert');
  afterEach(() => alertSpy.mockReset());

  it('resolves immediately without a weakening', async () => {
    await expect(confirmWeakening(null, () => '')).resolves.toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('asks, and keeps the alarm unless the user confirms', async () => {
    const weakening = detectWeakening(alarm(), null, NOW, NY);
    alertSpy.mockImplementationOnce((_t, _m, buttons) =>
      buttons?.find((b) => b.style === 'cancel')?.onPress?.(),
    );
    await expect(confirmWeakening(weakening, () => 'today at 7:00 AM')).resolves.toBe(false);
    expect(alertSpy.mock.calls[0]?.[1]).toBe('It rings today at 7:00 AM. This change deletes it.');

    alertSpy.mockImplementationOnce((_t, _m, buttons) =>
      buttons?.find((b) => b.style === 'destructive')?.onPress?.(),
    );
    await expect(confirmWeakening(weakening, () => 'x')).resolves.toBe(true);
  });
});
