// Deterministic ids are injected in most tests; this backs the default
// expo-crypto generator with Node's implementation.
jest.mock('expo-crypto', () => ({
  randomUUID: () => require('node:crypto').randomUUID(),
}));

// expo-audio has no native module under Jest: a silent, stable player stands in.
jest.mock('expo-audio', () => {
  const createAudioPlayer = () => ({
    play: jest.fn(),
    pause: jest.fn(),
    replace: jest.fn(),
    remove: jest.fn(),
    loop: false,
    volume: 1,
  });
  return {
    createAudioPlayer,
    useAudioPlayer: () => require('react').useState(createAudioPlayer)[0],
    setAudioModeAsync: jest.fn(async () => undefined),
  };
});
