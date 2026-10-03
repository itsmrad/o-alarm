import type { MissionStep } from '@/domain/missions';

import { addStep, moveStep, removeStep, updateStepConfig } from './chain-edit';

const ids = (steps: readonly MissionStep[]) => steps.map((s) => s.missionId);
const chain = (...missionIds: string[]): MissionStep[] =>
  missionIds.map((missionId) => ({ missionId, config: {} }));

describe('chain edit helpers', () => {
  it('addStep appends with the mission defaults (copied, not shared)', () => {
    const steps = addStep([], 'shake');
    expect(steps).toEqual([
      { missionId: 'shake', config: { targetCount: 20, sensitivity: 'normal' } },
    ]);
    const again = addStep(steps, 'shake');
    expect(again[0]?.config).not.toBe(again[1]?.config);
    expect(steps).toHaveLength(1);
  });

  it('removeStep drops by index', () => {
    expect(ids(removeStep(chain('math', 'shake', 'qr'), 1))).toEqual(['math', 'qr']);
  });

  it('moveStep reorders and clamps', () => {
    const c = chain('a', 'b', 'c');
    expect(ids(moveStep(c, 0, 1))).toEqual(['b', 'a', 'c']);
    expect(ids(moveStep(c, 2, 0))).toEqual(['c', 'a', 'b']);
    expect(ids(moveStep(c, 0, -1))).toEqual(['a', 'b', 'c']);
    expect(ids(moveStep(c, 2, 5))).toEqual(['a', 'b', 'c']);
    expect(ids(moveStep(c, 9, 0))).toEqual(['a', 'b', 'c']);
  });

  it('updateStepConfig replaces only that step', () => {
    const updated = updateStepConfig(chain('a', 'b'), 1, { x: 1 });
    expect(updated[0]?.config).toEqual({});
    expect(updated[1]?.config).toEqual({ x: 1 });
  });
});
