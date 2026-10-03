import { createAlarm, type Alarm } from '@/domain';

import { planReconcile, reconcile } from './reconcile';
import { desiredSpecs, specForOccurrence } from './specs';
import { FakeAlarmEngine } from './testing/fake-engine';
import type { ScheduledAlarm } from './types';

const NY = 'America/New_York';
const now = new Date('2026-10-02T05:00:00Z'); // Fri 01:00 EDT
const opts = { now, timeZone: NY };

const daily = (id: string, patch: Partial<Alarm> = {}) =>
  createAlarm({ id, hour: 7, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6], ...patch });

const ids = (engine: FakeAlarmEngine) => engine.entries.map((e) => e.id).sort();

describe('reconcile', () => {
  it('schedules the next occurrences of enabled alarms and verifies the read-back', async () => {
    const engine = new FakeAlarmEngine();
    const result = await reconcile([daily('a'), daily('b', { enabled: false })], engine, opts);
    expect(ids(engine)).toEqual(['a@2026-10-02', 'a@2026-10-03']);
    expect(result.verified).toBe(true);
    expect(result.plan.schedule).toHaveLength(2);
  });

  it('is idempotent: a second run changes nothing and never duplicates', async () => {
    const engine = new FakeAlarmEngine();
    await reconcile([daily('a')], engine, opts);
    engine.calls = [];
    const second = await reconcile([daily('a')], engine, opts);
    expect(engine.calls).toEqual([]);
    expect(second.plan.unchanged).toHaveLength(2);
    expect(engine.entries).toHaveLength(2);
    expect(second.verified).toBe(true);
  });

  it('reschedules drifted entries after an edit', async () => {
    const engine = new FakeAlarmEngine();
    await reconcile([daily('a')], engine, opts);
    const result = await reconcile([daily('a', { hour: 8 })], engine, opts);
    expect(result.plan.reschedule.map((s) => s.id)).toEqual(['a@2026-10-02', 'a@2026-10-03']);
    expect(engine.entries.map((e) => e.fireAt).sort()).toEqual([
      '2026-10-02T12:00:00.000Z',
      '2026-10-03T12:00:00.000Z',
    ]);
    expect(engine.entries).toHaveLength(2);
  });

  it('reschedules after a device tz change (floating alarm)', async () => {
    const engine = new FakeAlarmEngine();
    await reconcile([daily('a')], engine, opts);
    const result = await reconcile([daily('a')], engine, { now, timeZone: 'Europe/London' });
    expect(result.plan.reschedule).toHaveLength(2);
    expect(engine.entries.find((e) => e.id === 'a@2026-10-02')?.fireAt).toBe(
      '2026-10-02T06:00:00.000Z',
    );
  });

  it('cancels orphans: deleted alarms, disabled alarms, foreign ids', async () => {
    const engine = new FakeAlarmEngine();
    await reconcile([daily('a'), daily('b')], engine, opts);
    engine.entries.push({ ...engine.entries[0]!, id: 'ghost@2026-10-02', alarmId: 'ghost' });
    const result = await reconcile([daily('a', { enabled: false })], engine, opts);
    expect(engine.entries).toEqual([]);
    expect(result.plan.cancel.sort()).toEqual([
      'a@2026-10-02',
      'a@2026-10-03',
      'b@2026-10-02',
      'b@2026-10-03',
      'ghost@2026-10-02',
    ]);
    expect(result.verified).toBe(true);
  });

  it('collapses duplicate engine entries into exactly one', async () => {
    const engine = new FakeAlarmEngine();
    await reconcile([daily('a')], engine, opts);
    engine.entries.push({ ...engine.entries[0]! });
    const result = await reconcile([daily('a')], engine, opts);
    expect(result.plan.reschedule.map((s) => s.id)).toEqual(['a@2026-10-02']);
    expect(engine.entries.filter((e) => e.id === 'a@2026-10-02')).toHaveLength(1);
  });

  it('keeps future snooze/wake-check entries of active alarms, cancels stale ones', async () => {
    const engine = new FakeAlarmEngine();
    await reconcile([daily('a'), daily('b')], engine, opts);
    const base = engine.entries[0]!;
    const extra = (id: string, alarmId: string, fireAt: string): ScheduledAlarm => ({
      ...base,
      id,
      alarmId,
      kind: 'snooze',
      fireAt,
    });
    engine.entries.push(
      extra('a@2026-10-02#snooze-1', 'a', '2026-10-02T05:09:00.000Z'),
      extra('a@2026-10-01#snooze-1', 'a', '2026-10-01T11:09:00.000Z'),
      extra('b@2026-10-02#wake-check-1', 'b', '2026-10-02T05:05:00.000Z'),
    );
    const result = await reconcile([daily('a'), daily('b', { enabled: false })], engine, opts);
    expect(ids(engine)).toEqual(['a@2026-10-02', 'a@2026-10-02#snooze-1', 'a@2026-10-03']);
    expect(result.plan.cancel).toEqual(
      expect.arrayContaining(['a@2026-10-01#snooze-1', 'b@2026-10-02#wake-check-1']),
    );
  });

  it('scope limits the reconcile to one alarm', async () => {
    const engine = new FakeAlarmEngine();
    await reconcile([daily('a'), daily('b')], engine, opts);
    const result = await reconcile([daily('a', { hour: 9 })], engine, { ...opts, scope: 'a' });
    expect(result.plan.cancel).toEqual([]);
    expect(ids(engine)).toContain('b@2026-10-02');
    expect(engine.entries.find((e) => e.id === 'a@2026-10-02')?.fireAt).toBe(
      '2026-10-02T13:00:00.000Z',
    );
  });

  it('reports schedule failures instead of hiding them', async () => {
    const engine = new FakeAlarmEngine();
    engine.failSchedule = 'PERMISSION_DENIED';
    const result = await reconcile([daily('a')], engine, opts);
    expect(result.verified).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ operation: 'schedule', alarmId: 'a' });
    expect(result.failures[0]?.error.code).toBe('PERMISSION_DENIED');
    expect(result.mismatches).toEqual(['a@2026-10-02', 'a@2026-10-03']);
  });

  it('reports an unreadable engine (e.g. native stub NOT_IMPLEMENTED)', async () => {
    const engine = new FakeAlarmEngine();
    engine.failRead = 'NOT_IMPLEMENTED';
    const result = await reconcile([daily('a')], engine, opts);
    expect(result.verified).toBe(false);
    expect(result.failures[0]).toMatchObject({ operation: 'read' });
    expect(result.failures[0]?.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('verification catches an engine that stores something different', async () => {
    const engine = new FakeAlarmEngine();
    engine.corruptOnSchedule = (entry) => ({ ...entry, fireAt: '2026-10-09T11:00:00.000Z' });
    const result = await reconcile([daily('a')], engine, opts);
    expect(result.failures).toEqual([]);
    expect(result.verified).toBe(false);
    expect(result.mismatches).toHaveLength(2);
  });
});

describe('planReconcile', () => {
  it('treats ISO formatting differences in fireAt as equal', () => {
    const alarm = daily('a');
    const [spec] = desiredSpecs([alarm], now, NY, 1);
    const actual: ScheduledAlarm = {
      ...spec!,
      fireAt: '2026-10-02T11:00:00Z',
      scheduledAt: 'x',
    };
    const plan = planReconcile([spec!], [actual], { activeAlarmIds: new Set(['a']), now });
    expect(plan.unchanged).toEqual(['a@2026-10-02']);
  });

  it('builds specs from occurrences with a fallback label', () => {
    const alarm = daily('a', { label: '  ', missions: [{ missionId: 'math', config: {} }] });
    const [spec] = desiredSpecs([alarm], now, NY, 1);
    expect(spec).toMatchObject({ label: 'Alarm', hasMissions: true, kind: 'alarm' });
    expect(specForOccurrence).toBeDefined();
  });
});
