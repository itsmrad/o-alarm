import { resolvePurchasesConfig, type PurchasesConfigInput } from './config';
import { createLiveClient, type PurchasesSdk } from './live-client';
import { createMockClient } from './mock-client';
import type { PurchasesClient } from './types';

/**
 * Live RevenueCat when a key is present on a real build, otherwise the mock. The native SDK is
 * required lazily so Expo Go, web and tests never load it.
 */
export function createPurchasesClient(
  input?: PurchasesConfigInput,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  loadSdk: () => PurchasesSdk = () => require('react-native-purchases').default,
): PurchasesClient {
  const config = resolvePurchasesConfig(input);
  if (config.apiKey === null) return createMockClient(config.mode);
  try {
    return createLiveClient(config.apiKey, loadSdk());
  } catch {
    return createMockClient({ kind: 'mock', reason: 'no-key', simulate: false });
  }
}
