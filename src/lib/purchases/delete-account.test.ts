/** @jest-environment node */
import { createDeleteAccountHandler } from '../../../supabase/functions/_shared/delete-account';

function setup(over: Partial<Parameters<typeof createDeleteAccountHandler>[0]> = {}) {
  const deps = {
    verifyCaller: jest.fn(async (token: string) => (token === 'good' ? 'user_1' : null)),
    deleteSubscriber: jest.fn(async () => 'deleted' as const),
    deleteLocalBilling: jest.fn(async () => undefined),
    ...over,
  };
  const call = (headers: Record<string, string>, method = 'POST') =>
    createDeleteAccountHandler(deps)(new Request('https://x.test/f', { method, headers }));
  return { deps, call };
}

describe('delete-account-cleanup', () => {
  it('requires a verified caller and never trusts a body-supplied user id', async () => {
    const { deps, call } = setup();
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: 'Bearer bad' })).status).toBe(401);
    expect((await call({ authorization: 'Basic abc' })).status).toBe(401);
    expect((await call({ authorization: 'Bearer good' }, 'GET')).status).toBe(405);
    expect(deps.deleteSubscriber).not.toHaveBeenCalled();
  });

  it('treats a verification error as unauthorized', async () => {
    const { call } = setup({ verifyCaller: jest.fn().mockRejectedValue(new Error('boom')) });
    expect((await call({ authorization: 'Bearer good' })).status).toBe(401);
  });

  it('deletes the RevenueCat subscriber, then the local billing rows, for the verified user', async () => {
    const { deps, call } = setup();
    const response = await call({ authorization: 'Bearer good' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revenuecat: 'deleted' });
    expect(deps.deleteSubscriber).toHaveBeenCalledWith('user_1');
    expect(deps.deleteLocalBilling).toHaveBeenCalledWith('user_1');
  });

  it('fails (so the client can retry) when RevenueCat deletion fails, keeping local rows', async () => {
    const { deps, call } = setup({
      deleteSubscriber: jest.fn().mockRejectedValue(new Error('RevenueCat API 500')),
    });
    expect((await call({ authorization: 'Bearer good' })).status).toBe(502);
    expect(deps.deleteLocalBilling).not.toHaveBeenCalled();
  });
});
