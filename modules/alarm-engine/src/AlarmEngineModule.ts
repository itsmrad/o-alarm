import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  AlarmEngineModuleEvents,
  AlarmScheduleSpec,
  DismissOptions,
  DismissResult,
  EngineReadiness,
  ObservedEngineEvent,
  PermissionKind,
  PermissionStatus,
  RingingState,
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
  getActiveRinging(): Promise<RingingState | null>;
  snooze(scheduleId: string): Promise<ScheduledAlarm>;
  dismiss(scheduleId: string, options: DismissOptions): Promise<DismissResult>;
  drainObservedEvents(): Promise<ObservedEngineEvent[]>;
  ackObservedEvents(ids: string[]): Promise<void>;
}

/**
 * The native module, or null when it is not linked (Expo Go, web, tests).
 * Callers must handle null — see src/engine/resolve-engine.ts (D6).
 */
export default requireOptionalNativeModule<AlarmEngineNativeModule>('AlarmEngine');
