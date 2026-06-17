'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type WalletContextValue = {
  address: string | null;
  isConnected: boolean;
  isMiniappHost: boolean;
  /** Ask the host to open its passkey "create / log in" flow (must be called from a user gesture). */
  connect: () => void;
};

const WalletContext = createContext<WalletContextValue>({
  address: null,
  isConnected: false,
  isMiniappHost: false,
  connect: () => {},
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [isMiniappHost, setIsMiniappHost] = useState(false);
  // The SDK's account-creation entry point, captured once on load so `connect()` can fire it
  // SYNCHRONOUSLY from a click — awaiting an import first would let the browser block the
  // WebAuthn passkey prompt.
  const requestCreateAccountRef = useRef<null | (() => Promise<{ address?: string }>)>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    // Dynamic import: the SDK reads window/parent, so it must not run on the server.
    import('@aboutcircles/miniapp-sdk')
      .then(({ onWalletChange, isMiniappMode, requestCreateAccount }) => {
        if (cancelled) return;
        setIsMiniappHost(isMiniappMode());
        unsubscribe = onWalletChange((addr) => setAddress(addr ?? null));
        requestCreateAccountRef.current = requestCreateAccount;
      })
      .catch((err) => {
        console.error('[miniapp-sdk] failed to load:', err);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const connect = useCallback(() => {
    // Call straight away (no await before it) so the passkey prompt counts as user-initiated.
    // onWalletChange also fires on success, but we set the address here too as a belt-and-braces.
    requestCreateAccountRef.current?.()
      .then((r) => {
        if (r?.address) setAddress(r.address);
      })
      .catch(() => {});
  }, []);

  return (
    <WalletContext.Provider value={{ address, isConnected: !!address, isMiniappHost, connect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
