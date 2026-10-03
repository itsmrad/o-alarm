import { useSyncExternalStore } from 'react';

import type { AppDatabase } from '@/db/types';
import { PREFERENCE_KEYS, readPreference, writePreference } from '@/lib/sync/local-store';

/**
 * Entitlement interface (D18). RevenueCat (later task) is the provider: it calls
 * `setEntitlementFromProvider(...)` whenever CustomerInfo changes. Everyone else reads.
 *
 * - Default is `free`; an unknown/missing entitlement never blocks or disables an alarm.
 * - The last snapshot is cached locally (preferences table) so Pro features survive offline
 *   restarts; reads are synchronous and in-memory, so nothing ever waits on the network.
 */

export type Tier = 'free' | 'pro';

/** Where the current snapshot came from. */
export type EntitlementSource = 'default' | 'cache' | 'revenuecat' | 'server';

export interface EntitlementSnapshot {
  tier: Tier;
  source: EntitlementSource;
  /** When the provider last reported (ISO); null for the default. */
  updatedAt: string | null;
  /** Subscription expiry (ISO) when known; a cached `pro` past this reads as `free`. */
  expiresAt: string | null;
}

export interface ProviderEntitlement {
  tier: Tier;
  source?: Exclude<EntitlementSource, 'default' | 'cache'>;
  expiresAt?: string | null;
}

const DEFAULT_SNAPSHOT: EntitlementSnapshot = {
  tier: 'free',
  source: 'default',
  updatedAt: null,
  expiresAt: null,
};

let snapshot: EntitlementSnapshot = DEFAULT_SNAPSHOT;
let cache: { db: AppDatabase; deviceId: string } | null = null;
let clock: () => Date = () => new Date();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((listener) => listener());

/** Applies expiry: a lapsed `pro` degrades to `free` (D18), keeping its source/updatedAt. */
function effective(value: EntitlementSnapshot): EntitlementSnapshot {
  if (value.tier === 'pro' && value.expiresAt && Date.parse(value.expiresAt) <= clock().getTime()) {
    return { ...value, tier: 'free' };
  }
  return value;
}

function isSnapshot(value: unknown): value is EntitlementSnapshot {
  const v = value as Partial<EntitlementSnapshot> | null;
  return !!v && (v.tier === 'free' || v.tier === 'pro') && typeof v.source === 'string';
}

/**
 * Binds the local cache and loads the last snapshot. Called once at boot (AccountProviders).
 * Never throws: a broken cache just leaves the default (`free`).
 */
export function bindEntitlementCache(db: AppDatabase, deviceId: string, now?: () => Date): void {
  cache = { db, deviceId };
  if (now) clock = now;
  try {
    const cached = readPreference<unknown>(db, PREFERENCE_KEYS.entitlement);
    if (isSnapshot(cached)) {
      snapshot = { ...DEFAULT_SNAPSHOT, ...cached, source: 'cache' };
      notify();
    }
  } catch {
    // Keep the default.
  }
}

/** Synchronous, in-memory: safe on the ring path. */
export function getEntitlementSnapshot(): EntitlementSnapshot {
  return effective(snapshot);
}

/** Provider hook-in (RevenueCat CustomerInfo listener, server mirror). Persists the snapshot. */
export function setEntitlementFromProvider(input: ProviderEntitlement): EntitlementSnapshot {
  const now = clock();
  snapshot = {
    tier: input.tier,
    source: input.source ?? 'revenuecat',
    updatedAt: now.toISOString(),
    expiresAt: input.expiresAt ?? null,
  };
  if (cache) {
    try {
      writePreference(cache.db, PREFERENCE_KEYS.entitlement, snapshot, {
        now,
        deviceId: cache.deviceId,
      });
    } catch {
      // In-memory snapshot still applies; the cache catches up on the next update.
    }
  }
  notify();
  return getEntitlementSnapshot();
}

export function subscribeEntitlement(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: re-renders when the entitlement changes. */
export function useEntitlement(): EntitlementSnapshot {
  const current = useSyncExternalStore(subscribeEntitlement, () => snapshot);
  return effective(current);
}

/** Test-only: back to the unbound default. */
export function resetEntitlementsForTests(): void {
  snapshot = DEFAULT_SNAPSHOT;
  cache = null;
  clock = () => new Date();
  listeners.clear();
}
