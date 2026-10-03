import { readSupabaseConfig } from '@/lib/supabase';

/**
 * Account deletion, billing half: asks the `delete-account-cleanup` Edge Function to delete the
 * RevenueCat subscriber and our billing mirror for the signed-in user. Call it while the Clerk
 * session is still valid, next to `delete_my_data()` and before deleting the Clerk user. Throws
 * on failure so the caller can stop and let the user retry. It does not cancel the store
 * subscription (only the store can); tell the user to do that.
 */
export async function deleteBillingData(
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = readSupabaseConfig();
  if (!config) return; // Cloud is not configured: nothing was ever sent to the server.
  const token = await getToken();
  if (!token) throw new Error('Not signed in.');
  const response = await fetchImpl(`${config.url}/functions/v1/delete-account-cleanup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, apikey: config.publishableKey },
  });
  if (!response.ok) throw new Error(`Could not remove billing data (${response.status}).`);
}
