'use client';

import { useEffect, useState } from 'react';
import type { GraphEdge } from '@/lib/ego-graph';
import { extractFlowPath, realizedFlow } from '@/lib/ego-graph';
import {
  extractMemoFromInput,
  getTransactionHistory,
  getTransfersByTx,
  getTxInput,
  tokenIdToAddress,
  type TransferRow,
} from '@/lib/circles-rpc';
import { shortenAddress } from '@/lib/utils';
import { BottomSheet } from './Sheet';

function when(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function ActivityPanel({
  source,
  onClose,
  onReplay,
}: {
  source: string;
  onClose: () => void;
  onReplay: (participants: string[], edges: GraphEdge[], label: string) => Promise<void>;
}) {
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'error'>('loading');
  const [replaying, setReplaying] = useState<string | null>(null);
  // Memos by transactionHash — decoded from raw tx input (the indexer carries no message field).
  const [memos, setMemos] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setMemos(new Map());
    getTransactionHistory(source, 25)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setState('idle');
        // Fetch + decode the memo once per unique tx (rows repeat per netted leg).
        const uniq = [...new Set(r.map((x) => x.transactionHash))];
        void Promise.all(
          uniq.map(async (h) => [h, extractMemoFromInput(await getTxInput(h).catch(() => null))] as const),
        ).then((pairs) => {
          if (!cancelled) setMemos(new Map(pairs.filter(([, m]) => m) as [string, string][]));
        });
      })
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [source]);

  async function replay(row: TransferRow) {
    const me = source.toLowerCase();
    const sent = row.from.toLowerCase() === me;
    const counterparty = sent ? row.to : row.from;
    setReplaying(row.transactionHash);
    try {
      const legs = await getTransfersByTx(row.transactionHash);
      const mapped = legs.map((l) => ({
        from: String(l.from ?? ''),
        to: String(l.to ?? ''),
        tokenOwner: tokenIdToAddress(String(l.id ?? '')), // token id → issuer avatar address
      }));
      // Show the REALIZED flow — every leg as a directed edge colored by token issuer — rather than
      // collapsing it to the shortest trust corridor. Fall back to the corridor if the legs are
      // unusable (e.g. all mint/router so no avatar-to-avatar edge survives).
      const flow = realizedFlow(mapped);
      const tokens = flow.tokenCount > 1 ? ` · ${flow.tokenCount} tokens` : '';
      const { participants, edges } = flow.edges.length
        ? { participants: [...new Set([me, counterparty.toLowerCase(), ...flow.participants])], edges: flow.edges }
        : extractFlowPath(mapped, me, counterparty);
      const label = `${sent ? 'sent to' : 'received from'} ${shortenAddress(counterparty)}${flow.edges.length ? tokens : ''}`;
      await onReplay(participants, edges, label);
    } finally {
      setReplaying(null);
    }
  }

  return (
    <BottomSheet title="Activity" onClose={onClose}>
      {state === 'loading' && <p className="text-sm text-muted-foreground">Loading transfers…</p>}
      {state === 'error' && <p className="text-sm text-destructive">Could not load activity.</p>}
      {state === 'idle' && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No transfers yet for this avatar.</p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y">
          {rows.map((row) => {
            const me = source.toLowerCase();
            const sent = row.from.toLowerCase() === me;
            const counterparty = sent ? row.to : row.from;
            const amount = Number(row.circles).toLocaleString(undefined, { maximumFractionDigits: 3 });
            return (
              <li key={`${row.transactionHash}-${row.logIndex}`} className="flex items-center gap-3 py-2">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs"
                  style={{
                    backgroundColor: sent ? '#FAECE7' : '#E1F5EE',
                    color: sent ? '#993C1D' : '#0F6E56',
                  }}
                  aria-hidden
                >
                  {sent ? '↗' : '↙'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {sent ? 'Sent to' : 'Received from'} {shortenAddress(counterparty)}
                  </div>
                  <div className="text-xs text-muted-foreground">{when(row.timestamp)}</div>
                  {memos.get(row.transactionHash) && (
                    <div className="truncate text-xs italic text-foreground/80">
                      “{memos.get(row.transactionHash)}”
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium" style={{ color: sent ? undefined : '#0F6E56' }}>
                    {sent ? '−' : '+'}
                    {amount} CRC
                  </div>
                  <button
                    type="button"
                    onClick={() => replay(row)}
                    disabled={replaying === row.transactionHash}
                    className="text-xs text-primary underline disabled:opacity-50"
                  >
                    {replaying === row.transactionHash ? 'replaying…' : 'replay on map'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </BottomSheet>
  );
}
