import { Slot } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import * as WebBrowser from 'expo-web-browser';
import { Alert } from 'react-native';

import { AppServicesProvider } from '@/lib/app-services';
import { getEntitlementSnapshot, resetEntitlementsForTests } from '@/lib/entitlements';
import {
  PurchasesProvider,
  createPurchasesController,
  type CustomerSnapshot,
  type PurchasesClient,
} from '@/lib/purchases';
import { createMockClient } from '@/lib/purchases/mock-client';

import { PaywallScreen, annualSavings } from './paywall-screen';

jest.mock('@/db/client', () => ({
  openAppDatabase: async () => {
    const { createTestDatabase } = jest.requireActual('@/db/testing/test-db');
    return createTestDatabase().db;
  },
}));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(async () => ({ type: 'cancel' })),
}));

const alertSpy = jest.spyOn(Alert, 'alert');
beforeEach(() => alertSpy.mockReset());
afterEach(resetEntitlementsForTests);

const PRO: CustomerSnapshot = {
  managementUrl: 'https://manage.example/sub',
  proEntitlement: {
    isActive: true,
    willRenew: true,
    expirationDate: '2099-01-01T00:00:00.000Z',
    billingIssueDetectedAt: null,
    productIdentifier: 'pro_yearly',
    gracePeriodExpiresDate: null,
  },
};

function storeClient(overrides: Partial<PurchasesClient> = {}): PurchasesClient {
  return {
    mode: { kind: 'live' },
    start: async () => undefined,
    logIn: async () => ({ proEntitlement: null, managementUrl: null }),
    logOut: async () => ({ proEntitlement: null, managementUrl: null }),
    getCustomer: async () => ({ proEntitlement: null, managementUrl: null }),
    getOffering: async () => ({
      identifier: 'default',
      monthly: {
        id: 'm',
        period: 'month',
        priceString: '€2,29',
        price: 2.29,
        perMonthString: null,
      },
      annual: {
        id: 'y',
        period: 'year',
        priceString: '€17,99',
        price: 17.99,
        perMonthString: '€1,50',
      },
    }),
    purchase: async () => ({ cancelled: false, customer: PRO }),
    restore: async () => PRO,
    onCustomerChange: () => () => undefined,
    ...overrides,
  };
}

const render = (client: PurchasesClient, params = '') => {
  const controller = createPurchasesController(client);
  renderRouter(
    {
      _layout: () => (
        <AppServicesProvider renderBoot={() => null}>
          <PurchasesProvider controller={controller}>
            <Slot />
          </PurchasesProvider>
        </AppServicesProvider>
      ),
      index: PaywallScreen,
    },
    { initialUrl: params ? `/?${params}` : '/' },
  );
  return controller;
};

describe('paywall', () => {
  it('always states that core reliability is free and lists Pro features', async () => {
    render(storeClient());
    expect(await screen.findByText(/Core alarm reliability is always free/)).toBeTruthy();
    expect(screen.getByText('Mission chains')).toBeTruthy();
    expect(screen.getByText('Cloud sync across your devices')).toBeTruthy();
    expect(screen.getByText('Terms of Use')).toBeTruthy();
    expect(screen.getByText('Restore purchases')).toBeTruthy();
    expect(screen.getByText('Manage subscription')).toBeTruthy();
  });

  it('shows the real store prices from the current offering, not the fallback numbers', async () => {
    render(storeClient(), 'reason=mission-chains');
    expect(await screen.findByText('€17,99 / year')).toBeTruthy();
    expect(screen.getByText('€2,29 / month')).toBeTruthy();
    expect(screen.queryByText('$14.99 / year')).toBeNull();
    expect(screen.getByText('Mission chains are part of Pro.')).toBeTruthy();
    expect(screen.getByText('Save 35%')).toBeTruthy();
  });

  it('purchases the selected plan and unlocks Pro', async () => {
    const purchase = jest.fn(async () => ({ cancelled: false, customer: PRO }));
    render(storeClient({ purchase }));
    await screen.findByText('€17,99 / year');
    fireEvent.press(screen.getByText('Monthly'));
    await act(async () => fireEvent.press(screen.getByText(/^Continue/)));
    expect(purchase).toHaveBeenCalledWith('m');
    expect(getEntitlementSnapshot().tier).toBe('pro');
  });

  it('does nothing visible when the user cancels the purchase', async () => {
    const purchase = jest.fn(async () => ({ cancelled: true, customer: null }));
    render(storeClient({ purchase }));
    await screen.findByText('€17,99 / year');
    await act(async () => fireEvent.press(screen.getByText(/^Continue/)));
    expect(alertSpy).not.toHaveBeenCalled();
    expect(getEntitlementSnapshot().tier).toBe('free');
  });

  it('reports a failed purchase honestly', async () => {
    render(storeClient({ purchase: async () => Promise.reject(new Error('Store unavailable')) }));
    await screen.findByText('€17,99 / year');
    await act(async () => fireEvent.press(screen.getByText(/^Continue/)));
    expect(alertSpy).toHaveBeenCalledWith(
      'Purchase failed',
      expect.stringContaining('Store unavailable'),
    );
    expect(getEntitlementSnapshot().tier).toBe('free');
  });

  it('restores purchases', async () => {
    render(storeClient());
    await screen.findByText('€17,99 / year');
    await act(async () => fireEvent.press(screen.getByText('Restore purchases')));
    expect(alertSpy).toHaveBeenCalledWith('Pro restored', expect.any(String));
    expect(getEntitlementSnapshot().tier).toBe('pro');
  });

  it('opens manage subscription and terms links', async () => {
    render(storeClient());
    await screen.findByText('€17,99 / year');
    await act(async () => fireEvent.press(screen.getByText('Terms of Use')));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(expect.stringContaining('apple.com'));
    await act(async () => fireEvent.press(screen.getByText('Manage subscription')));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledTimes(2);
  });

  it('falls back to labelled, non-purchasable prices when the store cannot be reached', async () => {
    render(storeClient({ getOffering: async () => Promise.reject(new Error('offline')) }));
    expect(await screen.findByText(/Couldn't load current prices/)).toBeTruthy();
    expect(screen.getByText('$14.99 / year')).toBeTruthy();
    expect(screen.getByText('$1.99 / month')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^Continue/ }).props.accessibilityState.disabled,
    ).toBe(true);
  });

  it('renders in mock mode without crashing and refuses purchases in release builds', async () => {
    render(createMockClient({ kind: 'mock', reason: 'no-key', simulate: false }));
    expect(await screen.findByText(/Purchases are not available in this build/)).toBeTruthy();
    expect(screen.getByText('$14.99 / year')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /^Continue/ }).props.accessibilityState.disabled,
    ).toBe(true);
    expect(getEntitlementSnapshot().tier).toBe('free');
  });

  it('shows the subscriber state instead of plans when already Pro', async () => {
    const controller = render(storeClient({ getCustomer: async () => PRO }));
    await waitFor(() => expect(controller.getStatus().active).toBe(true));
    expect(await screen.findByText("You're on O-Alarm Pro")).toBeTruthy();
    expect(screen.queryByText(/^Continue/)).toBeNull();
    expect(screen.getByText('Done')).toBeTruthy();
  });
});

describe('annualSavings', () => {
  const plan = (price: number | null) => ({
    id: 'x',
    period: 'month' as const,
    priceString: '',
    price,
    perMonthString: null,
  });
  it('compares the annual price with twelve months and hides unknown or negative savings', () => {
    expect(annualSavings(plan(1.99), plan(14.99))).toBe(37);
    expect(annualSavings(plan(1.99), plan(null))).toBeNull();
    expect(annualSavings(plan(1), plan(20))).toBeNull();
  });
});
