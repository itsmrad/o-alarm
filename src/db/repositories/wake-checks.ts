import { eq, inArray, sql } from 'drizzle-orm';

import type { WakeCheckState } from '@/domain';

import { wakeChecks, wakeSessions } from '../schema';
import type { AppDatabase, WriteContext } from '../types';

export type WakeCheckRow = typeof wakeChecks.$inferSelect;
export type WakeSessionRow = typeof wakeSessions.$inferSelect;

/**
 * Wake Check persistence (D13): one `wake_checks` row per occurrence (unique index) holding the current
 * reducer state, plus the `wake_sessions` row it belongs to. Survives app kill, so the
 * flow resumes from here + the engine's observed events.
 */
export function createWakeChecksRepository(db: AppDatabase, newId: () => string) {
  const session = (occurrenceKey: string): WakeSessionRow | null =>
    db.select().from(wakeSessions).where(eq(wakeSessions.occurrenceKey, occurrenceKey)).get() ??
    null;

  const get = (occurrenceKey: string): WakeCheckRow | null =>
    db.select().from(wakeChecks).where(eq(wakeChecks.occurrenceKey, occurrenceKey)).get() ?? null;

  function ensureSession(
    entry: { alarmId: string; occurrenceKey: string; startedAt: string },
    ctx: WriteContext,
  ): WakeSessionRow {
    const existing = session(entry.occurrenceKey);
    if (existing) return existing;
    const now = ctx.now.toISOString();
    db.insert(wakeSessions)
      .values({
        id: newId(),
        ...entry,
        createdAt: now,
        updatedAt: now,
        version: 1,
        deviceId: ctx.deviceId,
      })
      .run();
    return session(entry.occurrenceKey)!;
  }

  return {
    get,
    session,

    /** Writes the reducer state for an occurrence (creating its wake session if needed). */
    save(
      entry: { alarmId: string; occurrenceKey: string; state: WakeCheckState },
      ctx: WriteContext,
    ): void {
      if (entry.state.status === 'idle') return;
      const now = ctx.now.toISOString();
      const existing = get(entry.occurrenceKey);
      const fields = {
        attempt: entry.state.attempt,
        status: entry.state.status,
        state: entry.state,
      };
      if (existing && JSON.stringify(existing.state) === JSON.stringify(entry.state)) return;
      const wakeSessionId =
        existing?.wakeSessionId ??
        ensureSession(
          { alarmId: entry.alarmId, occurrenceKey: entry.occurrenceKey, startedAt: now },
          ctx,
        ).id;
      // Upsert on the unique occurrence_key index (migration 0002): one row per occurrence.
      db.insert(wakeChecks)
        .values({
          id: newId(),
          wakeSessionId,
          occurrenceKey: entry.occurrenceKey,
          ...fields,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deviceId: ctx.deviceId,
        })
        .onConflictDoUpdate({
          target: wakeChecks.occurrenceKey,
          set: {
            ...fields,
            updatedAt: now,
            version: sql`${wakeChecks.version} + 1`,
            deviceId: ctx.deviceId,
          },
        })
        .run();
    },

    /** Closes the wake session (idempotent: the first outcome wins). */
    endSession(
      occurrenceKey: string,
      outcome: NonNullable<WakeSessionRow['outcome']>,
      at: string,
      ctx: WriteContext,
    ): void {
      const existing = session(occurrenceKey);
      if (!existing || existing.endedAt) return;
      db.update(wakeSessions)
        .set({
          endedAt: at,
          outcome,
          updatedAt: ctx.now.toISOString(),
          version: existing.version + 1,
          deviceId: ctx.deviceId,
        })
        .where(eq(wakeSessions.id, existing.id))
        .run();
    },

    /** Rows whose check is still in flight (armed or awaiting an answer). */
    listOpen(): WakeCheckRow[] {
      return db
        .select()
        .from(wakeChecks)
        .where(inArray(wakeChecks.status, ['armed', 'pending_verification']))
        .all();
    },
  };
}

export type WakeChecksRepository = ReturnType<typeof createWakeChecksRepository>;
