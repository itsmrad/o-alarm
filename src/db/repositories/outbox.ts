import { asc } from 'drizzle-orm';

import { outbox, type OutboxRow } from '../schema';
import type { AppDatabase } from '../types';

/** D17: local queue of pending cloud writes, drained by the sync worker (later task). */
export function createOutboxRepository(db: AppDatabase, newId: () => string) {
  return {
    enqueue(
      entry: Pick<OutboxRow, 'entity' | 'entityId' | 'op' | 'payload'>,
      now: Date,
    ): OutboxRow {
      const row: OutboxRow = {
        id: newId(),
        ...entry,
        createdAt: now.toISOString(),
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      };
      db.insert(outbox).values(row).run();
      return row;
    },

    list(): OutboxRow[] {
      return db.select().from(outbox).orderBy(asc(outbox.createdAt)).all();
    },
  };
}

export type OutboxRepository = ReturnType<typeof createOutboxRepository>;
