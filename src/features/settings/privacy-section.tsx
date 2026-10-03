import { useState } from 'react';

import { ListRow } from '@/components/list-row';
import { NativeSwitch } from '@/components/native-switch';
import { Section } from '@/components/section';
import { useAppServices } from '@/lib/app-services';
import { setAnalyticsOptOut } from '@/lib/observability';
import { PREFERENCE_KEYS, readPreference, writePreference } from '@/lib/sync';

/**
 * Analytics opt-out (stored locally in `preferences`; read at start and applied live, D20).
 * Raw sleep/wake history never goes to analytics regardless of this switch.
 */
export function PrivacySection() {
  const { db, deviceId } = useAppServices();
  const [optOut, setOptOut] = useState(
    () => readPreference<boolean>(db, PREFERENCE_KEYS.analyticsOptOut) === true,
  );

  const onChange = (share: boolean) => {
    setOptOut(!share);
    writePreference(db, PREFERENCE_KEYS.analyticsOptOut, !share, { now: new Date(), deviceId });
    // Live: opting out stops all capture immediately.
    setAnalyticsOptOut(!share);
  };

  return (
    <Section
      title="Privacy"
      footer="Anonymous app usage only. Your sleep and wake history is never shared with analytics, and never sold."
    >
      <ListRow
        title="Share usage analytics"
        accessory={
          <NativeSwitch value={!optOut} onValueChange={onChange} label="Share usage analytics" />
        }
      />
    </Section>
  );
}
