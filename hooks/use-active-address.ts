'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@/components/wallet/WalletProvider';

/**
 * The avatar the app should center on: the host-connected wallet, or — for local dev
 * outside the Circles host where `onWalletChange` never fires — a `?debugAddress=0x…`
 * override so the map can be exercised in `pnpm dev`.
 */
export function useActiveAddress() {
  const { address, isConnected, isMiniappHost, connect } = useWallet();
  const [debugAddress, setDebugAddress] = useState<string | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('debugAddress');
    if (p && /^0x[0-9a-fA-F]{40}$/.test(p)) setDebugAddress(p.toLowerCase());
  }, []);

  const active = address ?? debugAddress;
  return {
    address: active,
    isConnected,
    isMiniappHost,
    connect,
    isDebug: !address && !!debugAddress,
  };
}
