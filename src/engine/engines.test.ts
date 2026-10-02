import { ExecutionEnvironment } from 'expo-constants';

import { createAlarm } from '@/domain';

import { NativeAlarmEngine } from './native-engine';
import { PreviewAlarmEngine } from './preview-engine';
import { resolveEngine } from './resolve-engine';
import { desiredSpecs } from './specs';
import { AlarmEngineError } from './types';

const now = new Date('2026-10-02T05:00:00Z');
const [spec] = desiredSpecs(
  [createAlarm({ id: 'a', hour: 7, minute: 0, weekdays: [1, 2, 3, 4, 5] })],
  now,
  'UTC',
  1,
);

describe('PreviewAlarmEngine', () => {
  it('stores, upserts, reads back and cancels', async () => {
    const engine = new PreviewAlarmEngine(() => now);
    await engine.schedule(spec!);
    await engine.schedule({ ...spec!, label: 'Changed' });
    expect(await engine.getScheduled()).toEqual([
      expect.objectContaining({ id: spec!.id, label: 'Changed' }),
    ]);
    await engine.cancel(spec!.id);
    expect(await engine.getScheduled()).toEqual([]);
  });

  it('rejects past fire times', async () => {
    const engine = new PreviewAlarmEngine(() => new Date('2030-01-01T00:00:00Z'));
    await expect(engine.schedule(spec!)).rejects.toMatchObject({ code: 'INVALID_SPEC' });
  });

  it('is honest that it cannot ring', async () => {
    const readiness = await new PreviewAlarmEngine(() => now).getReadiness();
    expect(readiness.canRing).toBe(false);
    expect(readiness.items[0]).toMatchObject({ kind: 'engine', status: 'blocking' });
    expect(await new PreviewAlarmEngine().requestPermission()).toBe('unavailable');
  });

  it('previewAlarm emits an in-app trigger event', async () => {
    const engine = new PreviewAlarmEngine(() => now);
    const received = new Promise((resolve) => engine.addListener('trigger', resolve));
    await engine.previewAlarm(spec!);
    await expect(received).resolves.toMatchObject({ scheduleId: spec!.id, kind: 'alarm' });
  });
});

describe('resolveEngine (D6)', () => {
  const fakeNative = {} as never;

  it('uses the preview engine in Expo Go even if a module is present', () => {
    const engine = resolveEngine({
      nativeModule: fakeNative,
      executionEnvironment: ExecutionEnvironment.StoreClient,
    });
    expect(engine.kind).toBe('preview');
  });

  it('uses the preview engine when the module is missing', () => {
    expect(resolveEngine({ nativeModule: null, executionEnvironment: 'bare' }).kind).toBe(
      'preview',
    );
  });

  it('uses the native engine in a dev/production build', () => {
    const engine = resolveEngine({ nativeModule: fakeNative, executionEnvironment: 'bare' });
    expect(engine).toBeInstanceOf(NativeAlarmEngine);
  });

  it('defaults to preview under jest (module not linked)', () => {
    expect(resolveEngine().kind).toBe('preview');
  });
});

describe('NativeAlarmEngine', () => {
  it('normalizes native NOT_IMPLEMENTED rejections', async () => {
    const reject = () =>
      Promise.reject(Object.assign(new Error('stub'), { code: 'NOT_IMPLEMENTED' }));
    const engine = new NativeAlarmEngine({ schedule: reject, getScheduled: reject } as never);
    const error = await engine.schedule(spec!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AlarmEngineError);
    expect(error).toMatchObject({ code: 'NOT_IMPLEMENTED', message: 'stub' });
  });

  it('maps ERR_-prefixed and unknown codes', () => {
    expect(AlarmEngineError.from({ code: 'ERR_PERMISSION_DENIED', message: 'x' }).code).toBe(
      'PERMISSION_DENIED',
    );
    expect(AlarmEngineError.from(new Error('boom')).code).toBe('UNKNOWN');
  });
});

describe('PreviewAlarmEngine ringing simulation', () => {
  const base = spec!; // a@2026-10-02 07:00Z, snooze 9 min × 3
  let clock: Date;
  const make = (options = { autoRing: false }) => new PreviewAlarmEngine(() => clock, options);
  const advanceTo = (iso: string) => (clock = new Date(iso));

  beforeEach(() => {
    clock = new Date('2026-10-02T06:00:00Z');
  });

  it('rings a due alarm, exposes it for cold start, and records trigger_received', async () => {
    const engine = make();
    const triggered = new Promise((resolve) => engine.addListener('trigger', resolve));
    await engine.schedule(base);
    engine.checkDue();
    expect(await engine.getActiveRinging()).toBeNull(); // not due yet

    advanceTo('2026-10-02T07:00:00Z');
    engine.checkDue();
    await expect(triggered).resolves.toMatchObject({ scheduleId: base.id, kind: 'alarm' });
    expect(await engine.getActiveRinging()).toEqual({
      scheduleId: base.id,
      alarmId: 'a',
      occurrenceKey: base.occurrenceKey,
      kind: 'alarm',
      at: '2026-10-02T07:00:00.000Z',
      firedAt: '2026-10-02T07:00:00.000Z',
      snoozeCount: 0,
      label: 'Alarm',
      hasMissions: false,
      wakeCheck: false,
      important: false,
    });
    expect(await engine.getScheduled()).toEqual([]); // consumed
    expect((await engine.drainObservedEvents()).map((e) => e.type)).toEqual(['trigger_received']);
  });

  it('auto-rings from its own timer while the app is open', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-02T06:59:00Z') });
    try {
      const engine = new PreviewAlarmEngine();
      const listener = jest.fn();
      engine.addListener('trigger', listener);
      await engine.schedule(base);
      jest.advanceTimersByTime(60_000);
      jest.runOnlyPendingTimers(); // flush the async trigger callback
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: base.id }));
      expect(await engine.getActiveRinging()).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('snooze stops ringing and schedules the next snooze; enforces the limit', async () => {
    const engine = make();
    const snoozed = jest.fn();
    engine.addListener('snooze', snoozed);
    await engine.previewAlarm({ ...base, snooze: { enabled: true, durationMin: 5, maxCount: 2 } });

    const first = await engine.snooze(base.id);
    expect(first).toMatchObject({
      id: `${base.occurrenceKey}#snooze-1`,
      kind: 'snooze',
      fireAt: '2026-10-02T06:05:00.000Z',
    });
    expect(await engine.getActiveRinging()).toBeNull();
    expect(snoozed).toHaveBeenCalledTimes(1);

    advanceTo('2026-10-02T06:05:00Z');
    engine.checkDue();
    expect(await engine.getActiveRinging()).toMatchObject({ scheduleId: first.id, snoozeCount: 1 });
    const second = await engine.snooze(first.id);
    expect(second.id).toBe(`${base.occurrenceKey}#snooze-2`);

    advanceTo('2026-10-02T06:10:00Z');
    engine.checkDue();
    await expect(engine.snooze(second.id)).rejects.toMatchObject({ code: 'SNOOZE_LIMIT' });
    expect(await engine.getActiveRinging()).toMatchObject({ scheduleId: second.id }); // still ringing
  });

  it('snooze is refused when the alarm disallows it', async () => {
    const engine = make();
    await engine.previewAlarm({ ...base, snooze: { enabled: false, durationMin: 9, maxCount: 3 } });
    await expect(engine.snooze(base.id)).rejects.toMatchObject({ code: 'SNOOZE_LIMIT' });
  });

  it('snooze/dismiss reject NOT_RINGING for anything but the ringing alarm', async () => {
    const engine = make();
    await expect(engine.snooze(base.id)).rejects.toMatchObject({ code: 'NOT_RINGING' });
    await engine.previewAlarm(base);
    await expect(engine.dismiss('other', { missionCompleted: true })).rejects.toMatchObject({
      code: 'NOT_RINGING',
    });
  });

  it('dismiss stops ringing, resets snoozes and can schedule a wake check', async () => {
    const engine = make();
    const dismissed = jest.fn();
    engine.addListener('dismiss', dismissed);
    await engine.previewAlarm(base);
    await engine.snooze(base.id);
    advanceTo('2026-10-02T06:09:00Z');
    engine.checkDue();
    const ringing = await engine.getActiveRinging();

    const result = await engine.dismiss(ringing!.scheduleId, {
      missionCompleted: true,
      wakeCheckAt: '2026-10-02T06:14:00.000Z',
    });
    expect(result.wakeCheck).toMatchObject({
      id: `${base.occurrenceKey}#wake-check-1`,
      kind: 'wake_check',
      fireAt: '2026-10-02T06:14:00.000Z',
      alarmId: 'a',
    });
    expect(await engine.getActiveRinging()).toBeNull();
    expect(dismissed).toHaveBeenCalledTimes(1);

    // The wake check rings like any alarm, with a fresh snooze count.
    advanceTo('2026-10-02T06:14:00Z');
    engine.checkDue();
    expect(await engine.getActiveRinging()).toMatchObject({ kind: 'wake_check', snoozeCount: 0 });
    const again = await engine.dismiss(`${base.occurrenceKey}#wake-check-1`, {
      missionCompleted: true,
      wakeCheckAt: '2026-10-02T06:20:00.000Z',
    });
    expect(again.wakeCheck?.id).toBe(`${base.occurrenceKey}#wake-check-2`);
  });

  it('dismiss without wakeCheckAt schedules nothing; a past wakeCheckAt keeps it ringing', async () => {
    const engine = make();
    await engine.previewAlarm(base);
    await expect(
      engine.dismiss(base.id, { missionCompleted: false, wakeCheckAt: '2026-10-02T05:00:00Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    expect(await engine.getActiveRinging()).not.toBeNull();
    expect(await engine.dismiss(base.id, { missionCompleted: false })).toEqual({});
    expect(await engine.getScheduled()).toEqual([]);
  });

  it('observed events: drain is repeatable until ack; ack is idempotent', async () => {
    const engine = make();
    await engine.previewAlarm(base);
    await engine.snooze(base.id);
    const drained = await engine.drainObservedEvents();
    expect(drained.map((e) => e.type)).toEqual(['trigger_received', 'snoozed']);
    expect(drained[0]).toEqual({
      id: expect.any(String),
      type: 'trigger_received',
      scheduleId: base.id,
      alarmId: 'a',
      occurrenceKey: base.occurrenceKey,
      at: '2026-10-02T06:00:00.000Z',
    });
    expect(await engine.drainObservedEvents()).toEqual(drained);

    await engine.ackObservedEvents([drained[0]!.id]);
    await engine.ackObservedEvents([drained[0]!.id, 'unknown']);
    expect(await engine.drainObservedEvents()).toEqual([drained[1]]);
    await engine.ackObservedEvents(drained.map((e) => e.id));
    expect(await engine.drainObservedEvents()).toEqual([]);
  });

  it('a test ring takes over the current ring', async () => {
    const engine = make();
    await engine.previewAlarm(base);
    await engine.previewAlarm({ ...base, id: 'a#test', occurrenceKey: 'a#test' });
    expect(await engine.getActiveRinging()).toMatchObject({ scheduleId: 'a#test' });
  });
});

describe('NativeAlarmEngine ringing passthrough', () => {
  it('forwards the new calls and normalizes stub rejections', async () => {
    const reject = () =>
      Promise.reject(Object.assign(new Error('stub'), { code: 'NOT_IMPLEMENTED' }));
    const native = {
      getActiveRinging: jest.fn(async () => null),
      snooze: jest.fn(reject),
      dismiss: jest.fn(async () => ({})),
      drainObservedEvents: jest.fn(async () => []),
      ackObservedEvents: jest.fn(reject),
    };
    const engine = new NativeAlarmEngine(native as never);
    expect(await engine.getActiveRinging()).toBeNull();
    await expect(engine.snooze('x')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(await engine.dismiss('x', { missionCompleted: true, wakeCheckAt: 'w' })).toEqual({});
    expect(native.dismiss).toHaveBeenCalledWith('x', { missionCompleted: true, wakeCheckAt: 'w' });
    expect(await engine.drainObservedEvents()).toEqual([]);
    await expect(engine.ackObservedEvents(['1'])).rejects.toBeInstanceOf(AlarmEngineError);
  });
});
