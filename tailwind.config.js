/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--color-${name}) / <alpha-value>)`;

module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        background: token('background'),
        surface: { DEFAULT: token('surface'), muted: token('surface-muted') },
        foreground: { DEFAULT: token('foreground'), muted: token('foreground-muted') },
        border: token('border'),
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        danger: token('danger'),
        success: token('success'),
        warning: { DEFAULT: token('warning'), foreground: token('warning-foreground') },
      },
      // Apple HIG Dynamic Type "Large" sizes (pt), plus a display size for alarm times.
      fontSize: {
        display: ['64px', { lineHeight: '72px', fontWeight: '200' }],
        'large-title': ['34px', { lineHeight: '41px', fontWeight: '700' }],
        title1: ['28px', { lineHeight: '34px', fontWeight: '700' }],
        title2: ['22px', { lineHeight: '28px', fontWeight: '700' }],
        title3: ['20px', { lineHeight: '25px', fontWeight: '600' }],
        headline: ['17px', { lineHeight: '22px', fontWeight: '600' }],
        body: ['17px', { lineHeight: '22px' }],
        callout: ['16px', { lineHeight: '21px' }],
        subhead: ['15px', { lineHeight: '20px' }],
        footnote: ['13px', { lineHeight: '18px' }],
        caption: ['12px', { lineHeight: '16px' }],
      },
      borderRadius: { card: '16px', control: '12px' },
      // HIG minimum hit target is 44pt; alarm UI uses larger targets.
      minHeight: { touch: '44px', 'touch-lg': '64px' },
      minWidth: { touch: '44px' },
    },
  },
  plugins: [],
};
