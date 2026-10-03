import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type {
  AlarmSound,
  Escalation,
  OneOffOverride,
  SnoozePolicy,
  WakeCheckConfig,
  WakeCheckState,
} from '@/domain';
import type { MissionStep } from '@/domain/missions';

/**
 * Local SQLite schema (D8). SQLite is the on-device source of truth for alarms.
 * Timestamps are ISO-8601 UTC strings. Every syncable row carries the D17 sync columns.
 * After editing, run `npm run db:generate` to add a migration.
 */
const syncColumns = () => ({
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  version: integer('version').notNull().default(1),
  deletedAt: text('deleted_at'),
  deviceId: text('device_id').notNull(),
});

const bool = (name: string) => integer(name, { mode: 'boolean' });
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

export const alarms = sqliteTable('alarms', {
  ...syncColumns(),
  hour: integer('hour').notNull(),
  minute: integer('minute').notNull(),
  weekdays: json<number[]>('weekdays').notNull(),
  date: text('date'),
  timezonePolicy: text('timezone_policy', { enum: ['floating', 'fixed'] }).notNull(),
  timeZone: text('time_zone'),
  label: text('label').notNull().default(''),
  enabled: bool('enabled').notNull(),
  sound: json<AlarmSound>('sound').notNull(),
  vibration: bool('vibration').notNull(),
  escalation: json<Escalation>('escalation').notNull(),
  snooze: json<SnoozePolicy>('snooze').notNull(),
  skipNext: text('skip_next'),
  oneOffOverride: json<OneOffOverride>('one_off_override'),
  missions: json<MissionStep[]>('missions').notNull(),
  wakeCheck: json<WakeCheckConfig>('wake_check').notNull(),
  important: bool('important').notNull(),
  missionBeforeSnooze: bool('mission_before_snooze').notNull().default(false),
});

export const alarmOccurrences = sqliteTable(
  'alarm_occurrences',
  {
    ...syncColumns(),
    alarmId: text('alarm_id').notNull(),
    occurrenceKey: text('occurrence_key').notNull(),
    expectedAt: text('expected_at').notNull(),
    status: text('status', {
      enum: ['scheduled', 'triggered', 'snoozed', 'dismissed', 'missed', 'skipped', 'cancelled'],
    }).notNull(),
    triggeredAt: text('triggered_at'),
    dismissedAt: text('dismissed_at'),
    snoozeCount: integer('snooze_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('alarm_occurrences_key_idx').on(t.occurrenceKey),
    index('alarm_occurrences_alarm_idx').on(t.alarmId),
  ],
);

export const wakeSessions = sqliteTable(
  'wake_sessions',
  {
    ...syncColumns(),
    alarmId: text('alarm_id').notNull(),
    occurrenceKey: text('occurrence_key').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    outcome: text('outcome', { enum: ['awake', 'retriggered', 'abandoned'] }),
    snoozeCount: integer('snooze_count').notNull().default(0),
    dismissMethod: text('dismiss_method', { enum: ['mission', 'button', 'system_stop'] }),
  },
  (t) => [index('wake_sessions_occurrence_idx').on(t.occurrenceKey)],
);

export const missionAttempts = sqliteTable(
  'mission_attempts',
  {
    ...syncColumns(),
    wakeSessionId: text('wake_session_id').notNull(),
    missionId: text('mission_id').notNull(),
    stepIndex: integer('step_index').notNull(),
    outcome: text('outcome', { enum: ['completed', 'failed', 'abandoned'] }),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    details: json<Record<string, unknown>>('details'),
  },
  (t) => [index('mission_attempts_session_idx').on(t.wakeSessionId)],
);

export const wakeChecks = sqliteTable(
  'wake_checks',
  {
    ...syncColumns(),
    wakeSessionId: text('wake_session_id').notNull(),
    occurrenceKey: text('occurrence_key').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status', {
      enum: ['idle', 'armed', 'pending_verification', 'passed', 'failed', 'retriggered'],
    }).notNull(),
    /** Full reducer state (src/domain/wake-check.ts), persisted across app restarts. */
    state: json<WakeCheckState>('state').notNull(),
  },
  (t) => [
    index('wake_checks_session_idx').on(t.wakeSessionId),
    // One Wake Check row per occurrence (upserted); migration 0002 dedupes first.
    uniqueIndex('wake_checks_occurrence_idx').on(t.occurrenceKey),
  ],
);

export const sleepSessions = sqliteTable('sleep_sessions', {
  ...syncColumns(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  source: text('source', { enum: ['manual', 'estimated'] }).notNull(),
});

export const morningCheckins = sqliteTable(
  'morning_checkins',
  {
    ...syncColumns(),
    /** Civil date of the morning (YYYY-MM-DD). */
    date: text('date').notNull(),
    /** 1-5 */
    energy: integer('energy'),
    /** 1-5 */
    sleepQuality: integer('sleep_quality'),
    wakeSessionId: text('wake_session_id'),
  },
  (t) => [index('morning_checkins_date_idx').on(t.date)],
);

export const preferences = sqliteTable(
  'preferences',
  {
    ...syncColumns(),
    key: text('key').notNull(),
    value: json<unknown>('value').notNull(),
  },
  (t) => [uniqueIndex('preferences_key_idx').on(t.key)],
);

/** D12: append-only local event log. Never updated in place. */
export const events = sqliteTable(
  'events',
  {
    ...syncColumns(),
    type: text('type').notNull(),
    occurredAt: text('occurred_at').notNull(),
    alarmId: text('alarm_id'),
    occurrenceKey: text('occurrence_key'),
    payload: json<Record<string, unknown>>('payload').notNull(),
  },
  (t) => [
    index('events_occurred_at_idx').on(t.occurredAt),
    index('events_type_idx').on(t.type),
    index('events_alarm_idx').on(t.alarmId),
  ],
);

/** D17: pending cloud writes. Local-only (not itself synced). */
export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    op: text('op', { enum: ['upsert', 'delete'] }).notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    createdAt: text('created_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: text('next_attempt_at'),
  },
  (t) => [index('outbox_created_at_idx').on(t.createdAt)],
);

/** Per-entity sync cursors. Local-only. */
export const syncState = sqliteTable('sync_state', {
  entity: text('entity').primaryKey(),
  lastPulledAt: text('last_pulled_at'),
  cursor: text('cursor'),
  updatedAt: text('updated_at').notNull(),
});

/** This installation. `id` is the device_id stamped on every syncable write. */
export const device = sqliteTable('device', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  createdAt: text('created_at').notNull(),
});

export type AlarmRow = typeof alarms.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
