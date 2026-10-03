import type { WakeCheckConfig } from '@/domain';
import type { MissionStep } from '@/domain/missions';
import { hasPro, type MissionEntitlement } from '@/domain/missions-gating';

/** Steps asked for by the "movement" check: enough to be out of bed. */
export const MOVEMENT_STEPS = 20;

export type Verification =
  | { kind: 'confirm'; degraded: boolean }
  | { kind: 'mission'; steps: MissionStep[]; degraded: false };

/** Wake Check methods beyond a plain confirmation are Pro. */
export const isProMethod = (method: WakeCheckConfig['method']) => method !== 'confirm';

/**
 * What the prompt asks for at ring time. Pro methods without the entitlement degrade to
 * the free confirmation (D18) — never a harder or blocked check.
 */
export function verificationFor(
  config: WakeCheckConfig | undefined,
  entitlement: MissionEntitlement,
): Verification {
  if (!config || config.method === 'confirm') return { kind: 'confirm', degraded: false };
  if (!hasPro(entitlement)) return { kind: 'confirm', degraded: true };
  if (config.method === 'movement') {
    return {
      kind: 'mission',
      steps: [{ missionId: 'steps', config: { targetSteps: MOVEMENT_STEPS } }],
      degraded: false,
    };
  }
  return {
    kind: 'mission',
    steps: [{ missionId: config.missionId ?? 'math', config: {} }],
    degraded: false,
  };
}
