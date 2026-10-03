import { z } from 'zod';

/**
 * Mission chain types + registry contract. Missions themselves are implemented
 * in src/features/missions (later task); the domain only knows their shape.
 */

export type MissionTier = 'free' | 'pro';

/** MVP mission ids. The registry accepts others so later missions need no domain change. */
export type BuiltInMissionId = 'math' | 'shake' | 'qr' | 'steps';
export type MissionId = BuiltInMissionId | (string & {});

export const MAX_MISSION_CHAIN_LENGTH = 5;

export const missionStepSchema = z.object({
  missionId: z.string().min(1),
  /** Mission-specific config, validated by the mission's own `configSchema`. */
  config: z.record(z.string(), z.unknown()),
});

/** One step of an alarm's mission chain. Steps run in order; all must complete to dismiss. */
export type MissionStep = z.infer<typeof missionStepSchema>;

export interface MissionDefinition<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
  id: MissionId;
  tier: MissionTier;
  title: string;
  /** Validates/normalizes a step's `config`. */
  configSchema: z.ZodType<TConfig>;
  defaultConfig: TConfig;
  /**
   * Free mission used at ring time when this (pro) mission is unavailable, e.g. the
   * entitlement is unknown or lapsed (D18: never weaken an alarm into "no mission").
   */
  freeFallback?: MissionId;
}

export interface MissionRegistry {
  get(id: MissionId): MissionDefinition | undefined;
  list(): readonly MissionDefinition[];
}

export type MissionOutcome = 'completed' | 'failed' | 'abandoned';

export interface MissionAttemptResult {
  missionId: MissionId;
  stepIndex: number;
  outcome: MissionOutcome;
  startedAt: string;
  endedAt: string;
}
