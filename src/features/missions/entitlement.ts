import { useMemo } from 'react';

import type { MissionEntitlement } from '@/domain/missions-gating';
import { useEntitlement } from '@/lib/entitlements';

/**
 * The `pro` entitlement as missions and Wake Check see it (D18), from the cached local
 * snapshot (never waits on the network). Unknown/lapsed reads as free: Pro options
 * degrade at ring time and never block a dismissal.
 */
export function useMissionEntitlement(): MissionEntitlement {
  const pro = useEntitlement().tier === 'pro';
  return useMemo(() => ({ pro }), [pro]);
}
