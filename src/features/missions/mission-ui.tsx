import type Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, ComponentType } from 'react';
import type { z } from 'zod';

import type { MissionId } from '@/domain/missions';
import { defaultMathConfig, mathConfigSchema } from '@/domain/missions-math';
import { defaultQrConfig, isQrConfigured, qrConfigSchema } from '@/domain/missions-qr';
import { defaultShakeConfig, shakeConfigSchema } from '@/domain/missions-shake';
import { defaultStepsConfig, stepsConfigSchema } from '@/domain/missions-steps';

import { MathEditor, QrEditor, ShakeEditor, StepsEditor } from './config-editors';
import { MathMission } from './math-mission';
import { QrMission } from './qr-mission';
import { ShakeMission } from './shake-mission';
import { StepsMission } from './steps-mission';
import type { MissionEditorProps, MissionViewProps } from './types';

type Config = Record<string, unknown>;

export interface MissionUi {
  icon: ComponentProps<typeof Ionicons>['name'];
  /** One line for the picker / editor. */
  description: string;
  /** Short summary of a configured step, e.g. "Medium · 3 problems". */
  summary: (config: Config) => string;
  View: ComponentType<MissionViewProps<Config>>;
  Editor: ComponentType<MissionEditorProps<Config>>;
}

function bind<T extends Config>(
  schema: z.ZodType<T>,
  fallback: T,
  View: ComponentType<MissionViewProps<T>>,
  Editor: ComponentType<MissionEditorProps<T>>,
): Pick<MissionUi, 'View' | 'Editor'> & { parse: (config: Config) => T } {
  const parse = (config: Config): T => {
    const result = schema.safeParse(config);
    return result.success ? result.data : fallback;
  };
  return {
    parse,
    View: (props) => <View {...props} config={parse(props.config)} />,
    Editor: ({ config, onChange }) => <Editor config={parse(config)} onChange={onChange} />,
  };
}

const math = bind(mathConfigSchema, defaultMathConfig, MathMission, MathEditor);
const shake = bind(shakeConfigSchema, defaultShakeConfig, ShakeMission, ShakeEditor);
const steps = bind(stepsConfigSchema, defaultStepsConfig, StepsMission, StepsEditor);
const qr = bind(qrConfigSchema, defaultQrConfig, QrMission, QrEditor);

/** UI half of the registry; the domain registry (`missionRegistry`) owns ids/tiers/config. */
export const missionUi: Record<string, MissionUi> = {
  math: {
    icon: 'calculator',
    description: 'Solve arithmetic on a big keypad.',
    summary: (c) => {
      const { difficulty, problemCount } = math.parse(c);
      return `${difficulty[0]?.toUpperCase()}${difficulty.slice(1)} · ${problemCount} ${problemCount === 1 ? 'problem' : 'problems'}`;
    },
    View: math.View,
    Editor: math.Editor,
  },
  shake: {
    icon: 'phone-portrait',
    description: 'Shake your phone to wake your arms up.',
    summary: (c) => `${shake.parse(c).targetCount} shakes`,
    View: shake.View,
    Editor: shake.Editor,
  },
  steps: {
    icon: 'walk',
    description: 'Get out of bed and take steps.',
    summary: (c) => `${steps.parse(c).targetSteps} steps`,
    View: steps.View,
    Editor: steps.Editor,
  },
  qr: {
    icon: 'qr-code',
    description: 'Scan a barcode or QR code you registered across the room.',
    summary: (c) => {
      const config = qr.parse(c);
      if (!isQrConfigured(config)) return 'No code registered yet';
      return config.label ? `Scan “${config.label}”` : 'Code registered';
    },
    View: qr.View,
    Editor: qr.Editor,
  },
};

export function getMissionUi(id: MissionId): MissionUi | undefined {
  return missionUi[id];
}
