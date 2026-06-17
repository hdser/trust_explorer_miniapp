'use client';

// GPU trust-graph renderer on the proven cosmos.gl build (window.cosmosgl, loaded in
// app/layout.tsx). Colors are 0–1 RGBA (the build's convention).
//
// The force simulation runs until it CONVERGES (cosmos cools it via simulationDecay and
// fires onSimulationEnd) — no fixed-time pause — so a ~220-leaf star ego graph actually
// spreads into a clean radial map. Adding nodes (expand / route) preserves existing
// positions, seeds the new nodes near their neighbors, and re-runs the sim with low
// energy so they fan out and integrate rather than freezing in a clump.

import { useEffect, useRef } from 'react';
import type { Graph as GraphData, GraphEdge } from '@/lib/ego-graph';
import { TYPE_HEX, CENTER_HEX, PATH_HEX, NEW_HEX, hexToRgb } from '@/lib/avatar-style';

type Props = {
  graph: GraphData;
  selectedId?: string | null;
  routeNodes?: Set<string>;
  routeEdges?: GraphEdge[];
  // Expand emphasis: the just-tapped avatar (`focusNode`) and the avatars its expansion
  // newly pulled onto the map (`focusNodes`). Rendered as a growth highlight — bigger +
  // accent-colored, with the rest of the map left fully visible (NOT dimmed like a route).
  focusNode?: string | null;
  focusNodes?: Set<string>;
  // Bumped by the parent whenever the graph should be laid out from scratch (full-network
  // toggle, network reset, avatar change) rather than merged into the existing layout.
  layoutNonce?: number;
  // Bumped when node types/colors change (e.g. background type enrichment) — recolor only,
  // no relayout.
  colorVersion?: number;
  // When set, color nodes by group membership instead of avatar type: each group has a color,
  // members get it, everyone else dims to grey. null → color by type (the default).
  groupColoring?: { groups: { color: string; members: Set<string> }[] } | null;
  // Cached node positions for this graph (by id). When most nodes have one, the layout is
  // RESTORED instantly instead of re-simulated — so switching back to a scope is immediate.
  savedPositions?: Map<string, [number, number]>;
  // Fired after the layout settles so the parent can cache positions per scope.
  onPositionsSnapshot?: (positions: Map<string, [number, number]>) => void;
  onSelect?: (id: string | null) => void;
  onHover?: (id: string | null) => void;
};

function rgb01(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}
const ROUTE_RGB = rgb01(PATH_HEX);
const CENTER_RGB = rgb01(CENTER_HEX);
const NEW_RGB = rgb01(NEW_HEX);
const SPACE_CENTER = 4096;

// Force presets, applied per graph size on a from-scratch layout. The ego graph is a ~220-leaf
// star that wants weak centering + long links to bloom into an airy radial cloud. The global
// network is thousands of nodes: any centroid pull (simulationCenter) collapses it into a dense
// ball, so we drop it to 0 and lean on repulsion + gravity to fill the space (the values proven
// in the web_viewer's cosmos adapter for the full Circles graph).
const FORCES_EGO = {
  simulationRepulsion: 2.0,
  simulationRepulsionTheta: 1.15,
  simulationGravity: 0.1,
  simulationCenter: 0.1,
  simulationLinkSpring: 0.4,
  simulationLinkDistance: 50,
  simulationLinkDistRandomVariationRange: [1, 3],
  simulationFriction: 0.9,
  simulationDecay: 6000,
};
const NETWORK_THRESHOLD = 800; // above this, switch to the spread-out network forces

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

// Network forces scaled to node count. `simulationCenter` stays 0 (a centroid pull collapses
// a big graph into a ball). As the graph grows, gravity must DROP and repulsion ease, or the
// dense centre goes coincident and the whole thing runs away into a dot. With these gentle
// values the layout doesn't collapse; it expands to a good spread (~3k span at ~5k nodes,
// ~7k at ~23k nodes) and then drifts slowly outward — so we hard-stop it at the peak (see the
// short network run length below) rather than letting it creep to the space boundary.
function forcesNetwork(n: number) {
  return {
    simulationRepulsion: clamp(1.4, 2.2, 9000 / n),
    simulationRepulsionTheta: 1.5,
    // Gravity must stay low at scale: above ~0.025 a 20k-node graph forms a coincident core
    // and runs away to a dot within seconds. This keeps even the largest graph spreading.
    simulationGravity: clamp(0.018, 0.14, 430 / n),
    simulationCenter: 0,
    simulationLinkSpring: clamp(0.1, 0.3, 1200 / n),
    simulationLinkDistance: clamp(20, 30, n / 900),
    simulationLinkDistRandomVariationRange: [1, 1.5],
    simulationFriction: 0.85,
    simulationDecay: 30000, // stay energized through the (hard-stopped) run; don't cool early
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cosmosGl(): any {
  return (window as unknown as { cosmosgl?: { Graph: unknown } }).cosmosgl;
}

export function TrustGraph({ graph, selectedId, routeNodes, routeEdges, focusNode, focusNodes, layoutNonce = 0, colorVersion = 0, groupColoring, savedPositions, onPositionsSnapshot, onSelect, onHover }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const idsRef = useRef<string[]>([]);
  const posByIdRef = useRef<Map<string, [number, number]>>(new Map());
  const firstRef = useRef(true);
  const fittedRef = useRef(false);
  const nonceRef = useRef(layoutNonce);
  const timersRef = useRef<number[]>([]);
  const monitorRef = useRef<number | null>(null);
  const cb = useRef({ onSelect, onHover, onPositionsSnapshot });
  cb.current = { onSelect, onHover, onPositionsSnapshot };

  useEffect(() => {
    let cancelled = false;
    let raf = 0;

    const tryInit = () => {
      if (cancelled) return;
      const gl = cosmosGl();
      if (!gl?.Graph || !containerRef.current) {
        raf = window.requestAnimationFrame(tryInit);
        return;
      }
      graphRef.current = new gl.Graph(containerRef.current, {
        spaceSize: 8192,
        backgroundColor: [0, 0, 0, 0],
        // Star-tuned forces. A 1-hop ego graph is a pure star, which at equilibrium
        // collapses into a tight dandelion — so we VARY link distances heavily
        // (linkDistRandomVariationRange) to scatter leaves across many radii, with strong
        // repulsion + weak centering, giving an airy filled radial cloud. High decay lets
        // the sim run long enough to fully spread before cosmos stops it.
        simulationFriction: 0.9,
        simulationGravity: 0.1,
        simulationCenter: 0.1,
        simulationRepulsion: 2.0,
        simulationRepulsionTheta: 1.15,
        simulationLinkSpring: 0.4,
        simulationLinkDistance: 50,
        simulationLinkDistRandomVariationRange: [1, 3],
        simulationDecay: 6000,
        pointDefaultColor: [...rgb01(TYPE_HEX.human), 1],
        pointDefaultSize: 4,
        linkDefaultColor: [0.79, 0.78, 0.75, 0.5],
        linkDefaultWidth: 1,
        curvedLinks: true,
        linkArrows: false,
        scalePointsOnZoom: false,
        renderHoveredPointRing: true,
        hoveredPointRingColor: CENTER_HEX,
        fitViewOnInit: false,
        rescalePositions: false,
        enableDrag: false,
        enableZoom: true,
        // Keep the simulation running while the camera animates (fitView). Otherwise each
        // fitView pauses then resumes the sim, which reads as "runs, stops, runs, stops".
        enableSimulationDuringZoom: true,
        onClick: (index?: number) => cb.current.onSelect?.(index === undefined ? null : idsRef.current[index] ?? null),
        onMouseMove: (index?: number) => cb.current.onHover?.(index === undefined ? null : idsRef.current[index] ?? null),
        // The settle monitor (below) owns stopping + framing; here we just keep positions fresh.
        onSimulationEnd: () => reportPositions(),
      });
      renderGraph();
    };
    tryInit();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      timersRef.current.forEach((t) => window.clearTimeout(t));
      timersRef.current = [];
      if (monitorRef.current !== null) {
        window.clearInterval(monitorRef.current);
        monitorRef.current = null;
      }
      try {
        graphRef.current?.destroy?.();
      } catch {
        /* noop */
      }
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    renderGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    applyStyles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, routeNodes, routeEdges, focusNode, focusNodes, colorVersion]);

  // Trust edges plus any route (flow) edges not already present — drawn as overlay links.
  function combinedEdges(): GraphEdge[] {
    const trust = graph.edges;
    const route = routeEdges ?? [];
    if (!route.length) return trust;
    const seen = new Set(trust.flatMap((e) => [`${e.source}>${e.target}`, `${e.target}>${e.source}`]));
    return [...trust, ...route.filter((e) => !seen.has(`${e.source}>${e.target}`))];
  }

  function nodeColorsAndSizes() {
    const { nodes } = graph;
    const n = nodes.length;
    const colors = new Float32Array(n * 4);
    const sizes = new Float32Array(n);
    const hasRoute = !!routeNodes && routeNodes.size > 0;
    const hasFocus = !hasRoute && !!focusNode;
    const hasGroup = !hasRoute && !hasFocus && !!groupColoring && groupColoring.groups.length > 0;
    nodes.forEach((node, i) => {
      let rgb: [number, number, number];
      let alpha = 1;
      let size: number;
      if (hasRoute) {
        // Payment/convert route: coral corridor, everything else dimmed back.
        const onRoute = routeNodes?.has(node.id);
        rgb = onRoute ? ROUTE_RGB : node.isCenter ? CENTER_RGB : rgb01(TYPE_HEX[node.type] ?? TYPE_HEX.unknown);
        alpha = onRoute ? 1 : 0.1;
        size = node.isCenter ? 18 : onRoute ? 13 : node.id === selectedId ? 13 : 5;
      } else if (hasFocus) {
        // Expand: the tapped avatar and its freshly-pulled trusts pop; the rest of the map
        // stays fully visible so you see the network *grow*, not a lone path.
        const isFocus = node.id === focusNode;
        const isNew = focusNodes?.has(node.id);
        rgb = isFocus || isNew ? NEW_RGB : node.isCenter ? CENTER_RGB : rgb01(TYPE_HEX[node.type] ?? TYPE_HEX.unknown);
        size = isFocus ? 16 : isNew ? 9 : node.isCenter ? 18 : 5;
      } else if (hasGroup) {
        // Color by group membership: members take their group's color and pop; non-members
        // dim to faint grey so the selected groups stand out. You stay the purple center.
        const gi = groupColoring!.groups.findIndex((g) => g.members.has(node.id));
        if (node.isCenter) {
          rgb = CENTER_RGB;
          size = 18;
        } else if (gi >= 0) {
          rgb = rgb01(groupColoring!.groups[gi].color);
          size = node.id === selectedId ? 13 : 7;
        } else {
          rgb = rgb01(TYPE_HEX.unknown);
          alpha = 0.12;
          size = 5;
        }
      } else {
        rgb = node.isCenter ? CENTER_RGB : rgb01(TYPE_HEX[node.type] ?? TYPE_HEX.unknown);
        size = node.isCenter ? 18 : node.id === selectedId ? 13 : 5;
      }
      colors[i * 4] = rgb[0];
      colors[i * 4 + 1] = rgb[1];
      colors[i * 4 + 2] = rgb[2];
      colors[i * 4 + 3] = alpha;
      sizes[i] = size;
    });
    return { colors, sizes };
  }

  function linkStyles(edges: GraphEdge[]) {
    const m = edges.length;
    const colors = new Float32Array(m * 4);
    const widths = new Float32Array(m);
    const arrows: boolean[] = new Array(m).fill(false);
    const routeSet = new Set((routeEdges ?? []).flatMap((e) => [`${e.source}>${e.target}`, `${e.target}>${e.source}`]));
    const hasRoute = !!routeNodes && routeNodes.size > 0;
    const hasFocus = !hasRoute && !!focusNode;
    const setEdge = (i: number, rgb: [number, number, number], a: number, w: number, arrow = false) => {
      colors[i * 4] = rgb[0];
      colors[i * 4 + 1] = rgb[1];
      colors[i * 4 + 2] = rgb[2];
      colors[i * 4 + 3] = a;
      widths[i] = w;
      arrows[i] = arrow;
    };
    const GREY: [number, number, number] = [0.79, 0.78, 0.75];
    edges.forEach((e, i) => {
      if (hasRoute) {
        if (routeSet.has(`${e.source}>${e.target}`)) setEdge(i, ROUTE_RGB, 1, 3.5, true);
        else setEdge(i, GREY, 0.06, 1);
      } else if (hasFocus) {
        // Only the edges to freshly-pulled avatars light up — expand reads purely as the
        // network *growing*, not as a path lit through avatars already on the map.
        const touchesNew = !!focusNodes && (focusNodes.has(e.source) || focusNodes.has(e.target));
        if (touchesNew) setEdge(i, NEW_RGB, 0.95, 2.2, true);
        else setEdge(i, GREY, 0.4, 1);
      } else {
        setEdge(i, GREY, 0.4, 1);
      }
    });
    return { colors, widths, arrows };
  }

  function setLinksAndStyles(g: unknown, index: Map<string, number>) {
    const edges = combinedEdges();
    const links = new Float32Array(edges.length * 2);
    edges.forEach((e, i) => {
      links[i * 2] = index.get(e.source) ?? 0;
      links[i * 2 + 1] = index.get(e.target) ?? 0;
    });
    const ls = linkStyles(edges);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gg = g as any;
    gg.setLinks(links);
    gg.setLinkColors(ls.colors);
    gg.setLinkWidths(ls.widths);
    gg.setLinkArrows?.(ls.arrows);
  }

  // Recolor / re-route without moving nodes.
  function applyStyles() {
    const g = graphRef.current;
    if (!g || graph.nodes.length === 0) return;
    const index = new Map<string, number>();
    graph.nodes.forEach((n, i) => index.set(n.id, i));
    const { colors, sizes } = nodeColorsAndSizes();
    g.setPointColors(colors);
    g.setPointSizes(sizes);
    setLinksAndStyles(g, index);
    g.render();
  }

  function runSim(alpha: number) {
    const g = graphRef.current;
    if (typeof g.start === 'function') g.start(alpha);
    else g.render(alpha);
  }

  function fitView(ms: number, pad: number) {
    try {
      graphRef.current?.fitView(ms, pad);
    } catch {
      /* noop */
    }
  }

  // Run the simulation CONTINUOUSLY and stop it exactly once, when the layout has settled —
  // i.e. the average per-node movement between polls drops below ~1.5px on screen ("changes
  // are small"). A min time avoids stopping during an early lull; a max time is a safety cap
  // for graphs that keep drifting. No periodic re-fit (that was the stop/start jitter); we
  // frame once when it settles. Any previous monitor is cleared before a new run starts.
  function settleMonitor(relayout: boolean, n: number) {
    if (monitorRef.current !== null) {
      window.clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
    const POLL = 400;
    const minMs = relayout ? 2400 : 1200;
    const maxMs = relayout ? (n > NETWORK_THRESHOLD ? 16000 : 11000) : 5000;
    let last = (graphRef.current.getPointPositions() as number[]).slice();
    let elapsed = 0;
    let stable = 0;
    const finish = () => {
      if (monitorRef.current !== null) {
        window.clearInterval(monitorRef.current);
        monitorRef.current = null;
      }
      try {
        graphRef.current?.pause?.();
      } catch {
        /* noop */
      }
      fittedRef.current = true;
      fitView(650, 0.15);
      reportPositions();
    };
    monitorRef.current = window.setInterval(() => {
      const g = graphRef.current;
      if (!g) {
        if (monitorRef.current !== null) window.clearInterval(monitorRef.current);
        monitorRef.current = null;
        return;
      }
      elapsed += POLL;
      const cur = g.getPointPositions() as number[];
      const m = Math.min(idsRef.current.length, Math.floor(cur.length / 2));
      let move = 0;
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      for (let i = 0; i < m; i++) {
        const x = cur[i * 2], y = cur[i * 2 + 1];
        const dx = x - last[i * 2], dy = y - last[i * 2 + 1];
        move += Math.sqrt(dx * dx + dy * dy);
        if (x < mnx) mnx = x;
        if (x > mxx) mxx = x;
        if (y < mny) mny = y;
        if (y > mxy) mxy = y;
      }
      move = m ? move / m : 0;
      const span = Math.max(mxx - mnx, mxy - mny) || 1;
      last = cur.slice();
      // "Small change" ≈ avg node moved < ~1.5px on screen (span maps to ~700px on fit).
      const eps = Math.max(1.5, span / 450);
      if (elapsed >= minMs && move < eps) stable++;
      else stable = 0;
      if (stable >= 2 || elapsed >= maxMs) finish();
    }, POLL);
  }

  // Read the current positions, keep them for our own seeding, and hand a copy to the parent
  // so it can cache the layout per scope (instant restore when switching back).
  function reportPositions() {
    const g = graphRef.current;
    if (!g) return;
    const cur: number[] = g.getPointPositions();
    const map = new Map<string, [number, number]>();
    idsRef.current.forEach((id, i) => {
      const p: [number, number] = [cur[i * 2], cur[i * 2 + 1]];
      posByIdRef.current.set(id, p);
      map.set(id, p);
    });
    if (map.size) cb.current.onPositionsSnapshot?.(map);
  }

  function renderGraph() {
    const g = graphRef.current;
    if (!g || graph.nodes.length === 0) return;
    const { nodes } = graph;
    const isFirst = firstRef.current;
    // A relayout (first paint, full-network toggle, reset, avatar change) lays the whole graph
    // out from scratch; otherwise we merge new nodes into the settled layout (expand / route).
    const relayout = isFirst || layoutNonce !== nonceRef.current;
    nonceRef.current = layoutNonce;

    // Capture current positions of existing nodes before rebuilding.
    if (!isFirst && idsRef.current.length) {
      const cur: number[] = g.getPointPositions();
      idsRef.current.forEach((id, i) => posByIdRef.current.set(id, [cur[i * 2], cur[i * 2 + 1]]));
    }

    idsRef.current = nodes.map((n) => n.id);
    const index = new Map<string, number>();
    nodes.forEach((n, i) => index.set(n.id, i));

    // Adjacency over trust + route edges, to seed new nodes near their neighbors
    // (expand → near the tapped node; route hops → near you / the recipient).
    const adj = new Map<string, string[]>();
    for (const e of combinedEdges()) {
      (adj.get(e.source) ?? adj.set(e.source, []).get(e.source))!.push(e.target);
      (adj.get(e.target) ?? adj.set(e.target, []).get(e.target))!.push(e.source);
    }

    // If the parent handed us a cached layout for (almost) all of these nodes, we RESTORE it
    // verbatim — no re-simulation — so switching back to a scope is instant.
    const restoreHits = relayout && savedPositions
      ? nodes.reduce((c, n) => c + (savedPositions.has(n.id) ? 1 : 0), 0)
      : 0;
    const restore = relayout && nodes.length > 0 && restoreHits / nodes.length >= 0.8;

    // Initial scatter radius for nodes with no prior position — scaled to graph size so a
    // multi-thousand-node full network starts spread out (not a tight clump the sim must blow
    // apart), while the ~220-node ego graph keeps its compact start.
    const spread = Math.min(6500, Math.max(1200, Math.sqrt(nodes.length) * 90));
    const positions = new Float32Array(nodes.length * 2);
    nodes.forEach((node, i) => {
      const known = restore
        ? savedPositions!.get(node.id)
        : relayout
          ? undefined
          : posByIdRef.current.get(node.id);
      if (known) {
        positions[i * 2] = known[0];
        positions[i * 2 + 1] = known[1];
        return;
      }
      const placed = relayout
        ? []
        : ((adj.get(node.id) ?? [])
            .map((n) => posByIdRef.current.get(n))
            .filter(Boolean) as [number, number][]);
      if (placed.length) {
        const ax = placed.reduce((s, p) => s + p[0], 0) / placed.length;
        const ay = placed.reduce((s, p) => s + p[1], 0) / placed.length;
        positions[i * 2] = ax + (Math.random() - 0.5) * 300;
        positions[i * 2 + 1] = ay + (Math.random() - 0.5) * 300;
      } else {
        positions[i * 2] = SPACE_CENTER + (Math.random() - 0.5) * spread;
        positions[i * 2 + 1] = SPACE_CENTER + (Math.random() - 0.5) * spread;
      }
    });

    g.setPointPositions(positions, true); // dontRescale — keep our coordinates
    setLinksAndStyles(g, index);
    const { colors, sizes } = nodeColorsAndSizes();
    g.setPointColors(colors);
    g.setPointSizes(sizes);
    // Flush the new buffers to a frame BEFORE starting the sim. When the point count grows a
    // lot (e.g. ego→23k network), starting immediately can read the freshly-added points as
    // coincident at the origin, which makes the whole layout run away into a dot.
    try { g.render(); } catch { /* noop */ }

    // Clear any timers/monitor from a previous render so only one run is ever live.
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
    if (monitorRef.current !== null) {
      window.clearInterval(monitorRef.current);
      monitorRef.current = null;
    }

    if (restore) {
      // Cached layout: don't simulate at all — just frame it. Instant, and no risk of the
      // forces re-collapsing an already-good layout.
      firstRef.current = false;
      fittedRef.current = true;
      timersRef.current.push(window.setTimeout(() => fitView(450, 0.12), 16));
      return;
    }

    firstRef.current = false;
    if (relayout) {
      // Retune the forces to the graph size before energizing (small star vs huge network).
      try {
        g.setConfig?.(nodes.length > NETWORK_THRESHOLD ? forcesNetwork(nodes.length) : FORCES_EGO);
      } catch {
        /* noop */
      }
    }
    runSim(relayout ? 1 : 0.5);
    // Frame the start once, then let it run uninterrupted until the movement settles. The
    // monitor stops + frames exactly once — no mid-run re-fits, no premature stop/restart.
    fitView(650, relayout ? 0.18 : 0.2);
    settleMonitor(relayout, nodes.length);
  }

  return <div ref={containerRef} className="absolute inset-0" />;
}
