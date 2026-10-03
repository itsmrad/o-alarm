import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { MissionStep } from '@/domain/missions';
import type { MissionChainEvent } from '@/domain/missions-chain';
import { generateMathProblems } from '@/domain/missions-math';

import { MissionChainRunner } from './mission-chain-runner';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));

const mockAccelListeners = new Set<(m: object) => void>();
jest.mock('expo-sensors', () => ({
  Accelerometer: {
    isAvailableAsync: jest.fn(async () => true),
    setUpdateInterval: jest.fn(),
    addListener: jest.fn((listener: (m: object) => void) => {
      mockAccelListeners.add(listener);
      return { remove: () => mockAccelListeners.delete(listener) };
    }),
  },
  Pedometer: {
    isAvailableAsync: jest.fn(async () => false),
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    watchStepCount: jest.fn(),
  },
}));

let mockCameraPermission: { granted: boolean; canAskAgain: boolean; status: string } | null = null;
jest.mock('expo-camera', () => {
  const { View } = jest.requireActual('react-native');
  return {
    CameraView: View,
    useCameraPermissions: () => [mockCameraPermission, jest.fn()],
  };
});
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algo: string, data: string) => `hash:${data}`,
}));

const SEED = 1234;
const step = (missionId: string, config: Record<string, unknown> = {}): MissionStep => ({
  missionId,
  config,
});

function setup(props: Partial<React.ComponentProps<typeof MissionChainRunner>> = {}) {
  const events: MissionChainEvent[] = [];
  const onAllComplete = jest.fn();
  const onAbandon = jest.fn();
  render(
    <MissionChainRunner
      steps={[step('math', { difficulty: 'easy', problemCount: 1 })]}
      entitlement={{ pro: true }}
      seed={SEED}
      onEvent={(e) => events.push(e)}
      onAllComplete={onAllComplete}
      {...props}
    />,
  );
  return { events, onAllComplete, onAbandon };
}

function typeAnswer(answer: number) {
  for (const digit of String(answer)) fireEvent.press(screen.getByLabelText(digit));
}

/** Resting + one big jolt, per shake. */
async function shakeOnce(t: number) {
  await act(async () => {
    mockAccelListeners.forEach((l) => l({ x: 0, y: 0, z: 4, timestamp: t / 1000 }));
    mockAccelListeners.forEach((l) => l({ x: 0, y: 0, z: 1, timestamp: (t + 50) / 1000 }));
  });
}

beforeEach(() => {
  mockAccelListeners.clear();
  mockCameraPermission = { granted: false, canAskAgain: false, status: 'denied' };
});

describe('MissionChainRunner', () => {
  it('runs a math mission to completion and emits started/completed', () => {
    const { events, onAllComplete } = setup();
    const [problem] = generateMathProblems({ difficulty: 'easy', problemCount: 1 }, SEED);
    typeAnswer(problem!.answer);
    fireEvent.press(screen.getByLabelText('Submit answer'));

    expect(onAllComplete).toHaveBeenCalledTimes(1);
    expect(onAllComplete.mock.calls[0]?.[0]).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['mission_started', 'mission_completed']);
    expect(events[0]?.payload).toEqual({ missionId: 'math', stepIndex: 0 });
  });

  it('a wrong answer clears the input and does not complete', () => {
    const { events, onAllComplete } = setup();
    const [problem] = generateMathProblems({ difficulty: 'easy', problemCount: 1 }, SEED);
    typeAnswer(problem!.answer + 1);
    fireEvent.press(screen.getByLabelText('Submit answer'));
    expect(onAllComplete).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your answer is empty')).toBeTruthy();
    expect(screen.getByText('Not quite — try again')).toBeTruthy();
    expect(events.map((e) => e.type)).toEqual(['mission_started']);
  });

  it('submit is disabled until something is typed (no accidental completion)', () => {
    const { onAllComplete } = setup();
    fireEvent.press(screen.getByLabelText('Submit answer'));
    expect(onAllComplete).not.toHaveBeenCalled();
  });

  it('chains math then shake in order, showing progress', async () => {
    const { events, onAllComplete } = setup({
      steps: [
        step('math', { difficulty: 'easy', problemCount: 1 }),
        step('shake', { targetCount: 5, sensitivity: 'normal' }),
      ],
    });
    expect(screen.getByText(/Mission 1 of 2/)).toBeTruthy();
    const [problem] = generateMathProblems({ difficulty: 'easy', problemCount: 1 }, SEED);
    typeAnswer(problem!.answer);
    fireEvent.press(screen.getByLabelText('Submit answer'));
    expect(onAllComplete).not.toHaveBeenCalled();
    expect(await screen.findByText(/Mission 2 of 2/)).toBeTruthy();

    for (let i = 0; i < 5; i++) await shakeOnce(1000 + i * 1000);
    expect(onAllComplete).toHaveBeenCalledTimes(1);
    expect(events.map((e) => `${e.type}:${e.payload.stepIndex}`)).toEqual([
      'mission_started:0',
      'mission_completed:0',
      'mission_started:1',
      'mission_completed:1',
    ]);
  });

  it('degrades a Pro mission to Math without entitlement (never blocks)', () => {
    const { events } = setup({
      steps: [step('qr', { codeHash: 'x', label: '' })],
      entitlement: null,
    });
    expect(screen.getByText(/needs Pro/)).toBeTruthy();
    expect(screen.getByLabelText('Submit answer')).toBeTruthy();
    expect(events[0]?.payload).toMatchObject({ missionId: 'math' });
  });

  it('QR with denied camera: honest message, then Math with mission_failed permission_denied', () => {
    const { events, onAllComplete } = setup({
      steps: [step('qr', { codeHash: 'abc', label: 'Mirror' })],
    });
    expect(screen.getByText('Camera access is off')).toBeTruthy();
    fireEvent.press(screen.getByText('Use Math instead'));

    expect(events.map((e) => e.type)).toEqual([
      'mission_started',
      'mission_failed',
      'mission_started',
    ]);
    expect(events[1]?.payload).toEqual({
      missionId: 'qr',
      stepIndex: 0,
      reason: 'permission_denied',
    });
    expect(events[2]?.payload).toEqual({ missionId: 'math', stepIndex: 0 });
    expect(screen.getByLabelText('Submit answer')).toBeTruthy();
    expect(onAllComplete).not.toHaveBeenCalled();
  });

  it('shake with no accelerometer falls back to Math', async () => {
    const { Accelerometer } = jest.requireMock('expo-sensors');
    Accelerometer.isAvailableAsync.mockResolvedValueOnce(false);
    const { events } = setup({ steps: [step('shake', {})] });
    expect(await screen.findByLabelText('Submit answer')).toBeTruthy();
    expect(events.find((e) => e.type === 'mission_failed')?.payload).toMatchObject({
      reason: 'sensor_unavailable',
    });
  });

  it('abandon (hold to leave) is reported and is not completion', () => {
    const onAbandon = jest.fn();
    const { events, onAllComplete } = setup({ onAbandon });
    fireEvent(screen.getByLabelText('Hold to leave mission'), 'longPress');
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(onAllComplete).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: 'mission_failed',
      payload: { missionId: 'math', stepIndex: 0, reason: 'abandoned' },
    });
  });

  it('shows no leave control without onAbandon', () => {
    setup();
    expect(screen.queryByLabelText('Hold to leave mission')).toBeNull();
  });

  it('an empty chain completes immediately', () => {
    const { events, onAllComplete } = setup({ steps: [] });
    expect(onAllComplete).toHaveBeenCalledWith([]);
    expect(events).toEqual([]);
  });
});
