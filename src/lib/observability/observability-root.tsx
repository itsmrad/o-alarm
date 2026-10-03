import { useEffect, useRef } from 'react';

import { useAppServices } from '@/lib/app-services';
import { getEntitlementSnapshot } from '@/lib/entitlements';
import { PREFERENCE_KEYS, readPreference, useSync } from '@/lib/sync';

import { initAnalytics } from './analytics';
import { createObservabilityBridge } from './bridge';
import { captureIssue } from './sentry';

/**
 * Mount once under AppServicesProvider + AccountProviders. Starts analytics with the
 * stored opt-out, tails the event log (bridge) and reports sync failures. Renders nothing.
 */
export function ObservabilityRoot(): null {
  const { db, deviceId, alarms, ring } = useAppServices();
  const { status } = useSync();
  const reportedFailures = useRef(0);

  useEffect(() => {
    const tier = () => getEntitlementSnapshot().tier;
    try {
      initAnalytics({
        optOut: readPreference<boolean>(db, PREFERENCE_KEYS.analyticsOptOut) === true,
        tier,
      });
    } catch {
      // Analytics down = zero effect.
    }
    const bridge = createObservabilityBridge({ db, deviceId, alarms, ring, tier });
    bridge.start();
    return bridge.stop;
  }, [db, deviceId, alarms, ring]);

  // Sync failures: the error kind and count only (messages can name rows).
  const failures = status?.failures ?? 0;
  const kind = status?.lastErrorKind ?? null;
  useEffect(() => {
    if (failures === 0) {
      reportedFailures.current = 0;
      return;
    }
    if (failures <= reportedFailures.current || !kind) return;
    reportedFailures.current = failures;
    captureIssue('sync_failed', { kind, failures });
  }, [failures, kind]);

  return null;
}
