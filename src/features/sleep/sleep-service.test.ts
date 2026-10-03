import { createTestDatabase } from '@/db/testing/test-db';
import { outbox } from '@/db/schema';

import { createSleepService } from './sleep-service';

let n = 0;
let nowIso = '2026-10-03T03:00:00Z';
function setup() {
  const { db, close } = createTestDatabase();
  const service = createSleepService({
    db,
    deviceId: 'dev',
    clock: () => new Date(nowIso),
    newId: () => `id-${++n}`,
  });
  return { db, service, close };
}
const at = (iso: string) => new Date(iso);

describe('sleep sessions', () => {
  it('starts a session, and starting again while one is open is a no-op', () => {
    const { service, close } = setup();
    const first = service.startSleepSession(at('2026-10-03T03:00:00Z'));
    const second = service.startSleepSession(at('2026-10-03T03:05:00Z'));
    expect(second.id).toBe(first.id);
    expect(service.listSessions()).toHaveLength(1);
    expect(service.getActiveSession()?.id).toBe(first.id);
    close();
  });

  it('endActiveSleepSession closes the open session at the given instant', () => {
    const { service, close } = setup();
    service.startSleepSession(at('2026-10-03T03:00:00Z'));
    const ended = service.endActiveSleepSession(at('2026-10-03T11:00:00Z'));
    expect(ended).toMatchObject({
      startedAt: '2026-10-03T03:00:00.000Z',
      endedAt: '2026-10-03T11:00:00.000Z',
      version: 2,
    });
    expect(service.getActiveSession()).toBeNull();
    close();
  });

  it('endActiveSleepSession with nothing open returns null (alarm dismissed without "going to bed")', () => {
    const { service, close } = setup();
    expect(service.endActiveSleepSession(at('2026-10-03T11:00:00Z'))).toBeNull();
    close();
  });

  it('discards a stale open session instead of recording a 30 hour night', () => {
    const { service, close } = setup();
    service.startSleepSession(at('2026-10-01T03:00:00Z'));
    expect(service.endActiveSleepSession(at('2026-10-03T11:00:00Z'))).toBeNull();
    expect(service.listSessions()).toHaveLength(0);
    close();
  });

  it('starting after a stale open session replaces it', () => {
    const { service, close } = setup();
    const stale = service.startSleepSession(at('2026-10-01T03:00:00Z'));
    const fresh = service.startSleepSession(at('2026-10-03T03:00:00Z'));
    expect(fresh.id).not.toBe(stale.id);
    expect(service.listSessions().map((s) => s.id)).toEqual([fresh.id]);
    close();
  });

  it('manual edit changes times, marks the source manual, and validates', () => {
    const { service, close } = setup();
    const s = service.startSleepSession(at('2026-10-03T03:00:00Z'));
    service.endActiveSleepSession(at('2026-10-03T11:00:00Z'));
    const edited = service.updateSession(s.id, {
      startedAt: at('2026-10-03T02:30:00Z'),
      endedAt: at('2026-10-03T10:45:00Z'),
    });
    expect(edited).toMatchObject({
      startedAt: '2026-10-03T02:30:00.000Z',
      endedAt: '2026-10-03T10:45:00.000Z',
      source: 'manual',
    });
    expect(() =>
      service.updateSession(s.id, {
        startedAt: at('2026-10-03T11:00:00Z'),
        endedAt: at('2026-10-03T03:00:00Z'),
      }),
    ).toThrow(/after bedtime/);
    close();
  });

  it('deleting hides a session from history', () => {
    const { service, close } = setup();
    const s = service.startSleepSession(at('2026-10-03T03:00:00Z'));
    service.endActiveSleepSession(at('2026-10-03T11:00:00Z'));
    service.deleteSession(s.id);
    expect(service.listSessions()).toEqual([]);
    close();
  });

  it('lists newest first and honors `since`', () => {
    const { service, close } = setup();
    for (const day of ['01', '02', '03']) {
      service.startSleepSession(at(`2026-10-${day}T03:00:00Z`));
      service.endActiveSleepSession(at(`2026-10-${day}T11:00:00Z`));
    }
    expect(service.listSessions().map((s) => s.startedAt.slice(0, 10))).toEqual([
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
    ]);
    expect(service.listSessions({ since: at('2026-10-02T00:00:00Z') })).toHaveLength(2);
    close();
  });

  it('queues writes for sync (D17) without sending anything anywhere else', () => {
    const { db, service, close } = setup();
    service.startSleepSession(at('2026-10-03T03:00:00Z'));
    service.endActiveSleepSession(at('2026-10-03T11:00:00Z'));
    expect(
      db
        .select()
        .from(outbox)
        .all()
        .map((o) => o.entity),
    ).toEqual(['sleep_sessions', 'sleep_sessions']);
    close();
  });
});

describe('morning check-ins', () => {
  it('persists energy and sleep quality for a morning', () => {
    const { service, close } = setup();
    const saved = service.saveCheckIn({
      date: '2026-10-03',
      energy: 4,
      sleepQuality: 3,
      wakeSessionId: 'w1',
    });
    expect(saved).toMatchObject({
      date: '2026-10-03',
      energy: 4,
      sleepQuality: 3,
      wakeSessionId: 'w1',
      version: 1,
    });
    expect(service.getCheckIn('2026-10-03')?.energy).toBe(4);
    expect(service.listCheckIns()).toHaveLength(1);
    close();
  });

  it('replaces an earlier answer for the same morning instead of adding a row', () => {
    const { service, close } = setup();
    service.saveCheckIn({ date: '2026-10-03', energy: 2, sleepQuality: 2 });
    const second = service.saveCheckIn({ date: '2026-10-03', energy: 5, sleepQuality: 4 });
    expect(second).toMatchObject({ energy: 5, sleepQuality: 4, version: 2 });
    expect(service.listCheckIns()).toHaveLength(1);
    close();
  });

  it('a skip is recorded so the user is not asked again, and never erases an answer', () => {
    const { service, close } = setup();
    expect(service.hasCheckInEntry('2026-10-03')).toBe(false);
    service.skipCheckIn('2026-10-03');
    expect(service.hasCheckInEntry('2026-10-03')).toBe(true);
    expect(service.getCheckIn('2026-10-03')).toMatchObject({ energy: null, sleepQuality: null });

    service.saveCheckIn({ date: '2026-10-04', energy: 3, sleepQuality: 3 });
    service.skipCheckIn('2026-10-04');
    expect(service.getCheckIn('2026-10-04')).toMatchObject({ energy: 3, sleepQuality: 3 });
    close();
  });

  it('allows one rating alone and rejects out-of-range values', () => {
    const { service, close } = setup();
    expect(
      service.saveCheckIn({ date: '2026-10-03', energy: 5, sleepQuality: null }).sleepQuality,
    ).toBeNull();
    expect(() => service.saveCheckIn({ date: '2026-10-03', energy: 6, sleepQuality: 3 })).toThrow();
    expect(() =>
      service.saveCheckIn({ date: '2026-10-03', energy: 2.5, sleepQuality: 3 }),
    ).toThrow();
    close();
  });
});

describe('preferences', () => {
  it('defaults, persists patches, and survives reload', () => {
    const { service, close } = setup();
    expect(service.getSleepPrefs()).toMatchObject({ mode: 'auto', desiredSleepMin: 480 });
    service.setSleepPrefs({ desiredSleepMin: 450, latencyMin: 20 });
    expect(service.getSleepPrefs()).toMatchObject({
      desiredSleepMin: 450,
      latencyMin: 20,
      windDownMin: 45,
    });
    service.setSleepPrefs({ mode: 'manual' });
    expect(service.getSleepPrefs()).toMatchObject({ mode: 'manual', desiredSleepMin: 450 });
    close();
  });

  it('rejects invalid prefs and keeps reminder prefs separate and opt-in', () => {
    const { service, close } = setup();
    expect(() => service.setSleepPrefs({ desiredSleepMin: 30 })).toThrow();
    expect(service.getReminderPrefs()).toMatchObject({ bedtime: false, caffeine: false });
    service.setReminderPrefs({ bedtime: true });
    expect(service.getReminderPrefs()).toMatchObject({ bedtime: true, windDown: false });
    expect(service.getSleepPrefs().mode).toBe('auto');
    close();
  });

  it('notifies subscribers on every write', () => {
    const { service, close } = setup();
    const listener = jest.fn();
    const off = service.subscribe(listener);
    service.setSleepPrefs({ latencyMin: 10 });
    service.startSleepSession(at('2026-10-03T03:00:00Z'));
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    service.saveCheckIn({ date: '2026-10-03', energy: 3, sleepQuality: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
    close();
  });
});
