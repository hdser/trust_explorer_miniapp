'use client';

import { Badge } from '@/components/ui/badge';
import { explorerTxUrl } from '@/lib/circles';

/**
 * Status machine shared by the write demos (Trust, Send). A write goes
 * idle -> encoding (build calldata) -> submitting (host signs) -> submitted | error.
 */
export type TxStatus =
  | { kind: 'idle' }
  | { kind: 'encoding' }
  | { kind: 'submitting' }
  | { kind: 'submitted'; hashes: string[] }
  | { kind: 'error'; error: string };

/** Renders the outcome of a host-submitted transaction: pending hint, hashes, or error. */
export function TxResult({ status }: { status: TxStatus }) {
  if (status.kind === 'idle') return null;

  if (status.kind === 'encoding' || status.kind === 'submitting') {
    return (
      <p className="text-muted-foreground">
        {status.kind === 'encoding'
          ? 'Encoding the transaction…'
          : 'Waiting for the host to sign and submit…'}
      </p>
    );
  }

  if (status.kind === 'error') {
    return <p className="text-destructive">Transaction failed: {status.error}</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge>submitted</Badge>
        <span className="text-muted-foreground">
          {status.hashes.length} transaction{status.hashes.length === 1 ? '' : 's'} sent
          through the host.
        </span>
      </div>
      <ul className="space-y-1">
        {status.hashes.map((hash) => (
          <li key={hash}>
            <a
              className="font-mono text-xs underline break-all"
              href={explorerTxUrl(hash)}
              target="_blank"
              rel="noreferrer"
            >
              {hash}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
