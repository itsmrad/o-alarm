import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  AlarmEngineModuleEvents,
  AlarmScheduleSpec,
  EngineReadiness,
  PermissionKind,
  PermissionStatus,
  ScheduledAlarm,
} from './AlarmEngine.types';

export declare class AlarmEngineNativeModule extends NativeModule<AlarmEngineModuleEvents> {
  schedule(spec: AlarmScheduleSpec): Promise<ScheduledAlarm>;
  cancel(id: string): Promise<void>;
  cancelAll(): Promise<void>;
  getScheduled(): Promise<ScheduledAlarm[]>;
  getReadiness(): Promise<EngineReadiness>;
  requestPermission(kind: PermissionKind): Promise<PermissionStatus>;
  previewAlarm(spec: AlarmScheduleSpec): Promise<void>;
}

/**
 * The native module, or null when it is not linked (Expo Go, web, tests).
 * Callers must handle null — see src/engine/resolve-engine.ts (D6).
 */
export default requireOptionalNativeModule<AlarmEngineNativeModule>('AlarmEngine');
