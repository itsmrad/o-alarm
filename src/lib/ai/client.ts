import type { InsightsAiRequest } from '@/domain/insights-payload';
import { readSupabaseConfig, type SupabaseConfig } from '@/lib/supabase';

import { aiResponseSchema, type AiExplanation } from './contract';

/** Why there is no AI text: the screen then shows the deterministic insights only. */
export type AiUnavailableReason =
  | 'not_configured'
  | 'signed_out'
  | 'pro_required'
  | 'rate_limited'
  | 'offline'
  | 'service_unavailable'
  | 'invalid_output'
  | 'error';

export type AiOutcome =
  | { status: 'ok'; explanation: AiExplanation; model: string; cached: boolean }
  | { status: 'unavailable'; reason: AiUnavailableReason };

export const AI_REQUEST_TIMEOUT_MS = 40_000;

const unavailable = (reason: AiUnavailableReason): AiOutcome => ({ status: 'unavailable', reason });

/**
 * Asks the `ai-insights` Edge Function to explain already-computed insights. Never throws and
 * never blocks anything else: every failure maps to a reason the UI can show calmly.
 */
export async function requestAiExplanation(
  request: InsightsAiRequest,
  deps: {
    getToken: () => Promise<string | null>;
    fetch?: typeof fetch;
    config?: SupabaseConfig | null;
    timeoutMs?: number;
  },
): Promise<AiOutcome> {
  const config = deps.config === undefined ? readSupabaseConfig() : deps.config;
  if (!config) return unavailable('not_configured');
  let token: string | null;
  try {
    token = await deps.getToken();
  } catch {
    token = null;
  }
  if (!token) return unavailable('signed_out');

  const doFetch = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? AI_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(`${config.url}/functions/v1/ai-insights`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        apikey: config.publishableKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
  } catch {
    return unavailable(controller.signal.aborted ? 'service_unavailable' : 'offline');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) return unavailable('signed_out');
  if (response.status === 403) return unavailable('pro_required');
  if (response.status === 429) return unavailable('rate_limited');
  if (response.status >= 500) return unavailable('service_unavailable');
  if (!response.ok) return unavailable('error');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unavailable('error');
  }
  const parsed = aiResponseSchema.safeParse(body);
  if (!parsed.success) return unavailable('error');
  const result = parsed.data;
  if (result.status === 'fallback') {
    return unavailable(
      result.reason === 'not_configured'
        ? 'not_configured'
        : result.reason === 'invalid_output'
          ? 'invalid_output'
          : 'service_unavailable',
    );
  }
  return {
    status: 'ok',
    explanation: result.explanation,
    model: result.model,
    cached: result.cached,
  };
}
