import { snoozeScheduleId, wakeCheckScheduleId } from '@/domain';

import type {
  AlarmEngine,
  AlarmEngineEventPayload,
  AlarmScheduleSpec,
  DismissOptions,
  DismissResult,
  EngineEventMap,
  EngineEventType,
  EngineReadiness,
  EngineSubscription,
  ObservedEngineEvent,
  ObservedEngineEventType,
  PermissionStatus,
  RingingState,
  ScheduledAlarm,
} from './types';
import { AlarmEngineError } from './types';

export const PREVIEW_MODE_MESSAGE =
  'Preview mode — alarms will not ring. Install the development build.';

type Listeners = { [K in EngineEventType]: Set<(event: EngineEventMap[K]) => void> };

/** Snooze/wake-check follow-ups are instant-only: they never carry a wall-clock rule (D28). */
function instantOnly(spec: AlarmScheduleSpec): AlarmScheduleSpec {
  const { wallClock: _wallClock, ...rest } = spec;
  return rest;
}

/** Longest single timer; re-checked after, so long waits never drift or trip RN warnings. */
const MAX_TIMER_MS = 60_000;

export interface PreviewEngineOptions {
  /** Fire due alarms from a JS timer while the app is open (default true). */
  autoRing?: boolean;
}

/**
 * In-memory JS engine for Expo Go (D6). Stores schedules and simulates the ringing flow
 * (trigger → snooze / dismiss → wake check) while the app is open, so it is demoable.
 * It CANNOT ring for real: no OS alarm, no sound (the UI owns preview audio), nothing
 * when the app is closed. Readiness reports a blocking item and the UI shows a banner.
 */
export class PreviewAlarmEngine implements AlarmEngine {
  readonly kind = 'preview' as const;
  private readonly scheduled = new Map<string, ScheduledAlarm>();
  private ringing: { state: RingingState; spec: AlarmScheduleSpec } | null = null;
  /** Snoozes used per occurrence; reset on dismiss. */
  private readonly snoozeCounts = new Map<string, number>();
  /** Wake-check attempts per occurrence (for deterministic schedule ids). */
  private readonly wakeCheckAttempts = new Map<string, number>();
  private observed: ObservedEngineEvent[] = [];
  private eventSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly autoRing: boolean;
  private readonly listeners: Listeners = {
    trigger: new Set(),
    snooze: new Set(),
    dismiss: new Set(),
    stop: new Set(),
  };

  constructor(
    private readonly clock: () => Date = () => new Date(),
    options: PreviewEngineOptions = {},
  ) {
    this.autoRing = options.autoRing ?? true;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private store(spec: AlarmScheduleSpec): ScheduledAlarm {
    const fireAt = Date.parse(spec.fireAt);
    if (!spec.id || Number.isNaN(fireAt)) {
      throw new AlarmEngineError('INVALID_SPEC', `Invalid schedule spec "${spec.id}"`);
    }
    if (fireAt <= this.clock().getTime()) {
      throw new AlarmEngineError('INVALID_SPEC', `Fire time ${spec.fireAt} is in the past`);
    }
    const entry: ScheduledAlarm = { ...spec, scheduledAt: this.now() };
    this.scheduled.set(spec.id, entry);
    return { ...entry };
  }

  async schedule(spec: AlarmScheduleSpec): Promise<ScheduledAlarm> {
    const entry = this.store(spec);
    this.armTimer();
    return entry;
  }

  async cancel(id: string): Promise<void> {
    this.scheduled.delete(id);
    this.armTimer();
  }

  async cancelAll(): Promise<void> {
    this.scheduled.clear();
    this.armTimer();
  }

  async getScheduled(): Promise<ScheduledAlarm[]> {
    return [...this.scheduled.values()].map((entry) => ({ ...entry }));
  }

  async getReadiness(): Promise<EngineReadiness> {
    return {
      engine: 'preview',
      canRing: false,
      checkedAt: this.now(),
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
    // A test ring takes over whatever is ringing.
    this.ring(spec);
  }

  async getActiveRinging(): Promise<RingingState | null> {
    return this.ringing ? { ...this.ringing.state } : null;
  }

  async snooze(scheduleId: string): Promise<ScheduledAlarm> {
    const { state, spec } = this.requireRinging(scheduleId);
    const used = this.snoozeCounts.get(state.occurrenceKey) ?? 0;
    if (!spec.snooze.enabled || used >= spec.snooze.maxCount) {
      throw new AlarmEngineError(
        'SNOOZE_LIMIT',
        `Snooze limit reached (${used}/${spec.snooze.enabled ? spec.snooze.maxCount : 0})`,
      );
    }
    const fireAt = new Date(this.clock().getTime() + spec.snooze.durationMin * 60_000);
    const entry = this.store({
      ...instantOnly(spec),
      id: snoozeScheduleId(state.occurrenceKey, used + 1),
      kind: 'snooze',
      fireAt: fireAt.toISOString(),
    });
    this.snoozeCounts.set(state.occurrenceKey, used + 1);
    this.ringing = null;
    this.record('snoozed', state);
    this.emit('snooze', this.payload(state));
    this.armTimer();
    return entry;
  }

  async dismiss(scheduleId: string, options: DismissOptions): Promise<DismissResult> {
    const { state, spec } = this.requireRinging(scheduleId);
    let wakeCheck: ScheduledAlarm | undefined;
    if (options.wakeCheckAt !== undefined) {
      // Validate + store before clearing the ring, so a bad wakeCheckAt leaves it ringing.
      const attempt = (this.wakeCheckAttempts.get(state.occurrenceKey) ?? 0) + 1;
      wakeCheck = this.store({
        ...instantOnly(spec),
        id: wakeCheckScheduleId(state.occurrenceKey, attempt),
        kind: 'wake_check',
        fireAt: options.wakeCheckAt,
      });
      this.wakeCheckAttempts.set(state.occurrenceKey, attempt);
    }
    this.ringing = null;
    this.snoozeCounts.delete(state.occurrenceKey);
    this.record('dismissed', state);
    this.emit('dismiss', this.payload(state));
    this.armTimer();
    return wakeCheck ? { wakeCheck } : {};
  }

  async drainObservedEvents(): Promise<ObservedEngineEvent[]> {
    return this.observed.map((event) => ({ ...event }));
  }

  async ackObservedEvents(ids: string[]): Promise<void> {
    const acked = new Set(ids);
    this.observed = this.observed.filter((event) => !acked.has(event.id));
  }

  /**
   * Rings the earliest due alarm, if nothing is ringing. Called by the internal timer;
   * public so the app (e.g. on foreground) and tests can force a check.
   */
  checkDue(): void {
    if (this.ringing) return;
    const now = this.clock().getTime();
    const due = [...this.scheduled.values()]
      .filter((entry) => Date.parse(entry.fireAt) <= now)
      .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt))[0];
    if (due) {
      this.scheduled.delete(due.id);
      this.ring(due);
    }
    this.armTimer();
  }

  addListener<K extends EngineEventType>(
    type: K,
    listener: (event: EngineEventMap[K]) => void,
  ): EngineSubscription {
    const set = this.listeners[type] as Set<(event: EngineEventMap[K]) => void>;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }

  private ring(spec: AlarmScheduleSpec): void {
    const at = this.now();
    const state: RingingState = {
      scheduleId: spec.id,
      alarmId: spec.alarmId,
      occurrenceKey: spec.occurrenceKey,
      kind: spec.kind,
      at,
      firedAt: at,
      snoozeCount: this.snoozeCounts.get(spec.occurrenceKey) ?? 0,
      label: spec.label,
      hasMissions: spec.hasMissions,
      wakeCheck: spec.wakeCheck,
      important: spec.important,
    };
    this.ringing = { state, spec };
    this.record('trigger_received', state);
    // Async like a real engine callback.
    setTimeout(() => this.emit('trigger', this.payload(state)), 0);
  }

  private requireRinging(scheduleId: string) {
    if (!this.ringing || this.ringing.state.scheduleId !== scheduleId) {
      throw new AlarmEngineError('NOT_RINGING', `"${scheduleId}" is not ringing`);
    }
    return this.ringing;
  }

  private payload(state: RingingState): AlarmEngineEventPayload {
    return {
      scheduleId: state.scheduleId,
      alarmId: state.alarmId,
      occurrenceKey: state.occurrenceKey,
      kind: state.kind,
      at: this.now(),
    };
  }

  private record(type: ObservedEngineEventType, state: RingingState): void {
    this.observed.push({
      id: `preview-${++this.eventSeq}`,
      type,
      scheduleId: state.scheduleId,
      alarmId: state.alarmId,
      occurrenceKey: state.occurrenceKey,
      at: this.now(),
    });
  }

  private emit<K extends EngineEventType>(type: K, event: EngineEventMap[K]): void {
    (this.listeners[type] as Set<(event: EngineEventMap[K]) => void>).forEach((listener) =>
      listener(event),
    );
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.autoRing || this.ringing || this.scheduled.size === 0) return;
    const next = Math.min(...[...this.scheduled.values()].map((e) => Date.parse(e.fireAt)));
    const delay = Math.min(Math.max(0, next - this.clock().getTime()), MAX_TIMER_MS);
    this.timer = setTimeout(() => this.checkDue(), delay);
    // Never keep a Node/Jest process alive for a preview alarm.
    (this.timer as { unref?: () => void }).unref?.();
  }
}
