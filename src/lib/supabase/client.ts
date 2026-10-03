import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client authenticated with the Clerk session token (Supabase third-party auth,
 * D15/D16). Only the publishable key ships in the app (D21): never a service key.
 * Missing env → `null`, and sync stays disabled while the app keeps working.
 */
export interface SupabaseConfig {
  url: string;
  publishableKey: string;
  /** Custom fetch (tests); defaults to the platform fetch. */
  fetch?: typeof fetch;
}

export function readSupabaseConfig(
  env: Record<string, string | undefined> = {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  },
): SupabaseConfig | null {
  const url = env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && publishableKey ? { url, publishableKey } : null;
}

export function isSupabaseConfigured(): boolean {
  return readSupabaseConfig() !== null;
}

/** `getToken` returns the current Clerk session JWT (null when signed out). */
export function createSupabaseClient(
  config: SupabaseConfig,
  getToken: () => Promise<string | null>,
): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    accessToken: async () => (await getToken()) ?? null,
    ...(config.fetch ? { global: { fetch: config.fetch } } : {}),
  });
}
