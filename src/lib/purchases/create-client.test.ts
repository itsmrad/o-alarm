import { createPurchasesClient } from './create-client';
import type { PurchasesSdk } from './live-client';

const live = { platform: 'ios', executionEnvironment: 'bare', iosKey: 'appl_x', dev: false };

describe('createPurchasesClient', () => {
  it('does not load the native SDK in mock mode', () => {
    const loadSdk = jest.fn();
    const client = createPurchasesClient({ ...live, iosKey: '' }, loadSdk);
    expect(client.mode.kind).toBe('mock');
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it('falls back to a non-simulating mock when the SDK cannot load', () => {
    const client = createPurchasesClient(live, () => {
      throw new Error('native module missing');
    });
    expect(client.mode).toEqual({ kind: 'mock', reason: 'no-key', simulate: false });
  });

  it('configures the SDK with the key and maps cancellations', async () => {
    const sdk = {
      configure: jest.fn(),
      addCustomerInfoUpdateListener: jest.fn(),
      removeCustomerInfoUpdateListener: jest.fn(),
      purchasePackage: jest.fn().mockRejectedValue({ userCancelled: true, code: '1' }),
      getOfferings: jest.fn().mockResolvedValue({
        current: {
          identifier: 'default',
          availablePackages: [
            {
              identifier: '$rc_monthly',
              product: { priceString: '$1.99', price: 1.99, pricePerMonthString: '$1.99' },
            },
          ],
          monthly: {
            identifier: '$rc_monthly',
            product: { priceString: '$1.99', price: 1.99, pricePerMonthString: '$1.99' },
          },
          annual: null,
        },
      }),
    } as unknown as PurchasesSdk;
    const client = createPurchasesClient(live, () => sdk);
    await client.start();
    await client.start();
    expect(sdk.configure).toHaveBeenCalledTimes(1);
    expect(sdk.configure).toHaveBeenCalledWith({ apiKey: 'appl_x' });
    const offering = await client.getOffering();
    expect(offering?.monthly?.priceString).toBe('$1.99');
    expect(await client.purchase('$rc_monthly')).toEqual({ cancelled: true, customer: null });
  });
});
