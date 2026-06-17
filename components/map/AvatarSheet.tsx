'use client';

import { useEffect, useState } from 'react';
import type { GraphEdge, GraphNode } from '@/lib/ego-graph';
import { getProfileByAddress, getTokenBalances, type Profile } from '@/lib/circles-rpc';
import { TYPE_HEX, TYPE_LABEL } from '@/lib/avatar-style';
import { shortenAddress } from '@/lib/utils';
import { BottomSheet } from './Sheet';

export function AvatarSheet({
  node,
  centerId,
  edges,
  onClose,
  onPay,
  onExpand,
}: {
  node: GraphNode;
  centerId: string | null;
  edges: GraphEdge[];
  onClose: () => void;
  onPay: (node: GraphNode) => void;
  onExpand?: (id: string) => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProfile(null);
    setBalance(null);
    (async () => {
      const [p, bals] = await Promise.all([
        getProfileByAddress(node.id).catch(() => null),
        getTokenBalances(node.id).catch(() => []),
      ]);
      if (cancelled) return;
      setProfile(p);
      // Total Circles held (sum of all token balances) — matches the wallet, unlike getTotalBalance.
      setBalance(String(bals.reduce((s, t) => s + (t.circles || 0), 0)));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [node.id]);

  const isSelf = node.id === centerId;
  const youTrust = edges.some((e) => e.source === centerId && e.target === node.id);
  const trustsYou = edges.some((e) => e.source === node.id && e.target === centerId);
  const image = node.image ?? profile?.previewImageUrl ?? profile?.imageUrl ?? null;
  const name = node.name ?? profile?.name;
  const balanceText = balance != null ? Number(balance).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null;

  return (
    <BottomSheet title={isSelf ? 'You' : 'Avatar'} onClose={onClose}>
      <div className="flex items-center gap-3">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-medium text-white"
          style={{ backgroundColor: TYPE_HEX[node.type] }}
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="h-full w-full object-cover" />
          ) : (
            (name ?? node.id).slice(0, 2).toUpperCase()
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{name ?? shortenAddress(node.id)}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{shortenAddress(node.id)}</div>
        </div>
        <span className="rounded-md bg-muted px-2 py-1 text-xs">{TYPE_LABEL[node.type]}</span>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Balance</dt>
          <dd>{loading ? '…' : balanceText != null ? `${balanceText} CRC` : '—'}</dd>
        </div>
        {profile?.location && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Location</dt>
            <dd className="truncate">{profile.location}</dd>
          </div>
        )}
        {!isSelf && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Trust</dt>
            <dd className="text-right">
              {trustsYou && youTrust ? 'Mutual trust' : trustsYou ? 'Trusts you' : youTrust ? 'You trust them' : 'No direct trust'}
            </dd>
          </div>
        )}
      </dl>

      {profile?.description && <p className="mt-3 text-sm text-muted-foreground">{profile.description}</p>}

      <div className="mt-4 flex gap-2">
        {!isSelf && (
          <button
            type="button"
            onClick={() => onPay(node)}
            className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Send
          </button>
        )}
        {onExpand && (
          <button
            type="button"
            onClick={() => onExpand(node.id)}
            className="rounded-lg border px-3 py-2 text-sm hover:bg-muted"
          >
            Expand network
          </button>
        )}
      </div>
    </BottomSheet>
  );
}
