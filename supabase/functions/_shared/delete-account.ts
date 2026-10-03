// Account-deletion cleanup (PRODUCT.md "support export/delete"): erase the RevenueCat subscriber
// and our billing mirror. Pure TypeScript, I/O injected, shared by the Edge Function and Jest.
// Not a store cancellation: the user still cancels the subscription in the App Store / Google Play.

export interface DeleteAccountDeps {
  /** Verifies the caller's Clerk JWT (via public.current_user_id() under that token). */
  verifyCaller: (bearerToken: string) => Promise<string | null>;
  /** DELETE https://api.revenuecat.com/v1/subscribers/{id}. 'skipped' when no secret key is set. */
  deleteSubscriber: (appUserId: string) => Promise<'deleted' | 'not_found' | 'skipped'>;
  /** Removes entitlements + webhook event rows for this user (service role). */
  deleteLocalBilling: (appUserId: string) => Promise<void>;
  log?: (message: string) => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function createDeleteAccountHandler(
  deps: DeleteAccountDeps,
): (request: Request) => Promise<Response> {
  const log = deps.log ?? (() => undefined);
  return async (request) => {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return json(401, { error: 'missing bearer token' });

    let userId: string | null;
    try {
      userId = await deps.verifyCaller(token);
    } catch {
      userId = null;
    }
    if (!userId) return json(401, { error: 'invalid token' });

    try {
      // RevenueCat first: if it fails the client keeps the account and can retry the whole flow.
      const revenuecat = await deps.deleteSubscriber(userId);
      await deps.deleteLocalBilling(userId);
      return json(200, { revenuecat });
    } catch (error) {
      log(`delete-account-cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      return json(502, { error: 'billing cleanup failed' });
    }
  };
}
