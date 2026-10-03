import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import type { AppDatabase } from '@/db/types';
import { openAppDatabase } from '@/db/client';

import {
  endActiveSleepSession,
  shouldPromptCheckIn,
  sleepServiceFor,
  type SleepDeps,
} from './sleep-runtime';

// Real SQLite (better-sqlite3) + the real bundled migrations in place of expo-sqlite.
// One database for the whole file, like the app's single connection: AppServices boots on
// it and the sleep service is built on that same db (no second connection).
let mockDb: unknown;
jest.mock('@/db/client', () => ({
  openAppDatabase: async () => {
    const { createTestDatabase } = jest.requireActual('@/db/testing/test-db');
    mockDb ??= createTestDatabase().db;
    return mockDb;
  },
}));
jest.mock('expo-notifications', () => ({
  __esModule: true,
  SchedulableTriggerInputTypes: { DATE: 'date' },
  AndroidImportance: { DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'undetermined' })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'denied' })),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
}));

/** The same service the UI uses: keyed by the shared db. */
const sleepDeps = async (): Promise<SleepDeps> => ({
  db: (await openAppDatabase()) as AppDatabase,
  deviceId: 'test-device',
});

const alertSpy = jest.spyOn(Alert, 'alert');
beforeEach(() => alertSpy.mockReset());

const localMorning = () => {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return d;
};

describe('morning check-in route', () => {
  it('saves energy and sleep quality, closes, and stops prompting', async () => {
    expect(await shouldPromptCheckIn(localMorning(), await sleepDeps())).toBe(true);

    const app = renderRouter('./app', { initialUrl: '/checkin' });
    // Energy 4, then sleep quality 3 (each group has its own 1-5 radios).
    const [energy4] = await screen.findAllByLabelText(/^4 of 5/);
    fireEvent.press(energy4!);
    fireEvent.press(screen.getAllByLabelText(/^3 of 5/)[1]!);
    await act(async () => fireEvent.press(screen.getByText('Save')));

    const service = sleepServiceFor(await sleepDeps());
    await waitFor(() => expect(service.listCheckIns()).toHaveLength(1));
    expect(service.listCheckIns()[0]).toMatchObject({ energy: 4, sleepQuality: 3 });
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    expect(await shouldPromptCheckIn(localMorning(), await sleepDeps())).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('skipping after an answer closes without erasing the saved answer', async () => {
    const service = sleepServiceFor(await sleepDeps());
    const before = service.listCheckIns();
    renderRouter('./app', { initialUrl: '/checkin' });
    const skip = await screen.findByText('Skip');
    await act(async () => fireEvent.press(skip));
    expect(service.listCheckIns()).toEqual(before);
    expect(before[0]).toMatchObject({ energy: 4, sleepQuality: 3 });
  });
});

describe('Bedtime tab', () => {
  it('"Going to bed" starts a session that endActiveSleepSession closes', async () => {
    renderRouter('./app', { initialUrl: '/bedtime' });
    expect(await screen.findByText('No alarm to plan around')).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByText('Going to bed')));
    expect(await screen.findByText("I'm awake")).toBeTruthy();
    const service = sleepServiceFor(await sleepDeps());
    expect(service.getActiveSession()).not.toBeNull();

    await act(async () => {
      await endActiveSleepSession(new Date(Date.now() + 8 * 3_600_000), await sleepDeps());
    });
    await waitFor(() => expect(screen.queryByText("I'm awake")).toBeNull());
    expect(service.getActiveSession()).toBeNull();
    expect(service.listSessions()).toHaveLength(1);
  });

  it('nap mode saves a one-time "Nap" alarm and says honestly it will not ring in preview', async () => {
    renderRouter('./app', { initialUrl: '/bedtime' });
    const start = await screen.findByText('Start nap alarm');
    await act(async () => fireEvent.press(start));
    expect(await screen.findByText(/Nap alarm at/)).toBeTruthy();
    expect(screen.getAllByText(/will not ring in Expo Go/).length).toBeGreaterThan(0);
  });
});
