import { device } from '../schema';
import type { AppDatabase } from '../types';

/** Returns this installation's device id, creating it on first launch. */
export function getOrCreateDeviceId(
  db: AppDatabase,
  newId: () => string,
  platform: string,
  now: Date,
): string {
  const existing = db.select().from(device).limit(1).get();
  if (existing) return existing.id;
  const id = newId();
  db.insert(device).values({ id, platform, createdAt: now.toISOString() }).run();
  return id;
}
