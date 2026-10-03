import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import type { PurchasesController } from '@/lib/purchases';

import { trackPaywall } from './analytics';
import { PAYWALL_SOURCES, type PaywallEventProps } from './event-map';

type Source = NonNullable<PaywallEventProps['source']>;

const toSource = (reason: unknown): Source =>
  typeof reason === 'string' && (PAYWALL_SOURCES as readonly string[]).includes(reason)
    ? (reason as Source)
    : 'other';

/** Coarse plan from a store package/product id; never the id itself. */
export function planOf(packageId: string): PaywallEventProps['plan'] {
  const id = packageId.toLowerCase();
  if (id.includes('annual') || id.includes('year')) return 'annual';
  if (id.includes('month')) return 'monthly';
  return undefined;
}

let lastSource: Source = 'other';
const INSTRUMENTED = Symbol.for('o-alarm.observability.purchases');

/** `paywall_viewed` each time the paywall route opens, with its `reason` as the source. */
export function usePaywallViewTracking(): void {
  const pathname = usePathname();
  const { reason } = useGlobalSearchParams<{ reason?: string }>();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const was = previous.current;
    previous.current = pathname;
    if (pathname !== '/paywall' || was === '/paywall') return;
    lastSource = toSource(reason);
    trackPaywall('paywall_viewed', { source: lastSource });
  }, [pathname, reason]);
}

/**
 * Purchase funnel events around the RevenueCat controller's purchase/restore (wraps the
 * instance once; outcomes and errors pass through untouched). Coarse: plan + source only.
 */
export function instrumentPurchases(controller: PurchasesController): void {
  const target = controller as PurchasesController & { [INSTRUMENTED]?: true };
  if (target[INSTRUMENTED]) return;
  target[INSTRUMENTED] = true;
  const purchase = controller.purchase.bind(controller);
  const restore = controller.restore.bind(controller);
  controller.purchase = async (packageId) => {
    const props = { source: lastSource, plan: planOf(packageId) };
    trackPaywall('purchase_started', props);
    try {
      const outcome = await purchase(packageId);
      if (outcome === 'purchased') trackPaywall('purchase_completed', props);
      return outcome;
    } catch (error) {
      trackPaywall('purchase_failed', props);
      throw error;
    }
  };
  controller.restore = async () => {
    const active = await restore();
    if (active) trackPaywall('purchase_restored', { source: lastSource });
    return active;
  };
}
