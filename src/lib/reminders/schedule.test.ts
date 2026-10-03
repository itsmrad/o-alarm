import type { PlannedReminder } from '@/domain/sleep-reminders';

import { getReminderPermission, requestReminderPermission, syncReminders } from './schedule';

interface Stored {
  identifier: string;
  content: { title: string; body: string; data: Record<string, unknown> };
  trigger: { date: Date };
}

jest.mock('expo-notifications', () => {
  const store = new Map<string, unknown>();
  const state = { permission: { granted: true, status: 'granted' } };
  return {
    __esModule: true,
    __store: store,
    __state: state,
    SchedulableTriggerInputTypes: { DATE: 'date' },
    AndroidImportance: { DEFAULT: 3 },
    PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(async () => null),
    getPermissionsAsync: jest.fn(async () => state.permission),
    requestPermissionsAsync: jest.fn(async () => {
      state.permission = { granted: true, status: 'granted' };
      return state.permission;
    }),
    getAllScheduledNotificationsAsync: jest.fn(async () => [...store.values()]),
    scheduleNotificationAsync: jest.fn(async (req: { identifier: string }) => {
      store.set(req.identifier, req);
      return req.identifier;
    }),
    cancelScheduledNotificationAsync: jest.fn(async (id: string) => {
      store.delete(id);
    }),
  };
});

const mockNotifications = jest.requireMock('expo-notifications') as {
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  scheduleNotificationAsync: jest.Mock;
  cancelScheduledNotificationAsync: jest.Mock;
  __store: Map<string, Stored>;
  __state: { permission: { granted: boolean; status: string } };
};
const store = mockNotifications.__store;
const setPermission = (granted: boolean, status: string) => {
  mockNotifications.__state.permission = { granted, status };
};

const reminder = (
  id: string,
  minutes: number,
  overrides: Partial<PlannedReminder> = {},
): PlannedReminder => ({
  id,
  kind: 'bedtime',
  fireAt: new Date(Date.UTC(2026, 9, 3, 2, minutes)),
  title: 'Time for bed',
  body: 'Aim to be in bed now.',
  ...overrides,
});

beforeEach(() => {
  store.clear();
  setPermission(true, 'granted');
  jest.clearAllMocks();
});

describe('syncReminders', () => {
  it('schedules every planned reminder as a one-shot date trigger', async () => {
    const result = await syncReminders([
      reminder('sleep.bedtime.2026-10-02', 45),
      reminder('sleep.windDown.2026-10-02', 0, { kind: 'windDown' }),
    ]);
    expect(result).toMatchObject({ permission: 'granted', scheduled: 2, cancelled: 0, kept: 0 });
    expect([...store.keys()].sort()).toEqual([
      'sleep.bedtime.2026-10-02',
      'sleep.windDown.2026-10-02',
    ]);
    const request = mockNotifications.scheduleNotificationAsync.mock.calls[0]![0] as never as {
      trigger: { type: string; date: Date; channelId: string };
    };
    expect(request.trigger).toMatchObject({ type: 'date', channelId: 'sleep-reminders' });
  });

  it('is idempotent: syncing the same plan twice schedules and cancels nothing the second time', async () => {
    const plan = [
      reminder('sleep.bedtime.2026-10-02', 45),
      reminder('sleep.bedtime.2026-10-03', 45),
    ];
    await syncReminders(plan);
    mockNotifications.scheduleNotificationAsync.mockClear();
    const again = await syncReminders(plan);
    expect(again).toMatchObject({ scheduled: 0, cancelled: 0, kept: 2 });
    expect(mockNotifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockNotifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    expect(store.size).toBe(2);
  });

  it('replaces a reminder whose time changed (next alarm moved) without duplicating it', async () => {
    await syncReminders([reminder('sleep.bedtime.2026-10-02', 45)]);
    const result = await syncReminders([reminder('sleep.bedtime.2026-10-02', 15)]);
    expect(result).toMatchObject({ scheduled: 1, cancelled: 1, kept: 0 });
    expect(store.size).toBe(1);
    expect(store.get('sleep.bedtime.2026-10-02')?.trigger.date.toISOString()).toBe(
      '2026-10-03T02:15:00.000Z',
    );
  });

  it('cancels reminders that are no longer wanted (setting turned off / alarm removed)', async () => {
    await syncReminders([
      reminder('sleep.bedtime.2026-10-02', 45),
      reminder('sleep.bedtime.2026-10-03', 45),
    ]);
    const result = await syncReminders([reminder('sleep.bedtime.2026-10-03', 45)]);
    expect(result).toMatchObject({ scheduled: 0, cancelled: 1, kept: 1 });
    expect([...store.keys()]).toEqual(['sleep.bedtime.2026-10-03']);
    await syncReminders([]);
    expect(store.size).toBe(0);
  });

  it('never touches notifications it does not own', async () => {
    store.set('other.thing', {
      identifier: 'other.thing',
      content: { title: 'x', body: 'y', data: {} },
      trigger: { date: new Date() },
    });
    await syncReminders([]);
    expect(store.has('other.thing')).toBe(true);
    expect(mockNotifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });

  it('schedules nothing and clears ours when permission is denied', async () => {
    await syncReminders([reminder('sleep.bedtime.2026-10-02', 45)]);
    setPermission(false, 'denied');
    const result = await syncReminders([reminder('sleep.bedtime.2026-10-02', 45)]);
    expect(result).toMatchObject({ permission: 'denied', scheduled: 0, cancelled: 1 });
    expect(store.size).toBe(0);
  });

  it('reports unavailable (and does nothing) when the native module throws', async () => {
    mockNotifications.getPermissionsAsync.mockRejectedValueOnce(new Error('no native module'));
    const result = await syncReminders([reminder('sleep.bedtime.2026-10-02', 45)]);
    expect(result.permission).toBe('unavailable');
    expect(store.size).toBe(0);
  });

  it('counts a failed schedule instead of throwing', async () => {
    mockNotifications.scheduleNotificationAsync.mockRejectedValueOnce(new Error('boom'));
    const result = await syncReminders([reminder('sleep.bedtime.2026-10-02', 45)]);
    expect(result).toMatchObject({ scheduled: 0, failed: 1 });
  });

  it('serializes overlapping syncs so concurrent triggers do not duplicate', async () => {
    const plan = [reminder('sleep.bedtime.2026-10-02', 45)];
    await Promise.all([syncReminders(plan), syncReminders(plan), syncReminders(plan)]);
    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });
});

describe('permission helpers', () => {
  it('maps OS status to honest UI states', async () => {
    setPermission(false, 'undetermined');
    expect(await getReminderPermission()).toBe('undetermined');
    setPermission(false, 'denied');
    expect(await getReminderPermission()).toBe('denied');
  });

  it('only prompts when asked, and returns the new state', async () => {
    setPermission(false, 'undetermined');
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(await requestReminderPermission()).toBe('granted');
  });
});
