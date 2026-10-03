/**
 * Observability (D20/D38): Sentry for reliability problems, PostHog for coarse product
 * analytics. Both are no-ops without keys, honor the analytics opt-out and never sit on
 * the ring path. Raw sleep data never goes to analytics (D12).
 */
export { initSentry, captureIssue, captureError, type ReliabilityIssue } from './sentry';
export { setAnalyticsOptOut, track, trackPaywall } from './analytics';
export type { PaywallEventName, PaywallEventProps, ProductEvent } from './event-map';
export { AppErrorBoundary } from './error-boundary';
export { ObservabilityRoot } from './observability-root';
