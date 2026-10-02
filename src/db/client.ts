import { drizzle } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { openDatabaseSync } from 'expo-sqlite';

import migrations from './migrations/migrations';
import * as schema from './schema';
import type { AppDatabase } from './types';

export const DATABASE_NAME = 'oalarm.db';

/** Opens the on-device database and applies bundled migrations (D8). */
export async function openAppDatabase(): Promise<AppDatabase> {
  const sqlite = openDatabaseSync(DATABASE_NAME);
  sqlite.execSync('PRAGMA journal_mode = WAL;');
  const db = drizzle(sqlite, { schema });
  await migrate(db, migrations);
  return db;
}
