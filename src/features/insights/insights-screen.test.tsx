import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import * as Crypto from 'expo-crypto';

import { deviceTimeZone } from '@/db/alarm-service';
import { openAppDatabase } from '@/db/client';
import { createOccurrencesRepository } from '@/db/repositories/occurrences';
import type { AppDatabase } from '@/db/types';
import { weekBounds } from '@/domain/insights';
import { addDays, formatLocalDate, localDateInZone, resolveWallClock } from '@/domain/time';
import { readCachedReport } from '@/lib/ai';

import { clearAiMemoryForTests } from './use-ai';

// Real SQLite + bundled migrations; a fresh database per test (AppServices boots on it).
let mockDb: unknown;
jest.mock('@/db/client', () => ({
  openAppDatabase: async () => {
    const { createTestDatabase } = jest.requireActual('@/db/testing/test-db');
    mockDb ??= createTestDatabase().db;
    return mockDb;
  },
}));
jest.mock('expo-notifications', () => ({
  __esModule: true,
  SchedulableTriggerInputTypes: { DATE: 'date' },
  AndroidImportance: { DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'undetermined' })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'denied' })),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
}));

// Gating inputs: entitlement, account and cloud config.
let mockPro = false;
const mockOpenPaywall = jest.fn();
jest.mock('@/features/paywall/use-paywall', () => ({
  usePaywall: () => ({ isPro: mockPro, openPaywall: mockOpenPaywall }),
  openPaywall: (...args: unknown[]) => mockOpenPaywall(...args),
}));
let mockAccount = { configured: false, signedIn: false };
jest.mock('@/lib/auth', () => {
  const actual = jest.requireActual('@/lib/auth');
  return {
    ...actual,
    useAccount: () => ({
      ...jest.requireActual('@/lib/auth/account-context').GUEST_ACCOUNT,
      ...mockAccount,
      getToken: async () => (mockAccount.signedIn ? 'clerk-jwt' : null),
    }),
  };
});
let mockCloud = false;
jest.mock('@/lib/supabase', () => ({
  ...jest.requireActual('@/lib/supabase'),
  isSupabaseConfigured: () => mockCloud,
  readSupabaseConfig: () =>
    mockCloud ? { url: 'https://proj.supabase.co', publishableKey: 'sb_publishable_x' } : null,
}));

const fetchMock = jest.fn();
const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

const EXPLANATION = {
  headline: 'A steady week of getting up',
  summary: 'You were up on time on all three alarm mornings last week.',
  suggestions: [{ text: 'You could keep the same alarm routine.', basedOn: 'week' }],
};

/** Three dismissed alarm mornings last week (a complete week, so a report is due). */
async function seedLastWeek(): Promise<AppDatabase> {
  const db = (await openAppDatabase()) as AppDatabase;
  const tz = deviceTimeZone();
  const { start } = weekBounds(addDays(localDateInZone(new Date(), tz), -7));
  const occurrences = createOccurrencesRepository(db, Crypto.randomUUID);
  for (let i = 0; i < 3; i++) {
    const at = resolveWallClock(addDays(start, i), 7, 0, tz);
    const key = `alarm-secret:${formatLocalDate(addDays(start, i))}`;
    const ctx = { now: at, deviceId: 'device' };
    occurrences.upsertScheduled(
      { alarmId: 'alarm-secret', occurrenceKey: key, expectedAt: at.toISOString() },
      ctx,
    );
    occurrences.markDismissed(
      occurrences.get(key)!,
      new Date(at.getTime() + 120_000).toISOString(),
      ctx,
    );
  }
  return db;
}

beforeEach(() => {
  mockDb = undefined;
  mockPro = false;
  mockAccount = { configured: false, signedIn: false };
  mockCloud = false;
  fetchMock.mockReset();
  mockOpenPaywall.mockReset();
  clearAiMemoryForTests();
});

describe('Insights tab gating', () => {
  it('free tier: deterministic insights work offline, plus an upsell; the AI is never called', async () => {
    await seedLastWeek();
    renderRouter('./app', { initialUrl: '/insights' });
    expect(await screen.findByText(/3 alarm mornings, up on time 100% of them/)).toBeTruthy();
    expect(screen.getByText(/association in your own check-ins, not a cause/)).toBeTruthy();
    fireEvent.press(screen.getByText('Get the AI weekly report'));
    expect(mockOpenPaywall).toHaveBeenCalledWith('insights');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Pro in a build without cloud config says so calmly', async () => {
    mockPro = true;
    await seedLastWeek();
    renderRouter('./app', { initialUrl: '/insights' });
    expect(
      (await screen.findAllByText('AI explanations are not available in this build.')).length,
    ).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Pro but signed out asks to sign in', async () => {
    mockPro = true;
    mockCloud = true;
    mockAccount = { configured: true, signedIn: false };
    await seedLastWeek();
    renderRouter('./app', { initialUrl: '/insights' });
    expect((await screen.findAllByText('Sign in for AI explanations')).length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Pro + signed in: fetches the weekly report once, shows it and caches it on the device', async () => {
    mockPro = true;
    mockCloud = true;
    mockAccount = { configured: true, signedIn: true };
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'ok', explanation: EXPLANATION, model: 'm', cached: false }),
      ),
    );
    const db = await seedLastWeek();
    renderRouter('./app', { initialUrl: '/insights' });
    expect(await screen.findByText(EXPLANATION.headline)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://proj.supabase.co/functions/v1/ai-insights');
    const body = init.body as string;
    expect(JSON.parse(body)).toMatchObject({ kind: 'weekly_report', week: { mornings: 3 } });
    expect(body).not.toContain('alarm-secret');
    expect(body).not.toMatch(/T\d{2}:\d{2}/);
    await waitFor(() => expect(readCachedReport(db)?.explanation).toEqual(EXPLANATION));
  });

  it('offline: keeps the deterministic report and offers a retry', async () => {
    mockPro = true;
    mockCloud = true;
    mockAccount = { configured: true, signedIn: true };
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await seedLastWeek();
    renderRouter('./app', { initialUrl: '/insights' });
    expect(await screen.findByText(/You appear to be offline/)).toBeTruthy();
    expect(screen.getByText(/3 alarm mornings, up on time 100% of them/)).toBeTruthy();

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'ok', explanation: EXPLANATION, model: 'm', cached: false }),
      ),
    );
    await act(async () => fireEvent.press(screen.getAllByText('Try again')[0]!));
    expect(await screen.findByText(EXPLANATION.headline)).toBeTruthy();
  });

  it('rate limited: says when explanations renew, without a retry button', async () => {
    mockPro = true;
    mockCloud = true;
    mockAccount = { configured: true, signedIn: true };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );
    await seedLastWeek();
    renderRouter('./app', { initialUrl: '/insights' });
    expect(await screen.findByText(/used this week’s AI explanations/)).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
  });
});
