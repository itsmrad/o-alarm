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
