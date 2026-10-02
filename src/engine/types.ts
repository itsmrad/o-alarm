import type {
  AlarmEngineEventPayload,
  AlarmScheduleSpec,
  EngineReadiness,
  PermissionKind,
  PermissionStatus,
  ScheduledAlarm,
  StopEventPayload,
} from '@modules/alarm-engine';

export type {
  AlarmEngineEventPayload,
  AlarmScheduleSpec,
  EngineReadiness,
  PermissionKind,
  PermissionStatus,
  ReadinessItem,
  ReadinessKind,
  ReadinessStatus,
  ScheduleKind,
  ScheduledAlarm,
  StopEventPayload,
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
  /** Ring a test alarm now (preview engine: emits an in-app `trigger` only). */
  previewAlarm(spec: AlarmScheduleSpec): Promise<void>;
  addListener<K extends EngineEventType>(
    type: K,
    listener: (event: EngineEventMap[K]) => void,
  ): EngineSubscription;
}

export type AlarmEngineErrorCode =
  'NOT_IMPLEMENTED' | 'PERMISSION_DENIED' | 'INVALID_SPEC' | 'SCHEDULE_FAILED' | 'UNKNOWN';

const KNOWN_CODES: readonly AlarmEngineErrorCode[] = [
  'NOT_IMPLEMENTED',
  'PERMISSION_DENIED',
  'INVALID_SPEC',
  'SCHEDULE_FAILED',
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
