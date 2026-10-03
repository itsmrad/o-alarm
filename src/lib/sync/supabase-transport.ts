import type { SupabaseClient } from '@supabase/supabase-js';

import type { PulledAlarm } from './mapping';
import {
  classifyError,
  toSyncError,
  type CloudRow,
  type CloudTable,
  type GuestMigrationState,
  type PullCursor,
  type SyncTransport,
} from './transport';

type Response<T> = {
  data: T | null;
  error: { code?: string; message?: string } | null;
  status: number;
};

async function call<T>(request: PromiseLike<Response<T>>): Promise<T | null> {
  let response: Response<T>;
  try {
    response = await request;
  } catch (error) {
    throw toSyncError(error);
  }
  if (response.error) throw classifyError(response.error, response.status);
  return response.data;
}

/** SyncTransport over PostgREST (RLS scopes every call to the Clerk `sub`). */
export function createSupabaseTransport(client: SupabaseClient): SyncTransport {
  return {
    async upsertUser(row) {
      await call(client.from('users').upsert(row, { onConflict: 'id' }));
    },
    async upsert(table: CloudTable, rows: CloudRow[]) {
      await call(
        client.from(table).upsert(rows, {
          onConflict: 'id',
          // events are append-only: insert-or-ignore, never update (D12).
          ignoreDuplicates: table === 'events',
          // Columns missing from a row keep their database default instead of becoming null.
          defaultToNull: false,
        }),
      );
    },
    async pullAlarms(after: PullCursor, limit: number) {
      const at = `"${after.updatedAt}"`;
      const data = await call(
        client
          .from('alarms')
          .select('*')
          .or(`updated_at.gt.${at},and(updated_at.eq.${at},id.gt.${after.id})`)
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(limit),
      );
      return (data ?? []) as PulledAlarm[];
    },
    async beginGuestMigration(deviceId: string): Promise<GuestMigrationState> {
      const data = await call(client.rpc('begin_guest_migration', { p_device_id: deviceId }));
      const state = (data ?? {}) as { open?: boolean; completed_at?: string | null };
      return { open: state.open === true, completedAt: state.completed_at ?? null };
    },
    async completeGuestMigration() {
      await call(client.rpc('complete_guest_migration'));
    },
    async exportMyData() {
      return call(client.rpc('export_my_data'));
    },
    async deleteMyData() {
      return ((await call(client.rpc('delete_my_data'))) ?? {}) as Record<string, number>;
    },
  };
}
