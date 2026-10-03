import type { PulledAlarm } from './mapping';

/** Cloud tables the client pushes (supabase/migrations). */
export type CloudTable =
  | 'devices'
  | 'alarms'
  | 'alarm_occurrences'
  | 'wake_sessions'
  | 'mission_attempts'
  | 'wake_checks'
  | 'sleep_sessions'
  | 'morning_checkins'
  | 'sync_state'
  | 'events';

export type CloudRow = { id: string } & Record<string, unknown>;

/** Keyset position in a `(updated_at, id)`-ordered pull. */
export interface PullCursor {
  updatedAt: string;
  id: string;
}

export interface GuestMigrationState {
  /** Uploads are allowed by the one-time migration window (D22). */
  open: boolean;
  completedAt: string | null;
}

/**
 * Everything the sync engine needs from the cloud. The Supabase implementation lives in
 * `supabase-transport.ts`; tests use a fake. Every method throws a `SyncError` on failure.
 */
export interface SyncTransport {
  /** Creates/updates the caller's `users` row (FK parent of everything else). */
  upsertUser(row: { id: string; timezone: string | null }): Promise<void>;
  /** Idempotent upsert by primary key. `events` are insert-or-ignore (append-only). */
  upsert(table: CloudTable, rows: CloudRow[]): Promise<void>;
  /** Alarms strictly after `after` in `(updated_at, id)` order, at most `limit`. */
  pullAlarms(after: PullCursor, limit: number): Promise<PulledAlarm[]>;
  beginGuestMigration(deviceId: string): Promise<GuestMigrationState>;
  completeGuestMigration(): Promise<void>;
  exportMyData(): Promise<unknown>;
  deleteMyData(): Promise<Record<string, number>>;
}

/**
 * - `network`: offline / timeout / DNS. Retry with backoff.
 * - `auth`: missing or expired token. Retry with backoff (Clerk refreshes the token).
 * - `server`: 5xx / 429. Retry with backoff.
 * - `forbidden`: RLS rejected the write (not Pro, D22). Stop until the entitlement changes.
 * - `permanent`: this row can never be accepted (constraint violation). Skip it, don't retry.
 */
export type SyncErrorKind = 'network' | 'auth' | 'server' | 'forbidden' | 'permanent';

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }

  get transient(): boolean {
    return this.kind === 'network' || this.kind === 'auth' || this.kind === 'server';
  }
}

/** Classifies a PostgREST/Postgres error (`{ code, message }` + HTTP status). */
export function classifyError(
  error: { code?: string; message?: string; details?: string } | null | undefined,
  status?: number,
): SyncError {
  const code = error?.code ?? '';
  const message =
    error?.message || error?.details || (status ? `HTTP ${status}` : 'Network request failed');
  if (code === '42501') return new SyncError('forbidden', message, code);
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303' || /jwt/i.test(message)) {
    return new SyncError('auth', message, code);
  }
  // No HTTP status: the request never got a response (offline, DNS, timeout).
  if (!status) return new SyncError('network', message, code);
  if (status === 403) return new SyncError('forbidden', message, code);
  if (status === 429 || status >= 500) return new SyncError('server', message, code);
  // 22xxx data exceptions, 23xxx integrity violations, PGRST1xx/2xx request errors.
  return new SyncError('permanent', message, code);
}

export function toSyncError(error: unknown): SyncError {
  if (error instanceof SyncError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SyncError('network', message);
}
