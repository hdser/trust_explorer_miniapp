'use client';

import { useEffect, useState } from 'react';
import { searchProfiles, type SearchProfile } from '@/lib/circles-rpc';
import { shortenAddress } from '@/lib/utils';
import { BottomSheet } from './Sheet';

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim());

/**
 * Find any avatar by name (directory search) or by pasting a 0x address. Picking one hands the
 * address back to the parent, which places it on the map and opens its profile.
 */
export function SearchSheet({
  onSelect,
  onClose,
}: {
  onSelect: (address: string, name?: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchProfile[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || isAddress(q)) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      searchProfiles(q)
        .then((r) => !cancelled && (setResults(r.slice(0, 12)), setLoading(false)))
        .catch(() => !cancelled && (setResults([]), setLoading(false)));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const addr = isAddress(query) ? query.trim().toLowerCase() : null;

  return (
    <BottomSheet title="Find an avatar" onClose={onClose}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, or paste a 0x address"
        spellCheck={false}
        autoComplete="off"
        autoFocus
        className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />

      {addr && (
        <button
          type="button"
          onClick={() => onSelect(addr)}
          className="mt-2 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted"
        >
          <span>View this address</span>
          <span className="font-mono text-xs text-muted-foreground">{shortenAddress(addr)}</span>
        </button>
      )}

      {loading && <p className="mt-3 text-sm text-muted-foreground">Searching…</p>}

      {!loading && results.length > 0 && (
        <ul className="mt-2 divide-y rounded-lg border">
          {results.map((r) => (
            <li key={r.address}>
              <button
                type="button"
                onClick={() => onSelect(r.address.toLowerCase(), r.name)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span className="truncate">{r.name || shortenAddress(r.address)}</span>
                <span className="font-mono text-xs text-muted-foreground">{shortenAddress(r.address)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && !addr && query.trim().length >= 2 && results.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">No avatars found.</p>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Pick an avatar to see its profile and place it on the map.
      </p>
    </BottomSheet>
  );
}
