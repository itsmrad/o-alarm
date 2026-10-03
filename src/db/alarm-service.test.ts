import { createAlarm, type Alarm } from '@/domain';
import { FakeAlarmEngine } from '@/engine/testing/fake-engine';

import { createAlarmService, type AlarmDraft } from './alarm-service';
import { createOutboxRepository } from './repositories/outbox';
import { createTestDatabase } from './testing/test-db';

const NY = 'America/New_York';

function setup(start = '2026-10-02T05:00:00Z') {
  const { db, close } = createTestDatabase();
  const engine = new FakeAlarmEngine();
  let now = new Date(start);
  let zone = NY;
  let n = 0;
  const service = createAlarmService({
    db,
    engine,
    deviceId: 'device-1',
    clock: () => now,
    timeZone: () => zone,
    newId: () => `id-${++n}`,
  });
  return {
    db,
    engine,
    service,
    close,
    outbox: () => createOutboxRepository(db, () => 'x').list(),
    eventTypes: () =>
      service.events
        .list({ limit: 500 })
        .map((e) => e.type)
        .reverse(),
    setNow: (iso: string) => (now = new Date(iso)),
    setZone: (z: string) => (zone = z),
  };
}

const draft = (patch: Partial<Alarm> = {}): AlarmDraft => {
  const { id: _id, ...rest } = createAlarm({
    id: 'tmp',
    hour: 7,
    minute: 0,
    weekdays: [1, 2, 3, 4, 5],
    ...patch,
  });
  return rest;
};

describe('alarmService.save (D11)', () => {
  it('persists, schedules, verifies, logs events and enqueues sync — in that order', async () => {
    const t = setup();
    const { alarm, status } = await t.service.save(draft({ label: 'Work' }));

    expect(t.service.list()).toEqual([alarm]);
    expect(t.engine.entries.map((e) => e.id)).toEqual([
      `${alarm.id}@2026-10-02`,
      `${alarm.id}@2026-10-05`,
    ]);
    expect(status).toMatchObject({ state: 'scheduled', engine: 'native' });
    expect(status.state === 'scheduled' && status.nextFire.fireAt.toISOString()).toBe(
      '2026-10-02T11:00:00.000Z',
    );
    expect(t.eventTypes()).toEqual([
      'alarm_created',
      'alarm_native_scheduled',
      'alarm_native_scheduled',
    ]);
    expect(t.outbox()).toEqual([
      expect.objectContaining({ entity: 'alarms', entityId: alarm.id, op: 'upsert' }),
    ]);
    const row = t.outbox()[0]!.payload;
    expect(row).toMatchObject({ version: 1, deviceId: 'device-1', deletedAt: null });
    t.close();
  });

  it('rejects invalid input before touching the DB or engine', async () => {
    const t = setup();
    await expect(t.service.save({ ...draft(), hour: 25 })).rejects.toThrow();
    expect(t.service.list()).toEqual([]);
    expect(t.engine.calls).toEqual([]);
    t.close();
  });

  it('updates bump version, reschedule, and log the changed fields', async () => {
    const t = setup();
    const { alarm } = await t.service.save(draft());
    await t.service.save({ ...alarm, hour: 6, label: 'Earlier' });

    expect(t.engine.entries.map((e) => e.fireAt)).toEqual([
      '2026-10-02T10:00:00.000Z',
      '2026-10-05T10:00:00.000Z',
    ]);
    const updated = t.service.events.list({ type: 'alarm_updated' })[0];
    expect(updated?.payload).toEqual({ changed: ['hour', 'label'] });
    expect(t.outbox().map((o) => (o.payload as { version: number }).version)).toEqual([1, 2]);
    t.close();
  });

  it('saving the same alarm twice never duplicates engine entries', async () => {
    const t = setup();
    const { alarm } = await t.service.save(draft());
    t.engine.calls = [];
    await t.service.save(alarm);
    expect(t.engine.calls).toEqual([]);
    expect(t.engine.entries).toHaveLength(2);
    t.close();
  });

  it('a schedule failure is persisted, surfaced and logged — never silent', async () => {
    const t = setup();
    t.engine.failSchedule = 'PERMISSION_DENIED';
    const { alarm, status } = await t.service.save(draft());

    expect(t.service.get(alarm.id)).toEqual(alarm); // still saved locally
    expect(status).toMatchObject({ state: 'failed', code: 'PERMISSION_DENIED' });
    expect(t.service.getStatus(alarm.id)).toEqual(status);
    expect(t.eventTypes()).toEqual(['alarm_created', 'alarm_schedule_failed']);
    expect(t.outbox()).toHaveLength(1);
    t.close();
  });

  it('the native stub (NOT_IMPLEMENTED) surfaces as a failure', async () => {
    const t = setup();
    t.engine.failRead = 'NOT_IMPLEMENTED';
    const { status } = await t.service.save(draft());
    expect(status).toMatchObject({ state: 'failed', code: 'NOT_IMPLEMENTED' });
    t.close();
  });

  it('a read-back mismatch is reported as a verification failure', async () => {
    const t = setup();
    t.engine.corruptOnSchedule = (entry) => ({ ...entry, label: 'tampered' });
    const { status } = await t.service.save(draft());
    expect(status).toMatchObject({ state: 'failed', code: 'VERIFY_MISMATCH' });
    t.close();
  });

  it('disabling cancels native entries; status becomes inactive', async () => {
    const t = setup();
    const { alarm } = await t.service.save(draft());
    const { status } = await t.service.setEnabled(alarm.id, false);
    expect(status).toEqual({ state: 'inactive' });
    expect(t.engine.entries).toEqual([]);
    t.close();
  });

  it('remove soft-deletes, cancels, logs and enqueues a delete', async () => {
    const t = setup();
    const { alarm } = await t.service.save(draft());
    await t.service.remove(alarm.id);
    expect(t.service.list()).toEqual([]);
    expect(t.engine.entries).toEqual([]);
    expect(t.eventTypes()).toContain('alarm_deleted');
    expect(t.outbox().at(-1)).toMatchObject({ op: 'delete', entityId: alarm.id });
    expect((t.outbox().at(-1)!.payload as { deletedAt: string }).deletedAt).toBeTruthy();
    t.close();
  });

  it('skip next and one-off override flow through the write path', async () => {
    const t = setup();
    const { alarm } = await t.service.save(draft());
    await t.service.toggleSkipNext(alarm.id);
    expect(t.engine.entries.map((e) => e.occurrenceKey)).toEqual([
      `${alarm.id}@2026-10-05`,
      `${alarm.id}@2026-10-06`,
    ]);
    await t.service.setOneOffOverride(alarm.id, { hour: 5, minute: 30 });
    expect(t.engine.entries.find((e) => e.occurrenceKey === `${alarm.id}@2026-10-05`)?.fireAt).toBe(
      '2026-10-05T09:30:00.000Z',
    );
    t.close();
  });

  it('notifies subscribers after each write', async () => {
    const t = setup();
    const listener = jest.fn();
    t.service.subscribe(listener);
    const { alarm } = await t.service.save(draft());
    await t.service.remove(alarm.id);
    expect(listener).toHaveBeenCalledTimes(2);
    t.close();
  });
});

describe('alarmService.reconcileAll', () => {
  it('restores missing native entries (e.g. after reinstall) and follows tz changes', async () => {
    const t = setup();
    const { alarm } = await t.service.save(draft());
    await t.engine.cancelAll();
    await t.service.reconcileAll();
    expect(t.engine.entries).toHaveLength(2);

    t.setZone('Europe/London');
    await t.service.reconcileAll();
    expect(t.engine.entries[0]?.fireAt).toBe('2026-10-02T06:00:00.000Z');
    expect(t.service.getStatus(alarm.id)).toMatchObject({ state: 'scheduled' });
    t.close();
  });

  it('rolls forward after an occurrence passes', async () => {
    const t = setup();
    const { alarm } = await t.service.save(draft());
    t.setNow('2026-10-02T12:00:00Z');
    await t.service.reconcileAll();
    expect(t.engine.entries.map((e) => e.occurrenceKey)).toEqual([
      `${alarm.id}@2026-10-05`,
      `${alarm.id}@2026-10-06`,
    ]);
    // The 07:00 Friday entry was in the past → treated as orphan and removed.
    t.close();
  });
});
