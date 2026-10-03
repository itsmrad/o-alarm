import { codesMatch, isQrConfigured, normalizeScannedValue, qrConfigSchema } from './missions-qr';

describe('qr mission logic', () => {
  it('normalizes scanner whitespace', () => {
    expect(normalizeScannedValue(' 4006381333931\n')).toBe('4006381333931');
  });

  it('matches only the registered hash (case-insensitive hex)', () => {
    expect(codesMatch('abc123', 'ABC123')).toBe(true);
    expect(codesMatch('abc123', 'abc124')).toBe(false);
    expect(codesMatch(null, '')).toBe(false);
    expect(codesMatch('', '')).toBe(false);
  });

  it('is configured only with a code hash', () => {
    expect(isQrConfigured(qrConfigSchema.parse({}))).toBe(false);
    expect(isQrConfigured(qrConfigSchema.parse({ codeHash: 'abc' }))).toBe(true);
  });
});
