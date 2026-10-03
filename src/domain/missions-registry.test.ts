import type { MissionStep } from './missions';
import {
  canAddMission,
  canUseChain,
  canUseMission,
  resolveRingChain,
  type MissionEntitlement,
} from './missions-gating';
import { createMissionRegistry, missionRegistry } from './missions-registry';

const pro: MissionEntitlement = { pro: true };
const free: MissionEntitlement = { pro: false };
const step = (missionId: string, config: Record<string, unknown> = {}): MissionStep => ({
  missionId,
  config,
});

describe('mission registry', () => {
  it('lists the four MVP missions with the right tiers', () => {
    const tiers = Object.fromEntries(missionRegistry.list().map((d) => [d.id, d.tier]));
    expect(tiers).toEqual({ math: 'free', shake: 'free', steps: 'free', qr: 'pro' });
  });

  it('every default config satisfies its own schema', () => {
    for (const d of missionRegistry.list()) {
      expect(d.configSchema.safeParse(d.defaultConfig).success).toBe(true);
      expect(d.configSchema.parse({})).toEqual(d.defaultConfig);
    }
  });

  it('every non-math mission falls back to a free mission', () => {
    for (const d of missionRegistry.list()) {
      if (d.id === 'math') continue;
      expect(missionRegistry.get(d.freeFallback ?? '')?.tier).toBe('free');
    }
  });

  it('get() returns undefined for unknown ids', () => {
    expect(missionRegistry.get('memory')).toBeUndefined();
    expect(createMissionRegistry([]).list()).toHaveLength(0);
  });
});

describe('canUseMission / canUseChain / canAddMission', () => {
  it('free missions are open; qr needs pro; unknown is never usable', () => {
    for (const id of ['math', 'shake', 'steps']) {
      expect(canUseMission(id, null)).toBe(true);
      expect(canUseMission(id, undefined)).toBe(true);
      expect(canUseMission(id, free)).toBe(true);
    }
    expect(canUseMission('qr', null)).toBe(false);
    expect(canUseMission('qr', free)).toBe(false);
    expect(canUseMission('qr', pro)).toBe(true);
    expect(canUseMission('nope', pro)).toBe(false);
  });

  it('chains with more than one mission are pro', () => {
    expect(canUseChain([], free)).toBe(true);
    expect(canUseChain([step('math')], free)).toBe(true);
    expect(canUseChain([step('math'), step('shake')], free)).toBe(false);
    expect(canUseChain([step('math'), step('shake')], pro)).toBe(true);
    expect(canUseChain([step('qr')], free)).toBe(false);
  });

  it('canAddMission explains the denial', () => {
    expect(canAddMission([], 'math', free)).toEqual({ ok: true });
    expect(canAddMission([], 'qr', free)).toEqual({ ok: false, reason: 'pro_mission' });
    expect(canAddMission([step('math')], 'shake', free)).toEqual({
      ok: false,
      reason: 'pro_chain',
    });
    expect(canAddMission([step('math')], 'shake', pro)).toEqual({ ok: true });
    expect(canAddMission([], 'zzz', pro)).toEqual({ ok: false, reason: 'unknown_mission' });
    const full = Array.from({ length: 5 }, () => step('math'));
    expect(canAddMission(full, 'math', pro)).toEqual({ ok: false, reason: 'chain_full' });
  });
});

describe('resolveRingChain (D18: degrade, never block)', () => {
  const qrOk = step('qr', { codeHash: 'abc', label: 'Kitchen' });

  it('keeps a valid pro chain intact with entitlement', () => {
    const r = resolveRingChain([step('math'), qrOk, step('shake', { targetCount: 10 })], pro);
    expect(r.degraded).toEqual([]);
    expect(r.steps.map((s) => s.missionId)).toEqual(['math', 'qr', 'shake']);
    expect(r.steps[2]?.config).toEqual({ targetCount: 10, sensitivity: 'normal' });
  });

  it('degrades qr to math without entitlement', () => {
    for (const e of [null, undefined, free]) {
      const r = resolveRingChain([qrOk], e);
      expect(r.steps.map((s) => s.missionId)).toEqual(['math']);
      expect(r.degraded).toEqual([
        { stepIndex: 0, originalMissionId: 'qr', reason: 'pro_required' },
      ]);
    }
  });

  it('truncates a chain to its first mission without entitlement', () => {
    const r = resolveRingChain([step('shake'), step('steps'), step('math')], free);
    expect(r.steps.map((s) => s.missionId)).toEqual(['shake']);
    expect(r.degraded[0]?.reason).toBe('chain_requires_pro');
  });

  it('degrades unknown and unconfigured missions to math, even for pro', () => {
    const r = resolveRingChain([step('memory'), step('qr')], pro);
    expect(r.steps.map((s) => s.missionId)).toEqual(['math', 'math']);
    expect(r.degraded.map((d) => d.reason)).toEqual(['unknown_mission', 'not_configured']);
  });

  it('resets invalid config to defaults instead of failing', () => {
    const r = resolveRingChain([step('math', { difficulty: 'nightmare', problemCount: 99 })], free);
    expect(r.steps[0]).toEqual({
      missionId: 'math',
      config: { difficulty: 'easy', problemCount: 3 },
    });
  });

  it('an empty chain stays empty', () => {
    expect(resolveRingChain([], free)).toEqual({ steps: [], degraded: [] });
  });
});
