import { MAX_MISSION_CHAIN_LENGTH, type MissionId, type MissionStep } from './missions';
import {
  FALLBACK_MISSION_ID,
  missionRegistry,
  type BuiltInMissionDefinition,
} from './missions-registry';

/**
 * What the app knows about the user's `pro` entitlement. Unknown / missing is treated
 * as "not entitled" at gating time, but only ever degrades a mission — never blocks
 * dismissal and never disables an alarm (D18).
 */
export type MissionEntitlement = { pro: boolean } | null | undefined;

type Registry = { get(id: MissionId): BuiltInMissionDefinition | undefined };

export function hasPro(entitlement: MissionEntitlement): boolean {
  return entitlement?.pro === true;
}

/** Free missions are open to everyone; Pro missions need the `pro` entitlement. */
export function canUseMission(
  id: MissionId,
  entitlement: MissionEntitlement,
  registry: Registry = missionRegistry,
): boolean {
  const definition = registry.get(id);
  if (!definition) return false;
  return definition.tier === 'free' || hasPro(entitlement);
}

/** A chain of more than one mission is Pro, as is any Pro mission inside it. */
export function canUseChain(
  steps: readonly MissionStep[],
  entitlement: MissionEntitlement,
  registry: Registry = missionRegistry,
): boolean {
  if (steps.length > 1 && !hasPro(entitlement)) return false;
  return steps.every((step) => canUseMission(step.missionId, entitlement, registry));
}

export type AddMissionDenial = 'unknown_mission' | 'pro_mission' | 'pro_chain' | 'chain_full';

/** Edit-time check used by the chain editor (ring time degrades instead, see below). */
export function canAddMission(
  steps: readonly MissionStep[],
  id: MissionId,
  entitlement: MissionEntitlement,
  registry: Registry = missionRegistry,
): { ok: true } | { ok: false; reason: AddMissionDenial } {
  const definition = registry.get(id);
  if (!definition) return { ok: false, reason: 'unknown_mission' };
  if (steps.length >= MAX_MISSION_CHAIN_LENGTH) return { ok: false, reason: 'chain_full' };
  if (definition.tier === 'pro' && !hasPro(entitlement))
    return { ok: false, reason: 'pro_mission' };
  if (steps.length >= 1 && !hasPro(entitlement)) return { ok: false, reason: 'pro_chain' };
  return { ok: true };
}

export type DegradeReason =
  'unknown_mission' | 'pro_required' | 'not_configured' | 'chain_requires_pro';

export interface DegradedStep {
  stepIndex: number;
  originalMissionId: MissionId;
  reason: DegradeReason;
}

export interface ResolvedChain {
  steps: MissionStep[];
  degraded: DegradedStep[];
}

function fallbackStep(registry: Registry, preferred?: MissionId): MissionStep {
  const definition =
    (preferred ? registry.get(preferred) : undefined) ?? registry.get(FALLBACK_MISSION_ID);
  return {
    missionId: definition?.id ?? FALLBACK_MISSION_ID,
    config: { ...definition?.defaultConfig },
  };
}

/**
 * Ring-time resolution of a configured chain into one that can always be completed:
 * - without Pro, a chain keeps only its first step (the rest is `chain_requires_pro`);
 * - a Pro mission without entitlement becomes its free fallback (Math);
 * - unknown missions and unconfigured ones (QR with no code) become Math;
 * - configs are normalized through the mission's schema, invalid ones reset to defaults.
 * An empty chain stays empty: the alarm simply has no mission.
 */
export function resolveRingChain(
  steps: readonly MissionStep[],
  entitlement: MissionEntitlement,
  registry: Registry = missionRegistry,
): ResolvedChain {
  const degraded: DegradedStep[] = [];
  const limit = hasPro(entitlement) ? steps.length : 1;
  if (steps.length > limit) {
    degraded.push({
      stepIndex: limit,
      originalMissionId: steps[limit]?.missionId ?? '',
      reason: 'chain_requires_pro',
    });
  }
  const resolved = steps.slice(0, limit).map((step, stepIndex): MissionStep => {
    const definition = registry.get(step.missionId);
    const degrade = (reason: DegradeReason, preferred?: MissionId) => {
      degraded.push({ stepIndex, originalMissionId: step.missionId, reason });
      return fallbackStep(registry, preferred);
    };
    if (!definition) return degrade('unknown_mission');
    if (!canUseMission(step.missionId, entitlement, registry)) {
      return degrade('pro_required', definition.freeFallback);
    }
    const parsed = definition.configSchema.safeParse(step.config);
    const config = parsed.success ? parsed.data : { ...definition.defaultConfig };
    if (definition.isConfigured && !definition.isConfigured(config)) {
      return degrade('not_configured', definition.freeFallback);
    }
    return { missionId: step.missionId, config };
  });
  return { steps: resolved, degraded };
}
