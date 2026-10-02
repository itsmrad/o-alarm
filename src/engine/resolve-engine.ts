import AlarmEngineModule, { type AlarmEngineNativeModule } from '@modules/alarm-engine';
import Constants, { ExecutionEnvironment } from 'expo-constants';

import { NativeAlarmEngine } from './native-engine';
import { PreviewAlarmEngine } from './preview-engine';
import type { AlarmEngine } from './types';

interface ResolveOptions {
  nativeModule?: AlarmEngineNativeModule | null;
  executionEnvironment?: string;
}

/**
 * D6: the native engine when the module is linked (dev/production build), otherwise
 * the in-memory preview engine (Expo Go). Never throws.
 */
export function resolveEngine(options: ResolveOptions = {}): AlarmEngine {
  const nativeModule =
    options.nativeModule !== undefined ? options.nativeModule : AlarmEngineModule;
  const environment = options.executionEnvironment ?? Constants.executionEnvironment;
  if (environment === ExecutionEnvironment.StoreClient || !nativeModule) {
    return new PreviewAlarmEngine();
  }
  return new NativeAlarmEngine(nativeModule);
}
