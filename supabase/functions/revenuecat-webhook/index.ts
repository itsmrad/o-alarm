// Supabase Edge Function: RevenueCat webhook -> `entitlements` mirror (service role only).
// Deploy with JWT verification off (RevenueCat cannot send a Supabase JWT; the shared secret in
// the Authorization header is the credential): see [functions.revenuecat-webhook] in config.toml.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { createWebhookHandler } from '../_shared/revenuecat.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);
const revenueCatKey = Deno.env.get('REVENUECAT_SECRET_API_KEY');

Deno.serve(
  createWebhookHandler({
    secret: Deno.env.get('REVENUECAT_WEBHOOK_AUTH'),
    log: (message) => console.error(message),
    async apply(command) {
      const { data, error } = await supabase.rpc('apply_revenuecat_entitlement', command);
      if (error) throw new Error(error.message);
      return String(data);
    },
    async fetchSubscriber(appUserId) {
      if (!revenueCatKey) return null;
      const response = await fetch(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
        { headers: { authorization: `Bearer ${revenueCatKey}` } },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`RevenueCat API ${response.status}`);
      return (await response.json()).subscriber ?? null;
    },
  }),
);
