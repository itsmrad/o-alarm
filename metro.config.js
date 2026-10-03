const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const { withNativeWind } = require('nativewind/metro');

// Sentry's wrapper around Expo's default config (debug IDs for source maps, D38).
const config = getSentryExpoConfig(__dirname);

// Drizzle migrations are .sql files inlined by babel-plugin-inline-import.
config.resolver.sourceExts.push('sql');

module.exports = withNativeWind(config, { input: './global.css' });
