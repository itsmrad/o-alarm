/**
 * Whether the AI explanation layer can be called (D18/D19). Deterministic insights never depend
 * on this: they are free and offline. Being offline is only discovered by a failed call.
 */
export type AiAvailability = 'ready' | 'not_configured' | 'signed_out' | 'free';

export function resolveAiAvailability(input: {
  /** Supabase URL + publishable key and Clerk are configured in this build. */
  configured: boolean;
  signedIn: boolean;
  isPro: boolean;
}): AiAvailability {
  if (!input.isPro) return 'free';
  if (!input.configured) return 'not_configured';
  if (!input.signedIn) return 'signed_out';
  return 'ready';
}
