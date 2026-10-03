import { router } from 'expo-router';
import { useCallback } from 'react';

import { useEntitlement } from '@/lib/entitlements';

import type { PaywallReason } from './copy';

/** Opens the paywall modal. Safe to call from anywhere except the ring path. */
export function openPaywall(reason?: PaywallReason): void {
  router.push({ pathname: '/paywall', params: reason ? { reason } : {} });
}

/**
 * For gated features: `const { isPro, openPaywall } = usePaywall();` then
 * `if (!isPro) return openPaywall('mission-chains')`.
 */
export function usePaywall(): { isPro: boolean; openPaywall: (reason?: PaywallReason) => void } {
  const { tier } = useEntitlement();
  return { isPro: tier === 'pro', openPaywall: useCallback((reason) => openPaywall(reason), []) };
}
