import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type * as schema from './schema';

/**
 * Any synchronous Drizzle SQLite database with our schema: expo-sqlite in the app,
 * better-sqlite3 in tests. Repositories depend only on this.
 */
export type AppDatabase = BaseSQLiteDatabase<'sync', any, typeof schema>;

/** Stamps for syncable writes (D17). */
export interface WriteContext {
  now: Date;
  deviceId: string;
}
