import { ClerkProvider, useAuth, useUser } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useAppServices } from '@/lib/app-services';
import { bindEntitlementCache } from '@/lib/entitlements';
import { SyncProvider } from '@/lib/sync/sync-provider';

import {
  AccountContext,
  GUEST_ACCOUNT,
  readClerkPublishableKey,
  type AccountState,
} from './account-context';

/** Maps Clerk's hooks onto AccountState. Only rendered inside ClerkProvider. */
function ClerkAccountBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, getToken, signOut } = useAuth();
  const { user } = useUser();
  // Stable callbacks (identity never changes) that always use Clerk's latest functions.
  const latest = useRef({ getToken, signOut, user });
  useEffect(() => {
    latest.current = { getToken, signOut, user };
  }, [getToken, signOut, user]);

  const stableGetToken = useCallback(async () => {
    try {
      return (await latest.current.getToken()) ?? null;
    } catch {
      return null;
    }
  }, []);
  const stableSignOut = useCallback(async () => {
    await latest.current.signOut();
  }, []);
  const deleteUser = useCallback(async () => {
    const current = latest.current.user;
    if (!current) throw new Error('Not signed in.');
    await current.delete();
  }, []);

  const value = useMemo<AccountState>(
    () => ({
      configured: true,
      loaded: isLoaded,
      signedIn: !!isSignedIn,
      userId: isSignedIn ? (userId ?? null) : null,
      email: user?.primaryEmailAddress?.emailAddress ?? null,
      displayName: user?.fullName ?? null,
      getToken: stableGetToken,
      signOut: stableSignOut,
      deleteUser,
    }),
    [isLoaded, isSignedIn, userId, user, stableGetToken, stableSignOut, deleteUser],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/**
 * Account + cloud providers: Clerk (when configured), the entitlement cache and cloud sync.
 * Must sit inside AppServicesProvider (needs the local DB). Without a Clerk key the app runs
 * as a guest and account features say "not configured".
 */
export function AccountProviders({ children }: { children: ReactNode }) {
  const { db, deviceId } = useAppServices();
  // Load the cached entitlement before anything renders (synchronous, local).
  useState(() => bindEntitlementCache(db, deviceId));
  const publishableKey = readClerkPublishableKey();

  if (!publishableKey) {
    return (
      <AccountContext.Provider value={GUEST_ACCOUNT}>
        <SyncProvider>{children}</SyncProvider>
      </AccountContext.Provider>
    );
  }
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <ClerkAccountBridge>
        <SyncProvider>{children}</SyncProvider>
      </ClerkAccountBridge>
    </ClerkProvider>
  );
}
