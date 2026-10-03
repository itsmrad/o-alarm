import * as Crypto from 'expo-crypto';

import { normalizeScannedValue } from '@/domain/missions-qr';

/** SHA-256 hex of a scanned code's value. Only the hash is ever stored. */
export function hashCodeValue(value: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    normalizeScannedValue(value),
  );
}
