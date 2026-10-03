import { createAlarm, type Alarm } from '@/domain';
import type { StructuredInsight } from '@/domain/insights';
import { suggestedPrefill } from '@/features/insights/insights-screen';

import { applyPrefill, hasPrefill, parsePrefill, prefillParams } from './prefill';

const alarm = (patch: Partial<Alarm> = {}): Alarm =>
  createAlarm({ id: 'a1', hour: 7, minute: 0, weekdays: [1, 2, 3, 4, 5], ...patch });

const insight = (patch: Partial<StructuredInsight>): StructuredInsight => ({
  id: 'x',
  kind: 'snoozing',
  tone: 'attention',
  confidence: 'medium',
  sampleSize: 8,
  metrics: {},
  ...patch,
});

describe('alarm editor prefill', () => {
  it('round-trips through route params', () => {
    const prefill = {
      hour: 6,
      minute: 45,
      weekdays: [1, 3, 5] as const,
      label: 'Gym',
      snoozeMaxCount: 2 as const,
      wakeCheck: true,
    };
    const params = prefillParams({ ...prefill, weekdays: [...prefill.weekdays] });
    expect(params).toEqual({
      prefill_hour: '6',
      prefill_minute: '45',
      prefill_weekdays: '1,3,5',
      prefill_label: 'Gym',
      prefill_snoozeMaxCount: '2',
      prefill_wakeCheck: '1',
    });
    expect(parsePrefill(params)).toEqual({ ...prefill, weekdays: [1, 3, 5] });
  });

  it('drops malformed values instead of guessing', () => {
    expect(
      parsePrefill({
        prefill_hour: '25',
        prefill_minute: '0',
        prefill_weekdays: '1,9',
        prefill_label: 'x'.repeat(61),
        prefill_snoozeMaxCount: '4',
        prefill_wakeCheck: 'yes',
        id: 'a1',
      }),
    ).toEqual({});
    // An hour without a minute is not a time.
    expect(parsePrefill({ prefill_hour: '6' })).toEqual({});
    expect(hasPrefill(parsePrefill({}))).toBe(false);
  });

  it('only seeds the editor: applies onto the alarm without touching anything else', () => {
    const base = alarm();
    const next = applyPrefill(base, { snoozeMaxCount: 2, wakeCheck: true });
    expect(next.snooze).toEqual({ ...base.snooze, maxCount: 2 });
    expect(next.wakeCheck).toEqual({ ...base.wakeCheck, enabled: true });
    expect({ ...next, snooze: base.snooze, wakeCheck: base.wakeCheck }).toEqual(base);
    expect(applyPrefill(base, {})).toEqual(base);
  });
});

describe('Insights suggestion → editor prefill', () => {
  it('suggests one fewer snooze step when snoozing needs attention', () => {
    expect(suggestedPrefill(insight({}), alarm())).toEqual({ snoozeMaxCount: 2 });
    const one = alarm({ snooze: { enabled: true, durationMin: 9, maxCount: 1 } });
    expect(suggestedPrefill(insight({}), one)).toEqual({});
    expect(suggestedPrefill(insight({ tone: 'positive' }), alarm())).toEqual({});
  });

  it('suggests Wake Check after returning to sleep, unless it is already on', () => {
    expect(suggestedPrefill(insight({ kind: 'returned_to_sleep' }), alarm())).toEqual({
      wakeCheck: true,
    });
    const on = alarm();
    on.wakeCheck = { ...on.wakeCheck, enabled: true };
    expect(suggestedPrefill(insight({ kind: 'returned_to_sleep' }), on)).toEqual({});
    expect(suggestedPrefill(insight({ kind: 'difficult_weekday' }), alarm())).toEqual({});
  });
});
