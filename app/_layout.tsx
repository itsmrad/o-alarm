import '../global.css';

import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';

import { SleepReminderSync } from '@/features/sleep';
import { AppServicesProvider } from '@/lib/app-services';
import { AccountProviders } from '@/lib/auth';
import { AppErrorBoundary, ObservabilityRoot, initSentry } from '@/lib/observability';
import { PurchasesProvider } from '@/lib/purchases';
import { useThemeColors } from '@/theme/tokens';

SplashScreen.preventAutoHideAsync().catch(() => undefined);
// As early as possible; a no-op without EXPO_PUBLIC_SENTRY_DSN (D20/D38).
initSentry();

function BootScreen({ error }: { error?: Error }) {
  useEffect(() => {
    if (error) SplashScreen.hideAsync().catch(() => undefined);
  }, [error]);
  if (!error) return null;
  // Never fail silently: if local storage cannot open, say so.
  return (
    <View className="flex-1 justify-center gap-3 bg-background p-6">
      <Text className="text-title2 text-foreground">O-Alarm could not start</Text>
      <Text className="text-body text-foreground-muted">
        The on-device alarm database failed to open. Existing system alarms are unaffected.
      </Text>
      <Text className="text-footnote text-danger">{error.message}</Text>
    </View>
  );
}

function Navigation() {
  const colors = useThemeColors();
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  const base = colors.scheme === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider
      value={{
        ...base,
        colors: {
          ...base.colors,
          primary: colors.accent,
          background: colors.background,
          card: colors.surface,
          text: colors.foreground,
          border: colors.border,
          notification: colors.danger,
        },
      }}
    >
      <StatusBar style="auto" />
      <Stack screenOptions={{ contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="alarm/new" options={{ presentation: 'modal', title: 'New Alarm' }} />
        <Stack.Screen name="alarm/[id]" options={{ presentation: 'modal', title: 'Edit Alarm' }} />
        {/* Singular: the full-screen intent deep link (oalarm://ringing) and the JS trigger
            can both push an alarm screen; a second push reuses the open one (never stacks). */}
        <Stack.Screen
          name="ringing"
          dangerouslySingular
          options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false }}
        />
        <Stack.Screen
          name="mission"
          options={{ presentation: 'fullScreenModal', title: 'Mission' }}
        />
        <Stack.Screen
          name="wake-check"
          dangerouslySingular
          options={{ presentation: 'fullScreenModal', headerShown: false, gestureEnabled: false }}
        />
        <Stack.Screen name="paywall" options={{ presentation: 'modal', title: 'O-Alarm Pro' }} />
        <Stack.Screen name="checkin" options={{ presentation: 'modal', title: 'Good morning' }} />
        <Stack.Screen name="sign-in" options={{ presentation: 'modal', title: 'Sign in' }} />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <AppErrorBoundary>
      <AppServicesProvider
        renderBoot={(state) => (
          <BootScreen error={state.status === 'error' ? state.error : undefined} />
        )}
      >
        <AccountProviders>
          <PurchasesProvider>
            <SleepReminderSync />
            <ObservabilityRoot />
            <Navigation />
          </PurchasesProvider>
        </AccountProviders>
      </AppServicesProvider>
    </AppErrorBoundary>
  );
}
