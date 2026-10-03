import { createAlarmService, type AlarmDraft } from '@/db/alarm-service';
import { createEventsRepository } from '@/db/repositories/events';
import { createOccurrencesRepository } from '@/db/repositories/occurrences';
import { createOutboxRepository } from '@/db/repositories/outbox';
import { morningCheckins, wakeSessions } from '@/db/schema';
import { createTestDatabase } from '@/db/testing/test-db';
import { createAlarm, type Alarm } from '@/domain';
import { FakeAlarmEngine } from '@/engine/testing/fake-engine';
import type { Tier } from '@/lib/entitlements';

import { backoffDelay, createSyncEngine } from './engine';
import { alarmToCloud, occurrenceCloudId, type CloudAlarm } from './mapping';
import { FakeTransport } from './testing/fake-transport';
import { SyncError } from './transport';

const NY = 'America/New_York';
const DEVICE = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE = '22222222-2222-4222-8222-222222222222';
const USER = 'user_1';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup(options: { tier?: Tier; start?: string } = {}) {
  const { db, close } = createTestDatabase();
  const engine = new FakeAlarmEngine();
  let now = new Date(options.start ?? '2026-10-02T05:00:00Z');
  let n = 0;
  let tier: Tier = options.tier ?? 'pro';
  const newId = () => uuid(++n);
  const alarms = createAlarmService({
    db,
    engine,
    deviceId: DEVICE,
    clock: () => now,
    timeZone: () => NY,
    newId,
  });
  const transport = new FakeTransport();
  transport.pro = tier === 'pro';
  const reconcile = jest.fn<Promise<unknown>, []>(() => alarms.reconcileAll());
  const sync = createSyncEngine({
    db,
    transport,
    userId: USER,
    deviceId: DEVICE,
    device: {
      platform: 'ios',
      osVersion: '26.0',
      appVersion: '0.1.0',
      model: 'iPhone',
      alarmEngine: 'native',
    },
    getTier: () => tier,
    reconcile,
    clock: () => now,
    timeZone: () => NY,
    random: () => 0,
  });
  return {
    db,
    engine,
    alarms,
    transport,
    reconcile,
    sync,
    close,
    newId,
    outbox: () => createOutboxRepository(db, newId).list(),
    setNow: (iso: string) => (now = new Date(iso)),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    setTier: (next: Tier) => {
      tier = next;
      transport.pro = next === 'pro';
    },
  };
}

const draft = (patch: Partial<Alarm> = {}): AlarmDraft => {
  const { id: _id, ...alarm } = createAlarm({
    id: 'tmp',
    hour: 7,
    minute: 0,
    weekdays: [1, 2, 3, 4, 5],
  });
  return { ...alarm, ...patch };
};

/** A cloud alarm row as another device would push it. */
function remoteAlarm(id: string, patch: Partial<Alarm> = {}): CloudAlarm {
  const alarm = createAlarm({ id, hour: 6, minute: 30, weekdays: [6], ...patch });
  const now = '2026-10-02T04:00:00.000Z';
  return alarmToCloud(
    {
      ...alarm,
      createdAt: now,
      updatedAt: now,
      version: 1,
      deletedAt: null,
      deviceId: OTHER_DEVICE,
    },
    alarm,
    { userId: USER, deviceId: OTHER_DEVICE, timeZone: NY },
  );
}

describe('sync engine: push', () => {
  it('registers the user + device, pushes the alarm outbox and clears it', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft({ label: 'Gym' }));
    expect(t.outbox()).toHaveLength(1);

    const result = await t.sync.run();

    expect(result).toMatchObject({ outcome: 'synced', pushed: expect.any(Number) });
    expect(t.transport.users.get(USER)).toEqual({ id: USER, timezone: NY });
    expect(t.transport.rows('devices')).toEqual([
      expect.objectContaining({
        user_id: USER,
        device_id: DEVICE,
        platform: 'ios',
        alarm_engine: 'native',
      }),
    ]);
    expect(t.transport.table('alarms').get(alarm.id)).toMatchObject({
      label: 'Gym',
      weekdays: [1, 2, 3, 4, 5],
      user_id: USER,
      device_id: DEVICE,
      deleted_at: null,
    });
    expect(t.outbox()).toEqual([]);
    expect(t.transport.rows('sync_state')).toEqual([
      expect.objectContaining({
        user_id: USER,
        device_id: DEVICE,
        guest_migrated_at: expect.any(String),
      }),
    ]);
    expect(t.sync.getStatus()).toMatchObject({
      lastSyncedAt: expect.any(String),
      pendingCount: 0,
      failures: 0,
      lastError: null,
    });
    t.close();
  });

  it('coalesces several outbox entries of one alarm into one write of the current row', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft({ label: 'One' }));
    await t.sync.run();
    await t.alarms.save({ ...alarm, label: 'Two' });
    await t.alarms.save({ ...alarm, label: 'Three' });
    t.transport.calls = [];
    await t.sync.run();
    expect(t.transport.calls.filter((c) => c.startsWith('upsert:alarms'))).toEqual([
      'upsert:alarms:1',
    ]);
    expect(t.transport.table('alarms').get(alarm.id)).toMatchObject({ label: 'Three', version: 2 });
    t.close();
  });

  it('pushes local deletes as tombstones', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    await t.sync.run();
    await t.alarms.remove(alarm.id);
    await t.sync.run();
    expect(t.transport.table('alarms').get(alarm.id)?.deleted_at).toEqual(expect.any(String));
    expect(t.outbox()).toEqual([]);
    t.close();
  });

  it('skips and parks a row the server rejects permanently, without blocking the others', async () => {
    const t = setup();
    const { alarm: bad } = await t.alarms.save(draft({ label: 'Bad' }));
    const { alarm: good } = await t.alarms.save(draft({ label: 'Good' }));
    t.transport.rejectIds.add(bad.id);

    const result = await t.sync.run();

    // Rejected twice in a first run: by the one-time upload and again from the outbox.
    expect(result).toMatchObject({ outcome: 'synced', skipped: 2 });
    expect(t.transport.table('alarms').has(good.id)).toBe(true);
    expect(t.transport.table('alarms').has(bad.id)).toBe(false);
    const parked = t.outbox();
    expect(parked).toEqual([
      expect.objectContaining({
        entityId: bad.id,
        attempts: 1,
        lastError: expect.stringContaining('constraint'),
        nextAttemptAt: expect.any(String),
      }),
    ]);
    // Parked: not retried before nextAttemptAt.
    t.transport.calls = [];
    await t.sync.run();
    expect(t.transport.calls.some((c) => c.startsWith('upsert:alarms'))).toBe(false);
    expect(t.sync.getStatus()).toMatchObject({ pendingCount: 1 });
    t.close();
  });

  it('pushes history once, with deterministic occurrence ids', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    await t.sync.run();
    const occurrences = t.transport.rows('alarm_occurrences');
    expect(occurrences.length).toBeGreaterThan(0);
    for (const row of occurrences) {
      expect(row.id).toBe(occurrenceCloudId(row.occurrence_key as string));
      expect(row).toMatchObject({
        alarm_id: alarm.id,
        outcome: 'pending',
        schedule_status: 'scheduled',
      });
    }
    const eventNames = t.transport.rows('events').map((e) => e.name);
    expect(eventNames).toEqual(expect.arrayContaining(['alarm_created', 'alarm_native_scheduled']));

    t.transport.calls = [];
    await t.sync.run();
    expect(t.transport.calls.filter((c) => c.startsWith('upsert:events'))).toEqual([]);
    t.close();
  });
});

describe('sync engine: offline + backoff', () => {
  it('backs off exponentially when offline and recovers without losing local writes', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.transport.offline = true;

    const first = await t.sync.run();
    expect(first.outcome).toBe('failed');
    expect(first.error?.kind).toBe('network');
    expect(t.outbox()).toHaveLength(1);
    const status = t.sync.getStatus();
    expect(status).toMatchObject({ failures: 1, lastErrorKind: 'network' });
    expect(Date.parse(status.nextRetryAt!) - Date.parse('2026-10-02T05:00:00Z')).toBe(15_000);

    // Inside the backoff window: no network call at all.
    t.transport.calls = [];
    expect((await t.sync.run()).outcome).toBe('backoff');
    expect(t.transport.calls).toEqual([]);

    // A forced retry still fails and doubles the delay.
    await t.sync.run({ force: true });
    expect(t.sync.getStatus().failures).toBe(2);
    expect(Date.parse(t.sync.getStatus().nextRetryAt!) - Date.parse('2026-10-02T05:00:00Z')).toBe(
      30_000,
    );

    t.transport.offline = false;
    t.advance(31_000);
    expect((await t.sync.run()).outcome).toBe('synced');
    expect(t.sync.getStatus()).toMatchObject({ failures: 0, nextRetryAt: null, lastError: null });
    expect(t.transport.table('alarms').has(alarm.id)).toBe(true);
    expect(t.outbox()).toEqual([]);
    t.close();
  });

  it('computes 30 s doubling delays capped at 30 min, with jitter', () => {
    expect(backoffDelay(1, () => 1)).toBe(30_000);
    expect(backoffDelay(2, () => 1)).toBe(60_000);
    expect(backoffDelay(1, () => 0)).toBe(15_000);
    expect(backoffDelay(20, () => 1)).toBe(30 * 60_000);
  });

  it('treats an RLS rejection (server says not Pro) as a failure and keeps the outbox', async () => {
    const t = setup();
    await t.alarms.save(draft());
    await t.sync.run();
    await t.alarms.save(draft({ label: 'Later' }));
    t.transport.pro = false;
    const result = await t.sync.run();
    expect(result.error?.kind).toBe('forbidden');
    expect(t.outbox()).toHaveLength(1);
    t.close();
  });

  it('is single-flight', async () => {
    const t = setup();
    await t.alarms.save(draft());
    const a = t.sync.run();
    const b = t.sync.run();
    expect(a).toBe(b);
    await a;
    expect(t.transport.calls.filter((c) => c === 'beginGuestMigration')).toHaveLength(1);
    t.close();
  });

  it('retries transient server errors on the next run', async () => {
    const t = setup();
    await t.alarms.save(draft());
    t.transport.failNext = [new SyncError('server', '503 Service Unavailable')];
    expect((await t.sync.run()).error?.kind).toBe('server');
    t.advance(60_000);
    expect((await t.sync.run()).outcome).toBe('synced');
    t.close();
  });
});

describe('sync engine: pull + conflicts', () => {
  it('applies remote alarms through SQLite + the reconcile path, without echoing them back', async () => {
    const t = setup();
    await t.sync.run();
    t.reconcile.mockClear();
    t.transport.serverWrite('alarms', remoteAlarm(uuid(900), { label: 'From iPad' }));

    const result = await t.sync.run();

    expect(result).toMatchObject({ pulled: 1, applied: 1 });
    expect(t.alarms.get(uuid(900))).toMatchObject({ label: 'From iPad', weekdays: [6] });
    expect(t.reconcile).toHaveBeenCalledTimes(1);
    // The normal reconcile path scheduled it with the OS.
    expect(t.engine.entries.some((e) => e.alarmId === uuid(900))).toBe(true);
    expect(t.outbox()).toEqual([]);

    // Overlapping re-read is idempotent: nothing re-applied, no reconcile.
    t.reconcile.mockClear();
    const again = await t.sync.run();
    expect(again.applied).toBe(0);
    expect(t.reconcile).not.toHaveBeenCalled();
    expect(t.transport.table('alarms').get(uuid(900))?.version).toBe(1);
    t.close();
  });

  it('applies remote tombstones (and the reconcile path cancels the OS alarm)', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    await t.sync.run();
    expect(t.engine.entries.some((e) => e.alarmId === alarm.id)).toBe(true);

    t.transport.serverWrite('alarms', {
      ...t.transport.table('alarms').get(alarm.id)!,
      deleted_at: '2026-10-03T01:00:00.000Z',
    });
    await t.sync.run();

    expect(t.alarms.get(alarm.id)).toBeNull();
    expect(t.engine.entries.some((e) => e.alarmId === alarm.id)).toBe(false);
    t.close();
  });

  it('LWW: a newer remote write beats an older unpushed local edit', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft({ label: 'Original' }));
    await t.sync.run();
    // Local edit at 05:00 device time, while offline.
    await t.alarms.save({ ...alarm, label: 'Local' });
    // Another device writes later (server stamps 2026-10-03).
    t.transport.serverWrite('alarms', {
      ...t.transport.table('alarms').get(alarm.id)!,
      label: 'Remote',
      device_id: OTHER_DEVICE,
    });

    await t.sync.run();

    expect(t.alarms.get(alarm.id)?.label).toBe('Remote');
    expect(t.transport.table('alarms').get(alarm.id)?.label).toBe('Remote');
    expect(t.outbox()).toEqual([]);
    t.close();
  });

  it('LWW: a newer unpushed local edit beats an older remote write', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft({ label: 'Original' }));
    await t.sync.run();
    t.transport.serverWrite('alarms', {
      ...t.transport.table('alarms').get(alarm.id)!,
      label: 'Remote',
      device_id: OTHER_DEVICE,
    });
    // Local edit made after the remote write.
    t.setNow('2026-10-05T05:00:00Z');
    await t.alarms.save({ ...alarm, label: 'Local' });

    await t.sync.run();

    expect(t.alarms.get(alarm.id)?.label).toBe('Local');
    expect(t.transport.table('alarms').get(alarm.id)?.label).toBe('Local');
    t.close();
  });

  it('skips a cloud row that is not a valid local alarm instead of applying it', async () => {
    const t = setup();
    await t.sync.run();
    t.transport.serverWrite('alarms', {
      ...remoteAlarm(uuid(901)),
      one_time_date: null,
      weekdays: [],
    });
    const result = await t.sync.run();
    expect(result).toMatchObject({ outcome: 'synced', applied: 0, skipped: 1 });
    expect(t.alarms.get(uuid(901))).toBeNull();
    t.close();
  });

  it('pages through large pulls', async () => {
    const t = setup();
    await t.sync.run();
    for (let i = 0; i < 450; i++) t.transport.serverWrite('alarms', remoteAlarm(uuid(1000 + i)));
    const result = await t.sync.run();
    expect(result.pulled).toBe(450);
    expect(t.alarms.list()).toHaveLength(450);
    t.close();
  });

  it('never calls the alarm engine itself (only via the injected reconcile path)', async () => {
    const t = setup();
    await t.alarms.save(draft());
    t.engine.calls = [];
    t.reconcile.mockImplementation(async () => undefined);
    t.transport.serverWrite('alarms', remoteAlarm(uuid(902)));
    await t.sync.run();
    t.transport.serverWrite('alarms', remoteAlarm(uuid(903)));
    await t.sync.run();
    expect(t.reconcile).toHaveBeenCalled();
    expect(t.engine.calls).toEqual([]);
    t.close();
  });
});

describe('sync engine: guest → account migration', () => {
  it('uploads local history once for a free account, then stops syncing', async () => {
    const t = setup({ tier: 'free' });
    const { alarm } = await t.alarms.save(draft({ label: 'Guest alarm' }));
    const { alarm: deleted } = await t.alarms.save(draft({ label: 'Deleted' }));
    await t.alarms.remove(deleted.id);

    const result = await t.sync.run();

    expect(result.outcome).toBe('not_entitled');
    expect(t.transport.migration?.completedAt).toEqual(expect.any(String));
    expect(t.transport.table('alarms').get(alarm.id)).toMatchObject({ label: 'Guest alarm' });
    expect(t.transport.table('alarms').get(deleted.id)?.deleted_at).toEqual(expect.any(String));
    expect(t.transport.rows('events').length).toBeGreaterThan(0);
    expect(t.transport.rows('alarm_occurrences').length).toBeGreaterThan(0);
    expect(t.outbox()).toEqual([]);
    expect(t.sync.getStatus().migratedAt).toEqual(expect.any(String));

    // Once: later runs neither migrate again nor sync (free tier).
    await t.alarms.save({ ...alarm, label: 'Edited' });
    t.transport.calls = [];
    expect((await t.sync.run()).outcome).toBe('not_entitled');
    expect(t.transport.calls).toEqual([]);
    expect(t.transport.table('alarms').get(alarm.id)?.label).toBe('Guest alarm');
    expect(t.outbox()).toHaveLength(1);

    // Upgrading later syncs what accumulated.
    t.setTier('pro');
    await t.sync.run();
    expect(t.transport.table('alarms').get(alarm.id)?.label).toBe('Edited');
    t.close();
  });

  it('is resumable: an interrupted migration continues without duplicates', async () => {
    const t = setup({ tier: 'free' });
    for (let i = 0; i < 3; i++) await t.alarms.save(draft({ label: `A${i}` }));
    // Fail after the window opens and the user/device are registered.
    t.transport.failNext = [];
    const realUpsert = t.transport.upsert.bind(t.transport);
    let calls = 0;
    jest.spyOn(t.transport, 'upsert').mockImplementation(async (table, rows) => {
      if (table === 'alarm_occurrences' && calls++ === 0) {
        throw new SyncError('network', 'Network request failed');
      }
      return realUpsert(table, rows);
    });

    expect((await t.sync.run()).outcome).toBe('failed');
    expect(t.sync.getStatus().migratedAt).toBeNull();
    expect(t.transport.migration?.completedAt).toBeNull();
    expect(t.transport.rows('alarms')).toHaveLength(3);

    t.advance(60_000);
    expect((await t.sync.run()).outcome).toBe('not_entitled');
    expect(t.transport.rows('alarms')).toHaveLength(3);
    expect(t.transport.rows('alarms').every((row) => row.version === 1)).toBe(true);
    expect(t.transport.migration?.completedAt).toEqual(expect.any(String));
    t.close();
  });

  it('skips the upload when a free account already used its migration', async () => {
    const t = setup({ tier: 'free' });
    await t.alarms.save(draft());
    t.transport.migration = {
      startedAt: '2026-09-01T00:00:00Z',
      completedAt: '2026-09-01T00:01:00Z',
    };
    await t.sync.run();
    expect(t.transport.rows('alarms')).toEqual([]);
    expect(t.sync.getStatus().migratedAt).toEqual(expect.any(String));
    t.close();
  });

  it('pushes only history rows the cloud can represent', async () => {
    const t = setup();
    const at = '2026-10-02T05:00:00.000Z';
    const base = { createdAt: at, updatedAt: at, version: 1, deletedAt: null, deviceId: DEVICE };
    // A wake session whose occurrence is unknown locally, and an unrated check-in: both skipped.
    t.db
      .insert(wakeSessions)
      .values({
        ...base,
        id: uuid(50),
        alarmId: uuid(1),
        occurrenceKey: `${uuid(1)}@2026-10-02`,
        startedAt: at,
        snoozeCount: 0,
      })
      .run();
    t.db
      .insert(morningCheckins)
      .values({ ...base, id: uuid(51), date: '2026-10-02', energy: null, sleepQuality: 3 })
      .run();
    t.db
      .insert(morningCheckins)
      .values({ ...base, id: uuid(52), date: '2026-10-01', energy: 4, sleepQuality: 3 })
      .run();
    createEventsRepository(t.db, t.newId).append(
      { type: 'alarm_deleted', alarmId: uuid(1), payload: {} },
      { now: new Date(at), deviceId: DEVICE },
    );

    await t.sync.run();

    expect(t.transport.rows('wake_sessions')).toEqual([]);
    expect(t.transport.rows('morning_checkins')).toEqual([
      expect.objectContaining({ local_date: '2026-10-01', energy: 4, sleep_quality: 3 }),
    ]);
    expect(t.transport.rows('events')).toEqual([
      expect.objectContaining({ name: 'alarm_deleted' }),
    ]);

    // Once the occurrence exists, a later wake session is pushed against its deterministic id.
    const key = `${uuid(1)}@2026-10-03`;
    createOccurrencesRepository(t.db, t.newId).upsertScheduled(
      { alarmId: uuid(1), occurrenceKey: key, expectedAt: '2026-10-03T11:00:00.000Z' },
      { now: new Date('2026-10-02T06:00:00Z'), deviceId: DEVICE },
    );
    t.db
      .insert(wakeSessions)
      .values({
        ...base,
        id: uuid(53),
        alarmId: uuid(1),
        occurrenceKey: key,
        startedAt: at,
        updatedAt: '2026-10-02T07:00:00.000Z',
        snoozeCount: 0,
        outcome: 'awake',
        endedAt: at,
      })
      .run();
    t.advance(60_000);
    await t.sync.run();
    expect(t.transport.rows('wake_sessions')).toEqual([
      expect.objectContaining({
        id: uuid(53),
        alarm_occurrence_id: occurrenceCloudId(key),
        status: 'success',
      }),
    ]);
    t.close();
  });
});
