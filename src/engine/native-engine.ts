import type { AlarmEngineNativeModule } from '@modules/alarm-engine';

import type {
  AlarmEngine,
  AlarmScheduleSpec,
  EngineEventMap,
  EngineEventType,
  EngineReadiness,
  EngineSubscription,
  PermissionKind,
  PermissionStatus,
  ScheduledAlarm,
} from './types';
import { AlarmEngineError } from './types';

const NATIVE_EVENT = {
  trigger: 'onTrigger',
  snooze: 'onSnooze',
  dismiss: 'onDismiss',
  stop: 'onStop',
} as const satisfies Record<EngineEventType, string>;

/** Adapts the native module to the AlarmEngine contract, normalizing errors. */
export class NativeAlarmEngine implements AlarmEngine {
  readonly kind = 'native' as const;

  constructor(private readonly native: AlarmEngineNativeModule) {}

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw AlarmEngineError.from(error);
    }
  }

  schedule(spec: AlarmScheduleSpec): Promise<ScheduledAlarm> {
    return this.call(() => this.native.schedule(spec));
  }

  cancel(id: string): Promise<void> {
    return this.call(() => this.native.cancel(id));
  }

  cancelAll(): Promise<void> {
    return this.call(() => this.native.cancelAll());
  }

  getScheduled(): Promise<ScheduledAlarm[]> {
    return this.call(() => this.native.getScheduled());
  }

  getReadiness(): Promise<EngineReadiness> {
    return this.call(() => this.native.getReadiness());
  }

  requestPermission(kind: PermissionKind): Promise<PermissionStatus> {
    return this.call(() => this.native.requestPermission(kind));
  }

  previewAlarm(spec: AlarmScheduleSpec): Promise<void> {
    return this.call(() => this.native.previewAlarm(spec));
  }

  addListener<K extends EngineEventType>(
    type: K,
    listener: (event: EngineEventMap[K]) => void,
  ): EngineSubscription {
    // The module's event map is keyed by native names; payload types are identical.
    const subscribe = this.native.addListener.bind(this.native) as (
      name: string,
      cb: (event: EngineEventMap[K]) => void,
    ) => EngineSubscription;
    return subscribe(NATIVE_EVENT[type], listener);
  }
}
