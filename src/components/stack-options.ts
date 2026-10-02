import type { ComponentProps } from 'react';
import type { Stack } from 'expo-router';

/** HIG large-title headers for top-level tab stacks. */
export const largeTitleOptions: ComponentProps<typeof Stack>['screenOptions'] = {
  headerLargeTitleEnabled: true,
  headerShadowVisible: false,
  headerLargeTitleShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
};
