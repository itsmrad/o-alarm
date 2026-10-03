import { createAlarmService } from '@/db/alarm-service';
import { createEventsRepository } from '@/db/repositories/events';
import { createTestDatabase } from '@/db/testing/test-db';
import { EVENT_TYPES, createAlarm, type AppEvent, type EventType } from '@/domain';
import { FakeAlarmEngine } from '@/engine/testing/fake-engine';
import type { RingLifecycle } from '@/services/ring-lifecycle';

import {
  initAnalytics,
  resetAnalyticsForTests,
  setAnalyticsOptOut,
  track,
  trackInsightsViewed,
  trackPaywall,
  type AnalyticsClient,
} from './analytics';
import { createObservabilityBridge } from './bridge';
import { DEFAULT_POSTHOG_HOST, readObservabilityConfig } from './config';
import {
  ALLOWED_PROPERTIES,
  paywallEvent,
  sanitize,
  toProductEvent,
  type ProductEvent,
} from './event-map';
import {
  captureIssue,
  initSentry,
  resetSentryForTests,
  scrubBreadcrumb,
  scrubEvent,
} from './sentry';

const KEYS = { sentryDsn: 'https://k@o.ingest.sentry.io/1', posthogKey: 'phc_x', posthogHost: 'h' };
const NO_KEYS = readObservabilityConfig({});

function fakeAnalytics() {
  const captured: { name: string; properties?: Record<string, unknown> }[] = [];
  const client: AnalyticsClient & { optIn: jest.Mock; optOut: jest.Mock } = {
    capture: (name, properties) => captured.push({ name, properties }),
    optIn: jest.fn(),
    optOut: jest.fn(),
  };
  return { client, captured };
}

function fakeSentry() {
  const sentry = { init: jest.fn(), captureMessage: jest.fn(), captureException: jest.fn() };
  return sentry;
}

afterEach(() => {
  resetAnalyticsForTests();
  resetSentryForTests();
});

describe('no keys → no-op', () => {
  it('reads no keys and the default host', () => {
    expect(NO_KEYS).toEqual({
      sentryDsn: null,
      posthogKey: null,
      posthogHost: DEFAULT_POSTHOG_HOST,
    });
    expect(readObservabilityConfig({ EXPO_PUBLIC_SENTRY_DSN: '  ' }).sentryDsn).toBeNull();
  });

  it('never initializes and every call is a silent no-op', () => {
    const sentry = fakeSentry();
    expect(initSentry(NO_KEYS, () => sentry as never, true)).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
    const { client, captured } = fakeAnalytics();
    expect(initAnalytics({ optOut: false, config: NO_KEYS, create: () => client })).toBe(false);
    expect(() => {
      track({ name: 'alarm_created', properties: {} });
      trackPaywall('paywall_viewed');
      captureIssue('sync_failed', { kind: 'network' });
      setAnalyticsOptOut(true);
    }).not.toThrow();
    expect(captured).toEqual([]);
  });

  it('stays off under Jest even with keys, unless a test injects a client', () => {
    expect(initSentry(KEYS)).toBe(false);
    expect(initAnalytics({ optOut: false, config: KEYS })).toBe(false);
  });

  it('a throwing client never surfaces an error', () => {
    const sentry = fakeSentry();
    sentry.captureMessage.mockImplementation(() => {
      throw new Error('down');
    });
    initSentry(KEYS, () => sentry as never, true);
    expect(() => captureIssue('engine_error')).not.toThrow();
    initAnalytics({
      optOut: false,
      config: KEYS,
      create: () => ({
        capture: () => {
          throw new Error('down');
        },
        optIn: () => Promise.reject(new Error('down')),
        optOut: () => undefined,
      }),
    });
    expect(() => track({ name: 'alarm_snoozed', properties: {} })).not.toThrow();
    expect(() => setAnalyticsOptOut(false)).not.toThrow();
  });
});

describe('Sentry', () => {
  it('initializes privacy-first with scrubbing hooks', () => {
    const sentry = fakeSentry();
    expect(initSentry(KEYS, () => sentry as never, true)).toBe(true);
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: KEYS.sentryDsn,
        sendDefaultPii: false,
        beforeBreadcrumb: scrubBreadcrumb,
        beforeSend: scrubEvent,
      }),
    );
    captureIssue('alarm_schedule_failed', { code: 'PERMISSION_DENIED' });
    expect(sentry.captureMessage).toHaveBeenCalledWith('alarm_schedule_failed', {
      level: 'warning',
      tags: { code: 'PERMISSION_DENIED' },
    });
  });

  it('scrubs breadcrumbs and events of content', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'label Gym' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'ui.click', message: 'Slept 6h' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'touch', message: 'Work' })).toBeNull();
    expect(
      scrubBreadcrumb({
        category: 'navigation',
        data: { from: '/alarm/a1?x=Gym', to: '/ringing?scheduleId=s', extra: 'Gym' },
      }),
    ).toEqual({ category: 'navigation', data: { from: '/alarm/a1', to: '/ringing' } });
    expect(
      scrubBreadcrumb({ category: 'custom', message: 'bedtime 23:10', data: { hours: 7.5 } }),
    ).toEqual({ category: 'custom' });

    const event = scrubEvent({
      type: undefined,
      user: { id: 'u', email: 'a@b.c' },
      request: { url: 'x' },
      extra: { label: 'Gym' },
      breadcrumbs: [{ category: 'console', message: 'Gym' }, { category: 'app.start' }],
    } as never) as Record<string, unknown>;
    expect(event.user).toBeUndefined();
    expect(event.request).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.breadcrumbs).toEqual([{ category: 'app.start' }]);
  });
});

describe('PostHog opt-out', () => {
  it('opted out = nothing captured; opting in/out is applied live', () => {
    const { client, captured } = fakeAnalytics();
    const event: ProductEvent = { name: 'wake_check_passed', properties: { attempt: 1 } };
    expect(initAnalytics({ optOut: true, config: KEYS, create: () => client })).toBe(true);
    track(event);
    trackPaywall('paywall_viewed', { source: 'settings' });
    expect(captured).toEqual([]);

    setAnalyticsOptOut(false);
    expect(client.optIn).toHaveBeenCalled();
    track(event);
    expect(captured).toEqual([{ name: 'wake_check_passed', properties: { attempt: 1 } }]);

    setAnalyticsOptOut(true);
    expect(client.optOut).toHaveBeenCalled();
    track(event);
    expect(captured).toHaveLength(1);
  });

  it('insights_viewed carries no properties, whatever is passed', () => {
    const { client, captured } = fakeAnalytics();
    initAnalytics({ optOut: false, config: KEYS, create: () => client });
    trackInsightsViewed();
    track(sanitize('insights_viewed', { tier: 'pro', sleepMin: 420, label: 'Gym' }));
    expect(ALLOWED_PROPERTIES.insights_viewed).toEqual([]);
    expect(captured).toEqual([
      { name: 'insights_viewed', properties: {} },
      { name: 'insights_viewed', properties: {} },
    ]);
  });

  it('passes the stored opt-out to the client it creates', () => {
    const create = jest.fn(() => fakeAnalytics().client);
    initAnalytics({ optOut: true, config: KEYS, create });
    expect(create).toHaveBeenCalledWith('phc_x', 'h', true);
  });
});

/** Deterministic PRNG for the property test. */
function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const SECRET = 'SECRET';
const FORBIDDEN_KEYS = [
  'label',
  'hour',
  'minute',
  'date',
  'fireAt',
  'checkAt',
  'scheduledFor',
  'receivedAt',
  'nextFireAt',
  'bedtime',
  'duration',
  'durationMs',
  'sleep',
  'energy',
  'sleepQuality',
  'message',
];
const PAYLOAD_KEYS = [
  'hour',
  'minute',
  'weekdays',
  'oneTime',
  'changed',
  'engine',
  'scheduleId',
  'fireAt',
  'code',
  'message',
  'scheduledFor',
  'receivedAt',
  'snoozesUsed',
  'nextFireAt',
  'method',
  'missionId',
  'stepIndex',
  'durationMs',
  'reason',
  'attempt',
  'checkAt',
  'label',
  'bedtime',
  'sleepMinutes',
  'energy',
];

function randomValue(random: () => number): unknown {
  const pick = Math.floor(random() * 7);
  switch (pick) {
    case 0:
      return `${SECRET}-${Math.floor(random() * 1e6)}`;
    case 1:
      return Math.floor(random() * 1e5) / 7;
    case 2:
      return random() > 0.5;
    case 3:
      return [`${SECRET}-a`, 'label', 3];
    case 4:
      return { nested: SECRET };
    case 5:
      return null;
    default:
      return ['hour', 'label', `${SECRET}-field`];
  }
}

describe('event mapper (property test)', () => {
  it('only ever emits allow-listed, primitive, content-free properties', () => {
    const random = prng(42);
    const alarm = createAlarm({
      id: 'a1',
      hour: 6,
      minute: 45,
      weekdays: [1, 2],
      label: `${SECRET} label`,
      missions: [{ missionId: `${SECRET}-mission`, config: { note: SECRET } }],
      wakeCheck: {
        enabled: true,
        delayMin: 5,
        responseWindowSec: 60,
        method: 'mission',
        missionId: SECRET,
        maxRetriggers: 3,
      },
    });
    let mapped = 0;
    for (let i = 0; i < 300; i++) {
      for (const type of EVENT_TYPES) {
        const payload = Object.fromEntries(PAYLOAD_KEYS.map((k) => [k, randomValue(random)]));
        const event = {
          id: SECRET,
          type,
          occurredAt: SECRET,
          alarmId: SECRET,
          occurrenceKey: SECRET,
          payload,
        } as unknown as AppEvent;
        const result = toProductEvent(event, {
          tier: random() > 0.5 ? 'pro' : 'free',
          alarm: random() > 0.3 ? alarm : null,
        });
        if (!result) continue;
        mapped += 1;
        const allowed = ALLOWED_PROPERTIES[result.name];
        for (const [key, value] of Object.entries(result.properties)) {
          expect(allowed).toContain(key);
          expect(FORBIDDEN_KEYS).not.toContain(key);
          expect(['string', 'number', 'boolean']).toContain(typeof value);
          expect(String(value)).not.toContain(SECRET);
        }
      }
    }
    expect(mapped).toBeGreaterThan(0);
  });

  it('maps exactly the product events and drops everything else', () => {
    const productTypes: EventType[] = [
      'alarm_created',
      'alarm_updated',
      'mission_started',
      'mission_completed',
      'mission_failed',
      'wake_check_passed',
      'wake_check_failed',
      'alarm_snoozed',
    ];
    for (const type of EVENT_TYPES) {
      const event = {
        id: 'e',
        type,
        occurredAt: '',
        alarmId: null,
        occurrenceKey: null,
        payload: {},
      };
      const result = toProductEvent(event as unknown as AppEvent, { tier: 'free', alarm: null });
      expect(result === null).toBe(!productTypes.includes(type));
    }
  });

  it('buckets snooze counts and keeps paywall events coarse', () => {
    const snoozed = (snoozesUsed: number) =>
      toProductEvent(
        {
          id: 'e',
          type: 'alarm_snoozed',
          occurredAt: '',
          alarmId: null,
          occurrenceKey: null,
          payload: { snoozesUsed, nextFireAt: '2026-10-05T07:09:00Z' },
        },
        { tier: 'free', alarm: null },
      )?.properties;
    expect(snoozed(1)).toEqual({ tier: 'free', snooze_count: '1' });
    expect(snoozed(9)).toEqual({ tier: 'free', snooze_count: '4+' });
    expect(
      paywallEvent('purchase_completed', {
        tier: 'pro',
        plan: 'annual',
        source: `${SECRET}` as never,
      }).properties,
    ).toEqual({ tier: 'pro', plan: 'annual', source: 'other' });
  });
});

describe('observability bridge', () => {
  const NOW = new Date('2026-10-02T09:00:00Z');

  function setup() {
    const { db, close } = createTestDatabase();
    const engine = new FakeAlarmEngine();
    const alarms = createAlarmService({
      db,
      engine,
      deviceId: 'd1',
      clock: () => NOW,
      timeZone: () => 'America/New_York',
    });
    let reconcile: unknown = null;
    const ring = {
      subscribe: () => () => undefined,
      getLastReconcile: () => reconcile,
      getLastSync: () => null,
    } as unknown as RingLifecycle;
    const bridge = createObservabilityBridge({
      db,
      deviceId: 'd1',
      alarms,
      ring,
      tier: () => 'free',
      clock: () => NOW,
    });
    const { client, captured } = fakeAnalytics();
    initAnalytics({ optOut: false, config: KEYS, create: () => client });
    const sentry = fakeSentry();
    initSentry(KEYS, () => sentry as never, true);
    const events = createEventsRepository(db, () => `e-${Math.random()}`);
    return {
      db,
      engine,
      alarms,
      bridge,
      captured,
      sentry,
      events,
      close,
      setReconcile: (value: unknown) => (reconcile = value),
    };
  }

  const draft = () => {
    const { id: _id, ...rest } = createAlarm({
      id: 'x',
      hour: 7,
      minute: 0,
      weekdays: [1, 2, 3, 4, 5],
      label: 'Gym',
    });
    return rest;
  };

  it('starts at the end of the log, then forwards new local events once', async () => {
    const t = setup();
    await t.alarms.save(draft()); // history before observability: not replayed
    expect(t.bridge.flush()).toBe(0);
    expect(t.captured).toEqual([]);

    const { alarm } = await t.alarms.save(draft());
    t.bridge.flush();
    t.bridge.flush(); // idempotent: the cursor moved
    expect(t.captured.map((c) => c.name)).toEqual(['alarm_created']);
    expect(t.captured[0]!.properties).toMatchObject({
      tier: 'free',
      recurring: true,
      repeat_days: 5,
    });
    expect(JSON.stringify(t.captured)).not.toContain('Gym');
    expect(alarm.label).toBe('Gym');
    t.close();
  });

  it('routes schedule failures to Sentry with codes only, ignores other devices, honors opt-out', async () => {
    const t = setup();
    t.bridge.flush();
    t.engine.failSchedule = 'PERMISSION_DENIED';
    await t.alarms.save(draft());
    t.events.append(
      { type: 'wake_check_passed', alarmId: null, payload: { attempt: 1 } },
      { now: NOW, deviceId: 'other-device' },
    );
    t.bridge.flush();
    expect(t.sentry.captureMessage).toHaveBeenCalledWith('alarm_schedule_failed', {
      level: 'warning',
      tags: { code: 'PERMISSION_DENIED', engine: 'native' },
    });
    expect(t.captured.map((c) => c.name)).toEqual(['alarm_created']);

    setAnalyticsOptOut(true);
    t.events.append(
      { type: 'wake_check_passed', alarmId: null, payload: { attempt: 1 } },
      { now: NOW, deviceId: 'd1' },
    );
    t.bridge.flush();
    setAnalyticsOptOut(false);
    t.bridge.flush(); // no backfill of what happened while opted out
    expect(t.captured.map((c) => c.name)).toEqual(['alarm_created']);
    t.close();
  });

  it('reports a reconcile mismatch once, with counts and codes', () => {
    const t = setup();
    t.setReconcile({
      at: 'r1',
      result: {
        verified: false,
        mismatches: ['a@1'],
        failures: [{ error: { code: 'SCHEDULE_FAILED' } }],
      },
    });
    t.bridge.flush();
    t.bridge.flush();
    expect(t.sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(t.sentry.captureMessage).toHaveBeenCalledWith('reconcile_mismatch', {
      level: 'warning',
      tags: { mismatches: 1, failures: 1, codes: 'SCHEDULE_FAILED' },
    });
    t.close();
  });

  it('start/stop schedule and cancel a deferred flush (no leaked timers)', () => {
    jest.useFakeTimers();
    const t = setup();
    const flush = jest.spyOn(t.bridge, 'flush');
    t.bridge.start();
    t.bridge.stop();
    jest.runAllTimers();
    expect(flush).not.toHaveBeenCalled();
    jest.useRealTimers();
    t.close();
  });
});
