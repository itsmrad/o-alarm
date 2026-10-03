import { createAlarm, computeNextFire } from '@/domain';
import type { EngineReadiness, ReadinessItem, ScheduledAlarm } from '@/engine';
import { specForOccurrence } from '@/engine';

import { likelyMissCauses, nextAlarmReadiness } from './readiness-summary';

const NY = 'America/New_York';
const NOW = new Date('2026-10-02T09:00:00Z');
const alarm = createAlarm({ id: 'a1', hour: 7, minute: 0, weekdays: [1, 2, 3, 4, 5] });
const next = computeNextFire(alarm, NOW, NY)!;
const held: ScheduledAlarm[] = [{ ...specForOccurrence(alarm, next), scheduledAt: '' }];

const item = (patch: Partial<ReadinessItem>): ReadinessItem => ({
  kind: 'exact_alarm',
  status: 'ok',
  title: 'Exact alarms',
  detail: 'Allowed',
  action: null,
  ...patch,
});
const readiness = (items: ReadinessItem[]): EngineReadiness => ({
  engine: 'native',
  canRing: !items.some((i) => i.status === 'blocking'),
  checkedAt: NOW.toISOString(),
  items,
});
const scheduled = { state: 'scheduled' as const, engine: 'native' as const, nextFire: next };

describe('nextAlarmReadiness', () => {
  it('is ready when scheduled, held by the system and nothing blocks', () => {
    expect(
      nextAlarmReadiness({
        next,
        status: scheduled,
        readiness: readiness([item({})]),
        scheduled: held,
      }),
    ).toEqual({ level: 'ready', headline: 'Your next alarm is ready', reasons: [] });
  });

  it('reports warnings as at risk', () => {
    const result = nextAlarmReadiness({
      next,
      status: scheduled,
      readiness: readiness([item({ status: 'warning', title: 'Battery optimization' })]),
      scheduled: held,
    });
    expect(result).toMatchObject({ level: 'at_risk', reasons: ['Battery optimization'] });
  });

  it('is blocked when the system lost the alarm, scheduling failed, or a permission blocks', () => {
    expect(
      nextAlarmReadiness({ next, status: scheduled, readiness: readiness([]), scheduled: [] }),
    ).toMatchObject({
      level: 'blocked',
      reasons: ['The system does not hold this alarm right now.'],
    });
    const failed = nextAlarmReadiness({
      next,
      status: { state: 'failed', engine: 'native', nextFire: next, code: 'X', message: 'nope' },
      readiness: readiness([item({ status: 'blocking', title: 'Alarms not allowed' })]),
      scheduled: held,
    });
    expect(failed.level).toBe('blocked');
    expect(failed.reasons).toEqual(['Not scheduled: nope', 'Alarms not allowed']);
  });

  it('says so when there is no alarm', () => {
    expect(
      nextAlarmReadiness({ next: null, status: undefined, readiness: null, scheduled: null }).level,
    ).toBe('none');
  });
});

describe('likelyMissCauses', () => {
  it('lists preview mode and non-ok readiness items', () => {
    const causes = likelyMissCauses(
      'preview',
      readiness([
        item({ kind: 'engine', status: 'blocking', title: 'Preview mode' }),
        item({ status: 'warning', title: 'Notifications off', detail: 'Turn them on' }),
      ]),
    );
    expect(causes.map((c) => c.title)).toEqual(['Preview mode', 'Notifications off']);
  });

  it('never claims certainty when nothing looks wrong', () => {
    expect(likelyMissCauses('native', readiness([item({})])).map((c) => c.title)).toEqual([
      'No problem found right now',
    ]);
  });
});
