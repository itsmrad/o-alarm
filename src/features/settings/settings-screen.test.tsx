import { Slot } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useEffect } from 'react';
import { Alert, Text } from 'react-native';

import { createAlarm } from '@/domain';
import { AccountProviders } from '@/lib/auth';
import { AppServicesProvider, useAppServices, useAlarms } from '@/lib/app-services';
import { resetEntitlementsForTests } from '@/lib/entitlements';

import { SettingsScreen } from './settings-screen';

jest.mock('@/db/client', () => ({
  openAppDatabase: async () => {
    const { createTestDatabase } = jest.requireActual('@/db/testing/test-db');
    return createTestDatabase().db;
  },
}));

const alertSpy = jest.spyOn(Alert, 'alert');
beforeEach(() => {
  alertSpy.mockReset();
  delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
});
afterEach(resetEntitlementsForTests);

function Seed() {
  const { alarms } = useAppServices();
  const list = useAlarms();
  useEffect(() => {
    const { id: _id, ...draft } = createAlarm({ id: 'x', hour: 7, minute: 0, weekdays: [1] });
    void alarms.save({ ...draft, label: 'Seeded' });
  }, [alarms]);
  return <Text>{list.map((a) => a.label).join(',') || 'no alarms'}</Text>;
}

function Layout() {
  return (
    <AppServicesProvider renderBoot={() => null}>
      <AccountProviders>
        <Slot />
      </AccountProviders>
    </AppServicesProvider>
  );
}

describe('settings (account, sync, privacy, data)', () => {
  it('shows account and sync as not configured without env and keeps the app usable', async () => {
    renderRouter({ _layout: Layout, index: SettingsScreen });
    expect(await screen.findAllByText('Not configured')).toHaveLength(2);
    expect(screen.getByText('Share usage analytics')).toBeTruthy();
    expect(screen.getByText('Erase data on this device')).toBeTruthy();
    expect(screen.queryByText('Export my data')).toBeNull();
  });

  it('erases local alarms through the alarm service after two confirmations', async () => {
    renderRouter({
      _layout: Layout,
      index: () => (
        <>
          <Seed />
          <SettingsScreen />
        </>
      ),
    });
    await screen.findByText(/Seeded/);
    alertSpy.mockImplementation((_title, _message, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await act(async () => fireEvent.press(screen.getByText('Erase data on this device')));
    expect(alertSpy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText('no alarms')).toBeTruthy());
  });

  it('does not erase when the second confirmation is cancelled', async () => {
    renderRouter({
      _layout: Layout,
      index: () => (
        <>
          <Seed />
          <SettingsScreen />
        </>
      ),
    });
    await screen.findByText(/Seeded/);
    let n = 0;
    alertSpy.mockImplementation((_title, _message, buttons) => {
      const style = ++n === 1 ? 'destructive' : 'cancel';
      buttons?.find((b) => b.style === style)?.onPress?.();
    });
    await act(async () => fireEvent.press(screen.getByText('Erase data on this device')));
    expect(screen.getByText(/Seeded/)).toBeTruthy();
  });

  it('hides cloud sync for guests when Supabase is configured but nobody is signed in', async () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    renderRouter({ _layout: Layout, index: SettingsScreen });
    await screen.findByText('Share usage analytics');
    expect(screen.queryByText('Cloud sync')).toBeNull();
  });
});
