const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Drizzle migrations are .sql files inlined by babel-plugin-inline-import.
config.resolver.sourceExts.push('sql');

module.exports = withNativeWind(config, { input: './global.css' });
