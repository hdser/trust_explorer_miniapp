'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useActiveAddress } from '@/hooks/use-active-address';
import {
  buildEgoGraph,
  expandNode,
  loadFullNetwork,
  loadInvitesNetwork,
  mergeAddresses,
  resolveTypes,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from '@/lib/ego-graph';
import {
  getAggregatedTrustRelations,
  getGroupMembers,
  getProfileByAddress,
  getTokenBalances,
  ZERO_ADDRESS,
  type GroupInfo,
} from '@/lib/circles-rpc';
import { GROUP_PALETTE, TRUST_IN_HEX, TRUST_OUT_HEX, TYPE_HEX } from '@/lib/avatar-style';
import { shortenAddress } from '@/lib/utils';
import { TrustGraph } from './TrustGraph';
import { AvatarSheet } from './AvatarSheet';
import { PaySheet } from './PaySheet';
import { ActivityPanel } from './ActivityPanel';
import { ColorSheet, type ColorMode } from './ColorSheet';
import { SearchSheet } from './SearchSheet';

type Route = { nodes: Set<string>; edges: GraphEdge[]; label: string; legend?: { color: string; label: string }[] };
type Panel = 'none' | 'avatar' | 'pay' | 'activity' | 'color' | 'search';
type SelectedGroup = { address: string; name: string; symbol?: string; color: string };

// The three graphs you can view. `ego` is your local trust neighbourhood (tap to grow); the
// other two are the whole global graph for a relation, like the web_viewer's graph picker.
type Scope = 'ego' | 'trusts' | 'invites';
const SCOPES: { id: Scope; short: string; label: string }[] = [
  { id: 'ego', short: 'Vicinity', label: 'Your trust neighbourhood (tap a node to grow it)' },
  { id: 'trusts', short: 'Network', label: 'The whole Circles trust network' },
  { id: 'invites', short: 'Invitation', label: 'Who invited whom across Circles' },
];

const LEGEND: { type: keyof typeof TYPE_HEX; label: string }[] = [
  { type: 'human', label: 'Human' },
  { type: 'organization', label: 'Org' },
  { type: 'group', label: 'Group' },
];

type PosMap = Map<string, [number, number]>;

export function MapExperience() {
  const { address, isMiniappHost, connect } = useActiveAddress();
  const center = address?.toLowerCase() ?? null;

  const [graph, setGraph] = useState<Graph | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [focus, setFocus] = useState<{ node: string; added: Set<string>; label: string } | null>(null);
  // Bumped whenever the graph is replaced wholesale (avatar load, full-network toggle) so the
  // renderer lays it out from scratch with a run scaled to its size, instead of merging.
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [panel, setPanel] = useState<Panel>('none');
  const [payPreset, setPayPreset] = useState<GraphNode | null>(null);

  // Which graph is shown, plus a loading indicator for the heavy (global) scopes.
  const [scope, setScope] = useState<Scope>('ego');
  const [load, setLoad] = useState<{ scope: Scope; progress: number } | null>(null);
  // Loaded graphs + their settled positions, cached per scope so switching never re-fetches
  // and switching *back* restores the exact layout instantly. Only a deliberate refresh reloads.
  const graphCache = useRef<Record<Scope, Graph | null>>({ ego: null, trusts: null, invites: null });
  const posCache = useRef<Partial<Record<Scope, PosMap>>>({});
  const scopeRef = useRef<Scope>(scope);
  scopeRef.current = scope;
  // Bumped when node colors change (type enrichment OR group selection) so the map recolors
  // without re-laying-out. `enrichToken` cancels in-flight enrichment when the scope changes.
  const [colorVersion, setColorVersion] = useState(0);
  const enrichToken = useRef(0);

  // Coloring: by avatar type (default) or by membership of a few selected groups. Member sets
  // are fetched once per group and cached; the derived `groupColoring` is handed to TrustGraph.
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [selectedGroups, setSelectedGroups] = useState<SelectedGroup[]>([]);
  const groupMembers = useRef<Map<string, Set<string>>>(new Map());

  const [meName, setMeName] = useState<string | null>(null);
  const [meImage, setMeImage] = useState<string | null>(null);
  const [meBalance, setMeBalance] = useState<string | null>(null);

  // Load the ego graph for the connected avatar.
  useEffect(() => {
    if (!center) {
      setGraph(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setRoute(null);
    setFocus(null);
    setSelectedId(null);
    setPanel('none');
    // New avatar → every cached graph is stale.
    graphCache.current = { ego: null, trusts: null, invites: null };
    posCache.current = {};
    setScope('ego');
    setLoad(null);
    buildEgoGraph(center)
      .then((g) => {
        if (cancelled) return;
        graphCache.current.ego = g;
        setGraph(g);
        setLayoutNonce((n) => n + 1);
        setStatus('idle');
      })
      .catch(() => !cancelled && setStatus('error'));
    return () => {
      cancelled = true;
    };
  }, [center]);

  // Connected avatar header info.
  useEffect(() => {
    if (!center) {
      setMeName(null);
      setMeImage(null);
      setMeBalance(null);
      return;
    }
    let cancelled = false;
    getProfileByAddress(center)
      .then((p) => {
        if (cancelled || !p) return;
        setMeName(p.name ?? null);
        setMeImage(p.previewImageUrl ?? p.imageUrl ?? null);
      })
      .catch(() => {});
    // Total Circles held = sum of every token balance (demurraged), matching what the wallet
    // shows and the Send picker. `getTotalBalance` returns a much smaller, different figure.
    getTokenBalances(center)
      .then((bals) => !cancelled && setMeBalance(String(bals.reduce((s, b) => s + (b.circles || 0), 0))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [center]);

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null;

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    setPanel(id ? 'avatar' : 'none');
  }, []);

  // Cache the settled layout for the active scope so switching back restores it instantly.
  const handlePositions = useCallback((m: PosMap) => {
    posCache.current[scopeRef.current] = m;
  }, []);

  // The global trust graph comes back untyped (grey). Fill in human/org/group in the background
  // and recolor as they arrive — WITHOUT re-laying-out. Runs on first load AND whenever we show
  // a cached graph that still has grey nodes (e.g. enrichment was interrupted last time), and
  // keeps running even if you switch scopes, so the cached graph finishes colouring.
  const enrichScope = useCallback((target: Scope, g: Graph) => {
    if (target !== 'trusts') return; // ego is enriched at build; invites are all human
    if (!g.nodes.some((n) => n.type === 'unknown')) return;
    const token = ++enrichToken.current;
    void resolveTypes(
      g.nodes,
      () => {
        if (enrichToken.current === token) setColorVersion((v) => v + 1);
      },
      () => enrichToken.current !== token,
    ).catch(() => {});
  }, []);

  const applyRoute = useCallback(
    async (participants: string[], edges: GraphEdge[], label: string, legend?: { color: string; label: string }[]) => {
      if (!graph) return;
      const merged = await mergeAddresses(graph, participants);
      graphCache.current[scopeRef.current] = merged;
      setGraph(merged);
      setFocus(null);
      setRoute({ nodes: new Set(participants.map((p) => p.toLowerCase())), edges, label, legend });
    },
    [graph],
  );

  // Tap-to-grow: pull in the avatar's trust relations and let the map expand outward, with
  // the newly-discovered avatars popping in. NOT a payment path — the whole map stays visible.
  async function handleExpand(id: string) {
    if (!graph) return;
    const before = new Set(graph.nodes.map((n) => n.id));
    const next = await expandNode(graph, id);
    const added = new Set(next.nodes.filter((n) => !before.has(n.id)).map((n) => n.id));
    const node = next.nodes.find((n) => n.id === id);
    const name = node?.name ?? shortenAddress(id);
    const label = added.size
      ? `${name} — ${added.size} new avatar${added.size > 1 ? 's' : ''}`
      : `${name} — already all on your map`;
    setRoute(null);
    graphCache.current[scopeRef.current] = next;
    setGraph(next);
    setFocus({ node: id, added, label });
    setSelectedId(id);
    setPanel('none');
  }

  function handleSetColorMode(m: ColorMode) {
    setColorMode(m);
    setColorVersion((v) => v + 1);
  }

  // Search-select: place the avatar on the map and HIGHLIGHT its trust neighborhood — outgoing
  // (avatars it trusts, blue) and incoming (avatars that trust it, orange) — as directed edges, with
  // the rest of the map dimmed. Then open its profile (Expand / Send from there). Uses the complete
  // aggregated relations, so it works for any address regardless of the current scope.
  const NEIGHBORHOOD_CAP = 600; // bound extreme hubs (most avatars fall well under this)
  async function handleSearchSelect(addr: string, name?: string) {
    if (!graph) return;
    const a = addr.toLowerCase();
    setSelectedId(a);
    const rels = await getAggregatedTrustRelations(a).catch(() => []);
    const outSet = new Set<string>();
    const inSet = new Set<string>();
    for (const r of rels) {
      const o = r.objectAvatar.toLowerCase();
      if (o === ZERO_ADDRESS || o === a) continue;
      if (r.relation === 'trusts' || r.relation === 'mutuallyTrusts') outSet.add(o);
      if (r.relation === 'trustedBy' || r.relation === 'mutuallyTrusts') inSet.add(o);
    }
    const out = [...outSet].slice(0, NEIGHBORHOOD_CAP);
    const inc = [...inSet].slice(0, NEIGHBORHOOD_CAP);

    if (!out.length && !inc.length) {
      // No trust relations — just place + focus the single node.
      const merged = await mergeAddresses(graph, [a]);
      graphCache.current[scopeRef.current] = merged;
      setRoute(null);
      setGraph(merged);
      setFocus({ node: a, added: new Set(), label: name ?? shortenAddress(a) });
      setPanel('avatar');
      return;
    }

    const participants = [a, ...out, ...inc];
    const edges: GraphEdge[] = [
      ...out.map((o) => ({ source: a, target: o, color: TRUST_OUT_HEX })),
      ...inc.map((i) => ({ source: i, target: a, color: TRUST_IN_HEX })),
    ];
    const label = `${name ?? shortenAddress(a)} — trusts ${outSet.size}, trusted by ${inSet.size}`;
    await applyRoute(participants, edges, label, [
      { color: TRUST_OUT_HEX, label: 'trusts' },
      { color: TRUST_IN_HEX, label: 'trusted by' },
    ]);
    setSelectedId(a);
    setPanel('avatar');
  }

  // Toggle a group in the "color by group" selection. Selecting fetches its members once
  // (cached) and assigns a palette color; the recolor is instant via `colorVersion`.
  async function handleToggleGroup(g: GroupInfo) {
    const addr = g.group.toLowerCase();
    if (selectedGroups.some((s) => s.address === addr)) {
      setSelectedGroups((prev) => prev.filter((s) => s.address !== addr));
      setColorVersion((v) => v + 1);
      return;
    }
    if (selectedGroups.length >= GROUP_PALETTE.length) return;
    const used = new Set(selectedGroups.map((s) => s.color));
    const color = GROUP_PALETTE.find((c) => !used.has(c)) ?? GROUP_PALETTE[0];
    setSelectedGroups((prev) => [...prev, { address: addr, name: g.name || shortenAddress(addr), symbol: g.symbol, color }]);
    setColorMode('group');
    setColorVersion((v) => v + 1);
    if (!groupMembers.current.has(addr)) {
      const members = await getGroupMembers(addr).catch(() => [] as string[]);
      groupMembers.current.set(addr, new Set(members));
      setColorVersion((v) => v + 1);
    }
  }

  // Switch which graph is shown. Cached scopes restore instantly (no fetch); `refresh` forces a
  // reload of the target scope. Heavy scopes (trusts/invites) page the global graph over RPC.
  async function switchScope(target: Scope, refresh = false) {
    if (load || !center) return;
    if (target === scope && !refresh) return;
    setRoute(null);
    setFocus(null);
    setSelectedId(null);
    setPanel('none');

    if (refresh) {
      graphCache.current[target] = null;
      posCache.current[target] = undefined;
    }

    const cached = graphCache.current[target];
    if (cached) {
      // Already in memory — show it and let the renderer restore the cached layout. If a prior
      // enrichment was interrupted and grey nodes remain, resume colouring it.
      setScope(target);
      setGraph(cached);
      setLayoutNonce((n) => n + 1);
      enrichScope(target, cached);
      return;
    }

    setScope(target);
    setLoad({ scope: target, progress: 0 });
    try {
      let g: Graph;
      if (target === 'ego') {
        g = await buildEgoGraph(center);
      } else {
        const loader = target === 'trusts' ? loadFullNetwork : loadInvitesNetwork;
        g = await loader((edgeCount) => setLoad((l) => (l && l.scope === target ? { ...l, progress: edgeCount } : l)));
        const me = g.nodes.find((n) => n.id === center);
        if (me) me.isCenter = true;
      }
      graphCache.current[target] = g;
      posCache.current[target] = undefined;
      setGraph(g);
      setLayoutNonce((n) => n + 1);
      enrichScope(target, g);
    } catch {
      setStatus('error');
    } finally {
      setLoad(null);
    }
  }

  const meInitial = (meName ?? center ?? 'Y').slice(0, 2).toUpperCase();
  const balanceText =
    meBalance != null ? Number(meBalance).toLocaleString(undefined, { maximumFractionDigits: 0 }) : null;

  // Always-on count: avatars (nodes) and relationships. For trust scopes `meta.relations` carries the
  // TRUE trust count (the Network renderer only draws a degree-capped subset); invitations have no
  // reduction, so it falls back to the edge count.
  const avatarCount = graph?.nodes.length ?? 0;
  const relationCount = graph?.meta?.relations ?? graph?.edges.length ?? 0;
  const relationLabel = scope === 'invites' ? 'invites' : 'trusts';

  const groupColoring =
    colorMode === 'group' && selectedGroups.length
      ? {
          groups: selectedGroups.map((g) => ({
            color: g.color,
            members: groupMembers.current.get(g.address) ?? new Set<string>(),
          })),
        }
      : null;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-background">
      {/* Map hero */}
      {graph && graph.nodes.length > 0 && (
        <TrustGraph
          graph={graph}
          selectedId={selectedId}
          routeNodes={route?.nodes}
          routeEdges={route?.edges}
          focusNode={focus?.node}
          focusNodes={focus?.added}
          layoutNonce={layoutNonce}
          colorVersion={colorVersion}
          groupColoring={groupColoring}
          savedPositions={posCache.current[scope]}
          onPositionsSnapshot={handlePositions}
          onSelect={handleSelect}
        />
      )}

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-3">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-full border bg-card/90 px-3 py-1.5 shadow-sm backdrop-blur">
            <BrandGlyph />
            <span className="text-sm font-medium">Trust Explorer</span>
          </div>
          {center && graph && (
            <div className="flex items-center gap-1 rounded-full border bg-card/90 p-0.5 shadow-sm backdrop-blur">
              {SCOPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => switchScope(s.id)}
                  disabled={!!load}
                  title={s.label}
                  className="rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60"
                  style={
                    scope === s.id
                      ? { backgroundColor: '#534AB7', color: '#fff' }
                      : undefined
                  }
                >
                  {s.short}
                </button>
              ))}
              <button
                type="button"
                onClick={() => switchScope(scope, true)}
                disabled={!!load}
                title="Reload this graph"
                aria-label="Reload this graph"
                className="ml-0.5 flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-60"
              >
                <RefreshIcon />
              </button>
            </div>
          )}
          {load && (
            <span className="rounded-full border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
              {load.progress > 0 ? `Loading… ${load.progress.toLocaleString()} edges` : 'Loading…'}
            </span>
          )}
          {graph && !load && (
            <span className="rounded-full border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
              <span className="font-medium text-foreground">{avatarCount.toLocaleString()}</span> avatars ·{' '}
              <span className="font-medium text-foreground">{relationCount.toLocaleString()}</span> {relationLabel}
            </span>
          )}
        </div>

        {center && (
          <div className="pointer-events-auto flex items-center gap-2">
            {graph && (
              <button
                type="button"
                onClick={() => setPanel('search')}
                aria-label="Find an avatar"
                title="Find an avatar"
                className="flex h-9 w-9 items-center justify-center rounded-full border bg-card/90 text-muted-foreground shadow-sm backdrop-blur hover:bg-muted"
              >
                <Icon name="search" />
              </button>
            )}
            <div className="flex items-center gap-2 rounded-full border bg-card/90 py-1 pl-3 pr-1 shadow-sm backdrop-blur">
              {balanceText != null && <span className="text-xs font-medium">{balanceText} CRC</span>}
              <span
                className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full text-[11px] font-medium text-white"
                style={{ backgroundColor: TYPE_HEX.human }}
                title={meName ?? shortenAddress(center)}
              >
                {meImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={meImage} alt="" className="h-full w-full object-cover" />
                ) : (
                  meInitial
                )}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Legend (reflects the active color mode) */}
      {graph && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex max-w-[60vw] flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {colorMode === 'group' && selectedGroups.length ? (
            selectedGroups.map((g) => (
              <span key={g.address} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
                <span className="max-w-[28vw] truncate">{g.name}</span>
              </span>
            ))
          ) : (
            LEGEND.map((l) => (
              <span key={l.type} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TYPE_HEX[l.type] }} />
                {l.label}
              </span>
            ))
          )}
        </div>
      )}

      {/* States */}
      {!center && (
        <CenterCard>
          <BrandGlyph large />
          {isMiniappHost ? (
            <>
              <p className="mt-3 font-medium">Connect your Circles account</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Sign in with your passkey to map your trust network.
              </p>
              <button
                type="button"
                onClick={connect}
                style={{ backgroundColor: '#534AB7', color: '#fff' }}
                className="mt-4 rounded-full px-5 py-2.5 text-sm font-medium shadow-lg hover:opacity-90"
              >
                Connect
              </button>
            </>
          ) : (
            <>
              <p className="mt-3 font-medium">Open inside the Circles wallet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                This maps the connected avatar&apos;s trust network — send to anyone, convert tokens, replay flows.
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                Local dev: add <code className="rounded bg-muted px-1">?debugAddress=0x…</code>
              </p>
            </>
          )}
        </CenterCard>
      )}
      {center && status === 'loading' && (
        <CenterCard>
          <p className="text-sm text-muted-foreground">Loading your trust network…</p>
        </CenterCard>
      )}
      {center && status === 'error' && (
        <CenterCard>
          <p className="text-sm text-destructive">Couldn&apos;t load the trust graph. Try again.</p>
        </CenterCard>
      )}

      {/* Bottom action dock */}
      {graph && panel === 'none' && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex flex-wrap items-center justify-center gap-2 p-4">
          <button
            type="button"
            onClick={() => {
              setPayPreset(null);
              setPanel('pay');
            }}
            style={{ backgroundColor: '#534AB7', color: '#fff' }}
            className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium shadow-lg hover:opacity-90"
          >
            <Icon name="exchange" /> Send or convert
          </button>
          <button
            type="button"
            onClick={() => setPanel('activity')}
            className="flex items-center gap-2 rounded-full border bg-card px-4 py-2.5 text-sm shadow-md hover:bg-muted"
          >
            <Icon name="history" /> Activity
          </button>
          <button
            type="button"
            onClick={() => setPanel('color')}
            className="flex items-center gap-2 rounded-full border bg-card px-4 py-2.5 text-sm shadow-md hover:bg-muted"
          >
            <Icon name="palette" /> {colorMode === 'group' ? `Color · ${selectedGroups.length}` : 'Color'}
          </button>
          {(route || focus) && (
            <button
              type="button"
              onClick={() => {
                setRoute(null);
                setFocus(null);
              }}
              className="rounded-full border bg-card px-4 py-2.5 text-sm shadow-md hover:bg-muted"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Route / expand label (+ legend for the search neighborhood's in/out edge colors) */}
      {(route || focus) && panel === 'none' && (
        <div className="pointer-events-none absolute inset-x-0 bottom-16 z-10 flex flex-wrap items-center justify-center gap-1.5">
          <span className="rounded-full bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
            {route?.label ?? focus?.label}
          </span>
          {route?.legend?.map((l) => (
            <span
              key={l.label}
              className="flex items-center gap-1 rounded-full bg-card/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur"
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}

      {/* Overlays */}
      {panel === 'avatar' && selectedNode && graph && (
        <AvatarSheet
          node={selectedNode}
          centerId={center}
          edges={graph.edges}
          onClose={() => {
            setPanel('none');
            setSelectedId(null);
          }}
          onPay={(node) => {
            setPayPreset(node);
            setPanel('pay');
          }}
          onExpand={scope === 'ego' ? (id) => void handleExpand(id) : undefined}
        />
      )}
      {panel === 'pay' && address && (
        <PaySheet
          source={address}
          preset={payPreset}
          isMiniappHost={isMiniappHost}
          onClose={() => setPanel('none')}
          onRoute={applyRoute}
        />
      )}
      {panel === 'activity' && address && (
        <ActivityPanel source={address} onClose={() => setPanel('none')} onReplay={applyRoute} />
      )}
      {panel === 'color' && (
        <ColorSheet
          center={center}
          colorMode={colorMode}
          selected={selectedGroups}
          maxGroups={GROUP_PALETTE.length}
          onSetMode={handleSetColorMode}
          onToggleGroup={handleToggleGroup}
          onClose={() => setPanel('none')}
        />
      )}
      {panel === 'search' && (
        <SearchSheet onSelect={(addr, name) => void handleSearchSelect(addr, name)} onClose={() => setPanel('none')} />
      )}
    </div>
  );
}

function BrandGlyph({ large = false }: { large?: boolean }) {
  const s = large ? 28 : 18;
  return (
    <span className="relative inline-block" style={{ width: s + s * 0.4, height: s }} aria-hidden>
      <span
        className="absolute rounded-full border-2"
        style={{ left: 0, top: 0, width: s, height: s, borderColor: '#534AB7' }}
      />
      <span
        className="absolute rounded-full border-2"
        style={{ left: s * 0.4, top: 0, width: s, height: s, borderColor: '#1D9E75' }}
      />
    </span>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function Icon({ name }: { name: 'exchange' | 'history' | 'palette' | 'search' }) {
  if (name === 'search') {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    );
  }
  if (name === 'exchange') {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M7 10h14l-4-4" />
        <path d="M17 14H3l4 4" />
      </svg>
    );
  }
  if (name === 'palette') {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
        <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
        <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
        <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.012 17.5 2 12 2z" />
      </svg>
    );
  }
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4M12 7v5l3 2" />
    </svg>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="pointer-events-auto max-w-sm rounded-2xl border bg-card/95 p-6 text-center text-card-foreground shadow-sm">
        {children}
      </div>
    </div>
  );
}
