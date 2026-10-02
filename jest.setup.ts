// Deterministic ids are injected in most tests; this backs the default
// expo-crypto generator with Node's implementation.
jest.mock('expo-crypto', () => ({
  randomUUID: () => require('node:crypto').randomUUID(),
}));
