import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import type { MissionStep } from '@/domain/missions';

import { MissionChainEditor } from './mission-chain-editor';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_a: string, data: string) => `hash:${data}`,
}));

let latest: MissionStep[] = [];

function Harness({
  initial = [],
  pro,
  onRequestUpgrade,
}: {
  initial?: MissionStep[];
  pro: boolean;
  onRequestUpgrade?: () => void;
}) {
  const [steps, setSteps] = useState(initial);
  return (
    <MissionChainEditor
      steps={steps}
      onChange={(next) => {
        latest = next;
        setSteps(next);
      }}
      entitlement={{ pro }}
      onRequestUpgrade={onRequestUpgrade}
    />
  );
}

function renderEditor(element: React.ReactElement<{ initial?: MissionStep[] }>) {
  latest = element.props.initial ?? [];
  return render(element);
}

const ids = () => latest.map((s) => s.missionId);

describe('MissionChainEditor', () => {
  it('lists missions with Pro badges when adding', () => {
    renderEditor(<Harness pro={false} />);
    fireEvent.press(screen.getByText('Add mission'));
    expect(screen.getByLabelText('Add Math')).toBeTruthy();
    expect(screen.getByLabelText('Add QR / barcode, Pro')).toBeTruthy();
    expect(screen.getAllByLabelText('Pro')).toHaveLength(1);
  });

  it('free: can add one free mission, then a second asks for an upgrade', () => {
    const onRequestUpgrade = jest.fn();
    renderEditor(<Harness pro={false} onRequestUpgrade={onRequestUpgrade} />);
    fireEvent.press(screen.getByText('Add mission'));
    fireEvent.press(screen.getByLabelText('Add Math'));
    expect(ids()).toEqual(['math']);

    fireEvent.press(screen.getByText('Add mission'));
    fireEvent.press(screen.getByLabelText('Add Shake'));
    expect(ids()).toEqual(['math']);
    expect(onRequestUpgrade).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Chaining several missions needs Pro.')).toBeTruthy();
  });

  it('free: a Pro mission cannot be added', () => {
    const onRequestUpgrade = jest.fn();
    renderEditor(<Harness pro={false} onRequestUpgrade={onRequestUpgrade} />);
    fireEvent.press(screen.getByText('Add mission'));
    fireEvent.press(screen.getByLabelText('Add QR / barcode, Pro'));
    expect(ids()).toEqual([]);
    expect(onRequestUpgrade).toHaveBeenCalled();
    expect(screen.getByText('This mission needs Pro.')).toBeTruthy();
  });

  it('pro: builds a chain, reorders and removes', () => {
    renderEditor(<Harness pro />);
    for (const label of ['Add Math', 'Add Shake', 'Add Steps']) {
      fireEvent.press(screen.getByText('Add mission'));
      fireEvent.press(screen.getByLabelText(label));
    }
    expect(ids()).toEqual(['math', 'shake', 'steps']);

    fireEvent.press(screen.getAllByLabelText('Move down')[0]!);
    expect(ids()).toEqual(['shake', 'math', 'steps']);
    fireEvent.press(screen.getAllByLabelText('Move up')[2]!);
    expect(ids()).toEqual(['shake', 'steps', 'math']);
    fireEvent.press(screen.getAllByLabelText('Remove mission')[1]!);
    expect(ids()).toEqual(['shake', 'math']);
  });

  it('edits per-mission config', () => {
    renderEditor(<Harness pro initial={[{ missionId: 'math', config: {} }]} />);
    fireEvent.press(screen.getByLabelText(/^Math,/));
    fireEvent.press(screen.getByText('Hard'));
    fireEvent.press(screen.getByText('5'));
    expect(latest[0]?.config).toMatchObject({ difficulty: 'hard', problemCount: 5 });
  });

  it('warns when an existing chain would degrade without Pro', () => {
    render(
      <Harness
        pro={false}
        initial={[
          { missionId: 'qr', config: { codeHash: 'x', label: '' } },
          { missionId: 'math', config: {} },
        ]}
      />,
    );
    expect(screen.getByText(/fall back to a free/)).toBeTruthy();
  });
});
