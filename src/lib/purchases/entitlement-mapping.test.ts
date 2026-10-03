import { mapProStatus, toProviderEntitlement } from './entitlement-mapping';
import type { CustomerSnapshot } from './types';

const NOW = new Date('2026-10-03T08:00:00Z');
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY).toISOString();

const customer = (
  pro: Partial<NonNullable<CustomerSnapshot['proEntitlement']>> | null,
): CustomerSnapshot => ({
  managementUrl: 'https://manage.example/sub',
  proEntitlement: pro && {
    isActive: true,
    willRenew: true,
    expirationDate: iso(10),
    billingIssueDetectedAt: null,
    productIdentifier: 'pro_monthly',
    gracePeriodExpiresDate: null,
    ...pro,
  },
});

describe('entitlement mapping', () => {
  it('maps an active pro entitlement to the pro tier with its expiry', () => {
    const status = mapProStatus(customer({}), NOW);
    expect(status).toMatchObject({
      active: true,
      billingIssue: false,
      inGrace: false,
      willRenew: true,
      expiresAt: iso(10),
      productId: 'pro_monthly',
    });
    expect(toProviderEntitlement(status)).toEqual({
      tier: 'pro',
      source: 'revenuecat',
      expiresAt: iso(10),
    });
  });

  it('maps no entitlement and an expired one to free', () => {
    for (const info of [customer(null), customer({ isActive: false, expirationDate: iso(-3) })]) {
      const status = mapProStatus(info, NOW);
      expect(status.active).toBe(false);
      expect(status.managementUrl).toBe('https://manage.example/sub');
      expect(toProviderEntitlement(status)).toEqual({
        tier: 'free',
        source: 'revenuecat',
        expiresAt: null,
      });
    }
  });

  it('keeps pro through the billing grace period, expiring at the grace end', () => {
    const status = mapProStatus(
      customer({
        expirationDate: iso(-1),
        billingIssueDetectedAt: iso(-1),
        gracePeriodExpiresDate: iso(5),
      }),
      NOW,
    );
    expect(status).toMatchObject({ active: true, inGrace: true, billingIssue: true });
    expect(status.expiresAt).toBe(iso(5));
    expect(toProviderEntitlement(status).tier).toBe('pro');
  });

  it('flags a billing issue on a still-active subscription without changing the tier', () => {
    const status = mapProStatus(customer({ billingIssueDetectedAt: iso(-1) }), NOW);
    expect(status).toMatchObject({ active: true, billingIssue: true, inGrace: false });
    expect(toProviderEntitlement(status).tier).toBe('pro');
  });

  it('drops to free once the billing issue was never resolved (no longer active)', () => {
    const status = mapProStatus(
      customer({ isActive: false, expirationDate: iso(-8), billingIssueDetectedAt: iso(-9) }),
      NOW,
    );
    expect(toProviderEntitlement(status).tier).toBe('free');
    expect(status.billingIssue).toBe(false);
  });

  it('gives lifetime/promotional grants (no expiration) no expiry', () => {
    const status = mapProStatus(customer({ expirationDate: null, willRenew: false }), NOW);
    expect(toProviderEntitlement(status)).toEqual({
      tier: 'pro',
      source: 'revenuecat',
      expiresAt: null,
    });
  });

  it('trusts RevenueCat when it calls a past-dated entitlement active (no local expiry)', () => {
    const status = mapProStatus(customer({ expirationDate: iso(-1) }), NOW);
    expect(status.active).toBe(true);
    expect(status.expiresAt).toBeNull();
  });
});
