import { deviceTimeZone } from '@/db/alarm-service';
import type { AppDatabase } from '@/db/types';
import { civilDate } from '@/domain/sleep';
import { shouldPromptCheckInAt } from '@/domain/sleep-reminders';

import { createSleepService, type SleepService } from './sleep-service';

/** What the sleep feature needs from AppServices: the app's single database + device id. */
export interface SleepDeps {
  db: AppDatabase;
  deviceId: string;
}

/**
 * One SleepService per database, built on the app's single connection (AppServices.db).
 * The feature never opens a database of its own.
 */
const cache = new WeakMap<AppDatabase, SleepService>();
/** The service most recently handed out, for callers outside React (see below). */
let current: SleepService | null = null;

export function sleepServiceFor(deps: SleepDeps): SleepService {
  let service = cache.get(deps.db);
  if (!service) {
    service = createSleepService({ db: deps.db, deviceId: deps.deviceId });
    cache.set(deps.db, service);
  }
  current = service;
  return service;
}

const resolve = (deps?: SleepDeps): SleepService | null => (deps ? sleepServiceFor(deps) : current);

/**
 * INTEGRATION API — call when the user is up: on alarm dismissal (or Wake Check pass).
 * Closes the open sleep session at `at`. Pass `useAppServices()` as `services`; without it
 * the service registered by any mounted sleep hook / `SleepReminderSync` is used.
 * Resolves to null when no session was open, it was unusable, or no service is available.
 * Never throws into the ring path.
 */
export async function endActiveSleepSession(at: Date = new Date(), services?: SleepDeps) {
  try {
    return resolve(services)?.endActiveSleepSession(at) ?? null;
  } catch {
    return null;
  }
}

/**
 * INTEGRATION API — after wake: should the morning check-in (route `/checkin`) be offered?
 * True on a morning (03:00-13:59 local) when no check-in or skip exists for today yet.
 */
export async function shouldPromptCheckIn(
  now: Date = new Date(),
  services?: SleepDeps,
): Promise<boolean> {
  const timeZone = deviceTimeZone();
  try {
    const service = resolve(services);
    if (!service) return false;
    return shouldPromptCheckInAt({
      now,
      timeZone,
      hasEntryToday: service.hasCheckInEntry(civilDate(now, timeZone)),
    });
  } catch {
    return false;
  }
}
