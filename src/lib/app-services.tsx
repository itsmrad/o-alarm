import { router } from 'expo-router';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';

import { createAlarmService, type AlarmService } from '@/db/alarm-service';
import { openAppDatabase } from '@/db/client';
import { getOrCreateDeviceId } from '@/db/repositories/device';
import { resolveEngine, type AlarmEngine } from '@/engine';
import { createReliabilityLedger, type ReliabilityLedger } from '@/services/reliability-ledger';
import { createRingLifecycle, type RingLifecycle } from '@/services/ring-lifecycle';

export interface AppServices {
  engine: AlarmEngine;
  alarms: AlarmService;
  ledger: ReliabilityLedger;
  /** Ring/reconcile lifecycle; also the snooze/dismiss/mission hook point. */
  ring: RingLifecycle;
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
  const ledger = createReliabilityLedger({
    db,
    deviceId,
    engineKind: engine.kind,
    getAlarm: alarms.get,
  });
  const ring = createRingLifecycle({
    engine,
    alarms,
    ledger,
    showRinging: (event) =>
      router.push({ pathname: '/ringing', params: { scheduleId: event.scheduleId } }),
  });
  return { engine, alarms, ledger, ring };
}

/**
 * Opens the local DB, resolves the alarm engine (D6) and starts the ring lifecycle:
 * ringing routing, observed-event ingestion and DB ↔ engine reconciliation on start,
 * on every foreground, and when the device time zone changes (D10).
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
    const { ring } = services;
    ring.start();
    const appState = AppState.addEventListener('change', ring.onAppStateChange);
    // Time zone changes while foregrounded (no JS event exists for this).
    const tzPoll = setInterval(ring.checkTimeZone, 60_000);
    return () => {
      appState.remove();
      clearInterval(tzPoll);
      ring.stop();
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

/** Re-renders when the ring lifecycle reports new ledger/sync state. */
export function useRingState<T>(read: (services: AppServices) => T): T {
  const services = useAppServices();
  const [value, setValue] = useState(() => read(services));
  useEffect(() => {
    const update = () => setValue(read(services));
    update();
    const offRing = services.ring.subscribe(update);
    const offAlarms = services.alarms.subscribe(update);
    return () => {
      offRing();
      offAlarms();
    };
    // `read` is intentionally captured once per services instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);
  return value;
}
