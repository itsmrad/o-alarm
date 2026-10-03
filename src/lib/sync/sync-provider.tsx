import Constants from 'expo-constants';
import { usePathname } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';

import { useAccount } from '@/lib/auth/account-context';
import { useAppServices } from '@/lib/app-services';
import { getEntitlementSnapshot, useEntitlement } from '@/lib/entitlements';
import { createSupabaseClient, readSupabaseConfig } from '@/lib/supabase';

import { createSyncEngine, type SyncEngine, type SyncEngineStatus } from './engine';
import { createSupabaseTransport } from './supabase-transport';

/** Why sync is (not) running, for Settings. */
export type SyncAvailability =
  /** No Supabase URL/key in this build. */
  | 'not_configured'
  | 'signed_out'
  /** Signed in on the free tier: only the one-time migration runs (D22). */
  | 'free'
  | 'active';

export interface SyncContextValue {
  availability: SyncAvailability;
  status: SyncEngineStatus | null;
  /** Runs a sync now (ignores backoff). No-op when unavailable. */
  syncNow: () => Promise<void>;
  /** Signed-in cloud calls (export/delete work on every tier). Null when signed out/unconfigured. */
  cloud: Pick<SyncEngine, 'exportMyData' | 'deleteMyData'> | null;
}

const SyncContext = createContext<SyncContextValue>({
  availability: 'not_configured',
  status: null,
  syncNow: async () => undefined,
  cloud: null,
});

export const useSync = () => useContext(SyncContext);

/** Screens on the ring path: sync never runs while one is showing. */
const RING_PATHS = ['/ringing', '/mission', '/wake-check'];
const PERIODIC_MS = 15 * 60_000;
const CHANGE_DEBOUNCE_MS = 5_000;

/**
 * Drives the sync engine: on sign-in, app foreground, local alarm writes (debounced), tier
 * changes, every 15 min, and on backoff retries. Everything is fire-and-forget: the UI never
 * awaits sync and alarm behaviour never depends on it.
 */
export function SyncProvider({ children }: { children: ReactNode }) {
  const services = useAppServices();
  const account = useAccount();
  const entitlement = useEntitlement();
  const pathname = usePathname();
  const config = useMemo(() => readSupabaseConfig(), []);
  const { getToken } = account;

  const userId = account.signedIn ? account.userId : null;
  const engine = useMemo(() => {
    if (!config || !userId) return null;
    const client = createSupabaseClient(config, getToken);
    return createSyncEngine({
      db: services.db,
      transport: createSupabaseTransport(client),
      userId,
      deviceId: services.deviceId,
      device: {
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        osVersion: String(Platform.Version ?? '') || null,
        appVersion: Constants.expoConfig?.version ?? null,
        model: null,
        alarmEngine: services.engine.kind,
      },
      getTier: () => getEntitlementSnapshot().tier,
      // Pulled alarms reach the OS only through the normal reconcile path (D17).
      reconcile: () => services.alarms.reconcileAll(),
    });
  }, [config, userId, getToken, services]);

  // Set only from engine/alarm notifications (never synchronously in an effect).
  const [engineStatus, setStatus] = useState<SyncEngineStatus | null>(null);
  useEffect(() => engine?.subscribe(() => setStatus(engine.getStatus())), [engine]);
  const status = engine ? engineStatus : null;

  const onRingPath = RING_PATHS.some((path) => pathname?.startsWith(path));
  const onRingPathRef = useRef(onRingPath);
  useEffect(() => {
    onRingPathRef.current = onRingPath;
  }, [onRingPath]);

  const trigger = useCallback(
    async (force = false) => {
      if (!engine || onRingPathRef.current) return;
      await engine.run({ force });
    },
    [engine],
  );

  // Exponential-backoff retry after a failed run.
  const nextRetryAt = status?.nextRetryAt ?? null;
  useEffect(() => {
    if (!nextRetryAt) return;
    const timer = setTimeout(
      () => void trigger(),
      Math.max(1_000, Date.parse(nextRetryAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [nextRetryAt, trigger]);

  // Sign-in / engine change, tier change, leaving the ring path.
  useEffect(() => {
    void trigger();
  }, [trigger, entitlement.tier, onRingPath]);

  useEffect(() => {
    if (!engine) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') void trigger();
    });
    const unsubscribe = services.alarms.subscribe(() => {
      setStatus(engine.getStatus()); // pending count
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void trigger(), CHANGE_DEBOUNCE_MS);
    });
    const periodic = setInterval(() => void trigger(), PERIODIC_MS);
    return () => {
      appState.remove();
      unsubscribe();
      clearInterval(periodic);
      if (debounce) clearTimeout(debounce);
    };
  }, [engine, trigger, services.alarms]);

  const value = useMemo<SyncContextValue>(
    () => ({
      availability: !config
        ? 'not_configured'
        : !userId
          ? 'signed_out'
          : entitlement.tier === 'pro'
            ? 'active'
            : 'free',
      status,
      syncNow: () => trigger(true),
      cloud: engine,
    }),
    [config, userId, entitlement.tier, status, trigger, engine],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
