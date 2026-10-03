import { createAlarm, type Alarm } from '@/domain';
import type { AlarmRow } from '@/db/schema';

import {
  alarmFromCloud,
  alarmToCloud,
  decodeSound,
  encodeSound,
  eventToCloud,
  fromIsoWeekday,
  missionAttemptToCloud,
  occurrenceCloudId,
  occurrenceToCloud,
  sleepSessionToCloud,
  toIsoWeekday,
  wakeCheckToCloud,
  type MapContext,
} from './mapping';
import { isUuid, uuidV5 } from './uuid';

const ctx: MapContext = {
  userId: 'user_1',
  deviceId: '11111111-1111-4111-8111-111111111111',
  timeZone: 'America/New_York',
};
const AT = '2026-10-02T05:00:00.000Z';
const ID = 'a0000000-0000-4000-8000-000000000001';

const rowFor = (alarm: Alarm, patch: Partial<AlarmRow> = {}): AlarmRow => ({
  ...alarm,
  createdAt: AT,
  updatedAt: AT,
  version: 3,
  deletedAt: null,
  deviceId: ctx.deviceId,
  ...patch,
});

/** Every field set away from its default, so a dropped field fails the round trip. */
const everyField = createAlarm({
  id: ID,
  hour: 6,
  minute: 45,
  weekdays: [0, 1, 6],
  timezonePolicy: 'fixed',
  timeZone: 'Asia/Tokyo',
  label: 'x'.repeat(60),
  enabled: false,
  sound: { kind: 'custom', id: 'rooster:loud.caf' },
  vibration: false,
  escalation: { enabled: false, rampSeconds: 120 },
  snooze: { enabled: false, durationMin: 15, maxCount: 10 },
  skipNext: `${ID}@2026-10-05`,
  oneOffOverride: { occurrenceKey: `${ID}@2026-10-06`, hour: 5, minute: 10 },
  missions: [
    { missionId: 'math', config: { difficulty: 'hard', problems: 3 } },
    { missionId: 'qr', config: { codeHash: 'abc' } },
  ],
  wakeCheck: {
    enabled: true,
    delayMin: 45,
    responseWindowSec: 300,
    method: 'mission',
    missionId: 'shake',
    maxRetriggers: 10,
  },
  important: true,
  missionBeforeSnooze: true,
});

describe('alarm mapping (D25)', () => {
  it('round-trips every field local → cloud → local', () => {
    const cloud = alarmToCloud(rowFor(everyField), everyField, ctx);
    expect(alarmFromCloud(cloud)).toEqual(everyField);
    // Every local field is represented: the cloud row has no undefined values.
    expect(Object.values(cloud).every((value) => value !== undefined)).toBe(true);
  });

  it('round-trips a one-time floating alarm with defaults', () => {
    const alarm = createAlarm({ id: ID, hour: 23, minute: 59, date: '2026-12-31' });
    expect(alarmFromCloud(alarmToCloud(rowFor(alarm), alarm, ctx))).toEqual(alarm);
  });

  it('maps fields to the cloud columns', () => {
    const cloud = alarmToCloud(rowFor(everyField, { deletedAt: AT }), everyField, ctx);
    expect(cloud).toEqual({
      id: ID,
      user_id: 'user_1',
      device_id: ctx.deviceId,
      created_at: AT,
      deleted_at: AT,
      label: 'x'.repeat(60),
      enabled: false,
      hour: 6,
      minute: 45,
      weekdays: [1, 6, 7],
      one_time_date: null,
      timezone_policy: 'fixed',
      timezone: 'Asia/Tokyo',
      skip_date: '2026-10-05',
      override_date: '2026-10-06',
      override_hour: 5,
      override_minute: 10,
      sound: 'custom:rooster:loud.caf',
      vibrate: false,
      gradual_volume: false,
      gradual_volume_ramp_seconds: 120,
      snooze_enabled: false,
      snooze_minutes: 15,
      snooze_limit: 10,
      mission_chain: everyField.missions,
      mission_before_snooze: true,
      wake_check_enabled: true,
      wake_check_delay_minutes: 45,
      wake_check_method: 'mission',
      wake_check_response_window_seconds: 300,
      wake_check_max_retriggers: 10,
      wake_check_mission_id: 'shake',
      important: true,
    });
  });

  it('maps D32 missionBeforeSnooze', () => {
    const alarm = { ...everyField, missionBeforeSnooze: false };
    expect(alarmToCloud(rowFor(alarm), alarm, ctx).mission_before_snooze).toBe(false);
  });

  it('converts weekdays 0=Sun local ↔ ISO 1..7 cloud', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((d) => toIsoWeekday(d as never))).toEqual([
      7, 1, 2, 3, 4, 5, 6,
    ]);
    expect([1, 2, 3, 4, 5, 6, 7].map(fromIsoWeekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('encodes sounds as kind[:id]', () => {
    for (const sound of [
      { kind: 'default', id: null },
      { kind: 'default', id: 'x' },
      { kind: 'system', id: 'Radar' },
      { kind: 'custom', id: 'a:b' },
    ] as const) {
      expect(decodeSound(encodeSound(sound))).toEqual(sound);
    }
    expect(decodeSound(null)).toEqual({ kind: 'default', id: null });
    expect(decodeSound('weird:thing')).toEqual({ kind: 'default', id: null });
  });

  it('rejects cloud rows that are not valid local alarms', () => {
    const cloud = alarmToCloud(rowFor(everyField), everyField, ctx);
    expect(alarmFromCloud({ ...cloud, label: 'x'.repeat(61) })).toBeNull();
    expect(alarmFromCloud({ ...cloud, weekdays: [], one_time_date: null })).toBeNull();
    expect(alarmFromCloud({ ...cloud, snooze_limit: 20 })).toBeNull();
  });
});

describe('history mapping (push-only)', () => {
  const base = {
    createdAt: AT,
    updatedAt: AT,
    version: 1,
    deletedAt: null,
    deviceId: 'not-a-uuid',
  };

  it('maps occurrences with a deterministic id, the key date and the outcome', () => {
    const key = `${ID}@2026-10-03`;
    const row = occurrenceToCloud(
      {
        ...base,
        id: 'local',
        alarmId: ID,
        occurrenceKey: key,
        expectedAt: '2026-10-03T10:00:00.000Z',
        status: 'dismissed',
        triggeredAt: '2026-10-03T10:00:00.000Z',
        dismissedAt: null,
        snoozeCount: 2,
      },
      ctx,
    );
    expect(row).toMatchObject({
      id: occurrenceCloudId(key),
      device_id: ctx.deviceId,
      local_date: '2026-10-03',
      outcome: 'dismissed',
      schedule_status: 'scheduled',
      dismissed_at: '2026-10-03T10:00:00.000Z',
      snooze_count: 2,
    });
  });

  it('maps wake checks from the persisted reducer state', () => {
    const row = wakeCheckToCloud(
      {
        ...base,
        id: 'w',
        wakeSessionId: 's',
        occurrenceKey: `${ID}@2026-10-03`,
        attempt: 2,
        status: 'failed',
        state: { status: 'failed', attempt: 2, at: AT, reason: 'no_response' },
      },
      ctx,
      'movement',
    );
    expect(row).toMatchObject({
      check_number: 2,
      method: 'movement',
      outcome: 'no_response',
      due_at: AT,
    });
  });

  it('drops unknown mission types and event names, and oversized payloads', () => {
    const attempt = {
      ...base,
      id: 'm',
      wakeSessionId: 's',
      stepIndex: 0,
      outcome: null,
      startedAt: AT,
      endedAt: null,
      details: null,
    };
    expect(missionAttemptToCloud({ ...attempt, missionId: 'teleport' }, ctx)).toBeNull();
    expect(missionAttemptToCloud({ ...attempt, missionId: 'math' }, ctx)).toMatchObject({
      mission_type: 'math',
      outcome: 'in_progress',
      metrics: {},
    });
    const event = { ...base, id: 'e', occurredAt: AT, alarmId: 'nope', occurrenceKey: null };
    expect(eventToCloud({ ...event, type: 'made_up', payload: {} }, ctx)).toBeNull();
    expect(
      eventToCloud(
        { ...event, type: 'alarm_updated', payload: { changed: ['x'.repeat(5000)] } },
        ctx,
      ),
    ).toMatchObject({ name: 'alarm_updated', alarm_id: null, properties: {} });
  });

  it('derives the sleep local_date from the wake time and maps estimated → inferred', () => {
    const row = sleepSessionToCloud(
      {
        ...base,
        id: 's',
        startedAt: '2026-10-03T03:00:00.000Z',
        endedAt: '2026-10-03T11:00:00.000Z',
        source: 'estimated',
      },
      ctx,
    );
    expect(row).toMatchObject({ local_date: '2026-10-03', source: 'inferred', kind: 'night' });
  });
});

describe('uuidV5', () => {
  it('matches the RFC 4122 reference vector', () => {
    // python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    expect(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });

  it('is deterministic, distinct per name and well-formed', () => {
    expect(uuidV5('a')).toBe(uuidV5('a'));
    expect(uuidV5('a')).not.toBe(uuidV5('b'));
    expect(isUuid(uuidV5('ünïcødé 🚀'))).toBe(true);
  });
});
