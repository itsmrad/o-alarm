import { and, asc, desc, eq, gt, sql, type SQL } from 'drizzle-orm';

import type { AppEvent, EventType, NewEvent } from '@/domain';

import { events, type EventRow } from '../schema';
import type { AppDatabase, WriteContext } from '../types';

function rowToEvent(row: EventRow): AppEvent {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurredAt,
    alarmId: row.alarmId,
    occurrenceKey: row.occurrenceKey,
    payload: row.payload,
  } as AppEvent;
}

/** D12: append-only. There is intentionally no update/delete API. */
export function createEventsRepository(db: AppDatabase, newId: () => string) {
  return {
    append(event: NewEvent, ctx: WriteContext): AppEvent {
      const now = ctx.now.toISOString();
      const row = {
        id: newId(),
        type: event.type,
        occurredAt: now,
        alarmId: event.alarmId ?? null,
        occurrenceKey: event.occurrenceKey ?? null,
        payload: event.payload as Record<string, unknown>,
        createdAt: now,
        updatedAt: now,
        version: 1,
        deletedAt: null,
        deviceId: ctx.deviceId,
      };
      db.insert(events).values(row).run();
      return rowToEvent(row);
    },

    /**
     * Appends with a caller-chosen id unless that id already exists. Returns false for
     * the duplicate (an event reported by both the app and the engine's observed queue).
     * `occurredAt` defaults to now; observed events pass the engine's own timestamp.
     */
    appendOnce(event: NewEvent, id: string, ctx: WriteContext, occurredAt?: string): boolean {
      if (db.select({ id: events.id }).from(events).where(eq(events.id, id)).get()) return false;
      const now = ctx.now.toISOString();
      db.insert(events)
        .values({
          id,
          type: event.type,
          occurredAt: occurredAt ?? now,
          alarmId: event.alarmId ?? null,
          occurrenceKey: event.occurrenceKey ?? null,
          payload: event.payload as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deletedAt: null,
          deviceId: ctx.deviceId,
        })
        .run();
      return true;
    },

    /** Newest first. */
    list(
      filter: { type?: EventType; alarmId?: string; occurrenceKey?: string; limit?: number } = {},
    ): AppEvent[] {
      const conditions: SQL[] = [];
      if (filter.type) conditions.push(eq(events.type, filter.type));
      if (filter.alarmId) conditions.push(eq(events.alarmId, filter.alarmId));
      if (filter.occurrenceKey) conditions.push(eq(events.occurrenceKey, filter.occurrenceKey));
      return db
        .select()
        .from(events)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(events.occurredAt), desc(events.createdAt))
        .limit(filter.limit ?? 100)
        .all()
        .map(rowToEvent);
    },

    /**
     * Events written on this device after insertion position `afterRowId`, oldest first
     * (SQLite rowid: monotonic insertion order, so equal timestamps never reorder). For
     * consumers that tail the log (analytics/observability).
     */
    listAfter(
      afterRowId: number,
      deviceId: string,
      limit = 200,
    ): { rowId: number; event: AppEvent }[] {
      return db
        .select({ rowId: sql<number>`rowid`, row: events })
        .from(events)
        .where(and(gt(sql`rowid`, afterRowId), eq(events.deviceId, deviceId)))
        .orderBy(asc(sql`rowid`))
        .limit(limit)
        .all()
        .map(({ rowId, row }) => ({ rowId, event: rowToEvent(row) }));
    },

    /** Insertion position of the newest event (0 when empty). */
    lastRowId(): number {
      return (
        db
          .select({ rowId: sql<number>`max(rowid)` })
          .from(events)
          .get()?.rowId ?? 0
      );
    },
  };
}

export type EventsRepository = ReturnType<typeof createEventsRepository>;
