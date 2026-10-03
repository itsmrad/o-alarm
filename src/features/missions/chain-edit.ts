import type { MissionId, MissionStep } from '@/domain/missions';
import { missionRegistry } from '@/domain/missions-registry';

/** Pure edit helpers for a mission chain (used by the chain editor). */

export function addStep(steps: readonly MissionStep[], missionId: MissionId): MissionStep[] {
  const defaults = missionRegistry.get(missionId)?.defaultConfig ?? {};
  return [...steps, { missionId, config: { ...defaults } }];
}

export function removeStep(steps: readonly MissionStep[], index: number): MissionStep[] {
  return steps.filter((_, i) => i !== index);
}

export function updateStepConfig(
  steps: readonly MissionStep[],
  index: number,
  config: Record<string, unknown>,
): MissionStep[] {
  return steps.map((step, i) => (i === index ? { ...step, config } : step));
}

/** Moves a step to `to` (clamped); out-of-range `from` is a no-op. */
export function moveStep(steps: readonly MissionStep[], from: number, to: number): MissionStep[] {
  const target = Math.max(0, Math.min(steps.length - 1, to));
  const moving = steps[from];
  if (!moving || from === target) return [...steps];
  const next = steps.filter((_, i) => i !== from);
  next.splice(target, 0, moving);
  return next;
}
