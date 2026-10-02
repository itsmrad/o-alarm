import { createAlarm, setOneOffOverride, type Alarm } from '@/domain';

import { reconcile } from './reconcile';
import { PreviewAlarmEngine } from './preview-engine';
import { desiredSpecs, specFingerprint } from './specs';
import { FakeAlarmEngine } from './testing/fake-engine';

const NY = 'America/New_York';
const now = new Date('2026-10-02T05:00:00Z'); // Fri 01:00 EDT
const alarm = (patch: Partial<Alarm> = {}) =>
  createAlarm({ id: 'a', hour: 7, minute: 30, weekdays: [5, 1, 3], ...patch });

describe('wallClock on alarm specs (D28)', () => {
  it('floating alarm: device-relative wall clock with a null zone', () => {
    const [spec] = desiredSpecs([alarm()], now, NY, 1);
    expect(spec?.wallClock).toEqual({
      hour: 7,
      minute: 30,
      localDate: '2026-10-02',
      timeZone: null,
      weekdays: [1, 3, 5],
    });
  });

  it('fixed-zone alarm: carries its IANA zone and the local date in that zone', () => {
    // 05:00Z is already Friday 14:00 in Tokyo, so the next 07:30 there is Monday.
    const [spec] = desiredSpecs(
      [alarm({ timezonePolicy: 'fixed', timeZone: 'Asia/Tokyo' })],
      now,
      NY,
      1,
    );
    expect(spec?.wallClock).toEqual({
      hour: 7,
      minute: 30,
      localDate: '2026-10-05',
      timeZone: 'Asia/Tokyo',
      weekdays: [1, 3, 5],
    });
  });

  it('maps domain weekdays as-is (0 = Sunday)', () => {
    const [spec] = desiredSpecs([alarm({ weekdays: [0, 6] })], now, NY, 1);
    expect(spec?.wallClock?.weekdays).toEqual([0, 6]);
    expect(spec?.wallClock?.localDate).toBe('2026-10-03'); // Saturday
  });

  it('one-time alarm → empty weekdays', () => {
    const [spec] = desiredSpecs([alarm({ weekdays: [], date: '2026-10-04' })], now, NY, 1);
    expect(spec?.wallClock).toMatchObject({ weekdays: [], localDate: '2026-10-04' });
  });

  it("uses the occurrence's effective time when a one-off override applies", () => {
    const overridden = setOneOffOverride(alarm(), now, NY, { hour: 6, minute: 0 });
    const [first, second] = desiredSpecs([overridden], now, NY, 2);
    expect(first?.wallClock).toMatchObject({ hour: 6, minute: 0, localDate: '2026-10-02' });
    expect(second?.wallClock).toMatchObject({ hour: 7, minute: 30, localDate: '2026-10-05' });
  });

  it('snooze and wake-check follow-ups are instant-only', async () => {
    const engine = new PreviewAlarmEngine(() => now, { autoRing: false });
    const [spec] = desiredSpecs(
      [alarm({ snooze: { enabled: true, durationMin: 9, maxCount: 3 } })],
      now,
      NY,
      1,
    );
    await engine.previewAlarm(spec!);
    const snooze = await engine.snooze(spec!.id);
    expect(snooze.kind).toBe('snooze');
    expect(snooze).not.toHaveProperty('wallClock');
    engine.checkDue();
    const ringing = await engine.getActiveRinging();
    expect(ringing).toBeNull(); // snooze not due yet; nothing rings
    await engine.previewAlarm(spec!);
    const { wakeCheck } = await engine.dismiss(spec!.id, {
      missionCompleted: true,
      wakeCheckAt: '2026-10-02T05:10:00.000Z',
    });
    expect(wakeCheck).not.toHaveProperty('wallClock');
  });

  it('preview engine stores and returns wallClock unchanged', async () => {
    const engine = new PreviewAlarmEngine(() => now, { autoRing: false });
    const [spec] = desiredSpecs([alarm()], now, NY, 1);
    await engine.schedule(spec!);
    expect((await engine.getScheduled())[0]?.wallClock).toEqual(spec!.wallClock);
  });
});

describe('specFingerprint with wallClock', () => {
  const [spec] = desiredSpecs([alarm()], now, NY, 1);

  it('ignores weekday order/duplicates and treats a missing zone as null', () => {
    const wc = spec!.wallClock!;
    expect(specFingerprint({ ...spec!, wallClock: { ...wc, weekdays: [5, 3, 1, 3] } })).toBe(
      specFingerprint(spec!),
    );
    const { timeZone: _tz, ...noZone } = wc;
    expect(specFingerprint({ ...spec!, wallClock: noZone as typeof wc })).toBe(
      specFingerprint(spec!),
    );
  });

  it('changes when the rule changes even if the fire instant does not', () => {
    const wc = spec!.wallClock!;
    expect(specFingerprint({ ...spec!, wallClock: { ...wc, weekdays: [1, 2, 3, 5] } })).not.toBe(
      specFingerprint(spec!),
    );
    expect(specFingerprint({ ...spec!, wallClock: undefined })).not.toBe(specFingerprint(spec!));
  });

  it('reconcile reschedules on a rule-only change and never churns otherwise', async () => {
    const engine = new FakeAlarmEngine();
    await reconcile([alarm()], engine, { now, timeZone: NY });
    engine.calls = [];
    await reconcile([alarm()], engine, { now, timeZone: NY });
    expect(engine.calls).toEqual([]);

    // Adding Tuesday keeps Fri's and Mon's fire instants but changes the rule.
    const result = await reconcile([alarm({ weekdays: [1, 2, 3, 5] })], engine, {
      now,
      timeZone: NY,
    });
    expect(result.plan.reschedule.map((s) => s.id)).toEqual(['a@2026-10-02', 'a@2026-10-05']);
    expect(result.verified).toBe(true);
    expect(engine.entries.every((e) => e.wallClock?.weekdays.join() === '1,2,3,5')).toBe(true);
  });

  it('a native read-back that drops wallClock is reported as a mismatch', async () => {
    const engine = new FakeAlarmEngine();
    engine.corruptOnSchedule = ({ wallClock: _w, ...entry }) => entry;
    const result = await reconcile([alarm()], engine, { now, timeZone: NY });
    expect(result.verified).toBe(false);
    expect(result.mismatches).toHaveLength(2);
  });
});
