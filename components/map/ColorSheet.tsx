'use client';

import { useEffect, useMemo, useState } from 'react';
import { findGroups, getGroupMemberships, getProfileByAddressBatch, type GroupInfo } from '@/lib/circles-rpc';
import { shortenAddress } from '@/lib/utils';
import { BottomSheet } from './Sheet';

export type ColorMode = 'type' | 'group';

/**
 * Choose how the map is colored: by avatar type (default) or by membership of a few Circles
 * groups. The group list is loaded here (recent groups + the groups YOU belong to, pinned on
 * top); selecting/deselecting is delegated to the parent, which fetches members + recolors.
 */
export function ColorSheet({
  center,
  colorMode,
  selected,
  maxGroups,
  onSetMode,
  onToggleGroup,
  onClose,
}: {
  center: string | null;
  colorMode: ColorMode;
  selected: { address: string; color: string }[];
  maxGroups: number;
  onSetMode: (m: ColorMode) => void;
  onToggleGroup: (g: GroupInfo) => void;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [all, myAddrs] = await Promise.all([
        findGroups(200).catch(() => [] as GroupInfo[]),
        center ? getGroupMemberships(center).catch(() => [] as string[]) : Promise.resolve([] as string[]),
      ]);
      if (cancelled) return;
      const byAddr = new Map(all.map((g) => [g.group.toLowerCase(), g]));
      // Resolve names for groups you're in that didn't appear in the recent-groups list.
      const missing = myAddrs.filter((a) => !byAddr.has(a));
      if (missing.length) {
        const profs = await getProfileByAddressBatch(missing).catch(() => []);
        missing.forEach((a, i) => byAddr.set(a, { group: a, name: profs[i]?.name }));
      }
      if (cancelled) return;
      const mineList = myAddrs.map((a) => byAddr.get(a)).filter(Boolean) as GroupInfo[];
      const rest = all.filter((g) => !myAddrs.includes(g.group.toLowerCase()));
      setMine(new Set(myAddrs));
      setGroups([...mineList, ...rest]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [center]);

  const selectedByAddr = useMemo(() => new Map(selected.map((s) => [s.address, s.color])), [selected]);
  const atMax = selected.length >= maxGroups;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? groups.filter(
          (g) =>
            (g.name ?? '').toLowerCase().includes(q) ||
            (g.symbol ?? '').toLowerCase().includes(q) ||
            g.group.toLowerCase().includes(q),
        )
      : groups;
    return list.slice(0, 60);
  }, [groups, query]);

  return (
    <BottomSheet title="Color the map" onClose={onClose}>
      <div className="flex gap-1 rounded-lg border p-0.5">
        {(['type', 'group'] as ColorMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSetMode(m)}
            className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
            style={colorMode === m ? { backgroundColor: '#534AB7', color: '#fff' } : undefined}
          >
            {m === 'type' ? 'By avatar type' : 'By group'}
          </button>
        ))}
      </div>

      {colorMode === 'type' ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Avatars are colored by type — human, organization, and group.
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs text-muted-foreground">
            Pick up to {maxGroups} groups. Their members light up in distinct colors; everyone else dims.
          </p>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search groups by name or symbol…"
            spellCheck={false}
            autoComplete="off"
            className="mt-2 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {loading ? (
            <p className="mt-3 text-sm text-muted-foreground">Loading groups…</p>
          ) : (
            <ul className="mt-2 divide-y rounded-lg border">
              {filtered.map((g) => {
                const addr = g.group.toLowerCase();
                const color = selectedByAddr.get(addr);
                const isSel = !!color;
                const disabled = !isSel && atMax;
                return (
                  <li key={addr}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onToggleGroup(g)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-40"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-3 w-3 shrink-0 rounded-full border"
                          style={{ backgroundColor: color ?? 'transparent' }}
                        />
                        <span className="truncate">
                          {g.name || shortenAddress(addr)}
                          {g.symbol ? ` · ${g.symbol}` : ''}
                        </span>
                        {mine.has(addr) && (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">yours</span>
                        )}
                      </span>
                      {isSel && <span className="shrink-0 text-xs text-muted-foreground">remove</span>}
                    </button>
                  </li>
                );
              })}
              {!filtered.length && <li className="px-3 py-2 text-sm text-muted-foreground">No groups found.</li>}
            </ul>
          )}
        </>
      )}
    </BottomSheet>
  );
}
