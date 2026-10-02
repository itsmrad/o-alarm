import { readFileSync } from 'node:fs';
import path from 'node:path';

import { colorTokens, themeColors } from './tokens';

function parseBlock(css: string): Record<string, string> {
  return Object.fromEntries(
    [...css.matchAll(/--color-([\w-]+):\s*([\d ]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

describe('color tokens', () => {
  const css = readFileSync(path.join(__dirname, '../../global.css'), 'utf8');
  const [light, dark] = css.split('@media (prefers-color-scheme: dark)');

  it('match global.css for light and dark', () => {
    expect(parseBlock(light!)).toEqual(colorTokens.light);
    expect(parseBlock(dark!)).toEqual(colorTokens.dark);
  });

  it('meet WCAG AA contrast for text on backgrounds', () => {
    const luminance = (rgb: string) => {
      const [r, g, b] = rgb.split(' ').map((c) => {
        const v = Number(c) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    for (const t of [colorTokens.light, colorTokens.dark]) {
      for (const bg of [t.background, t.surface]) {
        expect(contrast(t.foreground, bg)).toBeGreaterThanOrEqual(7);
        expect(contrast(t['foreground-muted'], bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.accent, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.danger, bg)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(t['accent-foreground'], t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['warning-foreground'], t.warning)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('formats rgb() strings', () => {
    expect(themeColors('light').accent).toBe('rgb(44, 82, 199)');
  });
});
