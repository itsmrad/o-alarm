import { sql } from 'drizzle-orm';

import { createAlarm } from '@/domain';

import { createTestDatabase } from '../testing/test-db';
import { createAlarmsRepository } from './alarms';
import { getOrCreateDeviceId } from './device';
import { createEventsRepository } from './events';

const ctx = { now: new Date('2026-10-02T05:00:00Z'), deviceId: 'dev' };

describe('migrations', () => {
  it('create every local table with sync columns on syncable tables', () => {
    const { db, close } = createTestDatabase();
    const tables = db
      .all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
      .map((t) => t.name);
    const syncable = [
      'alarms',
      'alarm_occurrences',
      'wake_sessions',
      'mission_attempts',
      'wake_checks',
      'sleep_sessions',
      'morning_checkins',
      'preferences',
      'events',
    ];
    expect(tables).toEqual(expect.arrayContaining([...syncable, 'outbox', 'sync_state', 'device']));
    for (const table of syncable) {
      const columns = db
        .all<{ name: string }>(sql.raw(`pragma table_info(${table})`))
        .map((c) => c.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          'id',
          'created_at',
          'updated_at',
          'version',
          'deleted_at',
          'device_id',
        ]),
      );
    }
    close();
  });
});

describe('alarms repository', () => {
  it('round-trips every alarm field', () => {
    const { db, close } = createTestDatabase();
    const repo = createAlarmsRepository(db);
    const alarm = createAlarm({
      id: 'a',
      hour: 6,
      minute: 45,
      weekdays: [1, 3],
      timezonePolicy: 'fixed',
      timeZone: 'Asia/Tokyo',
      label: 'Gym',
      oneOffOverride: { occurrenceKey: 'a@2026-10-05', hour: 6, minute: 0 },
      missions: [{ missionId: 'math', config: { difficulty: 'hard' } }],
      important: true,
    });
    repo.upsert(alarm, ctx);
    expect(repo.get('a')).toEqual(alarm);
    expect(repo.getRow('a')).toMatchObject({ version: 1, deviceId: 'dev' });
    repo.upsert({ ...alarm, label: 'Run' }, ctx);
    expect(repo.getRow('a')?.version).toBe(2);
    repo.softDelete('a', ctx);
    expect(repo.get('a')).toBeNull();
    expect(repo.list()).toEqual([]);
    expect(repo.getRow('a')?.deletedAt).toBe(ctx.now.toISOString());
    close();
  });

  it('lists alarms ordered by time of day', () => {
    const { db, close } = createTestDatabase();
    const repo = createAlarmsRepository(db);
    for (const [id, hour] of [
      ['late', 9],
      ['early', 5],
    ] as const) {
      repo.upsert(createAlarm({ id, hour, minute: 0, weekdays: [1] }), ctx);
    }
    expect(repo.list().map((a) => a.id)).toEqual(['early', 'late']);
    close();
  });
});

describe('events repository', () => {
  it('appends typed events and filters them', () => {
    const { db, close } = createTestDatabase();
    let n = 0;
    const repo = createEventsRepository(db, () => `e${++n}`);
    repo.append(
      {
        type: 'alarm_created',
        alarmId: 'a',
        payload: { hour: 7, minute: 0, weekdays: [], oneTime: true },
      },
      ctx,
    );
    repo.append(
      {
        type: 'alarm_snoozed',
        alarmId: 'b',
        occurrenceKey: 'b@x',
        payload: { snoozesUsed: 1, nextFireAt: 'z' },
      },
      ctx,
    );
    expect(
      repo
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual(['e1', 'e2']);
    expect(repo.list({ alarmId: 'b' })).toEqual([
      expect.objectContaining({
        type: 'alarm_snoozed',
        occurrenceKey: 'b@x',
        payload: { snoozesUsed: 1, nextFireAt: 'z' },
      }),
    ]);
    expect(repo.list({ type: 'alarm_created' })).toHaveLength(1);
    expect('update' in repo || 'delete' in repo).toBe(false);
    close();
  });
});

describe('device', () => {
  it('creates the device id once', () => {
    const { db, close } = createTestDatabase();
    const first = getOrCreateDeviceId(db, () => 'd1', 'ios', ctx.now);
    const second = getOrCreateDeviceId(db, () => 'd2', 'ios', ctx.now);
    expect([first, second]).toEqual(['d1', 'd1']);
    close();
  });
});
