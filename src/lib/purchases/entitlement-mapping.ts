import type { ProviderEntitlement } from '@/lib/entitlements';

import { NO_PRO, type CustomerSnapshot, type ProStatus } from './types';

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

/**
 * RevenueCat's own `isActive` is authoritative (it already covers store grace periods and
 * lifetime/promotional grants). We only derive an expiry for the local cache, so a cached
 * `pro` that stops being refreshed still lapses eventually (D18):
 *   - normal: the entitlement expiration;
 *   - billing grace: active *past* its expiration, so the later `gracePeriodExpiresDate`;
 *   - active but no usable future date (lifetime, or a past date RevenueCat still calls
 *     active): no expiry; the next online CustomerInfo corrects it.
 */
export function mapProStatus(customer: CustomerSnapshot, now: Date = new Date()): ProStatus {
  const pro = customer.proEntitlement;
  if (!pro || !pro.isActive) return { ...NO_PRO, managementUrl: customer.managementUrl };

  const nowMs = now.getTime();
  const expiration = ms(pro.expirationDate);
  const grace = ms(pro.gracePeriodExpiresDate);
  const latest = Math.max(expiration ?? -Infinity, grace ?? -Infinity);
  return {
    active: true,
    billingIssue: pro.billingIssueDetectedAt !== null,
    inGrace: expiration !== null && expiration <= nowMs && grace !== null && grace > nowMs,
    willRenew: pro.willRenew,
    expiresAt: latest > nowMs ? new Date(latest).toISOString() : null,
    productId: pro.productIdentifier,
    managementUrl: customer.managementUrl,
  };
}

/** The tier the rest of the app gates on. Only an authoritative snapshot may produce `free`. */
export function toProviderEntitlement(status: ProStatus): ProviderEntitlement {
  return {
    tier: status.active ? 'pro' : 'free',
    source: 'revenuecat',
    expiresAt: status.active ? status.expiresAt : null,
  };
}
