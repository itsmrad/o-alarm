import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';

import { alarmOccurrences } from '../schema';
import type { AppDatabase, WriteContext } from '../types';

export type OccurrenceRow = typeof alarmOccurrences.$inferSelect;
export type OccurrenceStatus = OccurrenceRow['status'];

/**
 * Reliability ledger: one row per expected occurrence (expected vs observed, D12).
 * `status` is the outcome: scheduled → triggered → snoozed → dismissed, or missed /
 * skipped / cancelled.
 */
export function createOccurrencesRepository(db: AppDatabase, newId: () => string) {
  const get = (occurrenceKey: string): OccurrenceRow | null =>
    db
      .select()
      .from(alarmOccurrences)
      .where(eq(alarmOccurrences.occurrenceKey, occurrenceKey))
      .get() ?? null;

  const update = (
    existing: OccurrenceRow,
    patch: Partial<
      Pick<OccurrenceRow, 'status' | 'expectedAt' | 'triggeredAt' | 'dismissedAt' | 'snoozeCount'>
    >,
    ctx: WriteContext,
  ) => {
    db.update(alarmOccurrences)
      .set({
        ...patch,
        updatedAt: ctx.now.toISOString(),
        version: existing.version + 1,
        deviceId: ctx.deviceId,
      })
      .where(eq(alarmOccurrences.id, existing.id))
      .run();
  };

  const insert = (
    entry: { alarmId: string; occurrenceKey: string; expectedAt: string },
    status: OccurrenceStatus,
    ctx: WriteContext,
  ): OccurrenceRow => {
    const now = ctx.now.toISOString();
    db.insert(alarmOccurrences)
      .values({
        id: newId(),
        ...entry,
        status,
        createdAt: now,
        updatedAt: now,
        version: 1,
        deviceId: ctx.deviceId,
      })
      .run();
    return get(entry.occurrenceKey)!;
  };

  return {
    get,

    /** Records/updates the expected fire time of a scheduled occurrence. */
    upsertScheduled(
      entry: { alarmId: string; occurrenceKey: string; expectedAt: string },
      ctx: WriteContext,
    ): void {
      const existing = get(entry.occurrenceKey);
      if (!existing) {
        insert(entry, 'scheduled', ctx);
        return;
      }
      // Never rewind an occurrence that already rang (a native re-arm read back late).
      if (existing.triggeredAt || existing.dismissedAt) return;
      if (existing.expectedAt === entry.expectedAt && existing.status === 'scheduled') return;
      update(existing, { expectedAt: entry.expectedAt, status: 'scheduled' }, ctx);
    },

    /** Row for a ringing occurrence; created if the engine armed it without JS (D28). */
    ensure(
      entry: { alarmId: string; occurrenceKey: string; expectedAt: string },
      ctx: WriteContext,
    ): OccurrenceRow {
      return get(entry.occurrenceKey) ?? insert(entry, 'scheduled', ctx);
    },

    markTriggered(row: OccurrenceRow, at: string, ctx: WriteContext): void {
      if (row.dismissedAt) return;
      update(row, { status: 'triggered', triggeredAt: row.triggeredAt ?? at }, ctx);
    },

    markSnoozed(row: OccurrenceRow, at: string, ctx: WriteContext): void {
      update(
        row,
        {
          status: row.dismissedAt ? row.status : 'snoozed',
          triggeredAt: row.triggeredAt ?? at,
          snoozeCount: row.snoozeCount + 1,
        },
        ctx,
      );
    },

    markDismissed(row: OccurrenceRow, at: string, ctx: WriteContext): void {
      update(
        row,
        { status: 'dismissed', triggeredAt: row.triggeredAt ?? at, dismissedAt: at },
        ctx,
      );
    },

    markMissed(row: OccurrenceRow, ctx: WriteContext): void {
      if (row.triggeredAt || row.dismissedAt) return;
      update(row, { status: 'missed' }, ctx);
    },

    /** A still-future scheduled occurrence the user removed (disable/delete/skip/edit). */
    markWithdrawn(occurrenceKey: string, status: 'cancelled' | 'skipped', ctx: WriteContext) {
      const row = get(occurrenceKey);
      if (!row || row.status !== 'scheduled') return;
      if (Date.parse(row.expectedAt) <= ctx.now.getTime()) return;
      update(row, { status }, ctx);
    },

    /** Scheduled occurrences whose expected time is at or before `cutoff`, never triggered. */
    listOverdue(cutoff: Date): OccurrenceRow[] {
      return db
        .select()
        .from(alarmOccurrences)
        .where(
          and(
            eq(alarmOccurrences.status, 'scheduled'),
            lte(alarmOccurrences.expectedAt, cutoff.toISOString()),
          ),
        )
        .all();
    },

    /** Newest first, optionally filtered by status and a lower bound on expected time. */
    listRecent(filter: { since?: Date; statuses?: OccurrenceStatus[]; limit?: number } = {}) {
      const conditions = [];
      if (filter.since)
        conditions.push(gte(alarmOccurrences.expectedAt, filter.since.toISOString()));
      if (filter.statuses) conditions.push(inArray(alarmOccurrences.status, filter.statuses));
      return db
        .select()
        .from(alarmOccurrences)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(alarmOccurrences.expectedAt))
        .limit(filter.limit ?? 50)
        .all();
    },

    listForAlarm(alarmId: string) {
      return db.select().from(alarmOccurrences).where(eq(alarmOccurrences.alarmId, alarmId)).all();
    },
  };
}

export type OccurrencesRepository = ReturnType<typeof createOccurrencesRepository>;
