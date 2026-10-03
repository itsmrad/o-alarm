import type { MissionEntitlement } from '@/domain/missions-gating';

const FREE: MissionEntitlement = { pro: false };

/**
 * The `pro` entitlement as missions and Wake Check see it (D18). Single swap point:
 * `@/lib/entitlements` (account-sync) is not on mvp yet, so this reads as free. When it
 * lands, return `{ pro: useEntitlement().tier === 'pro' }` here. Unknown is always free:
 * Pro options degrade at ring time and never block a dismissal.
 */
export function useMissionEntitlement(): MissionEntitlement {
  return FREE;
}
