// Thin JSON-RPC client for the public Circles RPC (Gnosis Chain).
//
// The whole point of this mini-app: no private indexer, no Postgres, no backend.
// Every read is a keyless JSON-RPC POST to the public endpoint that `new Sdk()`
// also defaults to. We hit it directly with fetch() so the data layer stays
// dependency-light and the method/param shapes are explicit.
//
// Shapes here were verified against the live endpoint before wiring (see
// scripts/probe-rpc.mjs and AGENTS.md "probe new methods against the live RPC").

export const CIRCLES_RPC_URL = 'https://rpc.aboutcircles.com/';

export type Address = string;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

let nextId = 1;

/** One JSON-RPC 2.0 call. Throws on transport or RPC error. */
export async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(CIRCLES_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message ?? 'unknown error'}`);
  return json.result as T;
}

// ── Trust graph ────────────────────────────────────────────────────────────

export type TrustEdge = { user: Address; limit: number };
export type TrustRelations = { user: Address; trusts: TrustEdge[]; trustedBy: TrustEdge[] };

/** Who this avatar trusts (`trusts`) and who trusts it (`trustedBy`). */
export function getTrustRelations(address: Address): Promise<TrustRelations> {
  return rpc<TrustRelations>('circles_getTrustRelations', [address]);
}

/**
 * The COMPLETE current trust set for an avatar — `getTrustRelations` returns only a partial
 * subset (verified: ~341 vs ~1013 for a hub avatar). Each row is from the subject's view:
 * `relation` is `trusts` (subject→object), `trustedBy` (object→subject), or `mutuallyTrusts`
 * (both), and `objectAvatarType` gives the neighbour's type inline (no extra lookup needed).
 */
export type AggTrustRelation = {
  subjectAvatar: Address;
  objectAvatar: Address;
  relation: 'trusts' | 'trustedBy' | 'mutuallyTrusts';
  objectAvatarType?: string;
  timestamp?: number;
  expiryTime?: number;
};

export function getAggregatedTrustRelations(address: Address): Promise<AggTrustRelation[]> {
  return rpc<AggTrustRelation[]>('circles_getAggregatedTrustRelations', [address]);
}

// ── Profiles ─────────────────────────────────────────────────────────────--

export type Profile = {
  address: Address;
  name?: string;
  description?: string;
  imageUrl?: string | null;
  previewImageUrl?: string | null;
  location?: string;
};

export function getProfileByAddress(address: Address): Promise<Profile | null> {
  return rpc<Profile | null>('circles_getProfileByAddress', [address]);
}

// The batch endpoint returns a different (richer) shape than the single one:
// it includes `type` ('human' | 'group' | 'organization') and a `picture` data URL.
export type ProfileBatchEntry = {
  address: Address;
  name?: string;
  type?: string;
  picture?: string | null;
  cidV0?: string;
};

/** Batch profile lookup (name + type + picture in one call). One entry per input address. */
export function getProfileByAddressBatch(addresses: Address[]): Promise<(ProfileBatchEntry | null)[]> {
  return rpc<(ProfileBatchEntry | null)[]>('circles_getProfileByAddressBatch', [addresses]);
}

export type SearchProfile = { address: Address; name: string; cid?: string; avatarType?: string };

/** Directory search by name (or address fragment) — used to pay people you don't trust yet. */
export function searchProfiles(query: string): Promise<SearchProfile[]> {
  return rpc<SearchProfile[]>('circles_searchProfiles', [query]);
}

// ── Avatar info (for type: human / organization / group) ────────────────────

export type AvatarInfo = { avatar: Address; type?: string; tokenId?: string; cidV0?: string };

export function getAvatarInfoBatch(addresses: Address[]): Promise<(AvatarInfo | null)[]> {
  return rpc<(AvatarInfo | null)[]>('circles_getAvatarInfoBatch', [addresses]);
}

// ── Balances (token picker) ──────────────────────────────────────────────--

export type TokenBalance = {
  tokenAddress: Address;
  tokenId: string;
  tokenOwner: Address;
  tokenType: string;
  version: number;
  attoCircles: string;
  circles: number;
  staticCircles: number;
  crc: number;
  isErc20: boolean;
  isErc1155: boolean;
  isWrapped: boolean;
  isInflationary: boolean;
  isGroup: boolean;
};

export function getTokenBalances(address: Address): Promise<TokenBalance[]> {
  return rpc<TokenBalance[]>('circles_getTokenBalances', [address]);
}

export function getTotalBalance(address: Address): Promise<string> {
  return rpc<string>('circles_getTotalBalance', [address, true]);
}

// ── Groups (color-by-group) ──────────────────────────────────────────────---

export type GroupInfo = { group: Address; name?: string; symbol?: string };
type GroupMembershipRow = { group: Address; member: Address; expiryTime?: number };

/** List Circles groups (newest first) with names + symbols — populates the group picker. */
export async function findGroups(limit = 200): Promise<GroupInfo[]> {
  const r = await rpc<{ results: GroupInfo[] }>('circles_findGroups', [limit]);
  return r.results ?? [];
}

/** Member addresses of a group (lowercased, capped to bound very large groups). */
export async function getGroupMembers(group: Address, limit = 3000): Promise<Address[]> {
  const r = await rpc<{ results: GroupMembershipRow[] }>('circles_getGroupMembers', [group, limit]);
  return (r.results ?? []).map((m) => m.member.toLowerCase());
}

/** Group addresses an avatar belongs to (lowercased) — to pre-seed the picker with your groups. */
export async function getGroupMemberships(avatar: Address, limit = 50): Promise<Address[]> {
  const r = await rpc<{ results: GroupMembershipRow[] }>('circles_getGroupMemberships', [avatar, limit]);
  return (r.results ?? []).map((m) => m.group.toLowerCase());
}

// ── Transaction history (Activity) ──────────────────────────────────────────

export type TransferRow = {
  blockNumber: number;
  timestamp: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
  version: number;
  from: Address;
  to: Address;
  value: string;
  circles: string;
  attoCircles: string;
  crc: string;
};

export async function getTransactionHistory(address: Address, limit = 25): Promise<TransferRow[]> {
  const r = await rpc<{ results: TransferRow[] }>('circles_getTransactionHistory', [address, limit]);
  return r.results ?? [];
}

// ── Transfer memo (a public text message carried with a transfer) ───────────-
//
// Circles encodes a message into the operateFlowMatrix `Stream.data` field with the envelope
// [version 0x01][type 0x0001][length 2-byte BE][utf-8 payload]. The indexer/transaction-history
// methods do NOT expose it, so we read it back from the raw tx input (eth_getTransactionByHash).
// We own both the encoder and the decoder, so they only have to agree with each other.

/** Encode a UTF-8 memo into the transfer-data envelope. Pass the result as the builder's `txData`. */
export function encodeMemo(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const len = Math.min(payload.length, 0xffff);
  const out = new Uint8Array(5 + len);
  out[0] = 0x01; // version
  out[1] = 0x00;
  out[2] = 0x01; // type 0x0001 = UTF-8 text
  out[3] = (len >> 8) & 0xff; // length, big-endian
  out[4] = len & 0xff;
  out.set(payload.subarray(0, len), 5);
  return out;
}

/** Raw transaction input (the Circles RPC also serves generic `eth_` methods). */
export async function getTxInput(hash: string): Promise<string | null> {
  const tx = await rpc<{ input?: string } | null>('eth_getTransactionByHash', [hash]);
  return tx?.input ?? null;
}

/**
 * Find a memo in a transaction's calldata. The envelope sits inside the ABI-encoded `Stream.data`
 * at no fixed offset, so we scan for the `01 0001 <len:2B>` header and validate the payload as
 * strict UTF-8 — which rejects the occasional coincidental header in unrelated calldata.
 */
export function extractMemoFromInput(input: string | null): string | null {
  if (!input) return null;
  const hex = input.startsWith('0x') ? input.slice(2) : input;
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2) !== '01') continue; // version
    if (hex.slice(i + 2, i + 6) !== '0001') continue; // type 0x0001
    const len = parseInt(hex.slice(i + 6, i + 10), 16); // 2-byte length
    if (len === 0 || len > 1024) continue;
    const start = i + 10;
    const end = start + len * 2;
    if (end > hex.length) continue;
    try {
      const bytes = new Uint8Array(len);
      for (let j = 0; j < len; j++) bytes[j] = parseInt(hex.slice(start + j * 2, start + j * 2 + 2), 16);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.trim()) return text;
    } catch {
      /* not a valid memo at this offset — keep scanning */
    }
  }
  return null;
}

// ── Pathfinder (predicted payment route) ─────────────────────────────────---

export type FlowRequest = {
  Source: Address;
  Sink: Address;
  TargetFlow: string;
  FromTokens?: Address[];
  ToTokens?: Address[];
  // WithWrap lets the route use wrapped tokens; MaxTransfers caps the matrix size.
  // Both are REQUIRED for self-conversion (Source==Sink) to return a real flow.
  WithWrap?: boolean;
  MaxTransfers?: number;
};

export type FlowTransfer = { from: Address; to: Address; tokenOwner: Address; value: string };
export type MaxFlowResponse = { maxFlow: string; transfers: FlowTransfer[] };

export function findPath(req: FlowRequest): Promise<MaxFlowResponse> {
  return rpc<MaxFlowResponse>('circlesV2_findPath', [req]);
}

// ── Generic query (full network + realized flow replay) ─────────────────────

export type QueryFilter = {
  Type: 'FilterPredicate' | 'Conjunction';
  FilterType?: string;
  Column?: string;
  Value?: unknown;
};
export type QueryOrder = { Column: string; SortOrder: 'ASC' | 'DESC' };
export type QueryParams = {
  Namespace: string;
  Table: string;
  Columns?: string[];
  Filter?: QueryFilter[];
  Order?: QueryOrder[];
  Limit?: number;
};

/** Run a `circles_query` and return rows as objects keyed by the returned columns. */
export async function circlesQuery(params: QueryParams): Promise<Record<string, unknown>[]> {
  // Input keys are PascalCase but the live endpoint returns lowercase `columns`/`rows`.
  const result = await rpc<{
    columns?: string[];
    rows?: unknown[][];
    Columns?: string[];
    Rows?: unknown[][];
  }>('circles_query', [{ Columns: [], Filter: [], Order: [], ...params }]);
  const cols = result.columns ?? result.Columns ?? [];
  const rows = result.rows ?? result.Rows ?? [];
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  });
}

/**
 * A CrcV2 ERC-1155 token id is a uint256 whose low 20 bytes are the issuer's avatar
 * address. (Pattern from koeppelmann/circles-explorer.)
 */
export function tokenIdToAddress(id: string): string {
  try {
    const hex = BigInt(id).toString(16).padStart(40, '0');
    return `0x${hex.slice(-40).toLowerCase()}`;
  } catch {
    return ZERO_ADDRESS;
  }
}

/** All `TransferSingle` legs of one transaction — used to replay how CRC actually flowed. */
export function getTransfersByTx(txHash: string): Promise<Record<string, unknown>[]> {
  return circlesQuery({
    Namespace: 'CrcV2',
    Table: 'TransferSingle',
    Filter: [{ Type: 'FilterPredicate', FilterType: 'Equals', Column: 'transactionHash', Value: txHash }],
    Order: [{ Column: 'logIndex', SortOrder: 'ASC' }],
    Limit: 1000,
  });
}

/** One page (1000 rows) of the global trust graph, ordered for stable pagination. */
export function queryTrustPage(after?: { blockNumber: number; transactionIndex: number; logIndex: number }) {
  const filter: QueryFilter[] = [];
  if (after) {
    filter.push({
      Type: 'FilterPredicate',
      FilterType: 'GreaterThan',
      Column: 'blockNumber',
      Value: after.blockNumber,
    });
  }
  return circlesQuery({
    Namespace: 'V_CrcV2',
    Table: 'TrustRelations',
    Filter: filter,
    Order: [
      { Column: 'blockNumber', SortOrder: 'ASC' },
      { Column: 'transactionIndex', SortOrder: 'ASC' },
      { Column: 'logIndex', SortOrder: 'ASC' },
    ],
    Limit: 1000,
  });
}

/**
 * One page (1000 rows) of the global invitations graph. Each `CrcV2.RegisterHuman` event is an
 * `inviter → avatar` edge (the existing avatar who let a new human register). Same pagination.
 */
export function queryInvitesPage(after?: { blockNumber: number; transactionIndex: number; logIndex: number }) {
  const filter: QueryFilter[] = [];
  if (after) {
    filter.push({
      Type: 'FilterPredicate',
      FilterType: 'GreaterThan',
      Column: 'blockNumber',
      Value: after.blockNumber,
    });
  }
  return circlesQuery({
    Namespace: 'CrcV2',
    Table: 'RegisterHuman',
    Filter: filter,
    Order: [
      { Column: 'blockNumber', SortOrder: 'ASC' },
      { Column: 'transactionIndex', SortOrder: 'ASC' },
      { Column: 'logIndex', SortOrder: 'ASC' },
    ],
    Limit: 1000,
  });
}
