import {
  type CustomerSnapshot,
  type PlanOffering,
  type PurchasesClient,
  type PurchasesMode,
} from './types';

/** Fallback labels (PRODUCT.md target pricing). Real prices always come from the store. */
export const FALLBACK_OFFERING: PlanOffering = {
  identifier: 'preview',
  monthly: {
    id: 'preview_monthly',
    period: 'month',
    priceString: '$1.99',
    price: 1.99,
    perMonthString: null,
  },
  annual: {
    id: 'preview_annual',
    period: 'year',
    priceString: '$14.99',
    price: 14.99,
    perMonthString: '$1.25',
  },
};

const FREE: CustomerSnapshot = { proEntitlement: null, managementUrl: null };

/**
 * Preview client: no network, no native module, never throws. With `simulate` (dev builds
 * only) a purchase grants a month of Pro in memory so the paywall and gated features can be
 * exercised; otherwise purchases are refused so a misconfigured release build can never hand
 * out Pro.
 */
export function createMockClient(
  mode: Extract<PurchasesMode, { kind: 'mock' }>,
  now: () => Date = () => new Date(),
): PurchasesClient {
  let customer: CustomerSnapshot = FREE;
  const listeners = new Set<(customer: CustomerSnapshot) => void>();
  const emit = () => listeners.forEach((listener) => listener(customer));

  return {
    mode,
    async start() {},
    async logIn() {
      return customer;
    },
    async logOut() {
      customer = FREE;
      return customer;
    },
    async getCustomer() {
      return customer;
    },
    async getOffering() {
      return FALLBACK_OFFERING;
    },
    async purchase(packageId) {
      if (!mode.simulate) throw new Error('Purchases are not available in this build.');
      const days = packageId === FALLBACK_OFFERING.annual?.id ? 365 : 30;
      customer = {
        proEntitlement: {
          isActive: true,
          willRenew: true,
          expirationDate: new Date(now().getTime() + days * 86_400_000).toISOString(),
          billingIssueDetectedAt: null,
          productIdentifier: packageId,
          gracePeriodExpiresDate: null,
        },
        managementUrl: null,
      };
      emit();
      return { cancelled: false, customer };
    },
    async restore() {
      return customer;
    },
    onCustomerChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
