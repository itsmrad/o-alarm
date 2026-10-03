import type { CustomerInfo, PurchasesOffering, PurchasesPackage } from 'react-native-purchases';

import {
  PRO_ENTITLEMENT_ID,
  type CustomerSnapshot,
  type PlanOffering,
  type PlanPackage,
  type PurchasesClient,
} from './types';

/** The slice of the `react-native-purchases` default export we use (injectable for tests). */
export type PurchasesSdk = Pick<
  typeof import('react-native-purchases').default,
  | 'configure'
  | 'logIn'
  | 'logOut'
  | 'getCustomerInfo'
  | 'getOfferings'
  | 'purchasePackage'
  | 'restorePurchases'
  | 'addCustomerInfoUpdateListener'
  | 'removeCustomerInfoUpdateListener'
>;

export function snapshotCustomer(info: CustomerInfo): CustomerSnapshot {
  const pro = info.entitlements.all[PRO_ENTITLEMENT_ID];
  return {
    proEntitlement: pro
      ? {
          isActive: pro.isActive,
          willRenew: pro.willRenew,
          expirationDate: pro.expirationDate,
          billingIssueDetectedAt: pro.billingIssueDetectedAt,
          productIdentifier: pro.productIdentifier,
          gracePeriodExpiresDate:
            info.subscriptionsByProductIdentifier?.[pro.productIdentifier]
              ?.gracePeriodExpiresDate ?? null,
        }
      : null,
    managementUrl: info.managementURL,
  };
}

const toPlan = (pkg: PurchasesPackage | null, period: 'month' | 'year'): PlanPackage | null =>
  pkg
    ? {
        id: pkg.identifier,
        period,
        priceString: pkg.product.priceString,
        price: Number.isFinite(pkg.product.price) ? pkg.product.price : null,
        perMonthString: pkg.product.pricePerMonthString,
      }
    : null;

function isUserCancelled(error: unknown): boolean {
  const e = error as { userCancelled?: boolean | null; code?: string | number } | null;
  // PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR is "1".
  return !!e && (e.userCancelled === true || String(e.code) === '1');
}

/** Live RevenueCat client. Every SDK call is async and none runs on the ring path. */
export function createLiveClient(apiKey: string, sdk: PurchasesSdk): PurchasesClient {
  let started = false;
  let packages = new Map<string, PurchasesPackage>();
  const listeners = new Set<(customer: CustomerSnapshot) => void>();
  const onInfo = (info: CustomerInfo) => {
    const snapshot = snapshotCustomer(info);
    listeners.forEach((listener) => listener(snapshot));
  };

  return {
    mode: { kind: 'live' },
    async start() {
      if (started) return;
      started = true;
      try {
        sdk.configure({ apiKey });
        sdk.addCustomerInfoUpdateListener(onInfo);
      } catch (error) {
        started = false;
        throw error;
      }
    },
    async logIn(userId) {
      return snapshotCustomer((await sdk.logIn(userId)).customerInfo);
    },
    async logOut() {
      return snapshotCustomer(await sdk.logOut());
    },
    async getCustomer() {
      return snapshotCustomer(await sdk.getCustomerInfo());
    },
    async getOffering(): Promise<PlanOffering | null> {
      const current: PurchasesOffering | null = (await sdk.getOfferings()).current;
      if (!current) return null;
      packages = new Map(current.availablePackages.map((pkg) => [pkg.identifier, pkg]));
      return {
        identifier: current.identifier,
        monthly: toPlan(current.monthly, 'month'),
        annual: toPlan(current.annual, 'year'),
      };
    },
    async purchase(packageId) {
      const pkg = packages.get(packageId);
      if (!pkg) throw new Error('This plan is no longer available. Reopen the paywall.');
      try {
        const result = await sdk.purchasePackage(pkg);
        return { cancelled: false, customer: snapshotCustomer(result.customerInfo) };
      } catch (error) {
        if (isUserCancelled(error)) return { cancelled: true, customer: null };
        throw error;
      }
    },
    async restore() {
      return snapshotCustomer(await sdk.restorePurchases());
    },
    onCustomerChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
