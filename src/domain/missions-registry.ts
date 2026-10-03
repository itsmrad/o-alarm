import type { MissionDefinition, MissionId, MissionRegistry } from './missions';
import { defaultMathConfig, mathConfigSchema } from './missions-math';
import { defaultQrConfig, isQrConfigured, qrConfigSchema } from './missions-qr';
import { defaultShakeConfig, shakeConfigSchema } from './missions-shake';
import { defaultStepsConfig, stepsConfigSchema } from './missions-steps';

/** The free mission every degraded/failed mission falls back to (D18). */
export const FALLBACK_MISSION_ID = 'math';

export interface BuiltInMissionDefinition extends MissionDefinition {
  /** False when the config cannot be completed as-is (e.g. QR with no registered code). */
  isConfigured?: (config: Record<string, unknown>) => boolean;
}

const definitions: BuiltInMissionDefinition[] = [
  {
    id: 'math',
    tier: 'free',
    title: 'Math',
    configSchema: mathConfigSchema,
    defaultConfig: defaultMathConfig,
  },
  {
    id: 'shake',
    tier: 'free',
    title: 'Shake',
    configSchema: shakeConfigSchema,
    defaultConfig: defaultShakeConfig,
    freeFallback: FALLBACK_MISSION_ID,
  },
  {
    id: 'steps',
    tier: 'free',
    title: 'Steps',
    configSchema: stepsConfigSchema,
    defaultConfig: defaultStepsConfig,
    freeFallback: FALLBACK_MISSION_ID,
  },
  {
    id: 'qr',
    tier: 'pro',
    title: 'QR / barcode',
    configSchema: qrConfigSchema,
    defaultConfig: defaultQrConfig,
    freeFallback: FALLBACK_MISSION_ID,
    isConfigured: (config) => isQrConfigured(qrConfigSchema.parse(config)),
  },
];

export function createMissionRegistry(
  list: readonly BuiltInMissionDefinition[] = definitions,
): MissionRegistry & { get(id: MissionId): BuiltInMissionDefinition | undefined } {
  const byId = new Map(list.map((d) => [d.id, d]));
  return {
    get: (id) => byId.get(id),
    list: () => list,
  };
}

export const missionRegistry = createMissionRegistry();
