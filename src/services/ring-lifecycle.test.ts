import { createAlarmService, type AlarmDraft } from '@/db/alarm-service';
import { createOccurrencesRepository } from '@/db/repositories/occurrences';
import { createTestDatabase } from '@/db/testing/test-db';
import { createAlarm, type Alarm } from '@/domain';
import type { AlarmEngineEventPayload, ObservedEngineEvent, RingingState } from '@/engine';
import { FakeAlarmEngine } from '@/engine/testing/fake-engine';

import { MISSED_GRACE_MS, createReliabilityLedger } from './reliability-ledger';
import { createRingLifecycle } from './ring-lifecycle';
import { createWakeCheckService } from './wake-check';

const NY = 'America/New_York';
// Friday 2026-10-02 05:00 in New York; a weekday 07:00 alarm fires 11:00Z today.
const START = '2026-10-02T09:00:00Z';
const FIRE = '2026-10-02T11:00:00.000Z';

function setup() {
  const { db, close } = createTestDatabase();
  const engine = new FakeAlarmEngine();
  let now = new Date(START);
  let zone = NY;
  let n = 0;
  const clock = () => now;
  const timeZone = () => zone;
  const newId = () => `id-${++n}`;
  const alarms = createAlarmService({ db, engine, deviceId: 'd1', clock, timeZone, newId });
  const ledger = createReliabilityLedger({
    db,
    deviceId: 'd1',
    engineKind: engine.kind,
    getAlarm: alarms.get,
    clock,
    newId,
  });
  const wakeChecks = createWakeCheckService({
    db,
    deviceId: 'd1',
    engine,
    getAlarm: alarms.get,
    clock,
    newId,
  });
  const shown: AlarmEngineEventPayload[] = [];
  const prompts: AlarmEngineEventPayload[] = [];
  const wokeUp: string[] = [];
  const ring = createRingLifecycle({
    engine,
    alarms,
    ledger,
    wakeChecks,
    showRinging: (event) => shown.push(event),
    showWakeCheck: (event) => prompts.push(event),
    onWokeUp: (woke) => wokeUp.push(woke.occurrenceKey),
    clock,
    timeZone,
  });
  const occurrences = createOccurrencesRepository(db, newId);
  return {
    db,
    engine,
    alarms,
    ledger,
    ring,
    shown,
    prompts,
    wokeUp,
    wakeChecks,
    close,
    occurrences,
    setNow: (iso: string) => (now = new Date(iso)),
    setZone: (z: string) => (zone = z),
    types: () =>
      alarms.events
        .list({ limit: 500 })
        .map((e) => e.type)
        .reverse(),
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

const ringingOf = (alarm: Alarm, patch: Partial<RingingState> = {}): RingingState => ({
  scheduleId: `${alarm.id}@2026-10-02`,
  alarmId: alarm.id,
  occurrenceKey: `${alarm.id}@2026-10-02`,
  kind: 'alarm',
  at: FIRE,
  firedAt: FIRE,
  snoozeCount: 0,
  label: alarm.label || 'Alarm',
  hasMissions: alarm.missions.length > 0,
  wakeCheck: false,
  important: alarm.important,
  ...patch,
});

const observed = (
  alarm: Alarm,
  type: ObservedEngineEvent['type'] | 'missed' | 'schedule_failed',
  id: string,
  at = FIRE,
  scheduleId = `${alarm.id}@2026-10-02`,
): ObservedEngineEvent =>
  ({
    id,
    type,
    scheduleId,
    alarmId: alarm.id,
    occurrenceKey: `${alarm.id}@2026-10-02`,
    at,
  }) as ObservedEngineEvent;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('ring lifecycle: routing', () => {
  it('routes an engine trigger to the ringing screen and logs it once', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.ring.start();
    await flush();
    t.setNow(FIRE);
    const event = { ...ringingOf(alarm) };
    t.engine.emit('trigger', event);
    t.engine.emit('trigger', event); // duplicate delivery
    await flush();

    expect(t.shown).toHaveLength(2); // routing is cheap; the screen dedupes itself
    const types = t
      .types()
      .filter((type) => type.startsWith('alarm_') && type !== 'alarm_native_scheduled');
    expect(types.filter((type) => type === 'alarm_trigger_received')).toHaveLength(1);
    expect(types.filter((type) => type === 'alarm_expected')).toHaveLength(1);
    expect(t.occurrences.get(`${alarm.id}@2026-10-02`)).toMatchObject({
      status: 'triggered',
      triggeredAt: FIRE,
      expectedAt: FIRE,
    });
    t.ring.stop();
    t.close();
  });

  it('does not stack a second ringing screen while one is open', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.ring.start();
    t.ring.setRingingScreenOpen(true);
    t.engine.emit('trigger', ringingOf(alarm));
    await flush();
    expect(t.shown).toHaveLength(0);
    t.ring.stop();
    t.close();
  });

  it('cold start while ringing: shows the ringing screen and holds reconcile back', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.engine.calls = [];
    t.engine.ringing = ringingOf(alarm);
    t.setNow(FIRE);

    const report = await t.ring.sync('start');
    expect(t.shown.map((e) => e.scheduleId)).toEqual([`${alarm.id}@2026-10-02`]);
    expect(report.ringing?.scheduleId).toBe(`${alarm.id}@2026-10-02`);
    expect(report.reconcile).toBeNull();
    expect(t.engine.calls.filter((c) => c.startsWith('cancel'))).toEqual([]);
    t.close();
  });

  it('start() subscribes once and runs the initial sync', async () => {
    const t = setup();
    await t.alarms.save(draft());
    t.engine.entries = []; // e.g. reinstall wiped native state
    t.ring.start();
    t.ring.start();
    await flush();
    expect(t.engine.entries).toHaveLength(2);
    expect(t.ring.getLastSync()?.reason).toBe('start');
    t.ring.stop();
    t.close();
  });
});

describe('ring lifecycle: observed events (drain → persist → ack)', () => {
  it('persists and acks, and a replay after a crash before ack never duplicates', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.setNow('2026-10-02T11:30:00Z');
    const batch = [
      observed(alarm, 'trigger_received', 'n1'),
      observed(alarm, 'snoozed', 'n2', '2026-10-02T11:01:00.000Z'),
      observed(
        alarm,
        'trigger_received',
        'n3',
        '2026-10-02T11:10:00.000Z',
        `${alarm.id}@2026-10-02#snooze-1`,
      ),
      observed(
        alarm,
        'dismissed',
        'n4',
        '2026-10-02T11:12:00.000Z',
        `${alarm.id}@2026-10-02#snooze-1`,
      ),
    ];
    t.engine.observed = batch.map((e) => ({ ...e }));

    const first = await t.ring.sync('foreground');
    expect(first.ingested).toBe(4);
    expect(t.engine.observed).toEqual([]);
    const after = t.types();

    // Crash between persist and ack: the engine hands out the same events again.
    t.engine.observed = batch.map((e) => ({ ...e }));
    await t.ring.sync('foreground');
    expect(t.types()).toEqual(after);
    expect(after.filter((type) => type === 'alarm_trigger_received')).toHaveLength(2);
    expect(after.filter((type) => type === 'alarm_snoozed')).toHaveLength(1);
    expect(after.filter((type) => type === 'alarm_dismissed')).toHaveLength(1);
    expect(t.occurrences.get(`${alarm.id}@2026-10-02`)).toMatchObject({
      status: 'dismissed',
      snoozeCount: 1,
      triggeredAt: FIRE,
      dismissedAt: '2026-10-02T11:12:00.000Z',
    });
    t.close();
  });

  it('an in-app dismiss and the engine-observed dismiss are one event', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.setNow(FIRE);
    t.engine.ringing = ringingOf(alarm);
    await t.ring.dismiss(`${alarm.id}@2026-10-02`, 'button');
    t.engine.observed = [observed(alarm, 'dismissed', 'n9')];
    await t.ring.sync('foreground');
    expect(t.types().filter((type) => type === 'alarm_dismissed')).toHaveLength(1);
    expect(t.engine.calls).toContain(`dismiss:${alarm.id}@2026-10-02`);
    t.close();
  });

  it('maps retriggers and system-stop (D14) per D12', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.setNow('2026-10-02T11:30:00Z');
    t.engine.observed = [
      observed(alarm, 'trigger_received', 'a'),
      observed(alarm, 'stopped_from_system_ui', 'b', '2026-10-02T11:01:00.000Z'),
      observed(
        alarm,
        'retriggered',
        'c',
        '2026-10-02T11:06:00.000Z',
        `${alarm.id}@2026-10-02#retrigger-1`,
      ),
    ];
    await t.ring.sync('foreground');
    const events = t.alarms.events.list({ limit: 50 });
    expect(events.find((e) => e.type === 'alarm_dismissed')?.payload).toEqual({
      method: 'system_stop',
    });
    expect(events.find((e) => e.type === 'alarm_retriggered')).toMatchObject({
      occurrenceKey: `${alarm.id}@2026-10-02`,
      payload: { reason: 'stop_without_mission', attempt: 1 },
    });
    t.close();
  });

  it('maps D29 observed missed / schedule_failed defensively', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.engine.observed = [
      observed(alarm, 'missed', 'm1'),
      { ...observed(alarm, 'schedule_failed', 'm2'), detail: 'exact alarm revoked' } as never,
    ];
    t.setNow('2026-10-02T11:01:00Z');
    await t.ring.sync('foreground');
    expect(t.occurrences.get(`${alarm.id}@2026-10-02`)?.status).toBe('missed');
    const failed = t.alarms.events
      .list({ type: 'alarm_schedule_failed' })
      .map((e) => e.payload as { code?: string; message?: string })
      .find((payload) => payload.code === 'NATIVE_SCHEDULE_FAILED');
    expect(failed?.message).toBe('exact alarm revoked');
    t.close();
  });
});

describe('ring lifecycle: reconcile triggers', () => {
  it('reconciles on foreground but not on background', async () => {
    const t = setup();
    await t.alarms.save(draft());
    t.ring.start();
    await flush();
    t.engine.entries = [];
    t.ring.onAppStateChange('background');
    await flush();
    expect(t.engine.entries).toHaveLength(0);
    t.ring.onAppStateChange('active');
    await flush();
    expect(t.engine.entries).toHaveLength(2);
    expect(t.ring.getLastSync()?.reason).toBe('foreground');
    expect(t.ring.getLastReconcile()?.result.verified).toBe(true);
    t.ring.stop();
    t.close();
  });

  it('detects a time-zone change on foreground and by polling, and re-plans', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.ring.start();
    await flush();
    expect(t.ring.checkTimeZone()).toBe(false);

    t.setZone('Europe/London');
    t.ring.onAppStateChange('active');
    await flush();
    expect(t.ring.getLastSync()?.reason).toBe('timezone');
    // It is 10:00 in London, so today's 07:00 has passed: next is Monday 07:00 BST.
    expect(t.engine.entries.map((e) => e.fireAt).sort()[0]).toBe('2026-10-05T06:00:00.000Z');
    expect(t.engine.entries.every((e) => e.alarmId === alarm.id)).toBe(true);

    t.setZone('Asia/Tokyo');
    expect(t.ring.checkTimeZone()).toBe(true);
    await flush();
    expect(t.ring.getLastSync()?.timeZone).toBe('Asia/Tokyo');
    t.ring.stop();
    t.close();
  });

  it('a ring that ends triggers a catch-up sync', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.ring.start();
    await flush();
    t.engine.entries = [];
    t.engine.emit('dismiss', ringingOf(alarm));
    await flush();
    expect(t.ring.getLastSync()?.reason).toBe('ring_ended');
    expect(t.engine.entries.length).toBeGreaterThan(0);
    t.ring.stop();
    t.close();
  });
});

describe('ring lifecycle: snooze and dismiss rules', () => {
  it('enforces the snooze limit before the engine', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(
      draft({ snooze: { enabled: true, durationMin: 5, maxCount: 2 } }),
    );
    t.setNow(FIRE);
    t.engine.ringing = ringingOf(alarm, { snoozeCount: 2 });
    await expect(t.ring.snooze(`${alarm.id}@2026-10-02`)).rejects.toMatchObject({
      code: 'SNOOZE_LIMIT',
    });
    expect(t.engine.calls.some((c) => c.startsWith('snooze:'))).toBe(false);

    t.engine.ringing = ringingOf(alarm, { snoozeCount: 1 });
    const entry = await t.ring.snooze(`${alarm.id}@2026-10-02`);
    expect(entry.kind).toBe('snooze');
    const snoozed = t.alarms.events.list({ type: 'alarm_snoozed' })[0];
    expect(snoozed?.payload).toEqual({ snoozesUsed: 2, nextFireAt: entry.fireAt });
    expect(t.occurrences.get(`${alarm.id}@2026-10-02`)).toMatchObject({
      status: 'snoozed',
      snoozeCount: 1,
    });
    t.close();
  });

  it('rejects actions for an alarm that is not ringing', async () => {
    const t = setup();
    await expect(t.ring.dismiss('nope', 'button')).rejects.toMatchObject({ code: 'NOT_RINGING' });
    t.close();
  });

  it('an alarm with missions only stops via the mission hook point', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft({ missions: [{ missionId: 'math', config: {} }] }));
    t.setNow(FIRE);
    t.engine.ringing = ringingOf(alarm);
    const scheduleId = `${alarm.id}@2026-10-02`;
    await expect(t.ring.dismiss(scheduleId, 'button')).rejects.toBeTruthy();
    expect(t.engine.ringing).not.toBeNull();

    await t.ring.completeMission({
      purpose: 'dismiss',
      scheduleId,
      alarmId: alarm.id,
      occurrenceKey: scheduleId,
    });
    expect(t.engine.ringing).toBeNull();
    expect(t.alarms.events.list({ type: 'alarm_dismissed' })[0]?.payload).toEqual({
      method: 'mission',
    });
    t.close();
  });
});

describe('reliability ledger: missed occurrences', () => {
  it('marks a scheduled occurrence missed only after the grace period', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    const key = `${alarm.id}@2026-10-02`;

    t.setNow(new Date(Date.parse(FIRE) + MISSED_GRACE_MS - 1).toISOString());
    await t.ring.sync('foreground');
    expect(t.occurrences.get(key)?.status).toBe('scheduled');

    t.setNow(new Date(Date.parse(FIRE) + MISSED_GRACE_MS + 1).toISOString());
    const report = await t.ring.sync('foreground');
    expect(report.missed.map((row) => row.occurrenceKey)).toEqual([key]);
    expect(t.occurrences.get(key)?.status).toBe('missed');
    expect(t.alarms.events.list({ type: 'alarm_expected' })).toHaveLength(1);

    expect(t.ledger.unacknowledgedMissed().map((row) => row.occurrenceKey)).toEqual([key]);
    t.ledger.acknowledgeMissed();
    expect(t.ledger.unacknowledgedMissed()).toEqual([]);

    // Idempotent: a second pass neither re-marks nor re-logs.
    await t.ring.sync('foreground');
    expect(t.alarms.events.list({ type: 'alarm_expected' })).toHaveLength(1);
    t.close();
  });

  it('a late-reported ring (observed queue) is never counted as missed', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    t.setNow('2026-10-02T12:00:00Z');
    t.engine.observed = [observed(alarm, 'trigger_received', 'x1')];
    const report = await t.ring.sync('start');
    expect(report.missed).toEqual([]);
    expect(t.occurrences.get(`${alarm.id}@2026-10-02`)?.status).toBe('triggered');
    t.close();
  });

  it('disabled or skipped occurrences are withdrawn, never missed', async () => {
    const t = setup();
    const { alarm } = await t.alarms.save(draft());
    await t.alarms.toggleSkipNext(alarm.id);
    expect(t.occurrences.get(`${alarm.id}@2026-10-02`)?.status).toBe('skipped');
    await t.alarms.setEnabled(alarm.id, false);
    expect(t.occurrences.get(`${alarm.id}@2026-10-05`)?.status).toBe('cancelled');

    t.setNow('2026-10-06T12:00:00Z');
    const report = await t.ring.sync('foreground');
    expect(report.missed).toEqual([]);
    t.close();
  });

  it('test rings stay out of the ledger', async () => {
    const t = setup();
    const entry = await t.alarms.scheduleTestAlarm(60_000);
    // Reconcile never cancels a test alarm (it has no DB alarm behind it).
    await t.ring.sync('foreground');
    expect(t.engine.entries.map((e) => e.id)).toContain(entry.id);

    t.setNow(entry.fireAt);
    t.engine.ringing = {
      ...ringingOf(createAlarm({ id: 'test-alarm', hour: 7, minute: 0, weekdays: [1] })),
      scheduleId: entry.id,
      occurrenceKey: entry.occurrenceKey,
    };
    t.engine.emit('trigger', t.engine.ringing);
    await t.ring.dismiss(entry.id, 'button');
    expect(t.ledger.recentOccurrences()).toEqual([]);
    expect(t.alarms.events.list({ type: 'alarm_trigger_received' })).toEqual([]);
    t.close();
  });
});

describe('Wake Check (D13)', () => {
  const WAKE = {
    enabled: true,
    delayMin: 5,
    responseWindowSec: 60,
    method: 'confirm' as const,
    missionId: null,
    maxRetriggers: 2,
  };
  const KEY = (alarm: Alarm) => `${alarm.id}@2026-10-02`;
  const at = (minutes: number, seconds = 0) =>
    new Date(Date.parse(FIRE) + minutes * 60_000 + seconds * 1000).toISOString();
  const prompt = (alarm: Alarm): RingingState =>
    ringingOf(alarm, { scheduleId: `${KEY(alarm)}#wake-check-1`, kind: 'wake_check', at: at(5) });
  const retrigger = (alarm: Alarm, attempt: number): RingingState =>
    ringingOf(alarm, { scheduleId: `${KEY(alarm)}#retrigger-${attempt}`, kind: 'retrigger' });
  const count = (t: ReturnType<typeof setup>, type: string) =>
    t.types().filter((x) => x === type).length;

  async function armed() {
    const t = setup();
    const { alarm } = await t.alarms.save(draft({ wakeCheck: WAKE }));
    t.ring.start();
    await flush();
    t.setNow(FIRE);
    t.engine.ringing = ringingOf(alarm);
    await t.ring.dismiss(KEY(alarm), 'button');
    return { t, alarm };
  }

  /** The prompt alarm rings (in-app trigger). */
  async function promptRings(t: ReturnType<typeof setup>, alarm: Alarm, base = 0) {
    t.setNow(at(base + 5));
    t.engine.ringing = { ...prompt(alarm), at: at(base + 5) };
    t.engine.emit('trigger', t.engine.ringing);
    await flush();
  }

  it('dismissal schedules the prompt and the native re-trigger at the deadline', async () => {
    const { t, alarm } = await armed();
    const byId = new Map(t.engine.entries.map((e) => [e.id, e]));
    expect(byId.get(`${KEY(alarm)}#wake-check-1`)).toMatchObject({
      kind: 'wake_check',
      fireAt: at(5),
    });
    expect(byId.get(`${KEY(alarm)}#retrigger-1`)).toMatchObject({
      kind: 'retrigger',
      fireAt: at(6),
      snooze: { enabled: false, maxCount: 0 },
    });
    expect(byId.get(`${KEY(alarm)}#retrigger-1`)?.wallClock).toBeUndefined();
    expect(t.wakeChecks.state(KEY(alarm))).toMatchObject({ status: 'armed', attempt: 1 });
    expect(count(t, 'wake_check_started')).toBe(1);
    expect(t.wokeUp).toEqual([]); // not up yet: the check is still to come
    // Reconcile keeps both follow-ups (they belong to an active alarm).
    await t.ring.sync('foreground');
    expect(t.engine.entries.some((e) => e.id === `${KEY(alarm)}#retrigger-1`)).toBe(true);
    t.close();
  });

  it('pass: cancels the re-trigger, stops the prompt, logs once and ends the wake-up', async () => {
    const { t, alarm } = await armed();
    await promptRings(t, alarm);
    expect(t.prompts.map((p) => p.kind)).toEqual(['wake_check']);
    expect(t.shown).toEqual([]);
    expect(t.wakeChecks.state(KEY(alarm))).toMatchObject({ status: 'pending_verification' });

    t.setNow(at(5, 30));
    await expect(
      t.ring.passWakeCheck({ alarmId: alarm.id, occurrenceKey: KEY(alarm) }),
    ).resolves.toBe('passed');
    expect(t.engine.entries.some((e) => e.kind === 'retrigger')).toBe(false);
    expect(t.engine.ringing).toBeNull();
    expect(count(t, 'wake_check_passed')).toBe(1);
    expect(count(t, 'alarm_dismissed')).toBe(1); // the prompt is not an alarm dismissal
    expect(count(t, 'alarm_trigger_received')).toBe(0); // nor an alarm trigger
    expect(t.wokeUp).toEqual([KEY(alarm)]);
    // A repeated pass is a no-op.
    await expect(
      t.ring.passWakeCheck({ alarmId: alarm.id, occurrenceKey: KEY(alarm) }),
    ).resolves.toBe('not_pending');
    expect(count(t, 'wake_check_passed')).toBe(1);
    t.close();
  });

  it('a pass after the deadline is a fail and the re-trigger stays', async () => {
    const { t, alarm } = await armed();
    await promptRings(t, alarm);
    t.setNow(at(6, 1));
    await expect(
      t.ring.passWakeCheck({ alarmId: alarm.id, occurrenceKey: KEY(alarm) }),
    ).resolves.toBe('late');
    expect(t.engine.entries.some((e) => e.id === `${KEY(alarm)}#retrigger-1`)).toBe(true);
    expect(count(t, 'wake_check_failed')).toBe(1);
    t.close();
  });

  it('no response: the re-trigger rings as a full alarm and re-arms until maxRetriggers', async () => {
    const { t, alarm } = await armed();
    for (const attempt of [1, 2]) {
      // Each cycle is armed at the previous dismissal: 07:00, then 07:06.
      const base = (attempt - 1) * 6;
      await promptRings(t, alarm, base);
      t.setNow(at(base + 6));
      await expect(
        t.ring.timeoutWakeCheck({ alarmId: alarm.id, occurrenceKey: KEY(alarm) }),
      ).resolves.toBe(true);
      expect(t.engine.ringing).toBeNull(); // prompt stopped so the re-trigger can ring

      t.engine.ringing = retrigger(alarm, attempt);
      t.engine.emit('trigger', t.engine.ringing);
      await flush();
      expect(t.shown.at(-1)?.kind).toBe('retrigger');
      expect(t.wakeChecks.state(KEY(alarm))).toMatchObject({ status: 'retriggered', attempt });
      await expect(t.ring.snooze(t.engine.ringing.scheduleId)).rejects.toMatchObject({
        code: 'SNOOZE_LIMIT',
      });
      await t.ring.dismiss(retrigger(alarm, attempt).scheduleId, 'button');
    }
    const retriggered = t.alarms.events.list({ type: 'alarm_retriggered' });
    expect(retriggered.map((e) => e.payload).reverse()).toEqual([
      { reason: 'wake_check_failed', attempt: 1 },
      { reason: 'wake_check_failed', attempt: 2 },
    ]);
    expect(count(t, 'wake_check_failed')).toBe(2);
    expect(count(t, 'wake_check_started')).toBe(2);
    // After the 2nd re-ring the limit is reached: no third check, the wake-up ends.
    expect(t.engine.entries.some((e) => e.id === `${KEY(alarm)}#retrigger-3`)).toBe(false);
    expect(t.wakeChecks.state(KEY(alarm))).toMatchObject({ status: 'retriggered', attempt: 2 });
    expect(t.wokeUp).toEqual([KEY(alarm)]);
    t.close();
  });

  it('resumes after an app kill from wake_checks + observed events, without duplicates', async () => {
    const { t, alarm } = await armed();
    // The app is killed: a fresh service graph over the same database and engine.
    const wakeChecks = createWakeCheckService({
      db: t.db,
      deviceId: 'd1',
      engine: t.engine,
      getAlarm: t.alarms.get,
      clock: () => new Date(at(7)),
    });
    const ring = createRingLifecycle({
      engine: t.engine,
      alarms: t.alarms,
      ledger: t.ledger,
      wakeChecks,
      showRinging: () => undefined,
      showWakeCheck: () => undefined,
      clock: () => new Date(at(7)),
      timeZone: () => NY,
    });
    expect(wakeChecks.state(KEY(alarm))).toMatchObject({ status: 'armed', attempt: 1 });

    const batch = [
      observed(alarm, 'trigger_received', 'w1', at(5), `${KEY(alarm)}#wake-check-1`),
      observed(alarm, 'trigger_received', 'w2', at(6), `${KEY(alarm)}#retrigger-1`),
    ];
    t.engine.observed = batch.map((e) => ({ ...e }));
    t.setNow(at(7));
    await ring.sync('start');
    expect(wakeChecks.state(KEY(alarm))).toMatchObject({ status: 'retriggered', attempt: 1 });
    const before = t.types();
    expect(before.filter((x) => x === 'wake_check_failed')).toHaveLength(1);
    expect(before.filter((x) => x === 'alarm_retriggered')).toHaveLength(1);

    t.engine.observed = batch.map((e) => ({ ...e })); // replay (crash before ack)
    await ring.sync('foreground');
    expect(t.types()).toEqual(before);
    t.close();
  });

  it('an answer window that ended in the background times out on the next sync', async () => {
    const { t, alarm } = await armed();
    await promptRings(t, alarm);
    t.setNow(at(6, 5));
    await t.ring.sync('foreground');
    expect(t.wakeChecks.state(KEY(alarm))).toMatchObject({ status: 'failed' });
    expect(t.engine.ringing).toBeNull();
    t.close();
  });

  it('arming is idempotent and test rings / disabled checks never arm', async () => {
    const { t, alarm } = await armed();
    const armedState = t.wakeChecks.state(KEY(alarm));
    expect(t.wakeChecks.planArm(ringingOf(alarm))).toBeNull(); // already armed
    if (armedState.status === 'armed') await t.wakeChecks.commitArm(ringingOf(alarm), armedState);
    expect(t.engine.entries.filter((e) => e.kind === 'retrigger')).toHaveLength(1);
    expect(count(t, 'wake_check_started')).toBe(1);

    expect(
      t.wakeChecks.planArm({ ...ringingOf(alarm), occurrenceKey: `${alarm.id}#test-1` }),
    ).toBeNull();
    const { alarm: plain } = await t.alarms.save(draft());
    expect(t.wakeChecks.planArm(ringingOf(plain))).toBeNull();
    t.close();
  });
});
