// Supabase Edge Function: erase the caller's RevenueCat subscriber + billing mirror.
// Call it from the app while the Clerk session is still valid, alongside delete_my_data():
//   POST /functions/v1/delete-account-cleanup   Authorization: Bearer <Clerk session token>
// Runs with JWT verification off (Clerk tokens are not Supabase-signed); the caller is verified by
// asking Postgres, under the caller's own token, who they are (public.current_user_id()).
import { createClient } from 'npm:@supabase/supabase-js@2';

import { createDeleteAccountHandler } from '../_shared/delete-account.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const revenueCatKey = Deno.env.get('REVENUECAT_SECRET_API_KEY');

Deno.serve(
  createDeleteAccountHandler({
    log: (message) => console.error(message),
    async verifyCaller(token) {
      // SUPABASE_ANON_KEY is the publishable key injected into every function.
      const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
        auth: { persistSession: false },
        accessToken: async () => token,
      });
      const { data, error } = await asCaller.rpc('current_user_id');
      if (error || typeof data !== 'string' || !data) return null;
      return data;
    },
    async deleteSubscriber(appUserId) {
      if (!revenueCatKey) return 'skipped';
      const response = await fetch(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${revenueCatKey}` } },
      );
      if (response.status === 404) return 'not_found';
      if (!response.ok) throw new Error(`RevenueCat API ${response.status}`);
      return 'deleted';
    },
    async deleteLocalBilling(appUserId) {
      const events = await admin.from('revenuecat_events').delete().eq('app_user_id', appUserId);
      if (events.error) throw new Error(events.error.message);
      const entitlements = await admin.from('entitlements').delete().eq('user_id', appUserId);
      if (entitlements.error) throw new Error(entitlements.error.message);
    },
  }),
);
