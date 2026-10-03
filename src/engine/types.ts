import type {
  AlarmEngineEventPayload,
  AlarmScheduleSpec,
  DismissOptions,
  DismissResult,
  EngineReadiness,
  ObservedEngineEvent,
  PermissionKind,
  PermissionStatus,
  RingingState,
  ScheduledAlarm,
  StopEventPayload,
} from '@modules/alarm-engine';

export type {
  AlarmEngineEventPayload,
  AlarmScheduleSpec,
  DismissOptions,
  DismissResult,
  EngineReadiness,
  ObservedEngineEvent,
  ObservedEngineEventType,
  PermissionKind,
  PermissionStatus,
  ReadinessItem,
  ReadinessKind,
  ReadinessStatus,
  RingingState,
  ScheduleKind,
  ScheduledAlarm,
  StopEventPayload,
  WallClock,
} from '@modules/alarm-engine';

export type EngineKind = 'native' | 'preview';

export interface EngineEventMap {
  trigger: AlarmEngineEventPayload;
  snooze: AlarmEngineEventPayload;
  dismiss: AlarmEngineEventPayload;
  stop: StopEventPayload;
}
export type EngineEventType = keyof EngineEventMap;

export interface EngineSubscription {
  remove(): void;
}

/**
 * The single seam between the app and OS alarm scheduling. Implemented natively
 * (modules/alarm-engine) and by PreviewAlarmEngine for Expo Go (D6).
 *
 * Contract:
 * - `schedule` is an idempotent upsert keyed by `spec.id`; it never creates duplicates.
 * - `getScheduled` reads back what the engine really holds, for verification (D11).
 * - Failures reject with `AlarmEngineError`; nothing fails silently.
 */
export interface AlarmEngine {
  readonly kind: EngineKind;
  schedule(spec: AlarmScheduleSpec): Promise<ScheduledAlarm>;
  cancel(id: string): Promise<void>;
  cancelAll(): Promise<void>;
  getScheduled(): Promise<ScheduledAlarm[]>;
  getReadiness(): Promise<EngineReadiness>;
  requestPermission(kind: PermissionKind): Promise<PermissionStatus>;
  /** Ring a test alarm now (preview engine: in-app ring only, no sound). */
  previewAlarm(spec: AlarmScheduleSpec): Promise<void>;

  /** The alarm ringing right now, if any — for cold start / relaunch while ringing. */
  getActiveRinging(): Promise<RingingState | null>;
  /**
   * Stop sound/vibration and atomically schedule the snooze re-trigger (D13). The domain
   * enforces snooze limits first; the engine also rejects `SNOOZE_LIMIT` (defense in depth).
   * Rejects `NOT_RINGING` if `scheduleId` is not the ringing alarm.
   */
  snooze(scheduleId: string): Promise<ScheduledAlarm>;
  /**
   * Stop ringing. With `wakeCheckAt`, atomically schedule a `wake_check` alarm (D13).
   * Rejects `NOT_RINGING` if `scheduleId` is not the ringing alarm.
   */
  dismiss(scheduleId: string, options: DismissOptions): Promise<DismissResult>;
  /**
   * Events recorded by the engine while JS may not have run. Returns the same events
   * until they are acknowledged, so a crash between drain and persist loses nothing.
   */
  drainObservedEvents(): Promise<ObservedEngineEvent[]>;
  /** Forget acknowledged events. Unknown ids are ignored (idempotent). */
  ackObservedEvents(ids: string[]): Promise<void>;
  addListener<K extends EngineEventType>(
    type: K,
    listener: (event: EngineEventMap[K]) => void,
  ): EngineSubscription;
}

export type AlarmEngineErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'PERMISSION_DENIED'
  | 'INVALID_SPEC'
  | 'SCHEDULE_FAILED'
  | 'SNOOZE_LIMIT'
  | 'NOT_RINGING'
  | 'UNKNOWN';

const KNOWN_CODES: readonly AlarmEngineErrorCode[] = [
  'NOT_IMPLEMENTED',
  'PERMISSION_DENIED',
  'INVALID_SPEC',
  'SCHEDULE_FAILED',
  'SNOOZE_LIMIT',
  'NOT_RINGING',
];

export class AlarmEngineError extends Error {
  readonly code: AlarmEngineErrorCode;

  constructor(code: AlarmEngineErrorCode, message: string) {
    super(message);
    this.name = 'AlarmEngineError';
    this.code = code;
  }

  /** Normalizes anything thrown by an engine (incl. native CodedErrors). */
  static from(error: unknown): AlarmEngineError {
    if (error instanceof AlarmEngineError) return error;
    const raw = error as { code?: unknown; message?: unknown } | null;
    const rawCode = typeof raw?.code === 'string' ? raw.code.replace(/^ERR_/, '') : '';
    const code = (KNOWN_CODES as readonly string[]).includes(rawCode)
      ? (rawCode as AlarmEngineErrorCode)
      : 'UNKNOWN';
    const message = typeof raw?.message === 'string' ? raw.message : String(error);
    return new AlarmEngineError(code, message);
  }
}
