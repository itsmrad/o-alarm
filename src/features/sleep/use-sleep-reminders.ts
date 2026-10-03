import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { deviceTimeZone, type AlarmService } from '@/db/alarm-service';
import { PLAN_NIGHTS, planReminders } from '@/domain/sleep-reminders';
import { upcomingWakeTargets } from '@/domain/sleep';
import { recentBedtimes } from '@/domain/sleep-stats';
import { useAppServices } from '@/lib/app-services';
import {
  getReminderPermission,
  requestReminderPermission,
  syncReminders,
  type ReminderPermission,
  type ReminderSyncResult,
} from '@/lib/reminders';

import { getSleepService } from './sleep-runtime';

/**
 * Recomputes tonight's reminder plan from the next alarm + sleep settings and makes the
 * OS match it. Idempotent; safe to call as often as anything changes.
 */
export async function refreshSleepReminders(
  alarms: AlarmService,
  now: Date = new Date(),
): Promise<ReminderSyncResult> {
  const sleep = await getSleepService();
  const timeZone = deviceTimeZone();
  const plan = planReminders({
    now,
    timeZone,
    prefs: sleep.getSleepPrefs(),
    reminderPrefs: sleep.getReminderPrefs(),
    targets: upcomingWakeTargets(alarms.list(), now, timeZone, PLAN_NIGHTS + 1),
    recentBedtimes: recentBedtimes(sleep.listSessions({ limit: 30 })),
  });
  return syncReminders(plan);
}

/**
 * INTEGRATION API — mount once under AppServicesProvider (e.g. in the tabs layout) so
 * reminders are rescheduled on start, on foreground, and whenever alarms or sleep
 * settings change. Also used by the Bedtime screen; concurrent runs are serialized.
 */
export function useSleepReminderSync(): void {
  const { alarms } = useAppServices();
  useEffect(() => {
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    const run = () => {
      if (!cancelled) refreshSleepReminders(alarms).catch(() => undefined);
    };
    run();
    cleanups.push(alarms.subscribe(run));
    getSleepService().then(
      (sleep) => {
        if (cancelled) return;
        cleanups.push(sleep.subscribe(run));
      },
      () => undefined,
    );
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') run();
    });
    cleanups.push(() => appState.remove());
    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [alarms]);
}

/** Renders nothing; mounts `useSleepReminderSync`. */
export function SleepReminderSync(): null {
  useSleepReminderSync();
  return null;
}

/** Notification permission for reminders, refreshed when the app returns to the foreground. */
export function useReminderPermission() {
  const { alarms } = useAppServices();
  const [permission, setPermission] = useState<ReminderPermission | null>(null);

  useEffect(() => {
    const refresh = () => getReminderPermission().then(setPermission, () => undefined);
    void refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => sub.remove();
  }, []);

  /** Shows the OS prompt (call from a tap), then reschedules. */
  const request = useCallback(async () => {
    const next = await requestReminderPermission();
    setPermission(next);
    refreshSleepReminders(alarms).catch(() => undefined);
    return next;
  }, [alarms]);

  return { permission, request };
}
