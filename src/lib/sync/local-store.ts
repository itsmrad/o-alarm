import { and, asc, count, eq, inArray } from 'drizzle-orm';

import { outbox, preferences, syncState, type OutboxRow } from '@/db/schema';
import type { AppDatabase, WriteContext } from '@/db/types';

import type { PullCursor } from './transport';

/**
 * Sync bookkeeping in the existing local tables (D31: no new local schema):
 *   sync_state  `entity` keys, per signed-in user:
 *                 `<userId>:account`        AccountSyncRecord (JSON in `cursor`)
 *                 `<userId>:pull:alarms`    pull cursor (JSON PullCursor), lastPulledAt
 *                 `<userId>:push:<table>`   push high-water mark for history tables
 *   preferences key/value (entitlement cache, privacy flags)
 *   outbox      pending alarm writes enqueued by the alarm service (D11)
 */

export interface AccountSyncRecord {
  /** When the one-time guest → account upload finished (or was not needed). */
  migratedAt: string | null;
  lastSyncedAt: string | null;
}

const EMPTY_ACCOUNT: AccountSyncRecord = { migratedAt: null, lastSyncedAt: null };

export function createLocalSyncStore(db: AppDatabase) {
  const getRow = (entity: string) =>
    db.select().from(syncState).where(eq(syncState.entity, entity)).get();

  const putRow = (
    entity: string,
    values: { cursor?: string | null; lastPulledAt?: string | null },
    now: Date,
  ) => {
    const updatedAt = now.toISOString();
    db.insert(syncState)
      .values({ entity, ...values, updatedAt })
      .onConflictDoUpdate({ target: syncState.entity, set: { ...values, updatedAt } })
      .run();
  };

  const readJson = <T>(entity: string): T | null => {
    const raw = getRow(entity)?.cursor;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  return {
    account(userId: string): AccountSyncRecord {
      return { ...EMPTY_ACCOUNT, ...readJson<AccountSyncRecord>(`${userId}:account`) };
    },
    updateAccount(userId: string, patch: Partial<AccountSyncRecord>, now: Date): void {
      const next = { ...this.account(userId), ...patch };
      putRow(`${userId}:account`, { cursor: JSON.stringify(next) }, now);
    },
    pullCursor(userId: string): PullCursor | null {
      return readJson<PullCursor>(`${userId}:pull:alarms`);
    },
    setPullCursor(userId: string, cursor: PullCursor, now: Date): void {
      putRow(
        `${userId}:pull:alarms`,
        { cursor: JSON.stringify(cursor), lastPulledAt: now.toISOString() },
        now,
      );
    },
    pushCursor(userId: string, table: string): PullCursor | null {
      return readJson<PullCursor>(`${userId}:push:${table}`);
    },
    setPushCursor(userId: string, table: string, cursor: PullCursor, now: Date): void {
      putRow(`${userId}:push:${table}`, { cursor: JSON.stringify(cursor) }, now);
    },
    /** Forgets every cursor/marker of one user (or all users). */
    clear(userId?: string): void {
      if (!userId) {
        db.delete(syncState).run();
        return;
      }
      const entities = db
        .select({ entity: syncState.entity })
        .from(syncState)
        .all()
        .map((row) => row.entity)
        .filter((entity) => entity.startsWith(`${userId}:`));
      if (entities.length) db.delete(syncState).where(inArray(syncState.entity, entities)).run();
    },

    // ------------------------------------------------------------------ outbox
    outbox: {
      /** Entries due for a push attempt, oldest first. */
      due(now: Date): OutboxRow[] {
        const iso = now.toISOString();
        return db
          .select()
          .from(outbox)
          .orderBy(asc(outbox.createdAt))
          .all()
          .filter((row) => !row.nextAttemptAt || row.nextAttemptAt <= iso);
      },
      forEntity(entity: string, entityId: string): OutboxRow[] {
        return db
          .select()
          .from(outbox)
          .where(and(eq(outbox.entity, entity), eq(outbox.entityId, entityId)))
          .all();
      },
      remove(ids: string[]): void {
        if (ids.length) db.delete(outbox).where(inArray(outbox.id, ids)).run();
      },
      /** Entries of `entity` for `entityIds`, created at or before `at` (covered by an upload). */
      removeCreatedBefore(entity: string, at: string, entityIds: Set<string>): void {
        const ids = db
          .select({ id: outbox.id, entityId: outbox.entityId, createdAt: outbox.createdAt })
          .from(outbox)
          .where(eq(outbox.entity, entity))
          .all()
          .filter((row) => row.createdAt <= at && entityIds.has(row.entityId))
          .map((row) => row.id);
        this.remove(ids);
      },
      markFailed(ids: string[], error: string, nextAttemptAt: string): void {
        for (const id of ids) {
          const row = db.select().from(outbox).where(eq(outbox.id, id)).get();
          if (!row) continue;
          db.update(outbox)
            .set({ attempts: row.attempts + 1, lastError: error.slice(0, 500), nextAttemptAt })
            .where(eq(outbox.id, id))
            .run();
        }
      },
      /** Entries of `entities` created at or before `at` (covered by a history push). */
      removeEntities(entities: readonly string[], at: string): void {
        if (entities.length === 0) return;
        const ids = db
          .select({ id: outbox.id, createdAt: outbox.createdAt })
          .from(outbox)
          .where(inArray(outbox.entity, [...entities]))
          .all()
          .filter((row) => row.createdAt <= at)
          .map((row) => row.id);
        this.remove(ids);
      },
      /** Pending entries of the entities sync uploads. */
      count(entities: readonly string[]): number {
        return (
          db
            .select({ n: count() })
            .from(outbox)
            .where(inArray(outbox.entity, [...entities]))
            .get()?.n ?? 0
        );
      },
    },
  };
}

export type LocalSyncStore = ReturnType<typeof createLocalSyncStore>;

// ---------------------------------------------------------------------------- preferences

export const PREFERENCE_KEYS = {
  /** Cached entitlement snapshot (src/lib/entitlements). */
  entitlement: 'entitlement',
  /** Privacy: user opted out of product analytics (read by analytics when it lands, D20). */
  analyticsOptOut: 'privacy.analytics_opt_out',
} as const;

export function readPreference<T>(db: AppDatabase, key: string): T | undefined {
  const row = db.select().from(preferences).where(eq(preferences.key, key)).get();
  return row && !row.deletedAt ? (row.value as T) : undefined;
}

export function writePreference(db: AppDatabase, key: string, value: unknown, ctx: WriteContext) {
  const now = ctx.now.toISOString();
  const existing = db.select().from(preferences).where(eq(preferences.key, key)).get();
  if (existing) {
    db.update(preferences)
      .set({
        value,
        updatedAt: now,
        version: existing.version + 1,
        deviceId: ctx.deviceId,
        deletedAt: null,
      })
      .where(eq(preferences.id, existing.id))
      .run();
    return;
  }
  db.insert(preferences)
    .values({
      id: `pref:${key}`,
      key,
      value,
      createdAt: now,
      updatedAt: now,
      version: 1,
      deviceId: ctx.deviceId,
    })
    .run();
}
