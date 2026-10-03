import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';

import { createTestDatabase } from '../testing/test-db';
import { createWakeChecksRepository } from './wake-checks';

const ctx = (iso: string) => ({ now: new Date(iso), deviceId: 'd1' });
const armed = (attempt: number) => ({
  status: 'armed' as const,
  attempt,
  checkAt: '2026-10-02T11:05:00.000Z',
  respondBy: '2026-10-02T11:06:00.000Z',
});

describe('wake_checks: one row per occurrence (migration 0002)', () => {
  it('has a unique index on occurrence_key', () => {
    const { db, close } = createTestDatabase();
    const index = db.get<{ sql: string }>(
      sql`select sql from sqlite_master where name = 'wake_checks_occurrence_idx'`,
    );
    expect(index?.sql).toMatch(/CREATE UNIQUE INDEX/);
    close();
  });

  it('save upserts: repeated and changed states keep a single row, version bumps', () => {
    const { db, close } = createTestDatabase();
    let n = 0;
    const repo = createWakeChecksRepository(db, () => `id-${++n}`);
    const entry = { alarmId: 'a1', occurrenceKey: 'a1@2026-10-02' };
    repo.save({ ...entry, state: armed(1) }, ctx('2026-10-02T11:00:00Z'));
    repo.save({ ...entry, state: armed(1) }, ctx('2026-10-02T11:00:01Z')); // no-op
    repo.save(
      { ...entry, state: { status: 'pending_verification', attempt: 1, deadline: 'x' } },
      ctx('2026-10-02T11:05:00Z'),
    );
    const rows = db.all<{ id: string; version: number; status: string }>(
      sql`select id, version, status from wake_checks`,
    );
    expect(rows).toEqual([{ id: 'id-2', version: 2, status: 'pending_verification' }]);
    expect(repo.session(entry.occurrenceKey)).toMatchObject({ alarmId: 'a1' });
    expect(() =>
      db.run(
        sql`insert into wake_checks (id, created_at, updated_at, device_id, wake_session_id, occurrence_key, attempt, status, state)
            values ('dup', 'x', 'x', 'd1', 's', 'a1@2026-10-02', 1, 'armed', '{}')`,
      ),
    ).toThrow(/UNIQUE/);
    close();
  });

  it('dedupes pre-existing duplicates (keeps the newest insert) before adding the index', () => {
    const dir = path.join(__dirname, '..', 'migrations');
    const statements = (file: string) =>
      fs
        .readFileSync(path.join(dir, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
    const sqlite = new Database(':memory:');
    for (const file of ['0000_init.sql', '0001_mission_before_snooze.sql']) {
      statements(file).forEach((statement) => sqlite.exec(statement));
    }
    const insert = sqlite.prepare(
      `insert into wake_checks (id, created_at, updated_at, device_id, wake_session_id, occurrence_key, attempt, status, state)
       values (?, 'x', 'x', 'd1', 's', ?, ?, 'armed', '{}')`,
    );
    insert.run('old', 'k1', 1);
    insert.run('other', 'k2', 1);
    insert.run('new', 'k1', 2);
    statements('0002_wake_checks_unique.sql').forEach((statement) => sqlite.exec(statement));
    expect(sqlite.prepare('select id from wake_checks order by id').all()).toEqual([
      { id: 'new' },
      { id: 'other' },
    ]);
    sqlite.close();
  });
});
