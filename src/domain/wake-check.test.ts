import { DEFAULT_WAKE_CHECK, type WakeCheckConfig } from './alarm';
import {
  initialWakeCheckState,
  isWakeCheckActive,
  retriggerScheduleId,
  wakeCheckReducer,
  wakeCheckScheduleId,
  type WakeCheckEvent,
  type WakeCheckState,
} from './wake-check';

const config: WakeCheckConfig = {
  ...DEFAULT_WAKE_CHECK,
  enabled: true,
  delayMin: 5,
  responseWindowSec: 60,
  maxRetriggers: 2,
};
const t = (iso: string) => new Date(`2026-10-02T${iso}Z`);
const run = (events: WakeCheckEvent[], from: WakeCheckState = initialWakeCheckState) =>
  events.reduce(wakeCheckReducer, from);

describe('wake check state machine', () => {
  it('armed → pending_verification → passed', () => {
    const armed = run([{ type: 'ARM', now: t('07:00:00'), config }]);
    expect(armed).toEqual({
      status: 'armed',
      attempt: 1,
      checkAt: '2026-10-02T07:05:00.000Z',
      respondBy: '2026-10-02T07:06:00.000Z',
    });
    expect(isWakeCheckActive(armed)).toBe(true);

    const pending = wakeCheckReducer(armed, { type: 'CHECK_DUE', now: t('07:05:00') });
    expect(pending).toEqual({
      status: 'pending_verification',
      attempt: 1,
      deadline: '2026-10-02T07:06:00.000Z',
    });

    const passed = wakeCheckReducer(pending, { type: 'VERIFY_PASSED', now: t('07:05:30') });
    expect(passed).toEqual({ status: 'passed', attempt: 1, at: '2026-10-02T07:05:30.000Z' });
    expect(isWakeCheckActive(passed)).toBe(false);
  });

  it('no response → failed → retriggered → re-armed with the next attempt', () => {
    const failed = run([
      { type: 'ARM', now: t('07:00:00'), config },
      { type: 'CHECK_DUE', now: t('07:05:00') },
      { type: 'RESPONSE_TIMEOUT', now: t('07:06:00') },
    ]);
    expect(failed).toMatchObject({ status: 'failed', reason: 'no_response', attempt: 1 });

    const retriggered = wakeCheckReducer(failed, { type: 'RETRIGGER', now: t('07:06:00') });
    expect(retriggered).toMatchObject({ status: 'retriggered', attempt: 1 });

    const rearmed = wakeCheckReducer(retriggered, { type: 'ARM', now: t('07:10:00'), config });
    expect(rearmed).toEqual({
      status: 'armed',
      attempt: 2,
      checkAt: '2026-10-02T07:15:00.000Z',
      respondBy: '2026-10-02T07:16:00.000Z',
    });
  });

  it('failed verification → failed', () => {
    const failed = run([
      { type: 'ARM', now: t('07:00:00'), config },
      { type: 'CHECK_DUE', now: t('07:05:00') },
      { type: 'VERIFY_FAILED', now: t('07:05:20') },
    ]);
    expect(failed).toMatchObject({ status: 'failed', reason: 'verification_failed' });
  });

  it('a pass after the deadline counts as no response', () => {
    const late = run([
      { type: 'ARM', now: t('07:00:00'), config },
      { type: 'CHECK_DUE', now: t('07:05:00') },
      { type: 'VERIFY_PASSED', now: t('07:06:01') },
    ]);
    expect(late).toMatchObject({ status: 'failed', reason: 'no_response' });
  });

  it('ignores a premature timeout', () => {
    const pending = run([
      { type: 'ARM', now: t('07:00:00'), config },
      { type: 'CHECK_DUE', now: t('07:05:00') },
    ]);
    expect(wakeCheckReducer(pending, { type: 'RESPONSE_TIMEOUT', now: t('07:05:10') })).toBe(
      pending,
    );
  });

  it('a late CHECK_DUE keeps the deadline fixed at arm time (matches the native retrigger)', () => {
    const pending = run([
      { type: 'ARM', now: t('07:00:00'), config },
      { type: 'CHECK_DUE', now: t('07:05:40') },
    ]);
    expect(pending).toMatchObject({ deadline: '2026-10-02T07:06:00.000Z' });
  });

  it('stops re-arming after maxRetriggers re-rings', () => {
    let state: WakeCheckState = initialWakeCheckState;
    for (let i = 0; i < 2; i++) {
      state = run(
        [
          { type: 'ARM', now: t('07:00:00'), config },
          { type: 'CHECK_DUE', now: t('07:05:00') },
          { type: 'RESPONSE_TIMEOUT', now: t('07:06:00') },
          { type: 'RETRIGGER', now: t('07:06:00') },
        ],
        state,
      );
    }
    expect(state).toMatchObject({ status: 'retriggered', attempt: 2 });
    expect(wakeCheckReducer(state, { type: 'ARM', now: t('07:20:00'), config })).toBe(state);
  });

  it('invalid transitions are no-ops', () => {
    const idle = initialWakeCheckState;
    expect(wakeCheckReducer(idle, { type: 'VERIFY_PASSED', now: t('07:00:00') })).toBe(idle);
    expect(wakeCheckReducer(idle, { type: 'CHECK_DUE', now: t('07:00:00') })).toBe(idle);
    expect(wakeCheckReducer(idle, { type: 'RETRIGGER', now: t('07:00:00') })).toBe(idle);
    const armed = run([{ type: 'ARM', now: t('07:00:00'), config }]);
    expect(wakeCheckReducer(armed, { type: 'ARM', now: t('07:01:00'), config })).toBe(armed);
    expect(wakeCheckReducer(armed, { type: 'VERIFY_PASSED', now: t('07:01:00') })).toBe(armed);
  });

  it('does nothing when wake check is disabled', () => {
    const disabled = { ...config, enabled: false };
    expect(
      wakeCheckReducer(initialWakeCheckState, {
        type: 'ARM',
        now: t('07:00:00'),
        config: disabled,
      }),
    ).toBe(initialWakeCheckState);
  });

  it('derives deterministic schedule ids', () => {
    expect(wakeCheckScheduleId('a1@2026-10-02', 1)).toBe('a1@2026-10-02#wake-check-1');
    expect(retriggerScheduleId('a1@2026-10-02', 2)).toBe('a1@2026-10-02#retrigger-2');
  });
});
