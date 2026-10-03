/**
 * Observability keys (D20/D38). Publishable client keys only (D21); each is optional and a
 * missing key turns that service into a no-op.
 */
export interface ObservabilityConfig {
  sentryDsn: string | null;
  posthogKey: string | null;
  posthogHost: string;
}

export type ObservabilityEnv = Partial<
  Record<'EXPO_PUBLIC_SENTRY_DSN' | 'EXPO_PUBLIC_POSTHOG_KEY' | 'EXPO_PUBLIC_POSTHOG_HOST', string>
>;

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

const value = (raw: string | undefined) => (raw && raw.trim() ? raw.trim() : null);

/** Under Jest nothing reports anywhere, keys or not. */
export const isTestEnvironment = () =>
  process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

export function readObservabilityConfig(
  // Literal `process.env.EXPO_PUBLIC_*` reads so Expo inlines them at build time.
  env: ObservabilityEnv = {
    EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
    EXPO_PUBLIC_POSTHOG_KEY: process.env.EXPO_PUBLIC_POSTHOG_KEY,
    EXPO_PUBLIC_POSTHOG_HOST: process.env.EXPO_PUBLIC_POSTHOG_HOST,
  },
): ObservabilityConfig {
  return {
    sentryDsn: value(env.EXPO_PUBLIC_SENTRY_DSN),
    posthogKey: value(env.EXPO_PUBLIC_POSTHOG_KEY),
    posthogHost: value(env.EXPO_PUBLIC_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST,
  };
}
