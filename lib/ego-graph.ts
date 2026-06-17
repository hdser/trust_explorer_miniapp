// Turn Circles RPC responses into a small, renderable graph centered on one avatar.
//
// The web_viewer pulled the *entire* trust graph from a Postgres indexer. Here we
// stay ego-centric: BFS a hop or two out from the connected avatar, which keeps the
// data small enough to fetch live from the public RPC. "Tap to expand" and the
// optional "load full network" toggle grow it on demand.

import {
  getAggregatedTrustRelations,
  getAvatarInfoBatch,
  getProfileByAddressBatch,
  queryTrustPage,
  queryInvitesPage,
  ZERO_ADDRESS,
  type AggTrustRelation,
  type FlowTransfer,
} from './circles-rpc';

/** Circles Hub v2 flow-matrix router — an intermediary in pathfinder output, not a real avatar. */
export const ROUTER_ADDRESS = '0xdc287474114cc0551a81ddc2eb51783fbf34802f';

export type AvatarType = 'human' | 'organization' | 'group' | 'unknown';

export type GraphNode = {
  id: string; // lowercased address
  name?: string;
  image?: string | null;
  type: AvatarType;
  isCenter?: boolean;
};

export type GraphEdge = { source: string; target: string };

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

const norm = (a: string) => a.toLowerCase();

/**
 * Map RPC type strings to our enum. The RPC labels avatars by the event that registered them:
 * v2 → "CrcV2_RegisterHuman" / "_RegisterGroup" / "_RegisterOrganization"; v1 → "CrcV1_Signup"
 * (a human) / "CrcV1_OrganizationSignup". Every registered avatar IS one of these three, so we
 * must recognise the v1 forms too — otherwise v1 humans fall through to 'unknown'.
 */
export function avatarTypeFrom(raw?: string, isHuman?: boolean): AvatarType {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('group')) return 'group';
  if (s.includes('organization')) return 'organization';
  if (s.includes('human') || s.includes('signup') || isHuman) return 'human';
  return 'unknown';
}

/**
 * Annotate nodes (in place) with name + picture (and type, when known). Bounded concurrency so a
 * large ego graph doesn't fire hundreds of simultaneous calls at the public RPC. Never DOWNGRADES
 * a node's type to 'unknown' — types resolved inline from the trust query are kept if a lookup
 * comes back blank.
 */
async function enrich(nodes: Map<string, GraphNode>, concurrency = 6): Promise<void> {
  const addrs = [...nodes.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < addrs.length; i += 50) chunks.push(addrs.slice(i, i + 50));
  let idx = 0;
  const worker = async () => {
    while (idx < chunks.length) {
      const chunk = chunks[idx++];
      const [infos, profiles] = await Promise.all([
        getAvatarInfoBatch(chunk).catch(() => []),
        getProfileByAddressBatch(chunk).catch(() => []),
      ]);
      chunk.forEach((addr, i) => {
        const node = nodes.get(addr);
        if (!node) return;
        const t = avatarTypeFrom(profiles[i]?.type ?? infos[i]?.type, undefined);
        if (t !== 'unknown') node.type = t;
        if (profiles[i]?.name) node.name = profiles[i]!.name;
        if (profiles[i]?.picture) node.image = profiles[i]!.picture;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
}

/**
 * Merge an avatar's aggregated trust relations into a node map + edge list (in place). `center`
 * is the subject; each relation adds the neighbour (typed inline via `objectAvatarType`) and the
 * directed edge(s). Returns the addresses newly added (for targeted enrichment).
 */
function applyAggRelations(
  center: string,
  rels: AggTrustRelation[],
  nodes: Map<string, GraphNode>,
  addEdge: (source: string, target: string) => void,
  maxNodes: number,
): string[] {
  const added: string[] = [];
  for (const r of rels) {
    const other = norm(r.objectAvatar);
    if (other === ZERO_ADDRESS || other === center) continue;
    if (!nodes.has(other) && nodes.size < maxNodes) {
      nodes.set(other, { id: other, type: avatarTypeFrom(r.objectAvatarType) });
      added.push(other);
    }
    if (!nodes.has(other)) continue;
    if (r.relation === 'trusts' || r.relation === 'mutuallyTrusts') addEdge(center, other);
    if (r.relation === 'trustedBy' || r.relation === 'mutuallyTrusts') addEdge(other, center);
  }
  return added;
}

/**
 * Resolve avatar TYPES (only) for an already-built graph, in place. The global graphs
 * ({@link loadFullNetwork}) are returned untyped so the map paints immediately; this fills in
 * human/org/group in the background with bounded concurrency (kind to the public RPC) and
 * calls `onProgress` after each batch so the UI can recolor as types arrive. Cancellable.
 */
export async function resolveTypes(
  nodes: GraphNode[],
  onProgress?: () => void,
  shouldStop?: () => boolean,
  concurrency = 6,
): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const todo = nodes.filter((n) => n.type === 'unknown');
  const chunks: GraphNode[][] = [];
  for (let i = 0; i < todo.length; i += 50) chunks.push(todo.slice(i, i + 50));
  let idx = 0;
  let done = 0;
  // The public RPC throttles a burst of batch calls; a swallowed failure would leave those
  // nodes grey forever. Retry a few times with backoff so enrichment actually completes.
  const fetchTypes = async (chunk: GraphNode[], attempt = 0): Promise<void> => {
    try {
      const infos = await getAvatarInfoBatch(chunk.map((n) => n.id));
      chunk.forEach((node, i) => {
        const t = avatarTypeFrom(infos[i]?.type);
        if (t !== 'unknown') node.type = t;
      });
      // Leftover unknowns (partial/empty batch) get retried as their own smaller pass.
      const missed = chunk.filter((n) => n.type === 'unknown');
      if (missed.length && attempt < 3) {
        await sleep(500 * (attempt + 1));
        await fetchTypes(missed, attempt + 1);
      }
    } catch {
      if (attempt < 3 && !shouldStop?.()) {
        await sleep(500 * (attempt + 1));
        await fetchTypes(chunk, attempt + 1);
      }
    }
  };
  const worker = async () => {
    while (idx < chunks.length) {
      if (shouldStop?.()) return;
      await fetchTypes(chunks[idx++]);
      // Recolor every few batches (not every one) — a recolor rebuilds GPU buffers, so doing it
      // ~once a second keeps the map repainting smoothly without thrashing during enrichment.
      if (++done % 6 === 0) onProgress?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  if (!shouldStop?.()) onProgress?.(); // final repaint with all types in
}

export type BuildEgoOptions = { maxNodes?: number };

/**
 * Build the ego graph around `address`: EVERY avatar it trusts and that trusts it, using the
 * complete `getAggregatedTrustRelations` (not the partial `getTrustRelations`). `maxNodes` bounds
 * extreme hubs; most avatars fall well under it. Deeper exploration is incremental via `expandNode`.
 */
export async function buildEgoGraph(address: string, opts: BuildEgoOptions = {}): Promise<Graph> {
  const { maxNodes = 1500 } = opts;
  const center = norm(address);
  const nodes = new Map<string, GraphNode>([[center, { id: center, type: 'unknown', isCenter: true }]]);
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (source: string, target: string) => {
    const key = `${source}>${target}`;
    if (!seenEdge.has(key)) {
      seenEdge.add(key);
      edges.push({ source, target });
    }
  };

  const rels = await getAggregatedTrustRelations(center);
  applyAggRelations(center, rels, nodes, addEdge, maxNodes);

  await enrich(nodes);
  return { nodes: [...nodes.values()], edges };
}

/** Fetch one avatar's full trust relations and merge them into an existing graph (tap-to-grow). */
export async function expandNode(graph: Graph, address: string, maxNodes = 2500): Promise<Graph> {
  const target = norm(address);
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = [...graph.edges];
  const seenEdge = new Set(edges.map((e) => `${e.source}>${e.target}`));
  const addEdge = (source: string, target_: string) => {
    const key = `${source}>${target_}`;
    if (!seenEdge.has(key)) {
      seenEdge.add(key);
      edges.push({ source, target: target_ });
    }
  };

  const rels = await getAggregatedTrustRelations(target);
  const added = applyAggRelations(target, rels, nodes, addEdge, maxNodes);

  if (added.length) {
    const newOnes = new Map(added.map((a) => [a, nodes.get(a)!]));
    await enrich(newOnes);
  }
  return { nodes: [...nodes.values()], edges };
}

/** Ensure every address in `addresses` exists as a node, enriching the new ones. */
export async function mergeAddresses(graph: Graph, addresses: string[]): Promise<Graph> {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const added = new Map<string, GraphNode>();
  for (const a of addresses) {
    const u = norm(a);
    if (u === ZERO_ADDRESS || u === ROUTER_ADDRESS) continue;
    if (!nodes.has(u)) {
      const node: GraphNode = { id: u, type: 'unknown' };
      nodes.set(u, node);
      added.set(u, node);
    }
  }
  if (added.size) await enrich(added);
  return { nodes: [...nodes.values()], edges: graph.edges };
}

/**
 * A Circles flow is a matrix of many small transfer legs (a payment can fan out through
 * 100+ avatars). Highlighting all of them lights up the whole graph, so instead we extract
 * the shortest source→sink corridor through the flow's directed edges and highlight just
 * that — a clean "you → … → recipient" path. The router contract is spliced out.
 */
export function extractFlowPath(
  transfers: { from: string; to: string; tokenOwner?: string }[],
  source: string,
  sink: string,
): { participants: string[]; edges: GraphEdge[] } {
  const src = norm(source);
  const snk = norm(sink);

  // Self-conversion (Source == Sink) is a cycle, not a path — highlight every avatar the
  // conversion flows through plus their direct legs (router/zero spliced out).
  if (src === snk) {
    const participants = new Set<string>([src]);
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    for (const t of transfers) {
      const f = norm(t.from);
      const to = norm(t.to);
      for (const a of [f, to]) if (a !== ROUTER_ADDRESS && a !== ZERO_ADDRESS) participants.add(a);
      if (f !== ROUTER_ADDRESS && to !== ROUTER_ADDRESS && f !== ZERO_ADDRESS && to !== ZERO_ADDRESS && f !== to) {
        const key = `${f}>${to}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ source: f, target: to });
        }
      }
    }
    return { participants: [...participants], edges };
  }

  // Directed adjacency from the flow legs.
  const adj = new Map<string, Set<string>>();
  for (const t of transfers) {
    const from = norm(t.from);
    const to = norm(t.to);
    if (from === to) continue;
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  }

  // BFS shortest path src → snk.
  const prev = new Map<string, string>();
  const seen = new Set<string>([src]);
  const queue: string[] = [src];
  let found = src === snk;
  while (queue.length && !found) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === snk) {
        found = true;
        break;
      }
      queue.push(next);
    }
  }

  let pathNodes: string[];
  if (found && src !== snk) {
    pathNodes = [snk];
    let c: string | undefined = snk;
    while (c !== undefined && c !== src) {
      c = prev.get(c);
      if (c !== undefined) pathNodes.unshift(c);
    }
  } else {
    pathNodes = [src, snk];
  }

  // Splice out the router / zero address; collapse consecutive duplicates.
  const cleaned = pathNodes.filter(
    (n, i) => (n !== ROUTER_ADDRESS && n !== ZERO_ADDRESS) || i === 0 || i === pathNodes.length - 1,
  );
  const participants = cleaned.filter((n, i) => i === 0 || n !== cleaned[i - 1]);

  const edges: GraphEdge[] = [];
  for (let i = 0; i < participants.length - 1; i++) {
    edges.push({ source: participants[i], target: participants[i + 1] });
  }
  return { participants, edges };
}

export type FlowSummary = { participants: string[]; edges: GraphEdge[]; hops: number };

export function summarizeFlow(transfers: FlowTransfer[], source: string, sink: string): FlowSummary {
  const { participants, edges } = extractFlowPath(transfers, source, sink);
  return { participants, edges, hops: Math.max(participants.length - 1, 0) };
}

/**
 * Page the entire global V2 trust graph via `circles_query`. Heavy — opt-in only.
 * Calls `onProgress` after each page so the UI can show how far it's gotten.
 *
 * Only **v2 avatars** are kept: emitting a CrcV2 trust requires being a registered v2
 * avatar, so every `truster` is a v2 avatar. We keep a trustee only if it is itself a
 * truster — i.e. also a v2 avatar — which drops non-v2 / unregistered trustee addresses.
 */
export async function loadFullNetwork(
  onProgress?: (edgeCount: number) => void,
  maxPages = 60,
): Promise<Graph> {
  const rawEdges: [string, string][] = [];
  const trusters = new Set<string>();
  let after: { blockNumber: number; transactionIndex: number; logIndex: number } | undefined;

  for (let page = 0; page < maxPages; page++) {
    const rows = await queryTrustPage(after);
    if (!rows.length) break;
    for (const row of rows) {
      const trustee = norm(String(row.trustee));
      const truster = norm(String(row.truster));
      if (trustee === ZERO_ADDRESS || truster === ZERO_ADDRESS || trustee === truster) continue;
      trusters.add(truster);
      rawEdges.push([truster, trustee]);
    }
    onProgress?.(rawEdges.length);
    const last = rows[rows.length - 1];
    after = {
      blockNumber: Number(last.blockNumber),
      transactionIndex: Number(last.transactionIndex),
      logIndex: Number(last.logIndex),
    };
    if (rows.length < 1000) break;
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const [truster, trustee] of rawEdges) {
    if (!trusters.has(trustee)) continue; // trustee isn't a v2 avatar (never trusts) — drop it
    if (!nodes.has(truster)) nodes.set(truster, { id: truster, type: 'unknown' });
    if (!nodes.has(trustee)) nodes.set(trustee, { id: trustee, type: 'unknown' });
    const key = `${truster}>${trustee}`;
    if (!seenEdge.has(key)) {
      seenEdge.add(key);
      edges.push({ source: truster, target: trustee });
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * Page the entire global **invitations** graph: `CrcV2.RegisterHuman` events, each an
 * `inviter → invitee` edge. Heavy — opt-in like {@link loadFullNetwork}. Both ends are humans
 * (only registered avatars invite, and the registrant is a human), so we type them 'human' —
 * that colors the map without the cost of enriching thousands of profiles.
 */
export async function loadInvitesNetwork(
  onProgress?: (edgeCount: number) => void,
  maxPages = 60,
): Promise<Graph> {
  const rawEdges: [string, string][] = [];
  let after: { blockNumber: number; transactionIndex: number; logIndex: number } | undefined;

  for (let page = 0; page < maxPages; page++) {
    const rows = await queryInvitesPage(after);
    if (!rows.length) break;
    for (const row of rows) {
      const inviter = norm(String(row.inviter));
      const invitee = norm(String(row.avatar));
      if (inviter === ZERO_ADDRESS || invitee === ZERO_ADDRESS || inviter === invitee) continue;
      rawEdges.push([inviter, invitee]);
    }
    onProgress?.(rawEdges.length);
    const last = rows[rows.length - 1];
    after = {
      blockNumber: Number(last.blockNumber),
      transactionIndex: Number(last.transactionIndex),
      logIndex: Number(last.logIndex),
    };
    if (rows.length < 1000) break;
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const [inviter, invitee] of rawEdges) {
    if (!nodes.has(inviter)) nodes.set(inviter, { id: inviter, type: 'human' });
    if (!nodes.has(invitee)) nodes.set(invitee, { id: invitee, type: 'human' });
    const key = `${inviter}>${invitee}`;
    if (!seenEdge.has(key)) {
      seenEdge.add(key);
      edges.push({ source: inviter, target: invitee });
    }
  }

  return { nodes: [...nodes.values()], edges };
}
