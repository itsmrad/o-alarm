import type {
  AlarmEngine,
  AlarmScheduleSpec,
  EngineEventMap,
  EngineEventType,
  EngineReadiness,
  EngineSubscription,
  PermissionStatus,
  ScheduledAlarm,
} from '../types';
import { AlarmEngineError, type AlarmEngineErrorCode } from '../types';

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
