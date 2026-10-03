import { isTestEnvironment, readObservabilityConfig, type ObservabilityConfig } from './config';
import {
  paywallEvent,
  sanitize,
  type PaywallEventName,
  type PaywallEventProps,
  type ProductEvent,
  type Tier,
} from './event-map';

/** The slice of the PostHog client we use (injectable for tests). */
export interface AnalyticsClient {
  capture(event: string, properties?: Record<string, string | number | boolean>): void;
  optIn(): unknown;
  optOut(): unknown;
}

let client: AnalyticsClient | null = null;
let optedOut = false;
let currentTier: () => Tier = () => 'free';

const quietly = (fn: () => unknown) => {
  try {
    const result = fn();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // Analytics down = zero effect.
  }
};

/**
 * PostHog when a key is configured (D20/D38): anonymous (no person profiles, no GeoIP),
 * no autocapture, no lifecycle events, no session replay. No key, Jest, or init error → no-op.
 */
export function initAnalytics(options: {
  optOut: boolean;
  tier?: () => Tier;
  config?: ObservabilityConfig;
  create?: (key: string, host: string, optOut: boolean) => AnalyticsClient;
}): boolean {
  optedOut = options.optOut;
  if (options.tier) currentTier = options.tier;
  const config = options.config ?? readObservabilityConfig();
  if (client || !config.posthogKey || (isTestEnvironment() && !options.create)) return false;
  try {
    client =
      options.create?.(config.posthogKey, config.posthogHost, options.optOut) ??
      createPostHog(config.posthogKey, config.posthogHost, options.optOut);
    return true;
  } catch {
    client = null;
    return false;
  }
}

function createPostHog(key: string, host: string, optOut: boolean): AnalyticsClient {
  // Loaded only when a key is configured, so keyless builds and tests never touch it.
  const { default: PostHog } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('posthog-react-native') as typeof import('posthog-react-native');
  return new PostHog(key, {
    host,
    defaultOptIn: !optOut,
    personProfiles: 'never',
    disableGeoip: true,
    captureAppLifecycleEvents: false,
    preloadFeatureFlags: false,
  });
}

/** Live opt-out (Settings → Privacy). Opted out = nothing is captured at all. */
export function setAnalyticsOptOut(optOut: boolean): void {
  optedOut = optOut;
  const active = client;
  if (active) quietly(() => (optOut ? active.optOut() : active.optIn()));
}

export const isAnalyticsOptedOut = () => optedOut;

/** Sends one already-sanitized product event. Fire-and-forget; never throws. */
export function track(event: ProductEvent | null): void {
  const active = client;
  if (!event || !active || optedOut) return;
  quietly(() => active.capture(event.name, event.properties));
}

/**
 * Public helper for the paywall / purchases flow: coarse events only (no prices, product
 * ids, receipts or error messages).
 */
export function trackPaywall(name: PaywallEventName, props: PaywallEventProps = {}): void {
  track(paywallEvent(name, { ...props, tier: currentTier() }));
}

/** The Insights tab was opened. Carries no properties. */
export function trackInsightsViewed(): void {
  track(sanitize('insights_viewed', {}));
}

/** Test-only. */
export function resetAnalyticsForTests(): void {
  client = null;
  optedOut = false;
  currentTier = () => 'free';
}
