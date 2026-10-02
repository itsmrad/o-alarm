import { and, eq, isNull } from 'drizzle-orm';

import type { Alarm } from '@/domain';
import type { Weekday } from '@/domain/time';

import { alarms, type AlarmRow } from '../schema';
import type { AppDatabase, WriteContext } from '../types';

export function rowToAlarm(row: AlarmRow): Alarm {
  return {
    id: row.id,
    hour: row.hour,
    minute: row.minute,
    weekdays: row.weekdays as Weekday[],
    date: row.date,
    timezonePolicy: row.timezonePolicy,
    timeZone: row.timeZone,
    label: row.label,
    enabled: row.enabled,
    sound: row.sound,
    vibration: row.vibration,
    escalation: row.escalation,
    snooze: row.snooze,
    skipNext: row.skipNext,
    oneOffOverride: row.oneOffOverride,
    missions: row.missions,
    wakeCheck: row.wakeCheck,
    important: row.important,
  };
}

function alarmColumns(alarm: Alarm) {
  const { id: _id, ...columns } = alarm;
  return columns;
}

export function createAlarmsRepository(db: AppDatabase) {
  return {
    /** Live (not soft-deleted) alarms, ordered by time of day. */
    list(): Alarm[] {
      return db
        .select()
        .from(alarms)
        .where(isNull(alarms.deletedAt))
        .orderBy(alarms.hour, alarms.minute, alarms.createdAt)
        .all()
        .map(rowToAlarm);
    },

    get(id: string): Alarm | null {
      const row = db
        .select()
        .from(alarms)
        .where(and(eq(alarms.id, id), isNull(alarms.deletedAt)))
        .get();
      return row ? rowToAlarm(row) : null;
    },

    getRow(id: string): AlarmRow | null {
      return db.select().from(alarms).where(eq(alarms.id, id)).get() ?? null;
    },

    /** Insert or update; bumps `version` and stamps updated_at/device_id. Returns the row. */
    upsert(alarm: Alarm, ctx: WriteContext): AlarmRow {
      const now = ctx.now.toISOString();
      const existing = this.getRow(alarm.id);
      if (existing) {
        db.update(alarms)
          .set({
            ...alarmColumns(alarm),
            updatedAt: now,
            version: existing.version + 1,
            deviceId: ctx.deviceId,
            deletedAt: null,
          })
          .where(eq(alarms.id, alarm.id))
          .run();
      } else {
        db.insert(alarms)
          .values({
            id: alarm.id,
            ...alarmColumns(alarm),
            createdAt: now,
            updatedAt: now,
            version: 1,
            deviceId: ctx.deviceId,
          })
          .run();
      }
      return this.getRow(alarm.id)!;
    },

    /** Soft delete (tombstone for sync). Returns the row, or null if missing. */
    softDelete(id: string, ctx: WriteContext): AlarmRow | null {
      const existing = this.getRow(id);
      if (!existing || existing.deletedAt) return existing;
      const now = ctx.now.toISOString();
      db.update(alarms)
        .set({
          deletedAt: now,
          updatedAt: now,
          version: existing.version + 1,
          deviceId: ctx.deviceId,
        })
        .where(eq(alarms.id, id))
        .run();
      return this.getRow(id);
    },
  };
}

export type AlarmsRepository = ReturnType<typeof createAlarmsRepository>;
