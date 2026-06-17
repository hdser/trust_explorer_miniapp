'use client';

import { useEffect, useState } from 'react';
import type { GraphEdge, GraphNode } from '@/lib/ego-graph';
import { summarizeFlow } from '@/lib/ego-graph';
import {
  encodeMemo,
  findPath,
  getAggregatedTrustRelations,
  getProfileByAddressBatch,
  getTokenBalances,
  searchProfiles,
  ZERO_ADDRESS,
  type SearchProfile,
  type TokenBalance,
} from '@/lib/circles-rpc';
import { fromAtto, getSdk, submitViaHost, toAtto } from '@/lib/circles';
import { TxResult, type TxStatus } from '@/components/circles/TxResult';
import { shortenAddress } from '@/lib/utils';
import { BottomSheet } from './Sheet';

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim());

type Recipient = { address: string; name?: string };
type ReceiveOption = { value: string; label: string }; // value '' = any token

type RouteState =
  | { kind: 'idle' }
  | { kind: 'finding' }
  | { kind: 'done'; maxFlow: bigint; hops: number; reachesTarget: boolean }
  | { kind: 'nopath' }
  | { kind: 'error'; message: string };

export function PaySheet({
  source,
  preset,
  isMiniappHost,
  onClose,
  onRoute,
}: {
  source: string;
  preset: GraphNode | null;
  isMiniappHost: boolean;
  onClose: () => void;
  onRoute: (participants: string[], edges: GraphEdge[], label: string) => Promise<void>;
}) {
  const me = source.toLowerCase();
  const [recipient, setRecipient] = useState<Recipient | null>(
    preset ? { address: preset.id, name: preset.name } : null,
  );
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchProfile[]>([]);
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [sendToken, setSendToken] = useState<string>(''); // tokenOwner (token A); '' = any you hold
  const [receiveToken, setReceiveToken] = useState<string>(''); // tokenOwner (token B); '' = any
  const [receiveOptions, setReceiveOptions] = useState<ReceiveOption[]>([]);
  const [loadingReceive, setLoadingReceive] = useState(false);
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState(''); // optional public note carried with the transfer
  const [route, setRoute] = useState<RouteState>({ kind: 'idle' });
  const [tx, setTx] = useState<TxStatus>({ kind: 'idle' });

  // Convert mode = paying yourself: send token A, receive token B (a real Circles
  // conversion via findPath with WithWrap + Source==Sink).
  const selfMode = !!recipient && recipient.address === me;

  // Your held tokens for the "You send" picker — top balances first.
  useEffect(() => {
    let cancelled = false;
    getTokenBalances(source)
      .then((b) => {
        if (cancelled) return;
        setBalances([...b].sort((a, z) => z.circles - a.circles).slice(0, 25));
      })
      .catch(() => setBalances([]));
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Recipient directory search (skip when the query is already an address).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || isAddress(q)) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchProfiles(q)
        .then((r) => !cancelled && setResults(r.slice(0, 6)))
        .catch(() => !cancelled && setResults([]));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // "They receive" options = any token the recipient trusts (their trusted avatars' tokens),
  // plus the recipient's own token. ToTokens for findPath is one of these.
  useEffect(() => {
    if (!recipient) {
      setReceiveOptions([]);
      setReceiveToken('');
      return;
    }
    let cancelled = false;
    const addr = recipient.address;
    setLoadingReceive(true);
    // Pay: default "any token they trust" (no ToTokens) for a short, readable route.
    // Convert (self): default to your own Circles as the conversion target.
    setReceiveToken(addr === me ? addr : '');
    (async () => {
      // Every token the recipient ACCEPTS = avatars they trust (relation trusts / mutuallyTrusts),
      // via the COMPLETE aggregated relations (getTrustRelations returns only a partial subset).
      const rels = await getAggregatedTrustRelations(addr).catch(() => []);
      const trusted = Array.from(
        new Set(
          rels
            .filter((r) => r.relation === 'trusts' || r.relation === 'mutuallyTrusts')
            .map((r) => r.objectAvatar.toLowerCase())
            .filter((u) => u !== ZERO_ADDRESS && u !== addr),
        ),
      ).slice(0, 500);
      // Resolve names in parallel batches (50/call) so the dropdown reads nicely.
      const chunks: string[][] = [];
      for (let i = 0; i < trusted.length; i += 50) chunks.push(trusted.slice(i, i + 50));
      const profiles = (await Promise.all(chunks.map((c) => getProfileByAddressBatch(c).catch(() => [])))).flat();
      if (cancelled) return;
      const labeled = trusted.map((owner, i) => ({ value: owner, label: profiles[i]?.name ?? shortenAddress(owner) }));
      // Named avatars first, then alphabetical — easier to scan a long list.
      labeled.sort((a, b) => {
        const an = !a.label.startsWith('0x');
        const bn = !b.label.startsWith('0x');
        if (an !== bn) return an ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
      const own = { value: addr, label: addr === me ? 'Your Circles' : "Recipient's Circles" };
      const any = { value: '', label: addr === me ? 'Any token you trust' : 'Any token they trust' };
      setReceiveOptions([...(addr === me ? [own, any] : [any, own]), ...labeled]);
      setLoadingReceive(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipient?.address]);

  const canFind = !!recipient && amount.trim() !== '' && route.kind !== 'finding';

  async function handleFind() {
    if (!recipient) return;
    let atto: bigint;
    try {
      atto = toAtto(amount);
    } catch (err) {
      setRoute({ kind: 'error', message: err instanceof Error ? err.message : 'Invalid amount.' });
      return;
    }
    if (atto <= 0n) {
      setRoute({ kind: 'error', message: 'Amount must be greater than zero.' });
      return;
    }
    setRoute({ kind: 'finding' });
    setTx({ kind: 'idle' });
    try {
      const res = await findPath({
        Source: source,
        Sink: recipient.address,
        TargetFlow: atto.toString(),
        FromTokens: sendToken ? [sendToken] : undefined,
        ToTokens: receiveToken ? [receiveToken] : undefined,
        WithWrap: true,
        MaxTransfers: 100,
      });
      const maxFlow = BigInt(res.maxFlow ?? '0');
      if (maxFlow <= 0n || !res.transfers?.length) {
        setRoute({ kind: 'nopath' });
        return;
      }
      const summary = summarizeFlow(res.transfers, source, recipient.address);
      const toLabel = receiveOptions.find((o) => o.value === receiveToken)?.label ?? 'token';
      const label = selfMode
        ? `convert → ${toLabel}`
        : `you → ${recipient.name ?? shortenAddress(recipient.address)}`;
      await onRoute(summary.participants, summary.edges, label);
      setRoute({ kind: 'done', maxFlow, hops: summary.hops, reachesTarget: maxFlow >= atto });
    } catch (err) {
      setRoute({ kind: 'error', message: err instanceof Error ? err.message : 'Could not find a route.' });
    }
  }

  // On-chain execution via the host. `constructAdvancedTransfer` routes through operateFlowMatrix
  // and honours fromTokens/toTokens, so token-specific pays AND conversions (Source==Sink) all
  // execute — using the same constraints as the route preview above. Only requirement: a host.
  const canSend = isMiniappHost;
  async function handleSend() {
    if (!recipient) return;
    let atto: bigint;
    // If the route can't carry the requested amount, send what CAN flow (its max) so the user
    // doesn't have to play guess-the-number. Haircut the reported maxFlow by 3%: the pathfinder's
    // maxFlow overshoots the actually-executable balance (demurrage + per-hop rounding), so sending
    // it verbatim trips "Insufficient balance. Requested X, Available Y". The /available/ retry
    // below still catches anything the haircut misses.
    if (route.kind === 'done' && !route.reachesTarget) {
      atto = (route.maxFlow * 97n) / 100n;
    } else {
      try {
        atto = toAtto(amount);
      } catch {
        return;
      }
    }
    if (atto <= 0n) return;
    try {
      const sdk = await getSdk();
      const { TransferBuilder } = await import('@aboutcircles/sdk-transfers');
      const builder = new TransferBuilder(sdk.circlesConfig);
      const note = memo.trim();
      const opts = {
        fromTokens: sendToken ? [sendToken as `0x${string}`] : undefined,
        toTokens: receiveToken ? [receiveToken as `0x${string}`] : undefined,
        useWrappedBalances: true,
        maxTransfers: 100,
        ...(note ? { txData: encodeMemo(note) } : {}),
      };
      // Build AND submit. The "insufficient balance" check can fire at either stage (the host
      // simulates the flow), so the whole thing must be inside the retry.
      const send = async (a: bigint) => {
        setTx({ kind: 'encoding' });
        const txs = await builder.constructAdvancedTransfer(
          source as `0x${string}`,
          recipient.address as `0x${string}`,
          a,
          opts,
        );
        if (!txs.length) throw new Error('No transfer path found.');
        setTx({ kind: 'submitting' });
        return submitViaHost(txs);
      };

      try {
        const hashes = await send(atto);
        setTx({ kind: 'submitted', hashes });
      } catch (err) {
        // A thin route's reported max can exceed what an intermediate hop can actually pass
        // (capacity / rounding / demurrage). The error reports the true available amount — retry
        // just under it (costs one more signature) instead of bouncing the send.
        const m = (err instanceof Error ? err.message : '').match(/available[:\s]*([\d.]+)/i);
        if (!m) throw err;
        const safe = (toAtto(m[1]) * 99n) / 100n; // 1% under to clear the limit
        if (safe <= 0n) throw err;
        const hashes = await send(safe);
        setTx({ kind: 'submitted', hashes });
      }
    } catch (err) {
      setTx({ kind: 'error', error: err instanceof Error ? err.message : 'Cancelled' });
    }
  }

  const sendBusy = tx.kind === 'encoding' || tx.kind === 'submitting';

  const sendTokenLabel = (tb: TokenBalance) => {
    const owner = tb.tokenOwner.toLowerCase();
    const who = owner === me ? 'Your Circles' : shortenAddress(tb.tokenOwner);
    const kind = tb.isGroup ? ' (group)' : '';
    // Wrapped = ERC-20 wrapper token; otherwise the personal ERC-1155 balance.
    const wrap = tb.isWrapped ? 'Wrapped' : 'Personal';
    return `${who}${kind} · ${tb.circles.toLocaleString(undefined, { maximumFractionDigits: 2 })} · ${wrap}`;
  };

  return (
    <BottomSheet title={selfMode ? 'Convert tokens' : 'Send Circles'} onClose={onClose}>
      {/* Recipient */}
      <label className="text-xs font-medium text-muted-foreground">To</label>
      {recipient ? (
        <div className="mt-1 flex items-center justify-between rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {selfMode ? 'Yourself (convert)' : recipient.name ?? shortenAddress(recipient.address)}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">{shortenAddress(recipient.address)}</div>
          </div>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => {
              setRecipient(null);
              setRoute({ kind: 'idle' });
            }}
          >
            change
          </button>
        </div>
      ) : (
        <div className="mt-1">
          <input
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
              if (isAddress(v)) setRecipient({ address: v.trim().toLowerCase() });
            }}
            placeholder="Search a name or paste any 0x address"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {results.length > 0 && (
            <ul className="mt-1 divide-y rounded-lg border">
              {results.map((r) => (
                <li key={r.address}>
                  <button
                    type="button"
                    onClick={() => {
                      setRecipient({ address: r.address.toLowerCase(), name: r.name });
                      setResults([]);
                      setQuery('');
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="truncate">{r.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{shortenAddress(r.address)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Anyone — routes through the global trust graph.
            </p>
            <button
              type="button"
              onClick={() => setRecipient({ address: me, name: 'You' })}
              className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              Myself (convert)
            </button>
          </div>
        </div>
      )}

      {/* Tokens */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs font-medium text-muted-foreground">You send</label>
          <select
            value={sendToken}
            onChange={(e) => setSendToken(e.target.value)}
            className="mt-1 w-full rounded-lg border bg-background px-2 py-2 text-sm"
          >
            <option value="">Any token you hold</option>
            {balances.map((tb) => (
              <option key={tb.tokenId} value={tb.tokenOwner.toLowerCase()}>
                {sendTokenLabel(tb)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">{selfMode ? 'Convert to' : 'They receive'}</label>
          <select
            value={receiveToken}
            onChange={(e) => setReceiveToken(e.target.value)}
            disabled={!recipient || loadingReceive}
            className="mt-1 w-full rounded-lg border bg-background px-2 py-2 text-sm disabled:opacity-60"
          >
            {!recipient && <option value="">Pick a recipient first</option>}
            {loadingReceive && <option value="">Loading tokens…</option>}
            {!loadingReceive &&
              receiveOptions.map((o) => (
                <option key={o.value || 'any'} value={o.value}>
                  {o.label}
                </option>
              ))}
          </select>
        </div>
      </div>
      {recipient && !loadingReceive && (
        <p className="mt-1 text-xs text-muted-foreground">
          {selfMode ? 'Convert your holdings into another token you trust.' : 'Any token the recipient trusts.'}
        </p>
      )}

      {/* Amount */}
      <div className="mt-3">
        <label className="text-xs font-medium text-muted-foreground">Amount (CRC)</label>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
          inputMode="decimal"
          className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Note — a public message carried with the transfer (skip for self-conversions) */}
      {!selfMode && (
        <div className="mt-3">
          <label className="text-xs font-medium text-muted-foreground">Note (optional)</label>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Add a message to this payment"
            maxLength={120}
            className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      <button
        type="button"
        onClick={handleFind}
        disabled={!canFind}
        className="mt-4 w-full rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {route.kind === 'finding' ? 'Finding…' : selfMode ? 'Find conversion' : 'Find route'}
      </button>

      {/* Route result */}
      {route.kind === 'nopath' && (
        <p className="mt-3 text-sm text-muted-foreground">No route for the selected tokens yet.</p>
      )}
      {route.kind === 'error' && <p className="mt-3 text-sm text-destructive">{route.message}</p>}
      {route.kind === 'done' && (
        <div className="mt-3 rounded-lg bg-muted/60 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Max flow</span>
            <span>{fromAtto(route.maxFlow)} CRC</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Hops</span>
            <span>{route.hops}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {route.reachesTarget
              ? 'Route highlighted on the map.'
              : `This path can carry at most ${fromAtto(route.maxFlow)} CRC right now (${route.hops} hops). Send that?`}
          </p>
          {!route.reachesTarget && (sendToken || receiveToken) && (
            <p className="mt-1 text-xs text-muted-foreground">
              Tip: set the tokens to “Any …” — a specific token often has a much thinner path.
            </p>
          )}

          {canSend ? (
            <button
              type="button"
              onClick={handleSend}
              disabled={sendBusy}
              className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {sendBusy
                ? 'Waiting for host…'
                : route.reachesTarget
                  ? selfMode
                    ? `Convert ${amount} CRC`
                    : `Send ${amount} CRC`
                  : selfMode
                    ? `Convert max — ${fromAtto(route.maxFlow)} CRC`
                    : `Send max — ${fromAtto(route.maxFlow)} CRC`}
            </button>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Open inside the Circles wallet to send.</p>
          )}
          <TxResult status={tx} />
        </div>
      )}
    </BottomSheet>
  );
}
