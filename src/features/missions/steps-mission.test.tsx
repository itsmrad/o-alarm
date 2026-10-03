import { act, render, screen } from '@testing-library/react-native';

import { StepsMission } from './steps-mission';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));

const mockAccel = new Set<(m: object) => void>();
let mockPedometerCallback: ((r: { steps: number }) => void) | null = null;
jest.mock('expo-sensors', () => ({
  Accelerometer: {
    isAvailableAsync: jest.fn(async () => true),
    setUpdateInterval: jest.fn(),
    addListener: jest.fn((l: (m: object) => void) => {
      mockAccel.add(l);
      return { remove: () => mockAccel.delete(l) };
    }),
  },
  Pedometer: {
    isAvailableAsync: jest.fn(),
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    watchStepCount: jest.fn((cb: (r: { steps: number }) => void) => {
      mockPedometerCallback = cb;
      return { remove: jest.fn() };
    }),
  },
}));

const { Pedometer } = jest.requireMock('expo-sensors');
const config = { targetSteps: 10 };

beforeEach(() => {
  mockAccel.clear();
  mockPedometerCallback = null;
});

const flush = () => act(async () => undefined);

describe('StepsMission', () => {
  it('uses the pedometer when available and permitted', async () => {
    Pedometer.isAvailableAsync.mockResolvedValue(true);
    Pedometer.getPermissionsAsync.mockResolvedValue({ granted: true });
    const onComplete = jest.fn();
    render(<StepsMission config={config} seed={1} onComplete={onComplete} onFail={jest.fn()} />);
    await flush();

    act(() => mockPedometerCallback?.({ steps: 4 }));
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('Counting with your phone’s step counter')).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();

    act(() => mockPedometerCallback?.({ steps: 10 }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('asks for permission, and falls back to the accelerometer honestly when denied', async () => {
    Pedometer.isAvailableAsync.mockResolvedValue(true);
    Pedometer.getPermissionsAsync.mockResolvedValue({ granted: false });
    Pedometer.requestPermissionsAsync.mockResolvedValue({ granted: false });
    const onComplete = jest.fn();
    render(<StepsMission config={config} seed={1} onComplete={onComplete} onFail={jest.fn()} />);
    await flush();
    expect(Pedometer.requestPermissionsAsync).toHaveBeenCalled();
    expect(screen.getByText(/Motion permission is off/)).toBeTruthy();

    // 12 s of 2 Hz walking at 50 Hz is well over the 10-step target.
    await act(async () => {
      for (let i = 0; i < 600; i++) {
        const t = i * 20;
        const z = 1 + 0.3 * Math.sin(2 * Math.PI * 2 * (t / 1000));
        mockAccel.forEach((l) => l({ x: 0, y: 0, z, timestamp: t / 1000 }));
      }
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fails with sensor_unavailable when there is no pedometer and no accelerometer', async () => {
    Pedometer.isAvailableAsync.mockResolvedValue(false);
    const { Accelerometer } = jest.requireMock('expo-sensors');
    Accelerometer.isAvailableAsync.mockResolvedValueOnce(false);
    const onFail = jest.fn();
    render(<StepsMission config={config} seed={1} onComplete={jest.fn()} onFail={onFail} />);
    await flush();
    expect(onFail).toHaveBeenCalledWith('sensor_unavailable');
  });
});
