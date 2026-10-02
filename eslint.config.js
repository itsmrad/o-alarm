// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const eslintPluginPrettierRecommended = require('eslint-plugin-prettier/recommended');

module.exports = defineConfig([
  expoConfig,
  eslintPluginPrettierRecommended,
  {
    ignores: [
      'dist/*',
      'ios/*',
      'android/*',
      'modules/alarm-engine/ios/*',
      'modules/alarm-engine/android/*',
      'src/db/migrations/*',
      'supabase/*',
    ],
  },
  {
    // src/domain must stay pure and framework-free.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            'react',
            'react-native',
            'expo-*',
            '@/db/*',
            '@/engine/*',
            '@/features/*',
            '@/lib/*',
          ],
        },
      ],
    },
  },
]);
