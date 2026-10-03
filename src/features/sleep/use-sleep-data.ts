import { useEffect, useMemo, useState } from 'react';

import type { SleepPrefs } from '@/domain/sleep';
import type { ReminderPrefs } from '@/domain/sleep-reminders';

import { useAppServices } from '@/lib/app-services';

import { sleepServiceFor } from './sleep-runtime';
import type { MorningCheckIn, SleepService, SleepSession } from './sleep-service';

/** History window loaded for the screen (stats use the most recent 14 nights of it). */
const HISTORY_DAYS = 45;

export interface SleepData {
  service: SleepService;
  prefs: SleepPrefs;
  reminderPrefs: ReminderPrefs;
  /** The open session ("sleeping now"), if any. */
  active: SleepSession | null;
  /** Newest first, includes the open one. */
  sessions: SleepSession[];
  checkIns: MorningCheckIn[];
}

export function useSleepService(): SleepService {
  const { db, deviceId } = useAppServices();
  return useMemo(() => sleepServiceFor({ db, deviceId }), [db, deviceId]);
}

/** Live sleep data; re-reads after every write through the sleep service. */
export function useSleepData(): SleepData {
  const service = useSleepService();
  const [version, setVersion] = useState(0);
  useEffect(() => service.subscribe(() => setVersion((v) => v + 1)), [service]);
  return useMemo(
    () => readSleepData(service),
    // `version` is the invalidation signal for the service reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, version],
  );
}

function readSleepData(service: SleepService): SleepData {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);
  return {
    service,
    prefs: service.getSleepPrefs(),
    reminderPrefs: service.getReminderPrefs(),
    active: service.getActiveSession(),
    sessions: service.listSessions({ since, limit: 200 }),
    checkIns: service.listCheckIns(HISTORY_DAYS),
  };
}
