import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { createAlarmsRepository } from '@/db/repositories/alarms';
import { createEventsRepository } from '@/db/repositories/events';
import type { AppDatabase } from '@/db/types';
import { createAlarm } from '@/domain';
import type { PreviewAlarmEngine } from '@/engine';

let mockDb: AppDatabase | null = null;
jest.mock('@/db/client', () => ({
  openAppDatabase: async () => mockDb,
}));

let mockEngine: PreviewAlarmEngine | null = null;
jest.mock('@/engine/resolve-engine', () => ({
  resolveEngine: () => {
    const { PreviewAlarmEngine: Engine } = jest.requireActual('@/engine/preview-engine');
    mockEngine ??= new Engine(undefined, { autoRing: false });
    return mockEngine;
  },
}));

// A one-tap stand-in for every mission: this test is about the flow, not the missions.
jest.mock('@/features/missions/mission-ui', () => {
  const { Pressable, Text } = jest.requireActual('react-native');
  const ui = {
    icon: 'calculator',
    description: '',
    summary: () => '',
    View: ({ onComplete }: { onComplete: () => void }) => (
      <Pressable accessibilityRole="button" accessibilityLabel="Solve mission" onPress={onComplete}>
        <Text>Solve</Text>
      </Pressable>
    ),
    Editor: () => null,
  };
  return { missionUi: { math: ui }, getMissionUi: () => ui };
});

jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

// Monday 2026-10-05 05:00 local; the alarm is weekdays 07:00.
const START = new Date(2026, 9, 5, 5, 0, 0);
const FIRE = new Date(2026, 9, 5, 7, 0, 0);
const plus = (ms: number) => new Date(FIRE.getTime() + ms);
const MIN = 60_000;

beforeEach(() => {
  jest.useFakeTimers({ now: START, advanceTimers: true });
  mockEngine = null;
  const { createTestDatabase } = jest.requireActual('@/db/testing/test-db');
  mockDb = createTestDatabase().db;
  createAlarmsRepository(mockDb!).upsert(
    createAlarm({
      id: 'a1',
      hour: 7,
      minute: 0,
      weekdays: [1, 2, 3, 4, 5],
      label: 'Work',
      missions: [{ missionId: 'math', config: {} }],
      wakeCheck: {
        enabled: true,
        delayMin: 5,
        responseWindowSec: 60,
        method: 'confirm',
        missionId: null,
        maxRetriggers: 1,
      },
    }),
    { now: START, deviceId: 'd1' },
  );
});
afterEach(() => jest.useRealTimers());

async function advanceTo(at: Date) {
  jest.setSystemTime(at);
  await act(async () => {
    mockEngine!.checkDue();
    await jest.advanceTimersByTimeAsync(1_100);
  });
}

const types = () =>
  createEventsRepository(mockDb!, () => 'x')
    .list({ limit: 200 })
    .map((e) => e.type);

/** Ring at 07:00 → hold → mission → solved: the alarm stops and Wake Check is armed. */
async function ringAndDismissWithMission(app: ReturnType<typeof renderRouter>) {
  await screen.findAllByText(/Work/);
  await advanceTo(plus(1_000));
  await waitFor(() => expect(app.getPathname()).toBe('/ringing'));

  await act(async () =>
    fireEvent(screen.getByLabelText('Hold to start mission'), 'accessibilityAction', {
      nativeEvent: { actionName: 'longpress' },
    }),
  );
  await waitFor(() => expect(app.getPathname()).toBe('/mission'));
  expect(screen.getByText('Mission to stop the alarm')).toBeTruthy();
  await act(async () => fireEvent.press(await screen.findByLabelText('Solve mission')));
  await waitFor(() => expect(app.getPathname()).toBe('/'));
  expect(await mockEngine!.getActiveRinging()).toBeNull();
  const scheduled = await mockEngine!.getScheduled();
  expect(scheduled.map((e) => e.kind)).toEqual(expect.arrayContaining(['wake_check', 'retrigger']));
  expect(types()).toEqual(
    expect.arrayContaining(['mission_started', 'mission_completed', 'wake_check_started']),
  );
}

describe('wake-up flow (Expo Go preview engine)', () => {
  it('ring → mission → dismiss → Wake Check → pass', async () => {
    const app = renderRouter('./app', { initialUrl: '/' });
    await ringAndDismissWithMission(app);

    // 5 minutes later the prompt rings.
    await advanceTo(plus(5 * MIN + 15_000));
    await waitFor(() => expect(app.getPathname()).toBe('/wake-check'));
    expect(screen.getByText('Still awake?')).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByLabelText('I’m awake')));
    await waitFor(() => expect(app.getPathname()).not.toBe('/wake-check'));
    expect(await mockEngine!.getActiveRinging()).toBeNull();
    expect((await mockEngine!.getScheduled()).some((e) => e.kind === 'retrigger')).toBe(false);
    expect(types()).toContain('wake_check_passed');
    expect(types()).not.toContain('alarm_retriggered');

    // Nothing rings again.
    await advanceTo(plus(8 * MIN));
    expect(await mockEngine!.getActiveRinging()).toBeNull();
  });

  it('no response → the alarm rings again as a full, unsnoozable alarm', async () => {
    const app = renderRouter('./app', { initialUrl: '/' });
    await ringAndDismissWithMission(app);

    await advanceTo(plus(5 * MIN + 15_000));
    await waitFor(() => expect(app.getPathname()).toBe('/wake-check'));

    // The answer window (60 s) passes: the prompt times out, the re-trigger rings.
    await advanceTo(plus(6 * MIN + 20_000));
    await advanceTo(plus(6 * MIN + 25_000));
    await waitFor(() => expect(app.getPathname()).toBe('/ringing'));
    expect(await screen.findByText('Ringing again — Wake Check missed')).toBeTruthy();
    expect(screen.getByText('Snooze is off for this alarm.')).toBeTruthy();
    expect(screen.getByLabelText('Hold to start mission')).toBeTruthy();
    expect(types()).toEqual(expect.arrayContaining(['wake_check_failed', 'alarm_retriggered']));
  });
});

describe('mission gate', () => {
  it('mission before snooze: leaving keeps it ringing; a chain degrades to one mission when free', async () => {
    createAlarmsRepository(mockDb!).upsert(
      createAlarm({
        id: 'a1',
        hour: 7,
        minute: 0,
        weekdays: [1, 2, 3, 4, 5],
        label: 'Work',
        // A 2-step chain is Pro; the free entitlement runs only the first step (D18).
        missions: [
          { missionId: 'math', config: {} },
          { missionId: 'math', config: {} },
        ],
        missionBeforeSnooze: true,
      }),
      { now: START, deviceId: 'd1' },
    );
    const app = renderRouter('./app', { initialUrl: '/' });
    await screen.findAllByText(/Work/);
    await advanceTo(plus(1_000));
    await waitFor(() => expect(app.getPathname()).toBe('/ringing'));
    expect(screen.getByText('3 snoozes left · mission first')).toBeTruthy();

    // Snooze → the mission first. Leaving is not a snooze: back to the ringing alarm.
    await act(async () => fireEvent.press(screen.getByLabelText('Snooze 9 min')));
    await waitFor(() => expect(app.getPathname()).toBe('/mission'));
    expect(screen.getByText('Mission to snooze')).toBeTruthy();
    expect(
      screen.getByText('Mission chains need Pro, so only the first mission runs.'),
    ).toBeTruthy();
    await act(async () => fireEvent(screen.getByLabelText('Hold to leave mission'), 'longPress'));
    await waitFor(() => expect(app.getPathname()).toBe('/ringing'));
    expect(await mockEngine!.getActiveRinging()).not.toBeNull();
    expect(types()).toContain('mission_failed'); // the abandon is logged

    // Second try: the single (degraded) mission is solved → snoozed.
    await act(async () => fireEvent.press(screen.getByLabelText('Snooze 9 min')));
    await waitFor(() => expect(app.getPathname()).toBe('/mission'));
    await act(async () => fireEvent.press(await screen.findByLabelText('Solve mission')));
    await waitFor(() => expect(app.getPathname()).toBe('/'));
    expect(await mockEngine!.getActiveRinging()).toBeNull();
    expect((await mockEngine!.getScheduled()).some((e) => e.kind === 'snooze')).toBe(true);
    expect(types().filter((t) => t === 'mission_completed')).toHaveLength(1);
    expect(types()).toContain('alarm_snoozed');
  });
});
