// Helpers for the two-SDK write pattern shared by every write demo:
//
//   @aboutcircles/sdk         -> encode calldata        (read-only `new Sdk()`, no signer)
//   @aboutcircles/miniapp-sdk -> submit via host's Safe  (sendTransactions)
//
// A miniapp holds no keys, so a write is: encode a `{ to, data, value }` with the
// SDK's contract wrappers, then hand it to the host to sign and broadcast. Both SDKs
// are imported dynamically (never at module top level) so they don't run during SSR —
// see AGENTS.md "Working with the Circles SDKs".

import type { Sdk } from '@aboutcircles/sdk';

/** Circles Hub v2 on Gnosis Chain — the contract every core write targets. */
export const HUB_V2 = '0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8' as const;

/**
 * Indefinite trust = max uint96, the SDK's own default `trust` expiry.
 * Passing `0n` instead would *remove* trust.
 */
export const INDEFINITE_TRUST_EXPIRY = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFF');

/** The transaction shape the host's `sendTransactions` accepts. */
export type HostTx = { to: string; data?: string; value?: string };

/** What the SDK encoders return: `{ to, data, value }` with a bigint (or absent) value. */
export type EncodedTx = { to: string; data?: string; value?: bigint | string };

let sdkSingleton: Sdk | null = null;

/**
 * A read-only `Sdk` (no contractRunner). Used both for reads (`sdk.rpc.*`) and for
 * encoding writes (`sdk.core.hubV2.*`). Memoized for the session; dynamically imported
 * so it never executes on the server.
 */
export async function getSdk(): Promise<Sdk> {
  if (sdkSingleton) return sdkSingleton;
  const { Sdk } = await import('@aboutcircles/sdk');
  sdkSingleton = new Sdk();
  return sdkSingleton;
}

/** Map an SDK-encoded tx to the host's `{ to, data, value }` (value serialized to a string). */
export function toHostTx(tx: EncodedTx): HostTx {
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value === undefined ? '0' : tx.value.toString(),
  };
}

/**
 * Submit encoded transactions through the host's Safe and return the tx hashes.
 * The host renders its own confirmation UI and rejects the promise if the user
 * declines. The host bridge touches `window`, so it is imported dynamically.
 */
export async function submitViaHost(txs: EncodedTx[]): Promise<string[]> {
  const { sendTransactions } = await import('@aboutcircles/miniapp-sdk');
  return sendTransactions(txs.map(toHostTx));
}

/** gnosisscan link for a transaction hash. */
export function explorerTxUrl(hash: string): string {
  return `https://gnosisscan.io/tx/${hash}`;
}

/** Parse a decimal CRC string (e.g. "12.5") into atto-CRC (18 dp) as a bigint. */
export function toAtto(amount: string): bigint {
  const trimmed = amount.trim();
  if (trimmed === '' || trimmed === '.' || !/^\d*\.?\d*$/.test(trimmed)) {
    throw new Error('Enter a valid amount.');
  }
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole || '0') * 10n ** 18n + BigInt(fracPadded || '0');
}

/** Format an atto-CRC bigint as a human-readable CRC string. */
export function fromAtto(atto: bigint, maxFractionDigits = 4): string {
  const negative = atto < 0n;
  const abs = negative ? -atto : atto;
  const whole = abs / 10n ** 18n;
  const fracStr = (abs % 10n ** 18n)
    .toString()
    .padStart(18, '0')
    .slice(0, maxFractionDigits)
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toLocaleString()}${fracStr ? `.${fracStr}` : ''}`;
}
