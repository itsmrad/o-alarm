import { ne } from 'drizzle-orm';

import type { AlarmService } from '@/db/alarm-service';
import {
  alarmOccurrences,
  alarms,
  events,
  missionAttempts,
  morningCheckins,
  outbox,
  preferences,
  sleepSessions,
  syncState,
  wakeChecks,
  wakeSessions,
} from '@/db/schema';
import type { AppDatabase } from '@/db/types';

import { PREFERENCE_KEYS } from './local-store';

/**
 * "Erase data on this device" (privacy). Alarms are removed through the alarm service first,
 * so every OS schedule is cancelled by the normal path; then all local history, sync state and
 * preferences are dropped. The entitlement cache is kept (it is purchase state, not user data,
 * and RevenueCat restores it anyway).
 */
export async function wipeLocalData(deps: { db: AppDatabase; alarms: AlarmService }) {
  for (const alarm of deps.alarms.list()) await deps.alarms.remove(alarm.id);
  deps.db.transaction((tx) => {
    for (const table of [
      events,
      missionAttempts,
      wakeChecks,
      wakeSessions,
      alarmOccurrences,
      sleepSessions,
      morningCheckins,
      alarms,
      outbox,
      syncState,
    ]) {
      tx.delete(table).run();
    }
    tx.delete(preferences).where(ne(preferences.key, PREFERENCE_KEYS.entitlement)).run();
  });
}
