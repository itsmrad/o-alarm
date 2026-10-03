import type { InsightsAiRequest } from '@/domain/insights-payload';

import { resolveAiAvailability } from './availability';
import { requestAiExplanation } from './client';

const REQUEST: InsightsAiRequest = {
  schemaVersion: 1,
  kind: 'explain',
  topic: 'wake_pattern',
  period: { start: '2026-10-12', end: '2026-10-18' },
  insights: [],
  bedtime: null,
};
const CONFIG = { url: 'https://proj.supabase.co', publishableKey: 'sb_publishable_x' };
const EXPLANATION = {
  headline: 'Calm week',
  summary: 'Up on time most mornings.',
  suggestions: [],
};

const respond = (status: number, body: unknown) =>
  jest.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
const call = (
  fetchMock: typeof fetch,
  over: Partial<Parameters<typeof requestAiExplanation>[1]> = {},
) =>
  requestAiExplanation(REQUEST, {
    getToken: async () => 'clerk-jwt',
    fetch: fetchMock,
    config: CONFIG,
    ...over,
  });

describe('resolveAiAvailability (client gating)', () => {
  it('free tier never calls the AI, whatever else is true', () => {
    expect(resolveAiAvailability({ configured: true, signedIn: true, isPro: false })).toBe('free');
    expect(resolveAiAvailability({ configured: false, signedIn: false, isPro: false })).toBe(
      'free',
    );
  });
  it('Pro needs a configured build and a signed-in account', () => {
    expect(resolveAiAvailability({ configured: false, signedIn: true, isPro: true })).toBe(
      'not_configured',
    );
    expect(resolveAiAvailability({ configured: true, signedIn: false, isPro: true })).toBe(
      'signed_out',
    );
    expect(resolveAiAvailability({ configured: true, signedIn: true, isPro: true })).toBe('ready');
  });
});

describe('requestAiExplanation', () => {
  it('posts the payload with the Clerk token and returns the validated explanation', async () => {
    const fetchMock = respond(200, {
      status: 'ok',
      explanation: EXPLANATION,
      model: 'm',
      cached: false,
    });
    expect(await call(fetchMock)).toEqual({
      status: 'ok',
      explanation: EXPLANATION,
      model: 'm',
      cached: false,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://proj.supabase.co/functions/v1/ai-insights');
    expect(init!.headers).toMatchObject({
      authorization: 'Bearer clerk-jwt',
      apikey: 'sb_publishable_x',
    });
    expect(JSON.parse(init!.body as string)).toEqual(REQUEST);
  });

  it('does not call anything when not configured or signed out', async () => {
    const fetchMock = respond(200, {});
    expect(await call(fetchMock, { config: null })).toEqual({
      status: 'unavailable',
      reason: 'not_configured',
    });
    expect(await call(fetchMock, { getToken: async () => null })).toEqual({
      status: 'unavailable',
      reason: 'signed_out',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, { error: 'unauthorized' }, 'signed_out'],
    [403, { error: 'pro_required' }, 'pro_required'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [400, { error: 'invalid_request' }, 'error'],
    [503, {}, 'service_unavailable'],
    [200, { status: 'fallback', reason: 'unavailable' }, 'service_unavailable'],
    [200, { status: 'fallback', reason: 'invalid_output' }, 'invalid_output'],
    [200, { status: 'fallback', reason: 'not_configured' }, 'not_configured'],
    [200, { status: 'ok', explanation: { headline: 'x' }, model: 'm', cached: false }, 'error'],
  ])('maps HTTP %i %j to %s', async (status, body, reason) => {
    expect(await call(respond(status, body))).toEqual({ status: 'unavailable', reason });
  });

  it('reports offline when the request cannot be sent', async () => {
    const offline = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    expect(await call(offline)).toEqual({ status: 'unavailable', reason: 'offline' });
  });

  it('gives up after its timeout', async () => {
    const hanging = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    expect(await call(hanging, { timeoutMs: 10 })).toEqual({
      status: 'unavailable',
      reason: 'service_unavailable',
    });
  });
});
