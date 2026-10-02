import { and, desc, eq, type SQL } from 'drizzle-orm';

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

    /** Newest first. */
    list(filter: { type?: EventType; alarmId?: string; limit?: number } = {}): AppEvent[] {
      const conditions: SQL[] = [];
      if (filter.type) conditions.push(eq(events.type, filter.type));
      if (filter.alarmId) conditions.push(eq(events.alarmId, filter.alarmId));
      return db
        .select()
        .from(events)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(events.occurredAt), desc(events.createdAt))
        .limit(filter.limit ?? 100)
        .all()
        .map(rowToEvent);
    },
  };
}

export type EventsRepository = ReturnType<typeof createEventsRepository>;
