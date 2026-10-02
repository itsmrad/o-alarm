import { router } from 'expo-router';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';

import { createAlarmService, deviceTimeZone, type AlarmService } from '@/db/alarm-service';
import { openAppDatabase } from '@/db/client';
import { getOrCreateDeviceId } from '@/db/repositories/device';
import { resolveEngine, type AlarmEngine } from '@/engine';

export interface AppServices {
  engine: AlarmEngine;
  alarms: AlarmService;
}

type BootState =
  | { status: 'loading' }
  | { status: 'ready'; services: AppServices }
  | { status: 'error'; error: Error };

const AppServicesContext = createContext<AppServices | null>(null);

async function boot(): Promise<AppServices> {
  const db = await openAppDatabase();
  const deviceId = getOrCreateDeviceId(db, Crypto.randomUUID, Platform.OS, new Date());
  const engine = resolveEngine();
  const alarms = createAlarmService({ db, engine, deviceId });
  return { engine, alarms };
}

/**
 * Opens the local DB, resolves the alarm engine (D6) and reconciles DB ↔ engine on
 * start, on every foreground, and when the device time zone changes (D10).
 */
export function AppServicesProvider({
  children,
  renderBoot,
}: {
  children: ReactNode;
  renderBoot: (state: Exclude<BootState, { status: 'ready' }>) => ReactNode;
}) {
  const [state, setState] = useState<BootState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    boot().then(
      (services) => !cancelled && setState({ status: 'ready', services }),
      (error: unknown) =>
        !cancelled &&
        setState({
          status: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const services = state.status === 'ready' ? state.services : null;

  useEffect(() => {
    if (!services) return;
    let lastZone = deviceTimeZone();
    const run = () => {
      lastZone = deviceTimeZone();
      // Failures are recorded per alarm (status + alarm_schedule_failed events).
      services.alarms.reconcileAll().catch(() => undefined);
    };
    run();
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') run();
    });
    // Time zone changes while foregrounded (no JS event exists for this).
    const tzPoll = setInterval(() => {
      if (deviceTimeZone() !== lastZone) run();
    }, 60_000);
    const trigger = services.engine.addListener('trigger', (event) => {
      router.push({
        pathname: '/ringing',
        params: { alarmId: event.alarmId, occurrenceKey: event.occurrenceKey },
      });
    });
    return () => {
      appState.remove();
      clearInterval(tzPoll);
      trigger.remove();
    };
  }, [services]);

  if (state.status !== 'ready') return renderBoot(state);
  return (
    <AppServicesContext.Provider value={state.services}>{children}</AppServicesContext.Provider>
  );
}

export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (!services) throw new Error('useAppServices must be used inside AppServicesProvider');
  return services;
}

/** Live list of alarms; re-renders after every write through the alarm service. */
export function useAlarms() {
  const { alarms } = useAppServices();
  const [list, setList] = useState(() => alarms.list());
  useEffect(() => alarms.subscribe(() => setList(alarms.list())), [alarms]);
  return list;
}

/** Current time, refreshed every `intervalMs` (for countdowns). */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
