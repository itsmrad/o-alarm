/**
 * Purchases client boundary (D18). The rest of the app never sees RevenueCat types: it sees
 * these, so the live SDK client and the preview/mock client are interchangeable and the UI
 * can be tested without a native module.
 */

export type PlanPeriod = 'month' | 'year';

export interface PlanPackage {
  /** Opaque id passed back to `purchase()`. */
  id: string;
  period: PlanPeriod;
  /** Localised store price, e.g. "$1.99". Fallback labels in preview mode. */
  priceString: string;
  /** Numeric price in the store currency, for the "save N%" label. */
  price: number | null;
  /** Localised monthly equivalent when the store provides one. */
  perMonthString: string | null;
}

export interface PlanOffering {
  identifier: string;
  monthly: PlanPackage | null;
  annual: PlanPackage | null;
}

/** What the app knows about the Pro subscription (not the same as the gating tier). */
export interface ProStatus {
  active: boolean;
  /** Active, but the store could not charge: the user should fix their payment method. */
  billingIssue: boolean;
  /** Active past its normal expiry because the store is in a billing grace period. */
  inGrace: boolean;
  willRenew: boolean;
  expiresAt: string | null;
  productId: string | null;
  managementUrl: string | null;
}

export const NO_PRO: ProStatus = {
  active: false,
  billingIssue: false,
  inGrace: false,
  willRenew: false,
  expiresAt: null,
  productId: null,
  managementUrl: null,
};

/** Why purchases are unavailable (live mode never has one). */
export type PurchasesUnavailableReason = 'no-key' | 'expo-go' | 'unsupported-platform';

export type PurchasesMode =
  /** Real store purchases through RevenueCat. */
  | { kind: 'live' }
  /** No store: prices are labels. `simulate` lets dev builds grant Pro locally to try the UI. */
  | { kind: 'mock'; reason: PurchasesUnavailableReason; simulate: boolean };

/** Minimal, SDK-free customer info (what the mapping and status code read). */
export interface CustomerSnapshot {
  proEntitlement: {
    isActive: boolean;
    willRenew: boolean;
    expirationDate: string | null;
    billingIssueDetectedAt: string | null;
    productIdentifier: string;
    /** From `subscriptionsByProductIdentifier[productIdentifier]`. */
    gracePeriodExpiresDate: string | null;
  } | null;
  managementUrl: string | null;
}

export interface PurchasesClient {
  readonly mode: PurchasesMode;
  /** Idempotent; never throws (a failed configure leaves later calls to reject). */
  start(): Promise<void>;
  logIn(userId: string): Promise<CustomerSnapshot>;
  logOut(): Promise<CustomerSnapshot>;
  getCustomer(): Promise<CustomerSnapshot>;
  getOffering(): Promise<PlanOffering | null>;
  /** Resolves `cancelled` for a user cancel; rejects for real failures. */
  purchase(packageId: string): Promise<{ cancelled: boolean; customer: CustomerSnapshot | null }>;
  restore(): Promise<CustomerSnapshot>;
  /** Fires on every CustomerInfo change. Returns the unsubscribe. */
  onCustomerChange(listener: (customer: CustomerSnapshot) => void): () => void;
}

export const PRO_ENTITLEMENT_ID = 'pro';
