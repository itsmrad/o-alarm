import * as Crypto from 'expo-crypto';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import type { z } from 'zod';

import { morningCheckins, preferences, sleepSessions } from '@/db/schema';
import { createOutboxRepository } from '@/db/repositories/outbox';
import type { AppDatabase, WriteContext } from '@/db/types';
import { DEFAULT_SLEEP_PREFS, sleepPrefsSchema, type SleepPrefs } from '@/domain/sleep';
import {
  DEFAULT_REMINDER_PREFS,
  reminderPrefsSchema,
  type ReminderPrefs,
} from '@/domain/sleep-reminders';
import { MAX_SESSION_MIN } from '@/domain/sleep-stats';

export type SleepSession = typeof sleepSessions.$inferSelect;
export type MorningCheckIn = typeof morningCheckins.$inferSelect;

export const SLEEP_PREFS_KEY = 'sleep.prefs';
export const REMINDER_PREFS_KEY = 'sleep.reminders';

export interface SleepServiceDeps {
  db: AppDatabase;
  deviceId: string;
  clock?: () => Date;
  newId?: () => string;
}

export interface CheckInInput {
  /** Civil date of the morning (YYYY-MM-DD). */
  date: string;
  /** 1-5, or null when skipped. */
  energy: number | null;
  /** 1-5, or null when skipped. */
  sleepQuality: number | null;
  wakeSessionId?: string | null;
}

const MINUTE_MS = 60_000;
const validRating = (value: number | null) =>
  value === null || (Number.isInteger(value) && value >= 1 && value <= 5);

/**
 * Local sleep data: sleep sessions, morning check-ins and sleep preferences, in the
 * existing tables (D31). Raw sleep data never leaves the device through this module;
 * rows reach the cloud only via the normal sync outbox for signed-in Pro accounts (D17/D22).
 */
export function createSleepService(deps: SleepServiceDeps) {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? Crypto.randomUUID;
  const outbox = createOutboxRepository(db, newId);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const ctx = (): WriteContext => ({ now: clock(), deviceId: deps.deviceId });

  const enqueue = (entity: string, entityId: string, row: Record<string, unknown>) =>
    outbox.enqueue({ entity, entityId, op: 'upsert', payload: row }, clock());

  // ---- preferences -------------------------------------------------------------------

  function readPref<T extends object>(key: string, schema: z.ZodType<T>, fallback: T): T {
    const row = db.select().from(preferences).where(eq(preferences.key, key)).get();
    if (!row || row.deletedAt) return fallback;
    const parsed = schema.safeParse({ ...fallback, ...(row.value as object) });
    return parsed.success ? parsed.data : fallback;
  }

  function writePref(key: string, value: unknown): void {
    const { now, deviceId } = ctx();
    const stamp = now.toISOString();
    const existing = db.select().from(preferences).where(eq(preferences.key, key)).get();
    let row;
    if (existing) {
      db.update(preferences)
        .set({ value, updatedAt: stamp, version: existing.version + 1, deviceId, deletedAt: null })
        .where(eq(preferences.id, existing.id))
        .run();
      row = db.select().from(preferences).where(eq(preferences.id, existing.id)).get()!;
    } else {
      row = {
        id: newId(),
        key,
        value,
        createdAt: stamp,
        updatedAt: stamp,
        version: 1,
        deletedAt: null,
        deviceId,
      };
      db.insert(preferences).values(row).run();
    }
    enqueue('preferences', row.id, row);
  }

  // ---- sleep sessions ----------------------------------------------------------------

  const openSessions = () =>
    db
      .select()
      .from(sleepSessions)
      .where(and(isNull(sleepSessions.endedAt), isNull(sleepSessions.deletedAt)))
      .orderBy(desc(sleepSessions.startedAt))
      .all();

  const getSession = (id: string) =>
    db.select().from(sleepSessions).where(eq(sleepSessions.id, id)).get() ?? null;

  const withinLimit = (startedAt: string, endedAt: string) => {
    const minutes = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / MINUTE_MS;
    return minutes > 0 && minutes <= MAX_SESSION_MIN;
  };

  function softDeleteSession(id: string, write: WriteContext): SleepSession | null {
    const existing = getSession(id);
    if (!existing || existing.deletedAt) return existing;
    const stamp = write.now.toISOString();
    db.update(sleepSessions)
      .set({
        deletedAt: stamp,
        updatedAt: stamp,
        version: existing.version + 1,
        deviceId: write.deviceId,
      })
      .where(eq(sleepSessions.id, id))
      .run();
    const row = getSession(id)!;
    enqueue('sleep_sessions', id, row);
    return row;
  }

  function updateSessionRow(id: string, fields: Partial<SleepSession>, write: WriteContext) {
    const existing = getSession(id)!;
    db.update(sleepSessions)
      .set({
        ...fields,
        updatedAt: write.now.toISOString(),
        version: existing.version + 1,
        deviceId: write.deviceId,
      })
      .where(eq(sleepSessions.id, id))
      .run();
    const row = getSession(id)!;
    enqueue('sleep_sessions', id, row);
    return row;
  }

  // ---- check-ins ---------------------------------------------------------------------

  const checkInFor = (date: string) =>
    db
      .select()
      .from(morningCheckins)
      .where(and(eq(morningCheckins.date, date), isNull(morningCheckins.deletedAt)))
      .get() ?? null;

  const service = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSleepPrefs: (): SleepPrefs =>
      readPref(SLEEP_PREFS_KEY, sleepPrefsSchema, DEFAULT_SLEEP_PREFS),
    setSleepPrefs(patch: Partial<SleepPrefs>): SleepPrefs {
      const next = sleepPrefsSchema.parse({ ...service.getSleepPrefs(), ...patch });
      writePref(SLEEP_PREFS_KEY, next);
      notify();
      return next;
    },

    getReminderPrefs: (): ReminderPrefs =>
      readPref(REMINDER_PREFS_KEY, reminderPrefsSchema, DEFAULT_REMINDER_PREFS),
    setReminderPrefs(patch: Partial<ReminderPrefs>): ReminderPrefs {
      const next = reminderPrefsSchema.parse({ ...service.getReminderPrefs(), ...patch });
      writePref(REMINDER_PREFS_KEY, next);
      notify();
      return next;
    },

    /** The session that is open right now (someone is asleep), if any. */
    getActiveSession(): SleepSession | null {
      return openSessions()[0] ?? null;
    },

    /**
     * "Going to bed". Idempotent: an already-open recent session is returned unchanged.
     * A session left open longer than MAX_SESSION_MIN is stale and is discarded first.
     */
    startSleepSession(at: Date = clock()): SleepSession {
      const open = openSessions()[0];
      if (open && withinLimit(open.startedAt, at.toISOString())) return open;
      const write = ctx();
      db.transaction(() => {
        for (const stale of openSessions()) softDeleteSession(stale.id, write);
      });
      const stamp = write.now.toISOString();
      const row: SleepSession = {
        id: newId(),
        startedAt: at.toISOString(),
        endedAt: null,
        source: 'manual',
        createdAt: stamp,
        updatedAt: stamp,
        version: 1,
        deletedAt: null,
        deviceId: write.deviceId,
      };
      db.insert(sleepSessions).values(row).run();
      enqueue('sleep_sessions', row.id, row);
      notify();
      return row;
    },

    /**
     * Ends the open session at `at` (alarm dismissal or "I'm awake"). Returns the closed
     * session, or null when nothing was open or the session was unusable (ended before it
     * started, or open longer than MAX_SESSION_MIN: discarded rather than recording nonsense).
     */
    endActiveSleepSession(at: Date = clock()): SleepSession | null {
      const [open, ...orphans] = openSessions();
      if (!open) return null;
      const write = ctx();
      const result = db.transaction(() => {
        for (const orphan of orphans) softDeleteSession(orphan.id, write);
        if (!withinLimit(open.startedAt, at.toISOString())) {
          softDeleteSession(open.id, write);
          return null;
        }
        return updateSessionRow(open.id, { endedAt: at.toISOString() }, write);
      });
      notify();
      return result;
    },

    /** Manual edit of a session's times (also used to correct an auto-ended one). */
    updateSession(id: string, times: { startedAt: Date; endedAt: Date | null }): SleepSession {
      const existing = getSession(id);
      if (!existing || existing.deletedAt) throw new Error('Sleep session not found');
      const startedAt = times.startedAt.toISOString();
      const endedAt = times.endedAt ? times.endedAt.toISOString() : null;
      if (endedAt && !withinLimit(startedAt, endedAt)) {
        throw new Error(
          `Wake time must be after bedtime, within ${MAX_SESSION_MIN / 60} hours of it.`,
        );
      }
      const row = updateSessionRow(id, { startedAt, endedAt, source: 'manual' }, ctx());
      notify();
      return row;
    },

    deleteSession(id: string): void {
      softDeleteSession(id, ctx());
      notify();
    },

    /** Newest first; `since` bounds by start time. */
    listSessions(options: { since?: Date; limit?: number } = {}): SleepSession[] {
      return db
        .select()
        .from(sleepSessions)
        .where(
          and(
            isNull(sleepSessions.deletedAt),
            options.since ? gte(sleepSessions.startedAt, options.since.toISOString()) : undefined,
          ),
        )
        .orderBy(desc(sleepSessions.startedAt))
        .limit(options.limit ?? 100)
        .all();
    },

    getCheckIn: checkInFor,

    /** True once a check-in (or an explicit skip) exists for the morning of `date`. */
    hasCheckInEntry: (date: string): boolean => checkInFor(date) !== null,

    listCheckIns(limit = 60): MorningCheckIn[] {
      return db
        .select()
        .from(morningCheckins)
        .where(isNull(morningCheckins.deletedAt))
        .orderBy(desc(morningCheckins.date))
        .limit(limit)
        .all();
    },

    /**
     * Saves the check-in for a morning, replacing an earlier one for the same date. A
     * skip is stored as a row with both ratings null, so the user is not asked again.
     */
    saveCheckIn(input: CheckInInput): MorningCheckIn {
      if (!validRating(input.energy) || !validRating(input.sleepQuality)) {
        throw new Error('Ratings must be whole numbers from 1 to 5');
      }
      const write = ctx();
      const stamp = write.now.toISOString();
      const existing = checkInFor(input.date);
      let id: string;
      if (existing) {
        id = existing.id;
        db.update(morningCheckins)
          .set({
            energy: input.energy,
            sleepQuality: input.sleepQuality,
            wakeSessionId: input.wakeSessionId ?? existing.wakeSessionId,
            updatedAt: stamp,
            version: existing.version + 1,
            deviceId: write.deviceId,
          })
          .where(eq(morningCheckins.id, id))
          .run();
      } else {
        id = newId();
        db.insert(morningCheckins)
          .values({
            id,
            date: input.date,
            energy: input.energy,
            sleepQuality: input.sleepQuality,
            wakeSessionId: input.wakeSessionId ?? null,
            createdAt: stamp,
            updatedAt: stamp,
            version: 1,
            deletedAt: null,
            deviceId: write.deviceId,
          })
          .run();
      }
      const row = db.select().from(morningCheckins).where(eq(morningCheckins.id, id)).get()!;
      enqueue('morning_checkins', id, row);
      notify();
      return row;
    },

    skipCheckIn(date: string, wakeSessionId?: string | null): MorningCheckIn {
      const existing = checkInFor(date);
      // A skip must never wipe an answer that is already saved.
      if (existing && (existing.energy !== null || existing.sleepQuality !== null)) return existing;
      return service.saveCheckIn({ date, energy: null, sleepQuality: null, wakeSessionId });
    },
  };
  return service;
}

export type SleepService = ReturnType<typeof createSleepService>;
