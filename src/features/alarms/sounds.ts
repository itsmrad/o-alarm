import type { AlarmSound } from '@/domain';

export interface SoundOption {
  sound: AlarmSound;
  name: string;
  /** Bundled file played for in-app previews and Expo Go rings. */
  asset: number;
}

const CLASSIC = require('../../../assets/sounds/classic.wav') as number;

/**
 * Sounds the editor offers. `default` is the platform alarm tone (native engine); the
 * others are bundled with the app as `assets/sounds/<id>.wav` and referenced as
 * `{ kind: 'custom', id }` so the native engine can resolve the same file.
 */
export const SOUND_OPTIONS: readonly SoundOption[] = [
  { sound: { kind: 'default', id: null }, name: 'Default', asset: CLASSIC },
  { sound: { kind: 'custom', id: 'classic' }, name: 'Classic', asset: CLASSIC },
  {
    sound: { kind: 'custom', id: 'chime' },
    name: 'Chime',
    asset: require('../../../assets/sounds/chime.wav') as number,
  },
  {
    sound: { kind: 'custom', id: 'beacon' },
    name: 'Beacon',
    asset: require('../../../assets/sounds/beacon.wav') as number,
  },
  {
    sound: { kind: 'custom', id: 'pulse' },
    name: 'Pulse',
    asset: require('../../../assets/sounds/pulse.wav') as number,
  },
];

export const sameSound = (a: AlarmSound, b: AlarmSound) => a.kind === b.kind && a.id === b.id;

/** Unknown sounds (e.g. synced from a newer app version) fall back to Default. */
export function soundOption(sound: AlarmSound): SoundOption {
  return SOUND_OPTIONS.find((option) => sameSound(option.sound, sound)) ?? SOUND_OPTIONS[0]!;
}
