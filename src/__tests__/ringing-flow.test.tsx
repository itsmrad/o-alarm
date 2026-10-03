import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { createEventsRepository } from '@/db/repositories/events';
import { createOccurrencesRepository } from '@/db/repositories/occurrences';
import type { AppDatabase } from '@/db/types';
import type { PreviewAlarmEngine } from '@/engine';

// Real SQLite (better-sqlite3) + bundled migrations; the handle is kept for assertions.
let mockDb: AppDatabase | null = null;
jest.mock('@/db/client', () => ({
  openAppDatabase: async () => {
    const { createTestDatabase } = jest.requireActual('@/db/testing/test-db');
    // Reused across a simulated relaunch, like the on-device database.
    mockDb ??= createTestDatabase().db;
    return mockDb;
  },
}));

// The preview engine (Expo Go path), without its own timer: the test rings it on demand.
let mockEngine: PreviewAlarmEngine | null = null;
jest.mock('@/engine/resolve-engine', () => ({
  resolveEngine: () => {
    const { PreviewAlarmEngine: Engine } = jest.requireActual('@/engine/preview-engine');
    // Reused across a simulated relaunch, like the OS alarm state.
    mockEngine ??= new Engine(undefined, { autoRing: false });
    return mockEngine;
  },
}));

const alertSpy = jest.spyOn(Alert, 'alert');

// Monday 2026-10-05 05:00 local; the default new alarm is weekdays 07:00.
const START = new Date(2026, 9, 5, 5, 0, 0);
const FIRE = new Date(2026, 9, 5, 7, 0, 0);

beforeEach(() => {
  jest.useFakeTimers({ now: START, advanceTimers: true });
  alertSpy.mockReset();
  mockDb = null;
  mockEngine = null;
});
afterEach(() => jest.useRealTimers());

/** Moves the clock and lets the preview engine fire whatever is due. */
async function ringAt(at: Date) {
  jest.setSystemTime(at);
  await act(async () => {
    mockEngine!.checkDue();
    await jest.advanceTimersByTimeAsync(10);
  });
}

const hold = (label: string) =>
  fireEvent(screen.getByLabelText(label), 'accessibilityAction', {
    nativeEvent: { actionName: 'longpress' },
  });

describe('ringing flow (Expo Go preview engine)', () => {
  it('create → ring → snooze → ring again → hold to stop, with the ledger kept', async () => {
    const app = renderRouter('./app', { initialUrl: '/' });
    await screen.findByText('No alarm set');

    // Create the default 07:00 weekday alarm.
    fireEvent.press(screen.getByText('Add alarm'));
    fireEvent.changeText(await screen.findByLabelText('Alarm label'), 'Work');
    await act(async () => fireEvent.press(screen.getByLabelText('Save')));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    expect(alertSpy).not.toHaveBeenCalled();

    // 07:00: the engine fires → the lifecycle routes to the ringing screen.
    await ringAt(new Date(FIRE.getTime() + 1_000));
    await waitFor(() => expect(app.getPathname()).toBe('/ringing'));
    expect(await screen.findByText('Work')).toBeTruthy();
    expect(screen.getByText('3 snoozes left')).toBeTruthy();
    expect(screen.getByText(/Preview ring in Expo Go/)).toBeTruthy();

    // A single tap on Stop does nothing (no accidental dismissal).
    fireEvent.press(screen.getByLabelText('Hold to stop'));
    expect(app.getPathname()).toBe('/ringing');

    // Snooze → screen closes, a snooze re-trigger is scheduled 9 minutes out.
    await act(async () => fireEvent.press(screen.getByLabelText('Snooze 9 min')));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    const snooze = (await mockEngine!.getScheduled()).find((e) => e.kind === 'snooze');
    const snoozeDelay = Date.parse(snooze!.fireAt) - FIRE.getTime();
    expect(Math.abs(snoozeDelay - 9 * 60_000)).toBeLessThan(5_000);

    // The snooze rings: one snooze used.
    await ringAt(new Date(Date.parse(snooze!.fireAt) + 1_000));
    await waitFor(() => expect(app.getPathname()).toBe('/ringing'));
    expect(await screen.findByText('2 snoozes left')).toBeTruthy();
    expect(screen.getByText('Snoozed 1×')).toBeTruthy();

    // Press-and-hold stops it.
    await act(async () => hold('Hold to stop'));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    expect(await mockEngine!.getActiveRinging()).toBeNull();

    // Ledger + D12 events: expected, two triggers, one snooze, one dismissal.
    const occurrences = createOccurrencesRepository(mockDb!, () => 'x').listRecent();
    const rang = occurrences.find((row) => row.expectedAt === FIRE.toISOString());
    expect(rang).toMatchObject({ status: 'dismissed', snoozeCount: 1 });
    const types = createEventsRepository(mockDb!, () => 'x')
      .list({ limit: 100 })
      .map((e) => e.type);
    expect(types.filter((t) => t === 'alarm_expected')).toHaveLength(1);
    expect(types.filter((t) => t === 'alarm_trigger_received')).toHaveLength(2);
    expect(types.filter((t) => t === 'alarm_snoozed')).toHaveLength(1);
    expect(types.filter((t) => t === 'alarm_dismissed')).toHaveLength(1);
  });

  it('cold start while ringing opens the ringing screen; at the limit snooze is disabled', async () => {
    const app = renderRouter('./app', { initialUrl: '/' });
    await screen.findByText('No alarm set');
    fireEvent.press(screen.getByText('Add alarm'));
    await screen.findByLabelText('Alarm label');
    // Snooze allowed once.
    fireEvent.press(screen.getByText('1×'));
    await act(async () => fireEvent.press(screen.getByLabelText('Save')));
    await waitFor(() => expect(app.getPathname()).toBe('/'));

    await ringAt(new Date(FIRE.getTime() + 1_000));
    await waitFor(() => expect(app.getPathname()).toBe('/ringing'));
    await act(async () => fireEvent.press(await screen.findByLabelText('Snooze 9 min')));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    const snooze = (await mockEngine!.getScheduled()).find((e) => e.kind === 'snooze')!;
    await ringAt(new Date(Date.parse(snooze.fireAt) + 1_000));
    await waitFor(() => expect(app.getPathname()).toBe('/ringing'));

    expect(await screen.findByText('No snoozes left (1 of 1 used).')).toBeTruthy();
    expect(screen.getByLabelText('Snooze 9 min')).toBeDisabled();

    // Relaunch while it is still ringing: the app goes straight back to the alarm.
    app.unmount();
    const relaunched = renderRouter('./app', { initialUrl: '/' });
    await waitFor(() => expect(relaunched.getPathname()).toBe('/ringing'));
  });
});
