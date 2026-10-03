import { alarmSchema, createAlarm } from './alarm';
import { EVENT_TYPES, isEventType } from './events';

describe('alarm model', () => {
  it('creates a valid one-time alarm with defaults', () => {
    const alarm = createAlarm({ id: 'a', hour: 7, minute: 0, date: '2026-10-03' });
    expect(alarm).toMatchObject({
      enabled: true,
      timezonePolicy: 'floating',
      timeZone: null,
      snooze: { enabled: true, maxCount: 3 },
      missions: [],
    });
  });

  it('normalizes weekdays', () => {
    expect(createAlarm({ id: 'a', hour: 7, minute: 0, weekdays: [5, 1, 3] }).weekdays).toEqual([
      1, 3, 5,
    ]);
  });

  it.each([
    ['one-time without date', { weekdays: [], date: null }],
    ['recurring with a date', { weekdays: [1], date: '2026-10-03' }],
    ['fixed without zone', { weekdays: [1], timezonePolicy: 'fixed', timeZone: null }],
    ['fixed with bogus zone', { weekdays: [1], timezonePolicy: 'fixed', timeZone: 'X/Y' }],
    ['floating with zone', { weekdays: [1], timeZone: 'Europe/London' }],
    ['hour out of range', { weekdays: [1], hour: 24 }],
    ['invalid date', { weekdays: [], date: '2026-02-30' }],
  ])('rejects %s', (_name, patch) => {
    const base = createAlarm({ id: 'a', hour: 7, minute: 0, weekdays: [1] });
    expect(alarmSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it('accepts a fixed zone alarm', () => {
    const alarm = createAlarm({
      id: 'a',
      hour: 7,
      minute: 0,
      weekdays: [1],
      timezonePolicy: 'fixed',
      timeZone: 'Asia/Tokyo',
    });
    expect(alarm.timeZone).toBe('Asia/Tokyo');
  });
});

describe('events', () => {
  it('covers every PRODUCT.md key event', () => {
    const keyEvents = [
      'alarm_created',
      'alarm_updated',
      'alarm_native_scheduled',
      'alarm_schedule_failed',
      'alarm_expected',
      'alarm_trigger_received',
      'alarm_snoozed',
      'alarm_dismissed',
      'mission_started',
      'mission_completed',
      'mission_failed',
      'wake_check_started',
      'wake_check_passed',
      'wake_check_failed',
      'alarm_retriggered',
    ];
    for (const type of keyEvents) expect(EVENT_TYPES).toContain(type);
    expect(isEventType('alarm_created')).toBe(true);
    expect(isEventType('nope')).toBe(false);
  });
});
