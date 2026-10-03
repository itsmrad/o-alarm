// RevenueCat webhook logic (D18/D22). Pure TypeScript with no Deno or Node imports so the same
// file runs in the Edge runtime and in Jest (src/lib/purchases/webhook.test.ts).
//
// Docs: https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields

export const PRO_ENTITLEMENT = 'pro';

export interface RevenueCatEvent {
  id: string;
  type: string;
  app_user_id?: string | null;
  original_app_user_id?: string | null;
  product_id?: string | null;
  entitlement_id?: string | null;
  entitlement_ids?: string[] | null;
  period_type?: string | null;
  purchased_at_ms?: number | null;
  expiration_at_ms?: number | null;
  grace_period_expiration_at_ms?: number | null;
  event_timestamp_ms?: number | null;
  store?: string | null;
  environment?: string | null;
  transferred_from?: string[] | null;
  transferred_to?: string[] | null;
}

/** Arguments of public.apply_revenuecat_entitlement(). */
export interface EntitlementCommand {
  p_event_id: string;
  p_event_type: string;
  p_app_user_id: string;
  p_entitlement: string;
  p_is_active: boolean;
  p_product_id: string | null;
  p_store: string | null;
  p_environment: 'production' | 'sandbox';
  p_period_type: 'trial' | 'intro' | 'normal' | null;
  p_will_renew: boolean;
  p_original_purchase_at: string | null;
  p_expires_at: string | null;
  p_event_at: string | null;
}

export type MappedEvent =
  | { kind: 'ignore'; reason: string }
  | { kind: 'apply'; commands: EntitlementCommand[] }
  /** Entitlements moved between users and the event carries no dates: re-read them from the API. */
  | { kind: 'transfer'; from: string[]; to: string[]; event: RevenueCatEvent };

const iso = (ms: number | null | undefined) =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

const STORES: Record<string, string> = {
  APP_STORE: 'app_store',
  MAC_APP_STORE: 'app_store',
  PLAY_STORE: 'play_store',
  STRIPE: 'stripe',
  RC_BILLING: 'stripe',
  PROMOTIONAL: 'promotional',
};

const PERIODS: Record<string, 'trial' | 'intro' | 'normal'> = {
  TRIAL: 'trial',
  INTRO: 'intro',
  NORMAL: 'normal',
};

/** RevenueCat anonymous ids ($RCAnonymousID:…) are not Clerk users: nothing to key on. */
export const isAnonymousId = (id: string) => id.startsWith('$RCAnonymousID:');

const ACTIVATING = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'PRODUCT_CHANGE',
  'TEMPORARY_ENTITLEMENT_GRANT',
  'REFUND_REVERSED',
  'SUBSCRIPTION_EXTENDED',
  'SUBSCRIPTION_PAUSED',
  'CANCELLATION',
  'BILLING_ISSUE',
]);

function hasPro(event: RevenueCatEvent): boolean {
  const ids = event.entitlement_ids ?? (event.entitlement_id ? [event.entitlement_id] : null);
  // Old payloads can omit the ids; this app has a single entitlement, so treat that as `pro`.
  return !ids || ids.length === 0 || ids.includes(PRO_ENTITLEMENT);
}

function command(
  event: RevenueCatEvent,
  userId: string,
  state: { isActive: boolean; willRenew: boolean; expiresMs: number | null },
): EntitlementCommand {
  return {
    p_event_id: event.id,
    p_event_type: event.type,
    p_app_user_id: userId,
    p_entitlement: PRO_ENTITLEMENT,
    p_is_active: state.isActive,
    p_product_id: event.product_id ?? null,
    p_store: (event.store && STORES[event.store]) || null,
    p_environment: event.environment === 'SANDBOX' ? 'sandbox' : 'production',
    p_period_type: (event.period_type && PERIODS[event.period_type]) || null,
    p_will_renew: state.willRenew,
    p_original_purchase_at: iso(event.purchased_at_ms),
    p_expires_at: iso(state.expiresMs),
    p_event_at: iso(event.event_timestamp_ms),
  };
}

/**
 * Maps one webhook event onto `entitlements` rows. Access is decided from the dates RevenueCat
 * reports, never from the event name alone: CANCELLATION only turns off renewal (access lasts to
 * the period end), BILLING_ISSUE keeps access through the store's grace period, and only
 * EXPIRATION (or an already-past expiry) revokes it.
 */
export function mapEvent(event: RevenueCatEvent, now: Date = new Date()): MappedEvent {
  if (event.type === 'TEST') return { kind: 'ignore', reason: 'test event' };

  if (event.type === 'TRANSFER') {
    const real = (ids: string[] | null | undefined) =>
      (ids ?? []).filter((id) => id && !isAnonymousId(id));
    return { kind: 'transfer', from: real(event.transferred_from), to: real(event.transferred_to), event };
  }

  const userId = event.app_user_id;
  if (!userId) return { kind: 'ignore', reason: 'no app_user_id' };
  if (isAnonymousId(userId)) return { kind: 'ignore', reason: 'anonymous user' };
  if (!hasPro(event)) return { kind: 'ignore', reason: 'not the pro entitlement' };

  if (event.type === 'EXPIRATION') {
    return {
      kind: 'apply',
      commands: [
        command(event, userId, {
          isActive: false,
          willRenew: false,
          expiresMs: event.expiration_at_ms ?? now.getTime(),
        }),
      ],
    };
  }
  if (!ACTIVATING.has(event.type)) return { kind: 'ignore', reason: `unhandled ${event.type}` };

  const accessUntil = Math.max(
    event.expiration_at_ms ?? -Infinity,
    event.grace_period_expiration_at_ms ?? -Infinity,
  );
  const expiresMs = Number.isFinite(accessUntil) ? accessUntil : null; // null = lifetime/promo
  const isActive = expiresMs === null || expiresMs > now.getTime();
  const willRenew = !['CANCELLATION', 'SUBSCRIPTION_PAUSED', 'NON_RENEWING_PURCHASE'].includes(
    event.type,
  );
  return { kind: 'apply', commands: [command(event, userId, { isActive, willRenew, expiresMs })] };
}

/** Subscriber as returned by GET /v1/subscribers/{app_user_id}. */
export interface RevenueCatSubscriber {
  entitlements?: Record<
    string,
    {
      expires_date: string | null;
      grace_period_expires_date?: string | null;
      product_identifier: string;
      purchase_date?: string | null;
    }
  >;
  subscriptions?: Record<
    string,
    {
      store?: string | null;
      period_type?: string | null;
      unsubscribe_detected_at?: string | null;
      is_sandbox?: boolean;
    }
  >;
}

/** Builds a command from the REST API view of a user (used after a TRANSFER). */
export function mapSubscriber(
  event: RevenueCatEvent,
  userId: string,
  subscriber: RevenueCatSubscriber,
  now: Date = new Date(),
): EntitlementCommand {
  const pro = subscriber.entitlements?.[PRO_ENTITLEMENT];
  const sub = pro ? subscriber.subscriptions?.[pro.product_identifier] : undefined;
  const expiresMs = pro
    ? Math.max(
        pro.expires_date ? Date.parse(pro.expires_date) : -Infinity,
        pro.grace_period_expires_date ? Date.parse(pro.grace_period_expires_date) : -Infinity,
      )
    : -Infinity;
  const lifetime = !!pro && !pro.expires_date;
  const isActive = !!pro && (lifetime || expiresMs > now.getTime());
  return {
    p_event_id: `${event.id}:${userId}`,
    p_event_type: 'TRANSFER',
    p_app_user_id: userId,
    p_entitlement: PRO_ENTITLEMENT,
    p_is_active: isActive,
    p_product_id: pro?.product_identifier ?? null,
    p_store: (sub?.store && STORES[sub.store.toUpperCase()]) || null,
    p_environment: sub?.is_sandbox ? 'sandbox' : 'production',
    p_period_type: (sub?.period_type && PERIODS[sub.period_type.toUpperCase()]) || null,
    p_will_renew: isActive && !sub?.unsubscribe_detected_at,
    p_original_purchase_at: pro?.purchase_date ?? null,
    p_expires_at: Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null,
    p_event_at: iso(event.event_timestamp_ms),
  };
}

/** Constant-time string comparison (no early exit on the first differing byte). */
export function safeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** RevenueCat sends the configured Authorization header value verbatim. */
export function isAuthorized(secret: string | undefined, header: string | null): boolean {
  return !!secret && !!header && safeEqual(header, secret);
}

export interface WebhookDeps {
  /** REVENUECAT_WEBHOOK_AUTH. Unset => every request is rejected (fail closed). */
  secret: string | undefined;
  /** Calls public.apply_revenuecat_entitlement as the service role. */
  apply: (command: EntitlementCommand) => Promise<string>;
  /** GET /v1/subscribers/{id}; null when RevenueCat has no such user or no secret key is set. */
  fetchSubscriber: (appUserId: string) => Promise<RevenueCatSubscriber | null>;
  now?: () => Date;
  log?: (message: string) => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The `revenuecat-webhook` request handler, with all I/O injected. */
export function createWebhookHandler(deps: WebhookDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? (() => undefined);
  return async (request) => {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (!deps.secret) {
      log('REVENUECAT_WEBHOOK_AUTH is not set');
      return json(500, { error: 'webhook is not configured' });
    }
    if (!isAuthorized(deps.secret, request.headers.get('authorization'))) {
      return json(401, { error: 'unauthorized' });
    }

    let event: RevenueCatEvent;
    try {
      const body = (await request.json()) as { event?: RevenueCatEvent };
      if (!body?.event || typeof body.event.id !== 'string' || typeof body.event.type !== 'string') {
        return json(400, { error: 'missing event' });
      }
      event = body.event;
    } catch {
      return json(400, { error: 'invalid json' });
    }

    try {
      const mapped = mapEvent(event, deps.now?.());
      if (mapped.kind === 'ignore') return json(200, { status: 'ignored', reason: mapped.reason });

      const commands: EntitlementCommand[] = [];
      if (mapped.kind === 'apply') {
        commands.push(...mapped.commands);
      } else {
        // Transfer: the old owner loses the entitlement, the new owner's state comes from the API.
        for (const user of mapped.to) {
          const subscriber = await deps.fetchSubscriber(user);
          if (subscriber) commands.push(mapSubscriber(event, user, subscriber, deps.now?.()));
          else log(`transfer: no subscriber data for ${user}`);
        }
        // The previous owners no longer hold it (a user that is also a new owner keeps API truth).
        for (const user of mapped.from) {
          if (!mapped.to.includes(user)) commands.push(mapSubscriber(event, user, {}, deps.now?.()));
        }
      }

      const outcomes: string[] = [];
      for (const cmd of commands) outcomes.push(await deps.apply(cmd));
      return json(200, { status: 'ok', outcomes });
    } catch (error) {
      // Non-2xx: RevenueCat retries, and apply is idempotent per event id.
      log(`webhook failed: ${error instanceof Error ? error.message : String(error)}`);
      return json(500, { error: 'processing failed' });
    }
  };
}
