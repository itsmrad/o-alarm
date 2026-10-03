import type { MissionFailReason } from '@/domain/missions-chain';

/** Props every mission screen receives from the chain runner. */
export interface MissionViewProps<TConfig> {
  config: TConfig;
  /** Seed for any randomness, so a mission is reproducible in tests. */
  seed: number;
  onComplete: () => void;
  /** The mission cannot run here; the runner swaps in the free Math mission. */
  onFail: (reason: MissionFailReason) => void;
}

/** Props every mission's config editor receives from the chain editor. */
export interface MissionEditorProps<TConfig> {
  config: TConfig;
  onChange: (config: TConfig) => void;
}
