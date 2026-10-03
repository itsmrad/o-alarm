import { resolvePurchasesConfig } from './config';

const base = { platform: 'ios', executionEnvironment: 'bare', dev: false };

describe('purchases config', () => {
  it('uses the platform key on a real build', () => {
    expect(resolvePurchasesConfig({ ...base, iosKey: 'appl_x', androidKey: 'goog_y' })).toEqual({
      mode: { kind: 'live' },
      apiKey: 'appl_x',
    });
    expect(
      resolvePurchasesConfig({
        ...base,
        platform: 'android',
        iosKey: 'appl_x',
        androidKey: ' goog_y ',
      }),
    ).toEqual({ mode: { kind: 'live' }, apiKey: 'goog_y' });
  });

  it('falls back to mock without a key for that platform', () => {
    expect(resolvePurchasesConfig({ ...base, iosKey: '', androidKey: 'goog_y' })).toEqual({
      mode: { kind: 'mock', reason: 'no-key', simulate: false },
      apiKey: null,
    });
  });

  it('falls back to mock in Expo Go and on unsupported platforms, even with a key', () => {
    expect(
      resolvePurchasesConfig({ ...base, iosKey: 'appl_x', executionEnvironment: 'storeClient' })
        .mode,
    ).toMatchObject({ kind: 'mock', reason: 'expo-go' });
    expect(
      resolvePurchasesConfig({ ...base, iosKey: 'appl_x', platform: 'web' }).mode,
    ).toMatchObject({
      kind: 'mock',
      reason: 'unsupported-platform',
    });
  });

  it('only simulates purchases in dev builds', () => {
    expect(resolvePurchasesConfig({ ...base, dev: true }).mode).toMatchObject({ simulate: true });
  });
});
