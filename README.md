# monogun

A monolithic, from-scratch replacement for the GUN ecosystem — not a
wrapper around the `gun` npm package. One codebase covering the same
ground as GUN core + SEA + RAD + DAM/AXE, **plus** a hierarchical
deterministic keychain (Mathias Buus's [keypear](https://github.com/holepunchto/keypear)
scheme) used as the primary identity and addressing system, and a
GraphQL/SQL-shaped query layer on top.

Familiar to **SQLite and GraphQL users**: the API uses standard CRUD
operations (`insert`, `update`, `delete`, `select`), queries support
WHERE-like `filter`, ORDER BY via `sort`, and LIMIT/OFFSET pagination.

Two runtime dependencies: `ws` (WebSockets in Node — browsers have it
natively) and `sodium-universal` (real, audited Ed25519/tweak
primitives — native bindings in Node, WASM/JS in the browser).

## Layers

| Layer | File | What it is |
|---|---|---|
| Graph engine | `src/graph.js` | HAM last-write-wins CRDT (kept — good fit) |
| **Identity/addressing** | `src/keychain.js` | keypear-style deterministic Ed25519 derivation |
| Crypto | `src/crypto.js` | Web Crypto API — passphrase wrapping, encrypt-for-recipient |
| Storage | `src/storage.js` | append-only log (Node `fs` / browser IndexedDB) |
| Networking | `src/network.js` | WebSocket + flood-fill gossip |
| **Query** | `src/query.js` | GraphQL-shaped nested selection queries |
| Composite | `src/monogun.js` | wires everything above into one API |

## Why keychains became the addressing system, not just an auth feature

Once every node's soul (its graph address) can be a deterministically
derived Ed25519 public key, "create an account" and "create any
addressable sub-object" become the *same operation*:
`keychain.sub(label)`. A user's root keychain **is** their account;
`user.sub('posts').sub(postId)` **is** that post's address. No separate
ID-generation scheme, no collision risk, and — unlike the alias-hash
account system this replaced — a real structural parent/child
relationship between a user and everything they create.

Three properties fall directly out of the derivation math and are used
throughout this composite:

1. **Forward-only derivation.** `tweak = blake2b(parentPublicKey ||
   label)`. Computing a child's keys needs the parent's key material;
   going the other way — recovering a parent from a child, or a sibling
   from a sibling — is a hash-preimage problem. "Children can be made,
   but the parent can't be known" from the child's side.

2. **Public-key-only derivation (capability sharing).** The tweak only
   needs the parent's *public* key, not its private key. Anyone holding
   a parent's public key can compute every descendant's public
   address and verify signed writes under that whole subtree — without
   ever being able to sign as any node in it. `db.capability(soul)`
   hands out exactly this: read/verify/addressing power, no write power.

3. **Composition / reconstruction.** Given any parent `KeyPair` (held,
   not re-derived) and the label used at that level,
   `Keychain.composeChild(parentKeyPair, label)` recomputes exactly the
   child `sub(label).get()` would produce — the "hand someone the
   parent and the tweak" path, distinct from walking a live `Keychain`
   object.

**Implementation note:** `keychain.js` wraps `sodium-universal` directly
rather than reimplementing Ed25519 scalar/point tweaking from scratch.
An earlier version did reimplement it on `@noble/curves`; cross-checking
against the real `keypear` package (used as an oracle during
development) showed root-key derivation matched byte-for-byte but the
child/tweak derivation did not — `keypear`'s
`extension_tweak_ed25519_*` functions are a Holepunch-maintained
libsodium fork extension with an internal clamping step that isn't
derivable from public docs. Shipping a scheme that *looks* like
keypear's but silently diverges would be a correctness bug users could
easily miss, so this module calls the real extension functions instead.
Verified byte-for-byte against `keypear` — root keys, single- and
multi-level `sub()` chains, and even deterministic signatures all match
exactly, cross-verifiable in both directions (see the development
history; the cross-validation script isn't shipped since it depends on
`keypear` itself, which isn't a runtime dependency of this project).

## Why the query layer is GraphQL-shaped

The graph already has the exact shape GraphQL queries traverse: a root
node, some scalar fields, and links to other nodes
(`{'#': soul}` references). `query.js` is a small synchronous resolver
that walks a plain-object query description — no schema to declare, no
separate query language to parse, because the graph's own references
already encode the traversal paths a GraphQL schema would otherwise
need to declare explicitly.

```js
db.query({
  soul: postSoul,
  select: ['title', 'body'],
  author: { via: 'author', select: ['name'] },
  comments: { via: 'comments', list: true, select: ['text'] },
});
```

Keys you use in the query are the keys you get back (GraphQL-style
aliasing), `via` names the field holding the reference(s), and
`list: true` resolves an array of references instead of one.

## Other layer choices (from the original composite, still in effect)

- **Storage — append-only log, not a radix tree.** Simpler, trivially
  crash-safe (a torn last line from a crash is just dropped on replay),
  and the whole graph rebuilds in one O(n) pass on boot.
- **Networking — WebSockets + flood-fill gossip, not a DHT.** Correct
  and auditable at the cost of O(peers) traffic per write instead of
  O(log peers) — stated plainly as a small-to-medium mesh design (tens
  of peers), not a scale-to-thousands one.
- **HAM conflict resolution — kept.** Genuinely a good fit for a
  leaderless graph CRDT; no principled reason to replace it.

## API

### CRUD Operations (SQL/GraphQL-familiar)

```js
const MonoGun = require('./monogun');

const db = new MonoGun({ file: './data/log.ndjson', peers: [] });
await db.ready();

// INSERT — create a new record (auto-generated soul)
const postId = db.insert({ title: 'Hello', body: 'World' });

// SELECT / query — retrieve records (GraphQL/SQL syntax)
db.select({
  souls: ['post1', 'post2'],
  select: ['title', 'body'],
  filter: { published: true },
  sort: ['createdAt', 'desc'],
  limit: 10,
  offset: 0,
  mapToRows: true  // returns { title, body } without 'soul' field
});

// UPDATE — modify a record
db.update(postId, { body: 'Updated world' });

// DELETE — remove a record
db.delete(postId);

// SUBSCRIBE — listen for changes (GraphQL subscriptions)
db.subscribe(postId, (node) => console.log('changed:', node));
```

### Low-level Graph API (backward compatible)

```js
// --- plain graph writes/reads (soul can be any string) ---
db.put('greeting', { text: 'hello' });
db.get('greeting');
db.on('greeting', (node) => console.log(node));
db.link('post1', 'author', 'user1');

// --- identity: keychain-based, deterministic, hierarchical ---
const { soul } = await db.createIdentity({ passphrase: 'correct horse' });
// soul is a hex Ed25519 public key -- the account's graph address

const postSoul = await db.putAt(['posts', 'post1'], { title: 'hello world' });
// signed with a key deterministically derived from the identity's root

const verified = db.getAtVerified(postSoul); // checks every field's signature

await db.unlock(soul, 'correct horse'); // recover the identity elsewhere

// --- capability sharing: public-key-only, no signing power ---
const readonly = db.capability(soul);
readonly.sub('posts').get('post1'); // same address, can't sign

// --- GraphQL-shaped queries (native syntax) ---
db.query({
  soul: postSoul,
  select: ['title'],
  author: { via: 'author', select: ['name'] },
  comments: {
    via: 'comments',
    list: true,
    select: ['text'],
    filter: { approved: true },
    sort: ['createdAt', 'desc'],
    limit: 5
  },
});
```

### Enhanced Query Syntax (SQL/GraphQL-compatible)

Filters support MongoDB-style operators:
```js
db.select({
  souls: ['post1', 'post2', 'post3'],
  select: ['title', 'createdAt'],
  filter: {
    published: true,
    views: { $gte: 100 },
    tags: { $in: ['javascript', 'databases'] }
  },
  sort: ['views', 'desc'],
  limit: 20,
  offset: 0,
  mapToRows: true
});
```

### Networking a peer

```js
const http = require('http');
const server = http.createServer();
server.listen(8765);

const db = new MonoGun({
  file: './data/log.ndjson',
  server,
  peers: ['ws://otherpeer.example.com/monogun'],
});
```

## Run tests

```bash
npm install
npm test   # runs test/test.js (33 assertions across every layer)
           # and test/keychain-invariants.js (derivation security properties)
```

## Design Choices (intentional trade-offs)

- **Flood-fill gossip over DHT.** Network traffic scales with peer count (O(peers)), not diameter (O(log peers)). Correct choice for small-to-medium mesh (tens of peers, supervised environments). Thousands+ of peers require hierarchical routing or DHT; not in scope for this composite.
- **Per-field eventual consistency over atomic multi-field commits.** Each field write signs independently with its own timestamp. A node with multi-field writes across time will hold fields from different points in time, each independently valid and verifiable. Fits append-only semantics; users requiring atomic multi-field should batch writes to a single .putAt() call.
- **No rate limiting.** Spam resistance via proof-of-work (PoW) omitted; orthogonal to the graph and query layer. Can be added as an optional transport-layer policy without breaking the core API.

## Future work (not roadmap, just possible)

- **Range queries & indexing.** Soul indexing (B-tree, radix tree, or trie) would enable prefix scans and range lookups on soul names. Currently all soul access is O(1) key lookup. Useful for secondary indexes and scans; not required for the core identity/graph model.
- **DHT or hierarchical gossip.** To scale beyond tens of peers, gossip can layer into a DHT or cluster-based hierarchy to reduce bandwidth. Requires peer discovery and routing protocol; separate from current design.
