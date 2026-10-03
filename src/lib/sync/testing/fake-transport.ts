import type { PulledAlarm } from '../mapping';
import {
  SyncError,
  type CloudRow,
  type CloudTable,
  type GuestMigrationState,
  type PullCursor,
  type SyncTransport,
} from '../transport';

type StoredRow = CloudRow & { updated_at?: string; version?: number; created_at?: string };

/**
 * In-memory cloud that behaves like the Supabase schema where sync cares: server-stamped
 * `updated_at`/`version`, LWW upserts, insert-or-ignore events, `(updated_at, id)` pulls,
 * D22 write gating (pro or open migration window), plus switchable outages and rejections.
 */
export class FakeTransport implements SyncTransport {
  tables = new Map<string, Map<string, StoredRow>>();
  users = new Map<string, { id: string; timezone: string | null }>();
  calls: string[] = [];
  /** Server entitlement (what RLS sees). */
  pro = true;
  offline = false;
  /** Errors thrown by the next calls, in order. */
  failNext: SyncError[] = [];
  /** Row ids the server rejects as constraint violations. */
  rejectIds = new Set<string>();
  migration: { startedAt: string; completedAt: string | null } | null = null;
  private tick = Date.parse('2026-10-03T00:00:00.000Z');

  private stamp(): string {
    this.tick += 1000;
    // Postgres-style: microseconds + numeric offset.
    return new Date(this.tick).toISOString().replace('Z', '123+00:00');
  }

  private gate(op: string): void {
    this.calls.push(op);
    if (this.offline) throw new SyncError('network', 'Network request failed');
    const next = this.failNext.shift();
    if (next) throw next;
  }

  private canWrite(): boolean {
    return this.pro || (this.migration !== null && this.migration.completedAt === null);
  }

  table(name: string): Map<string, StoredRow> {
    let table = this.tables.get(name);
    if (!table) this.tables.set(name, (table = new Map()));
    return table;
  }

  rows(name: string): StoredRow[] {
    return [...this.table(name).values()];
  }

  /** Simulates a write from another device (bypasses gating). */
  serverWrite<T extends { id: string }>(table: CloudTable, row: T): StoredRow {
    const existing = this.table(table).get(row.id);
    const stored: StoredRow = {
      ...existing,
      ...row,
      created_at: existing?.created_at ?? (row as { created_at?: string }).created_at,
      version: (existing?.version ?? 0) + 1,
      updated_at: this.stamp(),
    };
    this.table(table).set(row.id, stored);
    return stored;
  }

  async upsertUser(row: { id: string; timezone: string | null }): Promise<void> {
    this.gate('upsertUser');
    this.users.set(row.id, row);
  }

  async upsert(table: CloudTable, rows: CloudRow[]): Promise<void> {
    this.gate(`upsert:${table}:${rows.length}`);
    if (!this.canWrite())
      throw new SyncError('forbidden', 'new row violates row-level security policy', '42501');
    const bad = rows.find((row) => this.rejectIds.has(row.id));
    if (bad) throw new SyncError('permanent', `check constraint violated by ${bad.id}`, '23514');
    for (const row of rows) {
      if (table === 'events' && this.table(table).has(row.id)) continue;
      this.serverWrite(table, row);
    }
  }

  async pullAlarms(after: PullCursor, limit: number): Promise<PulledAlarm[]> {
    this.gate('pullAlarms');
    const ms = (iso: string) => Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
    return this.rows('alarms')
      .filter(
        (row) =>
          ms(row.updated_at!) > ms(after.updatedAt) ||
          (ms(row.updated_at!) === ms(after.updatedAt) && row.id > after.id),
      )
      .sort((a, b) => ms(a.updated_at!) - ms(b.updated_at!) || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((row) => ({ ...row }) as unknown as PulledAlarm);
  }

  async beginGuestMigration(): Promise<GuestMigrationState> {
    this.gate('beginGuestMigration');
    this.migration ??= { startedAt: this.stamp(), completedAt: null };
    return { open: this.migration.completedAt === null, completedAt: this.migration.completedAt };
  }

  async completeGuestMigration(): Promise<void> {
    this.gate('completeGuestMigration');
    if (this.migration) this.migration.completedAt ??= this.stamp();
  }

  async exportMyData(): Promise<unknown> {
    this.gate('exportMyData');
    return { tables: Object.fromEntries([...this.tables].map(([k, v]) => [k, [...v.values()]])) };
  }

  async deleteMyData(): Promise<Record<string, number>> {
    this.gate('deleteMyData');
    const counts = Object.fromEntries([...this.tables].map(([k, v]) => [k, v.size]));
    this.tables.clear();
    this.users.clear();
    return counts;
  }
}
