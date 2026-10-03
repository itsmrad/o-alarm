import type * as SentryNS from '@sentry/react-native';
import Constants from 'expo-constants';

import { isTestEnvironment, readObservabilityConfig, type ObservabilityConfig } from './config';

type SentryModule = Pick<typeof SentryNS, 'init' | 'captureMessage' | 'captureException'>;
type Breadcrumb = SentryNS.Breadcrumb;
type ErrorEvent = Parameters<NonNullable<SentryNS.ReactNativeOptions['beforeSend']>>[0];

let sentry: SentryModule | null = null;

/** Reliability problems worth an alert. Tags are codes and counts only, never content. */
export type ReliabilityIssue =
  'alarm_schedule_failed' | 'reconcile_mismatch' | 'engine_error' | 'sync_failed';

export type IssueTags = Record<string, string | number | boolean>;

const stripQuery = (url: unknown) => (typeof url === 'string' ? url.split('?')[0] : undefined);

/**
 * Breadcrumbs carry no content: console output, UI text and touch targets (which can hold
 * alarm labels or sleep numbers) are dropped; navigation/http keep only paths.
 */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  const category = breadcrumb.category ?? '';
  if (category === 'console' || category.startsWith('ui.') || category === 'touch') return null;
  const base: Breadcrumb = {
    type: breadcrumb.type,
    category: breadcrumb.category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
  };
  if (category === 'navigation') {
    return {
      ...base,
      data: { from: stripQuery(breadcrumb.data?.from), to: stripQuery(breadcrumb.data?.to) },
    };
  }
  if (category === 'http' || category === 'fetch' || category === 'xhr') {
    return {
      ...base,
      data: {
        method: breadcrumb.data?.method,
        status_code: breadcrumb.data?.status_code,
        url: stripQuery(breadcrumb.data?.url),
      },
    };
  }
  return base;
}

/** No user, request or free-form extras leave the device (sendDefaultPii is off too). */
export function scrubEvent<T extends ErrorEvent>(event: T): T {
  delete event.user;
  delete event.request;
  delete event.extra;
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((b): b is Breadcrumb => b !== null);
  }
  return event;
}

function releaseInfo() {
  const config = Constants.expoConfig;
  const version = config?.version ?? '0.0.0';
  const build = config?.ios?.buildNumber ?? config?.android?.versionCode;
  return {
    release: `${config?.slug ?? 'o-alarm'}@${version}`,
    dist: build === undefined ? undefined : String(build),
  };
}

/**
 * Initializes Sentry when a DSN is configured (D20/D38). No DSN, Jest, or any init error →
 * stays a no-op. `load` is injectable for tests.
 */
export function initSentry(
  config: ObservabilityConfig = readObservabilityConfig(),
  // Loaded only when a DSN is configured, so keyless builds and tests never touch it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load: () => typeof SentryNS = () => require('@sentry/react-native'),
  allowInTests = false,
): boolean {
  if (sentry || !config.sentryDsn || (isTestEnvironment() && !allowInTests)) return false;
  try {
    const module = load();
    module.init({
      dsn: config.sentryDsn,
      ...releaseInfo(),
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      tracesSampleRate: 0,
      beforeBreadcrumb: scrubBreadcrumb,
      beforeSend: scrubEvent,
    });
    sentry = module;
    return true;
  } catch {
    return false;
  }
}

/** Fire-and-forget; never throws, never blocks. */
export function captureIssue(issue: ReliabilityIssue, tags: IssueTags = {}): void {
  if (!sentry) return;
  try {
    sentry.captureMessage(issue, { level: 'warning', tags });
  } catch {
    // Reporting must never affect the app.
  }
}

export function captureError(error: unknown, tags: IssueTags = {}): void {
  if (!sentry) return;
  try {
    sentry.captureException(error, { tags });
  } catch {
    // Reporting must never affect the app.
  }
}

export const isSentryActive = () => sentry !== null;

/** Test-only. */
export function resetSentryForTests(): void {
  sentry = null;
}
