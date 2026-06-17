// Probe the public Circles RPC to confirm method/param/response shapes.
// Run: node scripts/probe-rpc.mjs
const URL = 'https://rpc.aboutcircles.com/';
const A = '0xde374ece6fa50e781e81aac78e811b33d16912c7';

let id = 1;
async function rpc(method, params = []) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  });
  const json = await res.json();
  if (json.error) return { __error: json.error.message ?? json.error };
  return json.result;
}

function show(label, v) {
  const s = JSON.stringify(v);
  console.log(`\n=== ${label} ===`);
  console.log(s.length > 600 ? s.slice(0, 600) + '…' : s);
}

const rel = await rpc('circles_getTrustRelations', [A]);
const neighbors = [...(rel.trusts ?? []), ...(rel.trustedBy ?? [])]
  .map((t) => t.user)
  .filter((u) => u !== '0x0000000000000000000000000000000000000000')
  .slice(0, 3);
console.log('sample neighbors:', neighbors);

show('getProfileByAddressBatch([addrs])', await rpc('circles_getProfileByAddressBatch', [neighbors]));
show('getAvatarInfoBatch([addrs])', await rpc('circles_getAvatarInfoBatch', [neighbors]));
show('getTotalBalance(asTimeCircles)', await rpc('circles_getTotalBalance', [A, true]));

const hist = await rpc('circles_getTransactionHistory', [A, 1]);
const txHash = hist?.results?.[0]?.transactionHash;
console.log('\nfirst tx hash:', txHash);

const q = await rpc('circles_query', [
  {
    Namespace: 'CrcV2',
    Table: 'TransferSingle',
    Columns: [],
    Filter: [{ Type: 'FilterPredicate', FilterType: 'Equals', Column: 'transactionHash', Value: txHash }],
    Order: [{ Column: 'logIndex', SortOrder: 'ASC' }],
    Limit: 1000,
  },
]);
show('query TransferSingle by tx (columns)', q?.Columns ?? q);
console.log('TransferSingle rows:', q?.Rows?.length);
if (q?.Rows?.[0]) console.log('row0:', JSON.stringify(q.Rows[0]));

const tp = await rpc('circles_query', [
  {
    Namespace: 'V_CrcV2',
    Table: 'TrustRelations',
    Columns: [],
    Filter: [],
    Order: [{ Column: 'blockNumber', SortOrder: 'ASC' }],
    Limit: 2,
  },
]);
show('query V_CrcV2.TrustRelations (columns)', tp?.Columns ?? tp);
if (tp?.Rows?.[0]) console.log('row0:', JSON.stringify(tp.Rows[0]));
