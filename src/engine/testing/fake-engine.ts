import {
  AlarmEngineError,
  type AlarmEngine,
  type AlarmEngineErrorCode,
  type AlarmScheduleSpec,
  type DismissOptions,
  type DismissResult,
  type EngineEventMap,
  type EngineEventType,
  type EngineReadiness,
  type EngineSubscription,
  type ObservedEngineEvent,
  type PermissionStatus,
  type RingingState,
  type ScheduledAlarm,
} from '../types';

/**
 * Test double with an inspectable store (duplicates allowed, to simulate a buggy OS
 * state) plus switchable failures. Records every call.
 */
export class FakeAlarmEngine implements AlarmEngine {
  readonly kind = 'native' as const;
  entries: ScheduledAlarm[] = [];
  calls: string[] = [];
  failSchedule: AlarmEngineErrorCode | null = null;
  failRead: AlarmEngineErrorCode | null = null;
  /** Simulates an OS that silently alters what it stores (verify must catch it). */
  corruptOnSchedule: ((entry: ScheduledAlarm) => ScheduledAlarm) | null = null;
  /** Set by tests to simulate an alarm ringing. */
  ringing: RingingState | null = null;
  /** Set by tests to simulate events the native layer recorded. */
  observed: ObservedEngineEvent[] = [];
  private listeners = new Map<EngineEventType, Set<(event: never) => void>>();

  async schedule(spec: AlarmScheduleSpec): Promise<ScheduledAlarm> {
    this.calls.push(`schedule:${spec.id}`);
    if (this.failSchedule)
      throw new AlarmEngineError(this.failSchedule, `schedule ${spec.id} failed`);
    let entry: ScheduledAlarm = { ...spec, scheduledAt: '2026-01-01T00:00:00.000Z' };
    if (this.corruptOnSchedule) entry = this.corruptOnSchedule(entry);
    this.entries = [...this.entries.filter((e) => e.id !== spec.id), entry];
    return entry;
  }

  async cancel(id: string): Promise<void> {
    this.calls.push(`cancel:${id}`);
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  async cancelAll(): Promise<void> {
    this.calls.push('cancelAll');
    this.entries = [];
  }

  async getScheduled(): Promise<ScheduledAlarm[]> {
    if (this.failRead) throw new AlarmEngineError(this.failRead, 'read failed');
    return this.entries.map((e) => ({ ...e }));
  }

  async getReadiness(): Promise<EngineReadiness> {
    return { engine: 'native', canRing: true, checkedAt: '2026-01-01T00:00:00.000Z', items: [] };
  }

  async requestPermission(): Promise<PermissionStatus> {
    return 'granted';
  }

  async previewAlarm(): Promise<void> {}

  async getActiveRinging(): Promise<RingingState | null> {
    return this.ringing ? { ...this.ringing } : null;
  }

  private takeRinging(scheduleId: string): RingingState {
    if (this.ringing?.scheduleId !== scheduleId) {
      throw new AlarmEngineError('NOT_RINGING', `"${scheduleId}" is not ringing`);
    }
    const ringing = this.ringing;
    this.ringing = null;
    return ringing;
  }

  /** Schedules `<occurrenceKey>#snooze-n` 9 minutes after the ring (fake fixed duration). */
  async snooze(scheduleId: string): Promise<ScheduledAlarm> {
    this.calls.push(`snooze:${scheduleId}`);
    const ringing = this.takeRinging(scheduleId);
    const base = this.entries.find((e) => e.occurrenceKey === ringing.occurrenceKey) ?? null;
    if (!base) throw new AlarmEngineError('INVALID_SPEC', 'fake: no spec for ringing alarm');
    const fireAt = new Date(Date.parse(ringing.firedAt) + 9 * 60_000).toISOString();
    const id = `${ringing.occurrenceKey}#snooze-${ringing.snoozeCount + 1}`;
    const { wallClock: _w, ...instant } = base;
    return this.schedule({ ...instant, id, kind: 'snooze', fireAt });
  }

  async dismiss(scheduleId: string, options: DismissOptions): Promise<DismissResult> {
    this.calls.push(`dismiss:${scheduleId}`);
    const ringing = this.takeRinging(scheduleId);
    if (options.wakeCheckAt === undefined) return {};
    const base = this.entries.find((e) => e.occurrenceKey === ringing.occurrenceKey) ?? null;
    if (!base) throw new AlarmEngineError('INVALID_SPEC', 'fake: no spec for ringing alarm');
    const id = `${ringing.occurrenceKey}#wake-check-1`;
    const { wallClock: _w, ...instant } = base;
    return {
      wakeCheck: await this.schedule({
        ...instant,
        id,
        kind: 'wake_check',
        fireAt: options.wakeCheckAt,
      }),
    };
  }

  async drainObservedEvents(): Promise<ObservedEngineEvent[]> {
    return this.observed.map((e) => ({ ...e }));
  }

  async ackObservedEvents(ids: string[]): Promise<void> {
    this.observed = this.observed.filter((e) => !ids.includes(e.id));
  }

  addListener<K extends EngineEventType>(
    type: K,
    listener: (event: EngineEventMap[K]) => void,
  ): EngineSubscription {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(type, set);
    return { remove: () => set.delete(listener as (event: never) => void) };
  }

  emit<K extends EngineEventType>(type: K, event: EngineEventMap[K]): void {
    this.listeners
      .get(type)
      ?.forEach((listener) => (listener as (e: EngineEventMap[K]) => void)(event));
  }
}
