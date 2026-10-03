import type { MissionStep } from './missions';
import {
  advanceChain,
  createChainState,
  type ChainAction,
  type ChainState,
} from './missions-chain';

const step = (missionId: string): MissionStep => ({ missionId, config: {} });

function apply(state: ChainState, ...actions: ChainAction[]) {
  const events: ReturnType<typeof advanceChain>['events'] = [];
  let current = state;
  for (const action of actions) {
    const r = advanceChain(current, action);
    current = r.state;
    events.push(...r.events);
  }
  return { state: current, events };
}

describe('chain state machine', () => {
  it('runs steps in order and emits started/completed events', () => {
    const { state, events } = apply(
      createChainState([step('math'), step('shake')]),
      { type: 'start', now: 1000 },
      { type: 'complete', now: 4000 },
      { type: 'complete', now: 9000 },
    );
    expect(state.status).toBe('complete');
    expect(events).toEqual([
      { type: 'mission_started', payload: { missionId: 'math', stepIndex: 0 } },
      { type: 'mission_completed', payload: { missionId: 'math', stepIndex: 0, durationMs: 3000 } },
      { type: 'mission_started', payload: { missionId: 'shake', stepIndex: 1 } },
      {
        type: 'mission_completed',
        payload: { missionId: 'shake', stepIndex: 1, durationMs: 5000 },
      },
    ]);
    expect(state.attempts.map((a) => [a.missionId, a.stepIndex, a.outcome])).toEqual([
      ['math', 0, 'completed'],
      ['shake', 1, 'completed'],
    ]);
    expect(state.attempts[0]?.startedAt).toBe(new Date(1000).toISOString());
  });

  it('an empty chain completes immediately with no events', () => {
    const { state, events } = apply(createChainState([]), { type: 'start', now: 0 });
    expect(state.status).toBe('complete');
    expect(events).toEqual([]);
  });

  it('a failure swaps the step for Math, logs the reason, and the chain continues', () => {
    const { state, events } = apply(
      createChainState([step('qr'), step('steps')]),
      { type: 'start', now: 0 },
      { type: 'fail', now: 500, reason: 'permission_denied' },
    );
    expect(state.status).toBe('running');
    expect(state.index).toBe(0);
    expect(state.steps[0]?.missionId).toBe('math');
    expect(state.steps[1]?.missionId).toBe('steps');
    expect(events).toEqual([
      { type: 'mission_started', payload: { missionId: 'qr', stepIndex: 0 } },
      {
        type: 'mission_failed',
        payload: { missionId: 'qr', stepIndex: 0, reason: 'permission_denied' },
      },
      { type: 'mission_started', payload: { missionId: 'math', stepIndex: 0 } },
    ]);
    const done = apply(state, { type: 'complete', now: 900 }, { type: 'complete', now: 1200 });
    expect(done.state.status).toBe('complete');
    expect(done.state.attempts.map((a) => a.outcome)).toEqual(['failed', 'completed', 'completed']);
  });

  it('abandon ends the chain without completing it', () => {
    const { state, events } = apply(
      createChainState([step('math'), step('shake')]),
      { type: 'start', now: 0 },
      { type: 'complete', now: 10 },
      { type: 'abandon', now: 20 },
    );
    expect(state.status).toBe('abandoned');
    expect(events.at(-1)).toEqual({
      type: 'mission_failed',
      payload: { missionId: 'shake', stepIndex: 1, reason: 'abandoned' },
    });
    expect(state.attempts.at(-1)?.outcome).toBe('abandoned');
    // terminal: later actions are ignored
    expect(apply(state, { type: 'complete', now: 30 }).state.status).toBe('abandoned');
  });

  it('ignores actions before start and after completion', () => {
    const idle = createChainState([step('math')]);
    expect(advanceChain(idle, { type: 'complete', now: 1 })).toEqual({ state: idle, events: [] });
    const done = apply(idle, { type: 'start', now: 0 }, { type: 'complete', now: 1 }).state;
    expect(advanceChain(done, { type: 'complete', now: 2 }).events).toEqual([]);
    expect(advanceChain(done, { type: 'start', now: 2 }).events).toEqual([]);
  });

  it('does not mutate the previous state', () => {
    const initial = createChainState([step('qr')]);
    const started = advanceChain(initial, { type: 'start', now: 0 }).state;
    advanceChain(started, { type: 'fail', now: 1, reason: 'error' });
    expect(started.steps[0]?.missionId).toBe('qr');
  });
});
