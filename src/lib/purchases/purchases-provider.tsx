import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { useAccount } from '@/lib/auth';

import { createPurchasesController, type PurchasesController } from './controller';
import { createPurchasesClient } from './create-client';
import type { ProStatus } from './types';

const PurchasesContext = createContext<PurchasesController | null>(null);

/**
 * Starts RevenueCat once, ties it to the Clerk user (logIn on sign-in, logOut on sign-out) and
 * feeds CustomerInfo into the entitlement interface. Mount it inside AccountProviders. It
 * renders its children immediately and never blocks or touches the alarm/ring path: every
 * call is async and failures fall back to the cached entitlement.
 */
export function PurchasesProvider({
  children,
  controller: injected,
}: {
  children: ReactNode;
  /** Tests inject a controller. */
  controller?: PurchasesController;
}) {
  const [controller] = useState(
    () => injected ?? createPurchasesController(createPurchasesClient()),
  );
  const account = useAccount();
  const userId = account.loaded && account.signedIn ? account.userId : null;
  // Until Clerk has loaded we don't know whether the user is signed in: don't log anyone out.
  const identityKnown = account.loaded;

  useEffect(() => {
    void controller.start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void controller.refresh();
    });
    return () => {
      sub.remove();
    };
  }, [controller]);

  useEffect(() => {
    if (identityKnown) void controller.setUser(userId);
  }, [controller, identityKnown, userId]);

  return <PurchasesContext.Provider value={controller}>{children}</PurchasesContext.Provider>;
}

export function usePurchases(): PurchasesController {
  const controller = useContext(PurchasesContext);
  if (!controller) throw new Error('usePurchases must be used inside PurchasesProvider');
  return controller;
}

/** Like usePurchases but null when no provider is mounted (screens still render, preview-only). */
export function useOptionalPurchases(): PurchasesController | null {
  return useContext(PurchasesContext);
}

const NO_SUBSCRIBE = () => () => undefined;

export function useProStatus(): ProStatus | null {
  const controller = useOptionalPurchases();
  return useSyncExternalStore(controller ? controller.subscribe : NO_SUBSCRIBE, () =>
    controller ? controller.getStatus() : null,
  );
}
