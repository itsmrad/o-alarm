import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';

import * as schema from '../schema';
import type { AppDatabase } from '../types';

/**
 * Real SQLite (better-sqlite3, in memory) with the SAME drizzle-kit migrations the app
 * bundles, so tests exercise the actual schema.
 */
export function createTestDatabase(): { db: AppDatabase; close: () => void } {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(__dirname, '..', 'migrations') });
  return { db, close: () => sqlite.close() };
}
