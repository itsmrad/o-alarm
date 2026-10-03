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

// clerk-js opens a MessagePort at import time, which keeps Jest from exiting. Tests run
// without a Clerk key (guest), so signed-out stand-ins are all the app ever reaches.
jest.mock('@clerk/expo', () => {
  const signedOut = {
    isLoaded: true,
    isSignedIn: false,
    userId: null,
    getToken: async () => null,
    signOut: async () => undefined,
  };
  return {
    ClerkProvider: ({ children }: { children: unknown }) => children,
    useAuth: () => signedOut,
    useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
    useSignIn: () => ({ isLoaded: true, signIn: null, setActive: async () => undefined }),
    useSignUp: () => ({ isLoaded: true, signUp: null, setActive: async () => undefined }),
    useSSO: () => ({ startSSOFlow: async () => ({}) }),
    isClerkAPIResponseError: () => false,
  };
});
jest.mock('@clerk/expo/token-cache', () => ({ tokenCache: undefined }));
jest.mock('@clerk/expo/apple', () => ({
  useSignInWithApple: () => ({ startAppleAuthenticationFlow: async () => ({}) }),
}));
