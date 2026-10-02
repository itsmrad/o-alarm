import type {
  AlarmEngine,
  AlarmScheduleSpec,
  EngineEventMap,
  EngineEventType,
  EngineReadiness,
  EngineSubscription,
  PermissionStatus,
  ScheduledAlarm,
} from './types';
import { AlarmEngineError } from './types';

export const PREVIEW_MODE_MESSAGE =
  'Preview mode — alarms will not ring. Install the development build.';

type Listeners = { [K in EngineEventType]: Set<(event: EngineEventMap[K]) => void> };

/**
 * In-memory JS engine for Expo Go (D6). Stores schedules so the whole app flow works,
 * but it CANNOT ring: readiness reports a blocking item and the UI shows a banner.
 */
export class PreviewAlarmEngine implements AlarmEngine {
  readonly kind = 'preview' as const;
  private readonly scheduled = new Map<string, ScheduledAlarm>();
  private readonly listeners: Listeners = {
    trigger: new Set(),
    snooze: new Set(),
    dismiss: new Set(),
    stop: new Set(),
  };

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async schedule(spec: AlarmScheduleSpec): Promise<ScheduledAlarm> {
    const fireAt = Date.parse(spec.fireAt);
    if (!spec.id || Number.isNaN(fireAt)) {
      throw new AlarmEngineError('INVALID_SPEC', `Invalid schedule spec "${spec.id}"`);
    }
    if (fireAt <= this.clock().getTime()) {
      throw new AlarmEngineError('INVALID_SPEC', `Fire time ${spec.fireAt} is in the past`);
    }
    const entry: ScheduledAlarm = { ...spec, scheduledAt: this.clock().toISOString() };
    this.scheduled.set(spec.id, entry);
    return { ...entry };
  }

  async cancel(id: string): Promise<void> {
    this.scheduled.delete(id);
  }

  async cancelAll(): Promise<void> {
    this.scheduled.clear();
  }

  async getScheduled(): Promise<ScheduledAlarm[]> {
    return [...this.scheduled.values()].map((entry) => ({ ...entry }));
  }

  async getReadiness(): Promise<EngineReadiness> {
    return {
      engine: 'preview',
      canRing: false,
      checkedAt: this.clock().toISOString(),
      items: [
        {
          kind: 'engine',
          status: 'blocking',
          title: 'Preview mode',
          detail: `${PREVIEW_MODE_MESSAGE} Expo Go cannot load the native alarm engine.`,
          action: null,
        },
      ],
    };
  }

  async requestPermission(): Promise<PermissionStatus> {
    return 'unavailable';
  }

  async previewAlarm(spec: AlarmScheduleSpec): Promise<void> {
    const event = {
      scheduleId: spec.id,
      alarmId: spec.alarmId,
      occurrenceKey: spec.occurrenceKey,
      kind: spec.kind,
      at: this.clock().toISOString(),
    };
    // Async like a real engine callback.
    setTimeout(() => this.listeners.trigger.forEach((listener) => listener(event)), 0);
  }

  addListener<K extends EngineEventType>(
    type: K,
    listener: (event: EngineEventMap[K]) => void,
  ): EngineSubscription {
    const set = this.listeners[type] as Set<(event: EngineEventMap[K]) => void>;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }
}
