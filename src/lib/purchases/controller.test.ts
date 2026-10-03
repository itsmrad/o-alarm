import { createTestDatabase } from '@/db/testing/test-db';
import {
  bindEntitlementCache,
  getEntitlementSnapshot,
  resetEntitlementsForTests,
  setEntitlementFromProvider,
} from '@/lib/entitlements';

import { createPurchasesController } from './controller';
import { createMockClient } from './mock-client';
import type { CustomerSnapshot, PurchasesClient } from './types';

const NOW = new Date('2026-10-03T08:00:00Z');
const FREE: CustomerSnapshot = { proEntitlement: null, managementUrl: null };
const PRO: CustomerSnapshot = {
  managementUrl: null,
  proEntitlement: {
    isActive: true,
    willRenew: true,
    expirationDate: '2026-11-03T08:00:00.000Z',
    billingIssueDetectedAt: null,
    productIdentifier: 'pro_monthly',
    gracePeriodExpiresDate: null,
  },
};

afterEach(resetEntitlementsForTests);

function fakeClient(overrides: Partial<PurchasesClient> = {}) {
  const calls: string[] = [];
  const listeners = new Set<(c: CustomerSnapshot) => void>();
  const client: PurchasesClient = {
    mode: { kind: 'live' },
    start: async () => void calls.push('start'),
    logIn: async (id) => (calls.push(`logIn:${id}`), PRO),
    logOut: async () => (calls.push('logOut'), FREE),
    getCustomer: async () => (calls.push('getCustomer'), PRO),
    getOffering: async () => null,
    purchase: async () => ({ cancelled: false, customer: PRO }),
    restore: async () => PRO,
    onCustomerChange: (l) => (listeners.add(l), () => listeners.delete(l)),
    ...overrides,
  };
  return { client, calls, emit: (c: CustomerSnapshot) => listeners.forEach((l) => l(c)) };
}

describe('purchases controller', () => {
  it('applies CustomerInfo to the entitlement interface, including listener updates', async () => {
    const { client, emit } = fakeClient();
    const controller = createPurchasesController(client, { now: () => NOW });
    await controller.start();
    expect(getEntitlementSnapshot()).toMatchObject({ tier: 'pro', source: 'revenuecat' });
    expect(controller.getStatus().active).toBe(true);

    const seen = jest.fn();
    controller.subscribe(seen);
    emit(FREE);
    expect(getEntitlementSnapshot().tier).toBe('free');
    expect(seen).toHaveBeenCalled();
  });

  it('never downgrades a cached pro when RevenueCat is unreachable (D18)', async () => {
    const { db, close } = createTestDatabase();
    bindEntitlementCache(db, 'dev', () => NOW);
    setEntitlementFromProvider({ tier: 'pro', expiresAt: '2026-11-03T08:00:00.000Z' });
    resetEntitlementsForTests();
    bindEntitlementCache(db, 'dev', () => NOW); // "restart offline"
    expect(getEntitlementSnapshot()).toMatchObject({ tier: 'pro', source: 'cache' });

    const offline = () => Promise.reject(new Error('network request failed'));
    const { client } = fakeClient({
      start: offline,
      getCustomer: offline,
      logIn: offline,
      logOut: offline,
    });
    const controller = createPurchasesController(client, { now: () => NOW });
    await expect(controller.start()).resolves.toBeUndefined();
    await expect(controller.setUser('user_1')).resolves.toBeUndefined();
    await expect(controller.refresh()).resolves.toBeUndefined();
    expect(getEntitlementSnapshot()).toMatchObject({ tier: 'pro', source: 'cache' });
    close();
  });

  it('retries a failed identity change on the next refresh', async () => {
    let fail = true;
    const { client, calls } = fakeClient({
      logIn: async (id) => {
        if (fail) throw new Error('offline');
        calls.push(`logIn:${id}`);
        return PRO;
      },
    });
    const controller = createPurchasesController(client, { now: () => NOW });
    await controller.setUser('user_1');
    expect(calls).not.toContain('logIn:user_1');
    fail = false;
    await controller.refresh();
    expect(calls).toContain('logIn:user_1');
  });

  it('logs in on sign-in, logs out only after a sign-in, and ignores repeats', async () => {
    const { client, calls } = fakeClient();
    const controller = createPurchasesController(client, { now: () => NOW });
    await controller.setUser(null); // cold-start guest: already anonymous
    await controller.setUser('user_1');
    await controller.setUser('user_1');
    await controller.setUser(null);
    expect(calls.filter((c) => c.startsWith('log'))).toEqual(['logIn:user_1', 'logOut']);
    expect(getEntitlementSnapshot().tier).toBe('free'); // the signed-out device is a new anonymous user
  });

  it('configures before the first identity call', async () => {
    const { client, calls } = fakeClient();
    const controller = createPurchasesController(client, { now: () => NOW });
    void controller.start();
    await controller.setUser('user_1');
    expect(calls.slice(0, 2)).toEqual(['start', 'logIn:user_1']);
  });

  it('reports purchase outcomes and restores', async () => {
    const { client } = fakeClient({
      purchase: jest
        .fn()
        .mockResolvedValueOnce({ cancelled: true, customer: null })
        .mockResolvedValueOnce({ cancelled: false, customer: FREE })
        .mockResolvedValueOnce({ cancelled: false, customer: PRO }),
      restore: jest.fn().mockResolvedValueOnce(FREE).mockResolvedValueOnce(PRO),
    });
    const controller = createPurchasesController(client, { now: () => NOW });
    expect(await controller.purchase('m')).toBe('cancelled');
    expect(await controller.purchase('m')).toBe('pending');
    expect(await controller.purchase('m')).toBe('purchased');
    expect(getEntitlementSnapshot().tier).toBe('pro');
    resetEntitlementsForTests();
    expect(await controller.restore()).toBe(false);
    expect(await controller.restore()).toBe(true);
  });
});

describe('mock mode', () => {
  const mode = (simulate: boolean) => ({ kind: 'mock', reason: 'no-key', simulate }) as const;

  it('serves fallback prices and never throws on lifecycle calls', async () => {
    const controller = createPurchasesController(createMockClient(mode(false)), {
      now: () => NOW,
    });
    await controller.start();
    await controller.setUser('user_1');
    await controller.setUser(null);
    await controller.refresh();
    const offering = await controller.getOffering();
    expect(offering?.monthly?.priceString).toBe('$1.99');
    expect(offering?.annual?.priceString).toBe('$14.99');
    expect(getEntitlementSnapshot().tier).toBe('free');
  });

  it('refuses purchases outside dev so a misconfigured build cannot grant Pro', async () => {
    const controller = createPurchasesController(createMockClient(mode(false)), {
      now: () => NOW,
    });
    await expect(controller.purchase('preview_monthly')).rejects.toThrow(/not available/);
    expect(getEntitlementSnapshot().tier).toBe('free');
  });

  it('grants Pro in memory when simulating (dev), and sign-out clears it', async () => {
    const controller = createPurchasesController(
      createMockClient(mode(true), () => NOW),
      {
        now: () => NOW,
      },
    );
    await controller.setUser('user_1');
    expect(await controller.purchase('preview_annual')).toBe('purchased');
    expect(getEntitlementSnapshot()).toMatchObject({ tier: 'pro', expiresAt: expect.any(String) });
    await controller.setUser(null);
    expect(getEntitlementSnapshot().tier).toBe('free');
  });
});
