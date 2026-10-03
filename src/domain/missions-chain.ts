import type { NewEvent } from './events';
import type { MissionAttemptResult, MissionStep } from './missions';
import { FALLBACK_MISSION_ID, missionRegistry } from './missions-registry';

/** Why a mission could not run. Logged as the `mission_failed` reason. */
export type MissionFailReason =
  'permission_denied' | 'sensor_unavailable' | 'camera_unavailable' | 'error';

export type MissionChainEvent = Extract<
  NewEvent,
  { type: 'mission_started' | 'mission_completed' | 'mission_failed' }
>;

export type ChainStatus = 'idle' | 'running' | 'complete' | 'abandoned';

export interface ChainState {
  steps: MissionStep[];
  index: number;
  status: ChainStatus;
  /** ms epoch when the current step started. */
  stepStartedAt: number | null;
  attempts: MissionAttemptResult[];
}

export type ChainAction =
  | { type: 'start'; now: number }
  | { type: 'complete'; now: number }
  | { type: 'fail'; now: number; reason: MissionFailReason }
  | { type: 'abandon'; now: number };

export function createChainState(steps: readonly MissionStep[]): ChainState {
  return { steps: [...steps], index: 0, status: 'idle', stepStartedAt: null, attempts: [] };
}

const iso = (ms: number) => new Date(ms).toISOString();

function started(state: ChainState): MissionChainEvent {
  const step = state.steps[state.index];
  return {
    type: 'mission_started',
    payload: { missionId: step?.missionId ?? '', stepIndex: state.index },
  };
}

function record(
  state: ChainState,
  outcome: MissionAttemptResult['outcome'],
  now: number,
): MissionAttemptResult[] {
  const step = state.steps[state.index];
  if (!step) return state.attempts;
  return [
    ...state.attempts,
    {
      missionId: step.missionId,
      stepIndex: state.index,
      outcome,
      startedAt: iso(state.stepStartedAt ?? now),
      endedAt: iso(now),
    },
  ];
}

/**
 * Pure chain state machine. Returns the next state plus the events the caller must log.
 * - `complete` advances; finishing the last step sets status `complete`.
 * - `fail` swaps the current step for the free Math mission (never dead-ends a wake-up);
 *   a failing Math step (already the fallback) simply restarts.
 * - `abandon` ends the chain WITHOUT completion; it is not a dismissal.
 */
export function advanceChain(
  state: ChainState,
  action: ChainAction,
): { state: ChainState; events: MissionChainEvent[] } {
  const none = { state, events: [] as MissionChainEvent[] };
  const step = state.steps[state.index];

  switch (action.type) {
    case 'start': {
      if (state.status !== 'idle') return none;
      if (state.steps.length === 0) return { state: { ...state, status: 'complete' }, events: [] };
      const next = { ...state, status: 'running' as const, stepStartedAt: action.now };
      return { state: next, events: [started(next)] };
    }
    case 'complete': {
      if (state.status !== 'running' || !step) return none;
      const durationMs = Math.max(0, action.now - (state.stepStartedAt ?? action.now));
      const events: MissionChainEvent[] = [
        {
          type: 'mission_completed',
          payload: { missionId: step.missionId, stepIndex: state.index, durationMs },
        },
      ];
      const attempts = record(state, 'completed', action.now);
      if (state.index + 1 >= state.steps.length) {
        return { state: { ...state, status: 'complete', attempts }, events };
      }
      const next = { ...state, index: state.index + 1, stepStartedAt: action.now, attempts };
      return { state: next, events: [...events, started(next)] };
    }
    case 'fail': {
      if (state.status !== 'running' || !step) return none;
      const events: MissionChainEvent[] = [
        {
          type: 'mission_failed',
          payload: { missionId: step.missionId, stepIndex: state.index, reason: action.reason },
        },
      ];
      const attempts = record(state, 'failed', action.now);
      const steps = [...state.steps];
      if (step.missionId !== FALLBACK_MISSION_ID) {
        steps[state.index] = {
          missionId: FALLBACK_MISSION_ID,
          config: { ...missionRegistry.get(FALLBACK_MISSION_ID)?.defaultConfig },
        };
      }
      const next = { ...state, steps, attempts, stepStartedAt: action.now };
      return { state: next, events: [...events, started(next)] };
    }
    case 'abandon': {
      if (state.status !== 'running' || !step) return none;
      const events: MissionChainEvent[] = [
        {
          type: 'mission_failed',
          payload: { missionId: step.missionId, stepIndex: state.index, reason: 'abandoned' },
        },
      ];
      const attempts = record(state, 'abandoned', action.now);
      return { state: { ...state, status: 'abandoned', attempts }, events };
    }
  }
}
