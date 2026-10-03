import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

import type { PurchasesMode } from './types';

/**
 * Chooses live vs mock purchases. Keys are publishable (D21). The `process.env.EXPO_PUBLIC_*`
 * reads must stay literal so Expo can inline them at build time.
 */
export interface PurchasesConfigInput {
  iosKey?: string;
  androidKey?: string;
  platform?: string;
  executionEnvironment?: string;
  dev?: boolean;
}

export type PurchasesConfig =
  | { mode: { kind: 'live' }; apiKey: string }
  | {
      mode: Extract<PurchasesMode, { kind: 'mock' }>;
      apiKey: null;
    };

export function resolvePurchasesConfig(input: PurchasesConfigInput = {}): PurchasesConfig {
  const iosKey = (input.iosKey ?? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY)?.trim();
  const androidKey = (input.androidKey ?? process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY)?.trim();
  const platform = input.platform ?? Platform.OS;
  const environment = input.executionEnvironment ?? Constants.executionEnvironment;
  const simulate = input.dev ?? __DEV__;
  const mock = (reason: 'no-key' | 'expo-go' | 'unsupported-platform'): PurchasesConfig => ({
    mode: { kind: 'mock', reason, simulate },
    apiKey: null,
  });

  if (platform !== 'ios' && platform !== 'android') return mock('unsupported-platform');
  // Expo Go has no store access: RevenueCat cannot make real purchases there.
  if (environment === ExecutionEnvironment.StoreClient) return mock('expo-go');
  const apiKey = platform === 'ios' ? iosKey : androidKey;
  if (!apiKey) return mock('no-key');
  return { mode: { kind: 'live' }, apiKey };
}
