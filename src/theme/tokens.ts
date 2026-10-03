import { useColorScheme } from 'react-native';

/**
 * JS mirror of the semantic color tokens in global.css, for places that cannot take a
 * className (navigation theme, native controls). Values are "R G B" channel strings.
 * Parity with global.css is enforced by tokens.test.ts.
 */
export const colorTokens = {
  light: {
    background: '247 247 245',
    surface: '255 255 255',
    'surface-muted': '238 238 235',
    foreground: '17 19 21',
    'foreground-muted': '84 89 97',
    border: '216 217 212',
    accent: '44 82 199',
    'accent-foreground': '255 255 255',
    danger: '190 38 38',
    success: '26 122 76',
    warning: '255 244 219',
    'warning-foreground': '102 59 0',
  },
  dark: {
    background: '14 16 19',
    surface: '23 26 31',
    'surface-muted': '34 38 45',
    foreground: '242 243 245',
    'foreground-muted': '163 169 179',
    border: '44 49 58',
    accent: '143 168 255',
    'accent-foreground': '14 16 19',
    danger: '255 120 120',
    success: '92 205 150',
    warning: '58 42 10',
    'warning-foreground': '245 207 133',
  },
} as const;

export type ColorToken = keyof (typeof colorTokens)['light'];
export type ThemeColors = Record<ColorToken, string>;

const toRgb = (channels: string) => `rgb(${channels.split(' ').join(', ')})`;

export function themeColors(scheme: 'light' | 'dark'): ThemeColors {
  const tokens = colorTokens[scheme];
  return Object.fromEntries(
    Object.entries(tokens).map(([name, value]) => [name, toRgb(value)]),
  ) as ThemeColors;
}

export function useThemeColors(): ThemeColors & { scheme: 'light' | 'dark' } {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { ...themeColors(scheme), scheme };
}
