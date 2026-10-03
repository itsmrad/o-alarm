import { and, asc, eq, gt, inArray, or, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import { deviceTimeZone } from '@/db/alarm-service';
import { createAlarmsRepository, rowToAlarm } from '@/db/repositories/alarms';
import {
  alarmOccurrences,
  alarms,
  events,
  missionAttempts,
  morningCheckins,
  sleepSessions,
  wakeChecks,
  wakeSessions,
  type AlarmRow,
} from '@/db/schema';
import type { AppDatabase } from '@/db/types';
import type { WakeCheckConfig } from '@/domain';
import type { Tier } from '@/lib/entitlements';

import { createLocalSyncStore } from './local-store';
import {
  alarmFromCloud,
  alarmToCloud,
  eventToCloud,
  missionAttemptToCloud,
  morningCheckinToCloud,
  occurrenceToCloud,
  sleepSessionToCloud,
  wakeCheckToCloud,
  wakeSessionToCloud,
  type MapContext,
  type PulledAlarm,
} from './mapping';
import {
  toSyncError,
  type SyncError,
  type CloudRow,
  type CloudTable,
  type PullCursor,
  type SyncErrorKind,
  type SyncTransport,
} from './transport';
import { isUuid, uuidV5 } from './uuid';

/**
 * Offline-first cloud sync (D17, D22).
 *
 * One `run()` = [one-time guest migration] → register user/device → pull alarms → push alarm
 * outbox → push history → write sync_state. Rules:
 *   - Never throws and never blocks the UI: it is async, single-flight, and every failure is
 *     recorded in `getStatus()` with an exponential-backoff `nextRetryAt`.
 *   - Never touches the alarm engine. Pulled alarm changes go through the alarms repository
 *     into SQLite, then `reconcile()` (the alarm service's normal reconcile path) schedules.
 *   - Conflicts are last-writer-wins per row: the server's `updated_at` orders accepted writes;
 *     a local row only beats a pulled row when it has an unpushed change made after it.
 *   - Tombstones (`deleted_at`) travel both ways.
 *   - Runs only for Pro (D22), except the one-time guest → account migration.
 */

export interface DeviceInfo {
  platform: 'ios' | 'android';
  osVersion: string | null;
  appVersion: string | null;
  model: string | null;
  alarmEngine: 'native' | 'preview';
}

export interface SyncEngineDeps {
  db: AppDatabase;
  transport: SyncTransport;
  userId: string;
  deviceId: string;
  device: DeviceInfo;
  getTier: () => Tier;
  /** The normal reconcile path (alarm service `reconcileAll`). Called after pulled alarm writes. */
  reconcile: () => Promise<unknown>;
  clock?: () => Date;
  timeZone?: () => string;
  /** 0..1, for backoff jitter. */
  random?: () => number;
}

export type SyncOutcome =
  /** Full sync done. */
  | 'synced'
  /** Free tier: the one-time migration ran (or was already done); nothing else syncs. */
  | 'not_entitled'
  /** Backoff window not elapsed (use `force`). */
  | 'backoff'
  | 'failed';

export interface SyncRunResult {
  outcome: SyncOutcome;
  pushed: number;
  pulled: number;
  applied: number;
  skipped: number;
  error?: SyncError;
}

export interface SyncEngineStatus {
  running: boolean;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastErrorKind: SyncErrorKind | null;
  /** Consecutive failed runs (drives backoff). */
  failures: number;
  nextRetryAt: string | null;
  /** Local alarm writes not yet in the cloud. */
  pendingCount: number;
  migratedAt: string | null;
  /** Rows the cloud rejected permanently in the last run (kept locally, not retried). */
  skipped: number;
}

const PAGE = 200;
const PULL_OVERLAP_MS = 5_000;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const EPOCH: PullCursor = { updatedAt: '1970-01-01T00:00:00.000Z', id: ZERO_UUID };
const PARKED_MAX_MS = 24 * 60 * 60_000;
/** Local tables pushed by history scan (outbox entries for them are redundant). */
const HISTORY_ENTITIES = [
  'alarm_occurrences',
  'wake_sessions',
  'mission_attempts',
  'wake_checks',
  'sleep_sessions',
  'morning_checkins',
  'events',
] as const;
/** Outbox entities that cloud sync uploads (others, e.g. preferences, are not synced yet). */
const SYNCED_ENTITIES = ['alarms', ...HISTORY_ENTITIES];

/** Delay before retry `attempt` (1-based): 30 s doubling to 30 min, with 50–100 % jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
  return Math.round(base * (0.5 + random() * 0.5));
}

/** Postgres timestamps carry microseconds; JS dates only parse milliseconds reliably. */
const toMs = (iso: string) => Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));

const isLater = (a: PullCursor, b: PullCursor) =>
  toMs(a.updatedAt) > toMs(b.updatedAt) || (a.updatedAt === b.updatedAt && a.id > b.id);

type Syncable = SQLiteTable & {
  id: SQLiteColumn;
  updatedAt: SQLiteColumn;
};

interface HistoryTable {
  cloud: CloudTable;
  local: Syncable;
  /** Maps one batch of local rows; null entries are skipped (not representable in the cloud). */
  map: (rows: any[], ctx: MapContext) => (CloudRow | null)[];
}

export function createSyncEngine(deps: SyncEngineDeps) {
  const clock = deps.clock ?? (() => new Date());
  const timeZone = deps.timeZone ?? deviceTimeZone;
  const random = deps.random ?? Math.random;
  const store = createLocalSyncStore(deps.db);
  const alarmsRepo = createAlarmsRepository(deps.db);
  const cloudDeviceId = isUuid(deps.deviceId) ? deps.deviceId : uuidV5(`device:${deps.deviceId}`);
  const listeners = new Set<() => void>();

  let inFlight: Promise<SyncRunResult> | null = null;
  let registered = false;
  let skipped = 0;
  const status: Omit<SyncEngineStatus, 'pendingCount' | 'migratedAt' | 'lastSyncedAt'> = {
    running: false,
    lastAttemptAt: null,
    lastError: null,
    lastErrorKind: null,
    failures: 0,
    nextRetryAt: null,
    skipped: 0,
  };

  const notify = () => listeners.forEach((listener) => listener());
  const mapContext = (): MapContext => ({
    userId: deps.userId,
    deviceId: cloudDeviceId,
    timeZone: timeZone(),
  });

  // ------------------------------------------------------------------ push helpers

  /** Upserts rows; isolates permanently rejected rows. Returns the ids that were accepted. */
  async function pushRows(table: CloudTable, rows: CloudRow[]): Promise<Set<string>> {
    if (rows.length === 0) return new Set();
    try {
      await deps.transport.upsert(table, rows);
      return new Set(rows.map((row) => row.id));
    } catch (error) {
      const syncError = toSyncError(error);
      if (syncError.kind !== 'permanent') throw syncError;
      if (rows.length === 1) {
        skipped += 1;
        status.lastError = `${table}: ${syncError.message}`;
        status.lastErrorKind = 'permanent';
        return new Set();
      }
    }
    // A batch failed on a bad row: retry one by one so good rows still go through.
    const accepted = new Set<string>();
    for (const row of rows) {
      for (const id of await pushRows(table, [row])) accepted.add(id);
    }
    return accepted;
  }

  async function ensureRegistered(): Promise<void> {
    if (registered) return;
    const now = clock().toISOString();
    await deps.transport.upsertUser({ id: deps.userId, timezone: timeZone() });
    await deps.transport.upsert('devices', [
      {
        id: uuidV5(`device:${deps.userId}:${cloudDeviceId}`),
        user_id: deps.userId,
        device_id: cloudDeviceId,
        platform: deps.device.platform,
        os_version: deps.device.osVersion,
        app_version: deps.device.appVersion,
        device_model: deps.device.model,
        timezone: timeZone(),
        alarm_engine: deps.device.alarmEngine,
        last_seen_at: now,
      },
    ]);
    registered = true;
  }

  const alarmCloudRow = (row: AlarmRow) =>
    alarmToCloud(row, rowToAlarm(row), mapContext()) as unknown as CloudRow;

  /** Pushes due alarm outbox entries (coalesced per alarm, current row wins). */
  async function pushOutbox(): Promise<number> {
    const now = clock();
    const due = store.outbox.due(now).filter((entry) => entry.entity === 'alarms');
    const byAlarm = new Map<string, { ids: string[]; attempts: number; row: AlarmRow }>();
    for (const entry of due) {
      const current = alarmsRepo.getRow(entry.entityId) ?? (entry.payload as unknown as AlarmRow);
      const group = byAlarm.get(entry.entityId);
      if (group) {
        group.ids.push(entry.id);
        group.attempts = Math.max(group.attempts, entry.attempts);
      } else {
        byAlarm.set(entry.entityId, { ids: [entry.id], attempts: entry.attempts, row: current });
      }
    }
    const groups = [...byAlarm.values()];
    let pushed = 0;
    for (let i = 0; i < groups.length; i += PAGE) {
      const batch = groups.slice(i, i + PAGE);
      const accepted = await pushRows(
        'alarms',
        batch.map((group) => alarmCloudRow(group.row)),
      );
      for (const group of batch) {
        if (accepted.has(group.row.id)) {
          store.outbox.remove(group.ids);
          pushed += 1;
        } else {
          // Rejected permanently: park it (an app update may make it acceptable).
          const delay = Math.min(backoffDelay(group.attempts + 1, random), PARKED_MAX_MS);
          store.outbox.markFailed(
            group.ids,
            status.lastError ?? 'rejected',
            new Date(now.getTime() + delay).toISOString(),
          );
        }
      }
    }
    return pushed;
  }

  // History tables are scanned by local (updated_at, id) high-water mark, parents first.
  const historyTables: HistoryTable[] = [
    {
      cloud: 'alarm_occurrences',
      local: alarmOccurrences,
      map: (rows, ctx) => rows.map((row) => occurrenceToCloud(row, ctx)),
    },
    {
      cloud: 'wake_sessions',
      local: wakeSessions,
      map: (rows, ctx) => {
        const known = existing(
          alarmOccurrences,
          alarmOccurrences.occurrenceKey,
          rows.map((r) => r.occurrenceKey),
        );
        return rows.map((row) =>
          known.has(row.occurrenceKey) ? wakeSessionToCloud(row, ctx) : null,
        );
      },
    },
    {
      cloud: 'mission_attempts',
      local: missionAttempts,
      map: (rows, ctx) => {
        const known = existing(
          wakeSessions,
          wakeSessions.id,
          rows.map((r) => r.wakeSessionId),
        );
        return rows.map((row) =>
          known.has(row.wakeSessionId) ? missionAttemptToCloud(row, ctx) : null,
        );
      },
    },
    {
      cloud: 'wake_checks',
      local: wakeChecks,
      map: (rows, ctx) => {
        const known = existing(
          wakeSessions,
          wakeSessions.id,
          rows.map((r) => r.wakeSessionId),
        );
        return rows.map((row) =>
          known.has(row.wakeSessionId)
            ? wakeCheckToCloud(row, ctx, wakeCheckMethod(row.occurrenceKey))
            : null,
        );
      },
    },
    {
      cloud: 'sleep_sessions',
      local: sleepSessions,
      map: (rows, ctx) => rows.map((row) => sleepSessionToCloud(row, ctx)),
    },
    {
      cloud: 'morning_checkins',
      local: morningCheckins,
      map: (rows, ctx) => rows.map((row) => morningCheckinToCloud(row, ctx)),
    },
    {
      cloud: 'events',
      local: events,
      map: (rows, ctx) => rows.map((row) => eventToCloud(row, ctx)),
    },
  ];

  /** Which of `values` exist locally in `column` (children are pushed only with their parent). */
  function existing(table: SQLiteTable, column: SQLiteColumn, values: string[]): Set<string> {
    if (values.length === 0) return new Set();
    return new Set(
      deps.db
        .select({ value: column })
        .from(table)
        .where(inArray(column, values))
        .all()
        .map((row) => row.value as string),
    );
  }

  function wakeCheckMethod(occurrenceKey: string): WakeCheckConfig['method'] {
    const alarmId = occurrenceKey.slice(0, occurrenceKey.lastIndexOf('@'));
    const row = alarmId ? alarmsRepo.getRow(alarmId) : null;
    return row?.wakeCheck.method ?? 'confirm';
  }

  /** Pushes every local row of `table` changed since the stored cursor, in pages. */
  async function pushScan(
    cloud: CloudTable | 'alarms',
    local: Syncable,
    map: (rows: any[], ctx: MapContext) => (CloudRow | null)[],
  ): Promise<Set<string>> {
    const pushed = new Set<string>();
    for (;;) {
      const cursor = store.pushCursor(deps.userId, cloud) ?? EPOCH;
      const where: SQL | undefined = or(
        gt(local.updatedAt, cursor.updatedAt),
        and(eq(local.updatedAt, cursor.updatedAt), gt(local.id, cursor.id)),
      );
      const rows = deps.db
        .select()
        .from(local)
        .where(where)
        .orderBy(asc(local.updatedAt), asc(local.id))
        .limit(PAGE)
        .all() as { id: string; updatedAt: string }[];
      if (rows.length === 0) return pushed;
      const mapped = map(rows, mapContext()).filter((row): row is CloudRow => row !== null);
      for (const id of await pushRows(cloud, mapped)) pushed.add(id);
      const last = rows[rows.length - 1]!;
      store.setPushCursor(deps.userId, cloud, { updatedAt: last.updatedAt, id: last.id }, clock());
      if (rows.length < PAGE) return pushed;
    }
  }

  /** Pushes every history table; outbox entries other features queued for them are covered. */
  async function pushHistory(): Promise<number> {
    const startedAt = clock().toISOString();
    let pushed = 0;
    for (const table of historyTables) {
      pushed += (await pushScan(table.cloud, table.local, table.map)).size;
    }
    store.outbox.removeEntities(HISTORY_ENTITIES, startedAt);
    return pushed;
  }

  // ------------------------------------------------------------------ pull

  /** Applies one pulled alarm (LWW). Returns true when SQLite changed. */
  function applyRemote(remote: PulledAlarm): boolean {
    const local = alarmsRepo.getRow(remote.id);
    const pending = store.outbox.forEntity('alarms', remote.id);
    if (pending.length > 0 && local) {
      // This device's own earlier write can never beat its later pending edit. Against another
      // device, the newer write wins: the pending local change only if made after the remote one.
      if (remote.device_id === cloudDeviceId) return false;
      if (toMs(local.updatedAt) > toMs(remote.updated_at)) return false;
    }
    if (pending.length > 0) store.outbox.remove(pending.map((entry) => entry.id));
    const ctx = { now: clock(), deviceId: remote.device_id };
    if (remote.deleted_at) {
      if (!local || local.deletedAt) return false;
      alarmsRepo.softDelete(remote.id, ctx);
      return true;
    }
    const alarm = alarmFromCloud(remote);
    if (!alarm) {
      skipped += 1;
      status.lastError = `alarms: cloud row ${remote.id} is not a valid local alarm`;
      status.lastErrorKind = 'permanent';
      return false;
    }
    if (local && !local.deletedAt && sameJson(rowToAlarm(local), alarm)) return false;
    alarmsRepo.upsert(alarm, ctx);
    return true;
  }

  async function pullAlarms(): Promise<{ pulled: number; applied: number }> {
    const stored = store.pullCursor(deps.userId);
    let after: PullCursor = stored
      ? {
          updatedAt: new Date(toMs(stored.updatedAt) - PULL_OVERLAP_MS).toISOString(),
          id: ZERO_UUID,
        }
      : EPOCH;
    let newest = stored;
    let pulled = 0;
    let applied = 0;
    for (;;) {
      const rows = await deps.transport.pullAlarms(after, PAGE);
      for (const row of rows) {
        pulled += 1;
        if (applyRemote(row)) applied += 1;
        const position = { updatedAt: row.updated_at, id: row.id };
        if (!newest || isLater(position, newest)) newest = position;
      }
      if (rows.length < PAGE) break;
      const last = rows[rows.length - 1]!;
      after = { updatedAt: last.updated_at, id: last.id };
    }
    if (newest) store.setPullCursor(deps.userId, newest, clock());
    // Pulled changes reach the OS only through the normal reconcile path (D17).
    if (applied > 0) await deps.reconcile();
    return { pulled, applied };
  }

  // ------------------------------------------------------------------ migration

  /** One-time guest → account upload (D22): idempotent and resumable via push cursors. */
  async function migrate(tier: Tier): Promise<number> {
    const startedAt = clock().toISOString();
    const window = await deps.transport.beginGuestMigration(cloudDeviceId);
    let pushed = 0;
    if (window.open || tier === 'pro') {
      await ensureRegistered();
      const uploaded = await pushScan('alarms', alarms, (rows: AlarmRow[]) =>
        rows.map(alarmCloudRow),
      );
      pushed += uploaded.size + (await pushHistory());
      // Uploaded alarms' earlier outbox entries are covered; rejected ones stay queued (parked).
      store.outbox.removeCreatedBefore('alarms', startedAt, uploaded);
      if (window.open) await deps.transport.completeGuestMigration();
    }
    store.updateAccount(deps.userId, { migratedAt: clock().toISOString() }, clock());
    return pushed;
  }

  async function writeCloudSyncState(): Promise<void> {
    const account = store.account(deps.userId);
    const cursor = store.pullCursor(deps.userId);
    const now = clock().toISOString();
    await deps.transport.upsert('sync_state', [
      {
        id: uuidV5(`sync_state:${deps.userId}:${cloudDeviceId}`),
        user_id: deps.userId,
        device_id: cloudDeviceId,
        last_pushed_at: now,
        last_pulled_at: now,
        pull_cursor: cursor?.updatedAt ?? null,
        guest_migrated_at: account.migratedAt,
        schema_version: 1,
        last_error: status.lastErrorKind === 'permanent' ? status.lastError?.slice(0, 500) : null,
      },
    ]);
  }

  // ------------------------------------------------------------------ run

  async function cycle(): Promise<SyncRunResult> {
    const result: SyncRunResult = {
      outcome: 'synced',
      pushed: 0,
      pulled: 0,
      applied: 0,
      skipped: 0,
    };
    const tier = deps.getTier();
    if (!store.account(deps.userId).migratedAt) result.pushed += await migrate(tier);
    if (tier !== 'pro') return { ...result, outcome: 'not_entitled' };
    await ensureRegistered();
    // Pull before push: a pending local change only overwrites the cloud when it is newer (LWW).
    const pull = await pullAlarms();
    result.pulled = pull.pulled;
    result.applied = pull.applied;
    result.pushed += await pushOutbox();
    result.pushed += await pushHistory();
    await writeCloudSyncState();
    store.updateAccount(deps.userId, { lastSyncedAt: clock().toISOString() }, clock());
    return result;
  }

  async function execute(): Promise<SyncRunResult> {
    status.running = true;
    status.lastAttemptAt = clock().toISOString();
    skipped = 0;
    status.lastError = null;
    status.lastErrorKind = null;
    notify();
    try {
      const result = await cycle();
      status.failures = 0;
      status.nextRetryAt = null;
      status.skipped = skipped;
      return { ...result, skipped };
    } catch (error) {
      const syncError = toSyncError(error);
      status.failures += 1;
      status.lastError = syncError.message;
      status.lastErrorKind = syncError.kind;
      status.skipped = skipped;
      status.nextRetryAt = new Date(
        clock().getTime() + backoffDelay(status.failures, random),
      ).toISOString();
      return { outcome: 'failed', pushed: 0, pulled: 0, applied: 0, skipped, error: syncError };
    } finally {
      status.running = false;
      inFlight = null;
      notify();
    }
  }

  return {
    /**
     * Runs one sync cycle. Single-flight: concurrent callers share the running cycle. During a
     * backoff window it returns `backoff` without touching the network unless `force` is set.
     */
    run(options: { force?: boolean } = {}): Promise<SyncRunResult> {
      if (inFlight) return inFlight;
      if (!options.force && status.nextRetryAt && toMs(status.nextRetryAt) > clock().getTime()) {
        return Promise.resolve({
          outcome: 'backoff',
          pushed: 0,
          pulled: 0,
          applied: 0,
          skipped: 0,
        });
      }
      inFlight = execute();
      return inFlight;
    },
    getStatus(): SyncEngineStatus {
      const account = store.account(deps.userId);
      return {
        ...status,
        lastSyncedAt: account.lastSyncedAt,
        migratedAt: account.migratedAt,
        pendingCount: store.outbox.count(SYNCED_ENTITIES),
      };
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exportMyData: () => deps.transport.exportMyData(),
    deleteMyData: () => deps.transport.deleteMyData(),
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;

/** Order-insensitive deep equality for plain JSON values. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as any)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameJson((a as any)[k], (b as any)[k]));
}
