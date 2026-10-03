/** @jest-environment node */
import {
  createWebhookHandler,
  mapEvent,
  type EntitlementCommand,
  type RevenueCatEvent,
  type RevenueCatSubscriber,
} from '../../../supabase/functions/_shared/revenuecat';

const NOW = new Date('2026-10-03T08:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => NOW.getTime() + days * DAY;
const SECRET = 'Bearer s3cret';

const event = (over: Partial<RevenueCatEvent>): RevenueCatEvent => ({
  id: 'evt-1',
  type: 'INITIAL_PURCHASE',
  app_user_id: 'user_clerk_1',
  product_id: 'o_alarm_pro_monthly',
  entitlement_ids: ['pro'],
  period_type: 'NORMAL',
  purchased_at_ms: at(0),
  expiration_at_ms: at(30),
  event_timestamp_ms: at(0),
  store: 'APP_STORE',
  environment: 'PRODUCTION',
  ...over,
});

const only = (mapped: ReturnType<typeof mapEvent>): EntitlementCommand => {
  if (mapped.kind !== 'apply') throw new Error(`expected apply, got ${mapped.kind}`);
  return mapped.commands[0]!;
};

describe('mapEvent', () => {
  it('activates on purchase and renewal with the store expiry', () => {
    const cmd = only(mapEvent(event({}), NOW));
    expect(cmd).toMatchObject({
      p_event_id: 'evt-1',
      p_app_user_id: 'user_clerk_1',
      p_entitlement: 'pro',
      p_is_active: true,
      p_will_renew: true,
      p_store: 'app_store',
      p_environment: 'production',
      p_period_type: 'normal',
      p_product_id: 'o_alarm_pro_monthly',
      p_expires_at: new Date(at(30)).toISOString(),
    });
    expect(only(mapEvent(event({ type: 'RENEWAL' }), NOW)).p_is_active).toBe(true);
  });

  it('maps trial, sandbox and play store fields', () => {
    expect(
      only(
        mapEvent(event({ period_type: 'TRIAL', environment: 'SANDBOX', store: 'PLAY_STORE' }), NOW),
      ),
    ).toMatchObject({ p_period_type: 'trial', p_environment: 'sandbox', p_store: 'play_store' });
  });

  it('keeps access after a cancellation until the period ends, with renewal off', () => {
    expect(only(mapEvent(event({ type: 'CANCELLATION' }), NOW))).toMatchObject({
      p_is_active: true,
      p_will_renew: false,
    });
  });

  it('revokes at once when a cancellation or refund already ended the period', () => {
    expect(
      only(mapEvent(event({ type: 'CANCELLATION', expiration_at_ms: at(-1) }), NOW)).p_is_active,
    ).toBe(false);
  });

  it('keeps access through the billing grace period and uses its end as the expiry', () => {
    const cmd = only(
      mapEvent(
        event({
          type: 'BILLING_ISSUE',
          expiration_at_ms: at(-1),
          grace_period_expiration_at_ms: at(5),
        }),
        NOW,
      ),
    );
    expect(cmd).toMatchObject({ p_is_active: true, p_expires_at: new Date(at(5)).toISOString() });
  });

  it('ends access on a billing issue with no grace left, and on EXPIRATION', () => {
    expect(
      only(mapEvent(event({ type: 'BILLING_ISSUE', expiration_at_ms: at(-3) }), NOW)).p_is_active,
    ).toBe(false);
    expect(
      only(mapEvent(event({ type: 'EXPIRATION', expiration_at_ms: at(-1) }), NOW)),
    ).toMatchObject({ p_is_active: false, p_will_renew: false });
  });

  it('treats a missing expiry (lifetime / promotional) as active with no end', () => {
    expect(
      only(mapEvent(event({ type: 'NON_RENEWING_PURCHASE', expiration_at_ms: null }), NOW)),
    ).toMatchObject({ p_is_active: true, p_expires_at: null, p_will_renew: false });
  });

  it('ignores test events, anonymous users, other entitlements and unhandled types', () => {
    expect(mapEvent(event({ type: 'TEST' }), NOW).kind).toBe('ignore');
    expect(mapEvent(event({ app_user_id: '$RCAnonymousID:abc' }), NOW).kind).toBe('ignore');
    expect(mapEvent(event({ app_user_id: null }), NOW).kind).toBe('ignore');
    expect(mapEvent(event({ entitlement_ids: ['other'] }), NOW).kind).toBe('ignore');
    expect(mapEvent(event({ type: 'VIRTUAL_CURRENCY_TRANSACTION' }), NOW).kind).toBe('ignore');
  });

  it('returns transfers for API reconciliation, dropping anonymous ids', () => {
    const mapped = mapEvent(
      event({
        type: 'TRANSFER',
        app_user_id: null,
        transferred_from: ['$RCAnonymousID:abc'],
        transferred_to: ['user_clerk_1'],
      }),
      NOW,
    );
    expect(mapped).toMatchObject({ kind: 'transfer', from: [], to: ['user_clerk_1'] });
  });
});

describe('webhook handler', () => {
  const subscriber: RevenueCatSubscriber = {
    entitlements: {
      pro: {
        expires_date: new Date(at(20)).toISOString(),
        product_identifier: 'o_alarm_pro_yearly',
        purchase_date: new Date(at(-10)).toISOString(),
      },
    },
    subscriptions: { o_alarm_pro_yearly: { store: 'app_store', period_type: 'normal' } },
  };

  function setup(
    overrides: { secret?: string | undefined; apply?: jest.Mock; fetchSubscriber?: jest.Mock } = {},
  ) {
    const apply = overrides.apply ?? jest.fn(async () => 'applied');
    const fetchSubscriber = overrides.fetchSubscriber ?? jest.fn(async () => subscriber);
    const handler = createWebhookHandler({
      secret: 'secret' in overrides ? overrides.secret : SECRET,
      apply,
      fetchSubscriber,
      now: () => NOW,
    });
    const call = (
      body: unknown,
      headers: Record<string, string> = { authorization: SECRET },
      method = 'POST',
    ) =>
      handler(
        new Request('https://x.test/revenuecat-webhook', {
          method,
          headers,
          body:
            method === 'POST'
              ? typeof body === 'string'
                ? body
                : JSON.stringify(body)
              : undefined,
        }),
      );
    return { apply, fetchSubscriber, call };
  }

  it('rejects a missing or wrong Authorization header without touching the database', async () => {
    const { call, apply } = setup();
    expect((await call({ event: event({}) }, {})).status).toBe(401);
    expect((await call({ event: event({}) }, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call({ event: event({}) }, { authorization: 'Bearer s3cre' })).status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it('fails closed when the secret is not configured', async () => {
    const { call, apply } = setup({ secret: undefined });
    expect((await call({ event: event({}) }, { authorization: 'undefined' })).status).toBe(500);
    expect((await call({ event: event({}) }, {})).status).toBe(500);
    expect(apply).not.toHaveBeenCalled();
  });

  it('only accepts POST and well-formed bodies', async () => {
    const { call } = setup();
    expect((await call(null, { authorization: SECRET }, 'GET')).status).toBe(405);
    expect((await call('not json')).status).toBe(400);
    expect((await call({ nope: true })).status).toBe(400);
  });

  it('applies a mapped event once per call and reports the outcome', async () => {
    const { call, apply } = setup();
    const response = await call({ api_version: '1.0', event: event({}) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', outcomes: ['applied'] });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ p_event_id: 'evt-1', p_is_active: true }),
    );
  });

  it('is idempotent: a redelivery passes the same event id and surfaces the database verdict', async () => {
    const apply = jest.fn().mockResolvedValueOnce('applied').mockResolvedValueOnce('duplicate');
    const { call } = setup({ apply });
    await call({ event: event({}) });
    const second = await call({ event: event({}) });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'ok', outcomes: ['duplicate'] });
    expect(apply.mock.calls.map(([cmd]) => cmd.p_event_id)).toEqual(['evt-1', 'evt-1']);
  });

  it('acknowledges ignored events with 200 so RevenueCat stops retrying', async () => {
    const { call, apply } = setup();
    const response = await call({ event: event({ type: 'TEST' }) });
    expect(response.status).toBe(200);
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns 500 (retry) when the database write fails', async () => {
    const { call } = setup({ apply: jest.fn().mockRejectedValue(new Error('db down')) });
    expect((await call({ event: event({}) })).status).toBe(500);
  });

  it('reconciles a transfer from the REST API and deactivates the previous owner', async () => {
    const { call, apply, fetchSubscriber } = setup();
    const response = await call({
      event: event({
        id: 'evt-t',
        type: 'TRANSFER',
        app_user_id: null,
        transferred_from: ['user_old'],
        transferred_to: ['user_new'],
      }),
    });
    expect(response.status).toBe(200);
    expect(fetchSubscriber).toHaveBeenCalledWith('user_new');
    const cmds = apply.mock.calls.map(([cmd]) => cmd as EntitlementCommand);
    expect(cmds).toEqual([
      expect.objectContaining({
        p_app_user_id: 'user_new',
        p_is_active: true,
        p_event_id: 'evt-t:user_new',
        p_product_id: 'o_alarm_pro_yearly',
      }),
      expect.objectContaining({
        p_app_user_id: 'user_old',
        p_is_active: false,
        p_event_id: 'evt-t:user_old',
      }),
    ]);
  });
});
