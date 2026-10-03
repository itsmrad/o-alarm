import { act, renderHook } from '@testing-library/react-native';

import { createTestDatabase } from '@/db/testing/test-db';
import { PREFERENCE_KEYS, readPreference, writePreference } from '@/lib/sync/local-store';

import {
  bindEntitlementCache,
  getEntitlementSnapshot,
  resetEntitlementsForTests,
  setEntitlementFromProvider,
  useEntitlement,
} from './index';

const NOW = new Date('2026-10-03T08:00:00Z');

afterEach(resetEntitlementsForTests);

describe('entitlements', () => {
  it('defaults to free without a provider or cache', () => {
    expect(getEntitlementSnapshot()).toEqual({
      tier: 'free',
      source: 'default',
      updatedAt: null,
      expiresAt: null,
    });
  });

  it('persists provider updates and restores them as the cache on the next launch', () => {
    const { db, close } = createTestDatabase();
    bindEntitlementCache(db, 'dev', () => NOW);
    setEntitlementFromProvider({ tier: 'pro', expiresAt: '2026-11-03T08:00:00.000Z' });
    expect(getEntitlementSnapshot()).toMatchObject({ tier: 'pro', source: 'revenuecat' });
    expect(readPreference(db, PREFERENCE_KEYS.entitlement)).toMatchObject({ tier: 'pro' });

    // "Restart": module state gone, cache remains.
    resetEntitlementsForTests();
    expect(getEntitlementSnapshot().tier).toBe('free');
    bindEntitlementCache(db, 'dev', () => NOW);
    expect(getEntitlementSnapshot()).toEqual({
      tier: 'pro',
      source: 'cache',
      updatedAt: NOW.toISOString(),
      expiresAt: '2026-11-03T08:00:00.000Z',
    });
    close();
  });

  it('reads a lapsed cached pro as free (D18 degrade, never block)', () => {
    const { db, close } = createTestDatabase();
    bindEntitlementCache(db, 'dev', () => NOW);
    setEntitlementFromProvider({ tier: 'pro', expiresAt: '2026-10-01T00:00:00.000Z' });
    expect(getEntitlementSnapshot()).toMatchObject({ tier: 'free', source: 'revenuecat' });
    close();
  });

  it('ignores a corrupt cache and keeps the free default', () => {
    const { db, close } = createTestDatabase();
    writePreference(
      db,
      PREFERENCE_KEYS.entitlement,
      { tier: 'gold' },
      { now: NOW, deviceId: 'dev' },
    );
    bindEntitlementCache(db, 'dev', () => NOW);
    expect(getEntitlementSnapshot()).toMatchObject({ tier: 'free', source: 'default' });
    close();
  });

  it('works without a bound cache (in-memory only) and notifies hook users', () => {
    const { result } = renderHook(() => useEntitlement());
    expect(result.current.tier).toBe('free');
    act(() => {
      setEntitlementFromProvider({ tier: 'pro', source: 'server' });
    });
    expect(result.current).toMatchObject({ tier: 'pro', source: 'server' });
  });
});
