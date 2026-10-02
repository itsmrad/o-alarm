import { eq } from 'drizzle-orm';

import { alarmOccurrences } from '../schema';
import type { AppDatabase, WriteContext } from '../types';

/** Expected occurrences (for expected-vs-observed tracking). */
export function createOccurrencesRepository(db: AppDatabase, newId: () => string) {
  return {
    /** Records/updates the expected fire time of a scheduled occurrence. */
    upsertScheduled(
      entry: { alarmId: string; occurrenceKey: string; expectedAt: string },
      ctx: WriteContext,
    ): void {
      const now = ctx.now.toISOString();
      const existing = db
        .select()
        .from(alarmOccurrences)
        .where(eq(alarmOccurrences.occurrenceKey, entry.occurrenceKey))
        .get();
      if (existing) {
        if (existing.expectedAt === entry.expectedAt && existing.status === 'scheduled') return;
        db.update(alarmOccurrences)
          .set({
            expectedAt: entry.expectedAt,
            status: 'scheduled',
            updatedAt: now,
            version: existing.version + 1,
            deviceId: ctx.deviceId,
          })
          .where(eq(alarmOccurrences.id, existing.id))
          .run();
        return;
      }
      db.insert(alarmOccurrences)
        .values({
          id: newId(),
          ...entry,
          status: 'scheduled',
          createdAt: now,
          updatedAt: now,
          version: 1,
          deviceId: ctx.deviceId,
        })
        .run();
    },

    listForAlarm(alarmId: string) {
      return db.select().from(alarmOccurrences).where(eq(alarmOccurrences.alarmId, alarmId)).all();
    },
  };
}

export type OccurrencesRepository = ReturnType<typeof createOccurrencesRepository>;
