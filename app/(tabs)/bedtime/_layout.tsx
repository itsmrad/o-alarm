import { Stack } from 'expo-router';

import { largeTitleOptions } from '@/components/stack-options';

export default function Layout() {
  return (
    <Stack screenOptions={largeTitleOptions}>
      <Stack.Screen name="index" options={{ title: 'Bedtime' }} />
    </Stack>
  );
}
