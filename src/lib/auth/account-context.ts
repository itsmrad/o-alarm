import { createContext, useContext } from 'react';

/**
 * The signed-in account as the rest of the app sees it (D15). Guest = no session: the app
 * is fully functional and nothing here is ever required by the alarm path.
 */
export interface AccountState {
  /** EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is set. When false, account features show "not configured". */
  configured: boolean;
  /** Clerk finished loading (stays false offline on a cold start; never gate the app on it). */
  loaded: boolean;
  signedIn: boolean;
  /** Clerk user id (= Supabase `auth.jwt()->>'sub'`). */
  userId: string | null;
  email: string | null;
  displayName: string | null;
  /** Current Clerk session JWT for Supabase, or null when signed out / unavailable. */
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
  /** Deletes the Clerk user (requires "users can delete their account" in the Clerk dashboard). */
  deleteUser: () => Promise<void>;
}

const notConfigured = async () => {
  throw new Error('Accounts are not configured in this build.');
};

export const GUEST_ACCOUNT: AccountState = {
  configured: false,
  loaded: true,
  signedIn: false,
  userId: null,
  email: null,
  displayName: null,
  getToken: async () => null,
  signOut: notConfigured,
  deleteUser: notConfigured,
};

export const AccountContext = createContext<AccountState>(GUEST_ACCOUNT);

export function useAccount(): AccountState {
  return useContext(AccountContext);
}

export function readClerkPublishableKey(
  value: string | undefined = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
): string | null {
  return value?.trim() || null;
}
