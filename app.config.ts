import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'O-Alarm',
  slug: 'o-alarm',
  scheme: 'oalarm',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  platforms: ['ios', 'android'],
  ios: {
    bundleIdentifier: 'com.oalarm.app',
    // D4: AlarmKit only → iOS 26 minimum. Built-in key since SDK 56
    // (expo-build-properties' ios.deploymentTarget is deprecated).
    deploymentTarget: '26',
    supportsTablet: false,
  },
  android: {
    package: 'com.oalarm.app',
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    'expo-sqlite',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 160,
        resizeMode: 'contain',
        backgroundColor: '#F7F7F5',
        dark: { backgroundColor: '#0E1013' },
      },
    ],
    // D5: Android minSdk 26.
    ['expo-build-properties', { android: { minSdkVersion: 26 } }],
  ],
  experiments: {
    typedRoutes: true,
  },
});
