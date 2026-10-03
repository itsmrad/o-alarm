import { z } from 'zod';

export const qrConfigSchema = z.object({
  /** SHA-256 (hex) of the registered code's value; null until a code is registered. */
  codeHash: z.string().nullable().default(null),
  /** User's name for the code's location, e.g. "Bathroom mirror". */
  label: z.string().max(40).default(''),
});
export type QrConfig = z.infer<typeof qrConfigSchema>;

export const defaultQrConfig: QrConfig = { codeHash: null, label: '' };

export function isQrConfigured(config: QrConfig): boolean {
  return !!config.codeHash;
}

/** Scanners differ in trailing whitespace/newlines; the code's identity is its trimmed value. */
export function normalizeScannedValue(value: string): string {
  return value.trim();
}

export function codesMatch(expectedHash: string | null, scannedHash: string): boolean {
  return !!expectedHash && expectedHash.toLowerCase() === scannedHash.toLowerCase();
}
