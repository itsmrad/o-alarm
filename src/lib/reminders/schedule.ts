import * as Notifications from 'expo-notifications';

import { REMINDER_ID_PREFIX, type PlannedReminder } from '@/domain/sleep-reminders';

/**
 * Local, non-critical sleep reminders via expo-notifications. These are nudges only:
 * they do not ring through silent mode or Focus, and nothing here schedules an alarm
 * (D4/D30). Alarms are scheduled exclusively by the alarm engine.
 */

export const REMINDER_CHANNEL_ID = 'sleep-reminders';

export type ReminderPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export interface ReminderSyncResult {
  permission: ReminderPermission;
  scheduled: number;
  cancelled: number;
  kept: number;
  failed: number;
}

let configured = false;

async function ensureConfigured(): Promise<void> {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  // Android 13+ needs the channel to exist before the permission prompt can appear.
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
    name: 'Sleep reminders',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => undefined);
}

function toPermission(response: Notifications.NotificationPermissionsStatus): ReminderPermission {
  if (response.granted) return 'granted';
  return response.status === Notifications.PermissionStatus.UNDETERMINED
    ? 'undetermined'
    : 'denied';
}

export async function getReminderPermission(): Promise<ReminderPermission> {
  try {
    await ensureConfigured();
    return toPermission(await Notifications.getPermissionsAsync());
  } catch {
    return 'unavailable';
  }
}

/** Shows the OS prompt (only when still undetermined). Call from a user action. */
export async function requestReminderPermission(): Promise<ReminderPermission> {
  try {
    await ensureConfigured();
    return toPermission(await Notifications.requestPermissionsAsync());
  } catch {
    return 'unavailable';
  }
}

const signature = (r: PlannedReminder) => `${r.fireAt.getTime()}|${r.title}|${r.body}`;

async function reconcile(planned: readonly PlannedReminder[]): Promise<ReminderSyncResult> {
  const result: ReminderSyncResult = {
    permission: 'unavailable',
    scheduled: 0,
    cancelled: 0,
    kept: 0,
    failed: 0,
  };
  let existing: Notifications.NotificationRequest[];
  try {
    await ensureConfigured();
    result.permission = toPermission(await Notifications.getPermissionsAsync());
    existing = (await Notifications.getAllScheduledNotificationsAsync()).filter((n) =>
      n.identifier.startsWith(REMINDER_ID_PREFIX),
    );
  } catch {
    return result;
  }

  // Without permission nothing can be delivered: clear ours rather than leave stale entries.
  const desired = new Map(
    (result.permission === 'granted' ? planned : []).map((r) => [r.id, r] as const),
  );
  const alreadyScheduled = new Set<string>();

  for (const entry of existing) {
    const want = desired.get(entry.identifier);
    if (want && entry.content.data?.sig === signature(want)) {
      alreadyScheduled.add(entry.identifier);
      result.kept++;
      continue;
    }
    try {
      await Notifications.cancelScheduledNotificationAsync(entry.identifier);
      result.cancelled++;
    } catch {
      result.failed++;
    }
  }

  for (const reminder of desired.values()) {
    if (alreadyScheduled.has(reminder.id)) continue;
    try {
      await Notifications.scheduleNotificationAsync({
        identifier: reminder.id,
        content: {
          title: reminder.title,
          body: reminder.body,
          sound: true,
          data: { sig: signature(reminder), kind: reminder.kind },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: reminder.fireAt,
          channelId: REMINDER_CHANNEL_ID,
        },
      });
      result.scheduled++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Makes the OS's pending sleep reminders exactly `planned`. Idempotent: unchanged
 * reminders are left alone, changed or no-longer-wanted ones are replaced or cancelled,
 * and only identifiers starting with REMINDER_ID_PREFIX are ever touched. Calls are
 * serialized so overlapping triggers (alarm edit + foreground) cannot interleave.
 */
export function syncReminders(planned: readonly PlannedReminder[]): Promise<ReminderSyncResult> {
  const run = queue.then(() => reconcile(planned));
  queue = run.catch(() => undefined);
  return run;
}
