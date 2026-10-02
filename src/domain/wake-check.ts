import type { WakeCheckConfig } from './alarm';

/**
 * Wake Check state machine (pure reducer).
 *
 *   idle ─ARM→ armed ─CHECK_DUE→ pending_verification ─VERIFY_PASSED→ passed
 *                                        │ VERIFY_FAILED / RESPONSE_TIMEOUT
 *                                        ▼
 *                                      failed ─RETRIGGER→ retriggered ─ARM→ armed (attempt+1)
 *
 * `armed` / `pending_verification` are backed by native alarms (D13) so a killed app
 * still re-rings; this reducer is the in-app source of truth, persisted in wake_checks.
 */

export type WakeCheckFailureReason = 'no_response' | 'verification_failed';

export type WakeCheckState =
  | { status: 'idle' }
  | { status: 'armed'; attempt: number; checkAt: string }
  | { status: 'pending_verification'; attempt: number; deadline: string }
  | { status: 'passed'; attempt: number; at: string }
  | { status: 'failed'; attempt: number; at: string; reason: WakeCheckFailureReason }
  | { status: 'retriggered'; attempt: number; at: string };

export type WakeCheckEvent =
  /** User dismissed (after missions); start the verification delay. */
  | { type: 'ARM'; now: Date; config: WakeCheckConfig }
  /** The delayed check fired; ask the user to prove they are awake. */
  | { type: 'CHECK_DUE'; now: Date; config: WakeCheckConfig }
  | { type: 'VERIFY_PASSED'; now: Date }
  | { type: 'VERIFY_FAILED'; now: Date }
  | { type: 'RESPONSE_TIMEOUT'; now: Date }
  /** The alarm rang again because the check failed. */
  | { type: 'RETRIGGER'; now: Date };

export const initialWakeCheckState: WakeCheckState = { status: 'idle' };

const iso = (d: Date) => d.toISOString();
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** Invalid transitions return the same state object (no-op), never throw. */
export function wakeCheckReducer(state: WakeCheckState, event: WakeCheckEvent): WakeCheckState {
  switch (event.type) {
    case 'ARM': {
      if (!event.config.enabled) return state;
      if (state.status === 'idle') {
        return {
          status: 'armed',
          attempt: 1,
          checkAt: iso(plus(event.now, event.config.delayMin * 60_000)),
        };
      }
      if (state.status === 'retriggered') {
        if (state.attempt >= event.config.maxRetriggers + 1) return state;
        return {
          status: 'armed',
          attempt: state.attempt + 1,
          checkAt: iso(plus(event.now, event.config.delayMin * 60_000)),
        };
      }
      return state;
    }
    case 'CHECK_DUE':
      if (state.status !== 'armed') return state;
      return {
        status: 'pending_verification',
        attempt: state.attempt,
        deadline: iso(plus(event.now, event.config.responseWindowSec * 1000)),
      };
    case 'VERIFY_PASSED':
      if (state.status !== 'pending_verification') return state;
      // A late answer is a missed check: the user may already have fallen back asleep.
      if (event.now.getTime() > Date.parse(state.deadline)) {
        return {
          status: 'failed',
          attempt: state.attempt,
          at: iso(event.now),
          reason: 'no_response',
        };
      }
      return { status: 'passed', attempt: state.attempt, at: iso(event.now) };
    case 'VERIFY_FAILED':
      if (state.status !== 'pending_verification') return state;
      return {
        status: 'failed',
        attempt: state.attempt,
        at: iso(event.now),
        reason: 'verification_failed',
      };
    case 'RESPONSE_TIMEOUT':
      if (state.status !== 'pending_verification') return state;
      if (event.now.getTime() < Date.parse(state.deadline)) return state;
      return {
        status: 'failed',
        attempt: state.attempt,
        at: iso(event.now),
        reason: 'no_response',
      };
    case 'RETRIGGER':
      if (state.status !== 'failed') return state;
      return { status: 'retriggered', attempt: state.attempt, at: iso(event.now) };
  }
}

export function isWakeCheckActive(state: WakeCheckState): boolean {
  return state.status === 'armed' || state.status === 'pending_verification';
}

/** Engine schedule id for the wake-check follow-up alarm of an occurrence (D13). */
export function wakeCheckScheduleId(occurrenceKey: string, attempt: number): string {
  return `${occurrenceKey}#wake-check-${attempt}`;
}
