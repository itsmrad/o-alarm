// Supabase Edge Function: AI explanation of the app's deterministic wake insights (Pro, D18/D19).
//   POST /functions/v1/ai-insights   Authorization: Bearer <Clerk session token>   body: AiRequest
// Runs with JWT verification off (Clerk tokens are not Supabase-signed); the caller is verified by
// asking Postgres, under the caller's own token, who they are and whether they hold `pro`.
// Secrets: OPENROUTER_API_KEY (unset => `fallback: not_configured`). Env: OPENROUTER_MODEL.
import { createClient } from 'npm:@supabase/supabase-js@2';

import {
  createAiInsightsHandler,
  createOpenRouterCompleter,
  DEFAULT_OPENROUTER_MODEL,
  insightType,
} from './core.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const asCaller = (token: string) =>
  // SUPABASE_ANON_KEY is the publishable key injected into every function.
  createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false },
    accessToken: async () => token,
  });

const apiKey = Deno.env.get('OPENROUTER_API_KEY');
const model = Deno.env.get('OPENROUTER_MODEL')?.trim() || DEFAULT_OPENROUTER_MODEL;

Deno.serve(
  createAiInsightsHandler({
    log: (message) => console.error(message),
    model,
    complete: apiKey ? createOpenRouterCompleter({ apiKey, model }) : null,
    async verifyCaller(token) {
      const { data, error } = await asCaller(token).rpc('current_user_id');
      if (error || typeof data !== 'string' || !data) return null;
      return data;
    },
    async isPro(token) {
      const { data, error } = await asCaller(token).rpc('has_entitlement', { p_entitlement: 'pro' });
      return !error && data === true;
    },
    async findStored(userId, request) {
      const { data, error } = await admin
        .from('ai_insights')
        .select('structured, model')
        .eq('user_id', userId)
        .eq('type', insightType(request))
        .eq('period_start', request.period.start)
        .eq('period_end', request.period.end)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data?.model) return null;
      const structured = data.structured as { request?: unknown; explanation?: unknown };
      return { request: structured.request, explanation: structured.explanation, model: data.model };
    },
    async claimQuota(userId, bucket, limit) {
      const { data, error } = await admin.rpc('claim_ai_quota', {
        p_user_id: userId,
        p_bucket: bucket,
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      return typeof data === 'string' ? data : null;
    },
    async releaseQuota(claimId) {
      const { error } = await admin.from('ai_usage').delete().eq('id', claimId);
      if (error) throw new Error(error.message);
    },
    async store(userId, request, explanation, usedModel) {
      const { error } = await admin.from('ai_insights').upsert(
        {
          user_id: userId,
          type: insightType(request),
          period_start: request.period.start,
          period_end: request.period.end,
          structured: { request, explanation },
          explanation: explanation.summary,
          model: usedModel,
          deleted_at: null,
        },
        { onConflict: 'user_id,type,period_start,period_end' },
      );
      if (error) throw new Error(error.message);
    },
  }),
);
