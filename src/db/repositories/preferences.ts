import { eq } from 'drizzle-orm';

import { preferences } from '../schema';
import type { AppDatabase, WriteContext } from '../types';

/** Small key/value settings (JSON values), stamped for sync like every syncable row. */
export function createPreferencesRepository(db: AppDatabase, newId: () => string) {
  const row = (key: string) =>
    db.select().from(preferences).where(eq(preferences.key, key)).get() ?? null;

  return {
    get<T>(key: string): T | null {
      const existing = row(key);
      return existing && !existing.deletedAt ? (existing.value as T) : null;
    },

    set(key: string, value: unknown, ctx: WriteContext): void {
      const now = ctx.now.toISOString();
      const existing = row(key);
      if (existing) {
        db.update(preferences)
          .set({
            value,
            updatedAt: now,
            version: existing.version + 1,
            deletedAt: null,
            deviceId: ctx.deviceId,
          })
          .where(eq(preferences.id, existing.id))
          .run();
        return;
      }
      db.insert(preferences)
        .values({
          id: newId(),
          key,
          value,
          createdAt: now,
          updatedAt: now,
          version: 1,
          deviceId: ctx.deviceId,
        })
        .run();
    },
  };
}

export type PreferencesRepository = ReturnType<typeof createPreferencesRepository>;
