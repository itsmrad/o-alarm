import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import { deviceTimeZone } from '@/db/alarm-service';
import { openAppDatabase } from '@/db/client';
import { getOrCreateDeviceId } from '@/db/repositories/device';
import { civilDate } from '@/domain/sleep';
import { shouldPromptCheckInAt } from '@/domain/sleep-reminders';

import { createSleepService, type SleepService } from './sleep-service';

/**
 * The app-wide SleepService. Opens its own connection to the same on-device database
 * (WAL mode; sleep writes are rare and tiny), so this feature needs no change to the
 * shared app services. Lazy: nothing opens until the first sleep call.
 */
let instance: Promise<SleepService> | null = null;

export function getSleepService(): Promise<SleepService> {
  if (!instance) {
    const pending = (async () => {
      const db = await openAppDatabase();
      // Best effort: wait for a concurrent alarm write instead of failing with SQLITE_BUSY.
      try {
        (db as unknown as { $client?: { execSync?: (sql: string) => void } }).$client?.execSync?.(
          'PRAGMA busy_timeout = 3000;',
        );
      } catch {
        // Not fatal: the default behavior still works.
      }
      const deviceId = getOrCreateDeviceId(db, Crypto.randomUUID, Platform.OS, new Date());
      return createSleepService({ db, deviceId });
    })();
    pending.catch(() => {
      instance = null; // allow a retry after a failed open
    });
    instance = pending;
  }
  return instance;
}

/**
 * INTEGRATION API — call when the user is up: on alarm dismissal (or Wake Check pass).
 * Closes the open sleep session at `at`. Resolves to null when no session was open or it
 * was unusable. Never throws into the ring path: failures resolve to null.
 */
export async function endActiveSleepSession(at: Date = new Date()) {
  try {
    return (await getSleepService()).endActiveSleepSession(at);
  } catch {
    return null;
  }
}

/**
 * INTEGRATION API — after wake: should the morning check-in (route `/checkin`) be offered?
 * True on a morning (03:00-13:59 local) when no check-in or skip exists for today yet.
 */
export async function shouldPromptCheckIn(now: Date = new Date()): Promise<boolean> {
  const timeZone = deviceTimeZone();
  try {
    const service = await getSleepService();
    return shouldPromptCheckInAt({
      now,
      timeZone,
      hasEntryToday: service.hasCheckInEntry(civilDate(now, timeZone)),
    });
  } catch {
    return false;
  }
}
