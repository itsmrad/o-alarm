import { setEntitlementFromProvider, type ProviderEntitlement } from '@/lib/entitlements';

import { mapProStatus, toProviderEntitlement } from './entitlement-mapping';
import {
  NO_PRO,
  type CustomerSnapshot,
  type PlanOffering,
  type ProStatus,
  type PurchasesClient,
} from './types';

export type PurchaseOutcome = 'purchased' | 'pending' | 'cancelled';

export interface PurchasesController {
  readonly client: PurchasesClient;
  /** Configures the SDK, registers the CustomerInfo listener and refreshes. Safe to repeat. */
  start(): Promise<void>;
  /** Clerk user id, or null for guest. Safe to call on every render: it only acts on change. */
  setUser(userId: string | null): Promise<void>;
  /** Re-reads CustomerInfo (e.g. on foreground). Failures are swallowed: never downgrades. */
  refresh(): Promise<void>;
  getOffering(): Promise<PlanOffering | null>;
  purchase(packageId: string): Promise<PurchaseOutcome>;
  /** Resolves true when Pro is active after restoring. */
  restore(): Promise<boolean>;
  getStatus(): ProStatus;
  subscribe(listener: () => void): () => void;
}

/**
 * Wires a PurchasesClient to the entitlement interface (D18).
 *
 * Offline / RevenueCat down: every read failure is swallowed and nothing is applied, so the
 * cached entitlement (local preferences, loaded at boot) stays exactly as it was. Only a
 * successful CustomerInfo may change the tier, including down to `free`.
 */
export function createPurchasesController(
  client: PurchasesClient,
  options: {
    apply?: (entitlement: ProviderEntitlement) => unknown;
    now?: () => Date;
  } = {},
): PurchasesController {
  const apply = options.apply ?? setEntitlementFromProvider;
  const now = options.now ?? (() => new Date());
  const listeners = new Set<() => void>();
  let status: ProStatus = NO_PRO;
  let configured: Promise<void> | null = null;
  // Identity operations run one at a time, in order (logIn/logOut must never interleave).
  let queue: Promise<unknown> = Promise.resolve();
  let desiredUser: string | null = null;
  let appliedUser: string | null = null;

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const ingest = (customer: CustomerSnapshot) => {
    status = mapProStatus(customer, now());
    apply(toProviderEntitlement(status));
    listeners.forEach((listener) => listener());
  };

  // Configures the SDK and registers the listener; retried after a failure.
  const configure = (): Promise<void> => {
    configured ??= (async () => {
      await client.start();
      client.onCustomerChange(ingest);
    })().catch((error) => {
      configured = null;
      throw error;
    });
    return configured;
  };

  const refresh = () =>
    enqueue(() =>
      settle(async () => {
        await configure();
        await syncIdentity();
        ingest(await client.getCustomer());
      }),
    );

  const syncIdentity = async () => {
    // Only a signed-in -> signed-out transition calls logOut: a cold-start guest is already
    // anonymous (and RevenueCat rejects logOut for anonymous users).
    if (desiredUser === appliedUser) return;
    const target = desiredUser;
    ingest(await (target ? client.logIn(target) : client.logOut()));
    appliedUser = target;
  };

  const settle = async (task: () => Promise<unknown>) => {
    try {
      await task();
    } catch {
      // Offline or RevenueCat unavailable: keep the cached entitlement. Retried on refresh().
    }
  };

  return {
    client,
    start: refresh,
    setUser(userId) {
      desiredUser = userId;
      return enqueue(() =>
        settle(async () => {
          await configure();
          await syncIdentity();
        }),
      );
    },
    refresh,
    getOffering: () => client.getOffering(),
    async purchase(packageId) {
      const result = await client.purchase(packageId);
      if (result.cancelled || !result.customer) return 'cancelled';
      ingest(result.customer);
      return status.active ? 'purchased' : 'pending';
    },
    async restore() {
      ingest(await client.restore());
      return status.active;
    },
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
