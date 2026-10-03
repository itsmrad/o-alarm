import { createHash } from 'node:crypto';

import { hashCodeValue } from './qr-hash';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algo: string, data: string) =>
    jest
      .requireActual<typeof import('node:crypto')>('node:crypto')
      .createHash('sha256')
      .update(data)
      .digest('hex'),
}));

describe('hashCodeValue', () => {
  it('is the SHA-256 hex of the trimmed value', async () => {
    const expected = createHash('sha256').update('4006381333931').digest('hex');
    expect(await hashCodeValue('4006381333931')).toBe(expected);
    expect(await hashCodeValue('  4006381333931\n')).toBe(expected);
    expect(await hashCodeValue('4006381333932')).not.toBe(expected);
  });
});
