# nevil Development Rules

## Project Scope

nevil is a monolithic, from-scratch replacement for the GUN ecosystem covering core + SEA + RAD + DAM/AXE functionality, plus a hierarchical deterministic keychain addressing system and GraphQL/SQL-shaped query layer.

No synthetic tests. Debugging and troubleshooting only. Validation occurs via real execution and live measurement (exec_js, browser, network metrics). test.js deleted; constraint verification done via code audit and runtime witness, not mock suites.

## Architecture Principles

**Orthogonality across surfaces:**
- Systems: Monadic effect-separation, affine resource calculus, separation logic for disjoint state.
- Scope: Strict lexical bounds, parametric polymorphism, capability-passing; no ambient/global/implicit state.
- Alignment: Denotational semantics, total correctness via refinement types, constructive proofs; no partiality.

**Constraint-driven:**
All design decisions hold against formal constraints (`.gm/constraints.md`). 32 constraints verified; zero phantom limitations.

## Code Discipline

- **2-space indents, single quotes, camelCase naming.** Uniform across all .js files.
- **No TODO/FIXME/ellipsis comments.** All known work captured in `.gm/prd.yml`.
- **Minimal comments.** Only when WHY is non-obvious; never narrate WHAT (naming already does that).
- **No boilerplate.** Each layer focused on single concern; no helper bloat or copy-paste patterns.

## Layers (Files at root)

| Layer | File | Concern |
|---|---|---|
| Graph engine | `graph.js` | HAM last-write-wins CRDT + Lamport clocks for causal ordering |
| Identity/addressing | `keychain.js` | Deterministic Ed25519 derivation (keypear-style) |
| Crypto | `crypto.js` | Passphrase wrapping, Ed25519 signing, encrypt-for-recipient |
| Storage | `storage.js` | Append-only log (Node fs / browser IndexedDB) |
| Storage (B-tree) | `storage-btree.js` | Memtable + SSTable index wired into `Storage` for O(log n)-ish prefix/range lookups (boot still replays log O(n)) |
| Networking | `network.js` | WebSocket + DHT-aware bounded-subset routing + reputation ledger + throttle gating |
| Query | `query.js` | GraphQL-shaped nested selection with filter/sort/limit/offset |
| Composite | `nevil.js` | Wires all layers into one public API |

Supporting:
- `keychain-invariants.js` — derivation security property checks (audit only, not used at runtime)

## API Surface

### CRUD Operations (SQL/GraphQL-familiar)
- `insert(fields)` — new record (auto-generated soul)
- `select(query)` — retrieve with filter/sort/limit/offset
- `update(soul, fields)` — modify record
- `delete(soul)` — remove record
- `subscribe(soul, callback)` — listen for changes

### Graph API (backward compatible)
- `put(soul, fields)` — write node
- `get(soul)` — read node
- `on(soul, callback)` — listen for changes
- `link(soul, field, targetSoul)` — create reference

### Identity & Auth
- `createIdentity({ passphrase })` — create root keychain (returns {soul, keychain})
- `unlock(soul, passphrase)` — recover keychain elsewhere
- `capability(soul)` — public-key-only (read/verify, no sign)
- `putAt(path, fields)` — signed write under keychain path
- `getAtVerified(soul)` — read with signature verification

### Queries
- `query(spec)` — GraphQL-shaped: soul, select, via, list, filter, sort, limit, offset, mapToRows

### DHT Routing (Transcendence 1: bounded-subset traffic)
- `network._selectRoutingPeers(msg)` — select K healthiest + L adjacent connected peers for a soul's geohash bucket (flood-fill fallback when fewer than K/2 match)
- `network._computeGeohash(soul)` — deterministic geohash bucketing
- `network.updatePeerHealth(peerId, latency, loss)` — track peer health scores
- `network.getHealthyPeers()` — retrieve peers sorted by health
- Config: `dhtK`, `dhtL`, `dhtGeohashLength`, `dhtHealthUpdateFreq`, `dhtFallbackThreshold`, `dhtEnabled`

### Lamport Clocks (Transcendence 2: Causal consistency)
- `graph.localClock` — monotonically incrementing clock counter
- `graph.mergeNode(soul, fields, timestamps, lamportClock)` — merge with clock ordering
- `network.broadcast(payload, lamportClock)` — include clock in messages
- Config: `clockMaxJump`, `clockFastThreshold`, `clockConsensusSpread`

### Reputation Ledger (Transcendence 3: Byzantine-resistant throttling)
- `network.updateReputation(peerId, delta, reason)` — record reputation delta
- `network.getReputation(peerId)` — get cumulative score
- `network.getThrottleState(peerId)` — accept/queue/drop decision
- `network.isByzantineIsolated(peerId, threshold)` — check if isolated
- Delta reasons: 'good', 'malformed', 'replay', 'byzantine', 'routing-help'
- Config: `repAcceptThreshold`, `repQueueMin`, `repDropThreshold`, `repDelta*`, `queueRetryDelay`, `queueMaxRetries`

### B-tree Storage (Transcendence 4: O(log n)-ish lookups, O(n) boot)
- `BTreeIndex.write(soul, entry)` — write to memtable
- `BTreeIndex.get(soul)` — retrieve from memtable or SSTable
- `BTreeIndex.rangeScan(start, end)` — range query via binary search
- `BTreeIndex.prefixScan(prefix)` — prefix lookup
- `BTreeIndex.flushMemtable()` — flush to SSTable
- `BTreeIndex.compactSSTables()` — merge old SSTables
- Config: `memtableSizeLimit`, `memtableFlushFreq`, `sstableMergeThreshold`, `bloomFilterFpr`, `sstableBlockSize`

## Key Design Decisions

**Keychain as addressing:** Every soul can be a deterministically derived Ed25519 public key. `keychain.sub(label)` produces a new address with cryptographic parent/child relationship. Forward-only derivation (can't recover parent from child). Public-key-only capability sharing (no signing power).

**HAM conflict resolution:** Last-write-wins with lexical tie-break. Deterministic, no coordinator needed. Per-field eventual consistency (not atomic multi-field).

**Four Transcendences (Limitations Solved):**
1. **DHT-aware bounded-subset routing** (reduces flood-fill, not log-hop): Selects a bounded subset (K healthiest + L adjacent connected peers in a soul's geohash bucket) for keychain-derived souls; falls back to flood-fill broadcast when fewer than K/2 connected peers match. Each message still relays one hop to those K peers — this reduces O(peers) traffic toward O(K), it is NOT a provably O(log peers)-hop DHT.
2. **Lamport clocks** (causal ordering, actually used): HAM conflict resolution order is `lamportClock > wall-clock ts > canonical-value tie-break`. nevil auto-advances its global `_lamportClock` on every local write and passes the remote message's clock into `graph.mergeNode`. Real causal ordering, no consensus.
3. **Reputation ledger** (single live ledger, peer-to-peer throttling): `network` auto-records a delta when it drops a message (malformed/replay/byzantine/PoW fail); nevil gossips `reputationLedger` with each write; the accept/queue/drop gate operates in the real message flow. No central authority.
4. **B-tree index** (O(log n)-ish lookups, O(n) boot): `BTreeIndex` is wired as the real `Storage` index (`prefixMatch`/`rangeScan`/`get`/`add`/`rebuild`) when `enableSoulIndex`/`enableIndex` is set. `get` binary-searches SSTable ranges. The index is in-memory and rebuilt on boot by replaying the append-only log, so startup is O(n), not O(log n).

**Append-only storage:** Crash-safe (torn line dropped on replay). O(n) rebuild on boot (acceptable for <10M nodes). Optional B-tree index overlay gives O(log n)-ish prefix/range lookups after load.

**No synthetic testing:** Real execution only. Constraints verified via code audit, exec_js witness, runtime metrics (`network.getMetrics()`), witness tests (`tools/witness-*.js`), and integration tests.

## Resilience Guarantees (No Load-Dependent Knobs)

- **Peer disconnect:** Local writes queue in graph, persist immediately (append-only). Sync via flood-fill on reconnect.
- **Network partition:** Local consistency maintained (HAM deterministic). Reconverge on heal (LWW).
- **Storage stall:** Graph operations in-memory; disk stall doesn't block mutations or relay.
- **Missing refs in query:** Return `null` (no crashes on sparse graph).

## Constraints Status

All 32 formal constraints documented in `.gm/constraints.md`. Verified: idempotence (f∘f≡f), disjoint state (distinct souls isolated), no UB/races/leaks, Clarke-compliant abstraction, phantom-free AST, no truncation, spec-grounded code, all exceptions handled/propagated, pure state morphisms, subtractive entropy, DAG topology, Byzantine boundaries, IO-monad effects, no secrets in AST, type safety (JSDoc + noImplicitAny), uniform style, zero boilerplate, strict contracts, graceful degradation.

**Transcendence Implementation Status:**
- ✅ DHT-aware bounded-subset routing: fully implemented (network.js), enabled by default; selects K healthiest + L adjacent connected peers for a soul's geohash bucket with flood-fill fallback. Reduces O(peers) flood-fill toward O(K) — not a provably log-hop DHT. Witness: `tools/witness-dht-routing.js` asserts real A→B delivery via the routing layer.
- ✅ Lamport clocks for causal consistency: fully implemented (graph.js, network.js), actually used. Witness: `tools/witness-lamport-clocks.js` asserts two graphs converge on the higher clock and concurrent equal-timestamp writes converge deterministically.
- ✅ Reputation ledger for Byzantine throttling: fully implemented (network.js), single live ledger auto-penalized on in-flow drop. Witness: `tools/witness-reputation-ledger.js` asserts a bad-signature message is dropped in-flow AND auto-penalizes the sender's reputation.
- ✅ B-tree storage index: fully implemented (storage-btree.js), wired as the real Storage index with binary-search `get`. Witness: `tools/witness-btree-storage.js` uses real `Storage` and asserts the index contract.
- ✅ Integration test: all four transcendences working together. Witness: `tools/witness-integration.js` asserts `A.putAt(...)` gossips to B and `B.getAtVerified(...)` returns the verified title/_owner/_path, plus prefix scan.

## Configuration & Tuning

All magic constants exposed via constructor options (no hidden defaults):
- Network: DHT_K, DHT_L, DHT_GEOHASH_LENGTH, DHT_HEALTH_UPDATE_FREQ, DHT_FALLBACK_THRESHOLD, DHT_ENABLED
- Graph: CLOCK_MAX_JUMP, CLOCK_FAST_THRESHOLD, CLOCK_CONSENSUS_SPREAD
- Reputation: REP_*_THRESHOLD, REP_DELTA_*, QUEUE_RETRY_DELAY, QUEUE_MAX_RETRIES
- Storage: MEMTABLE_SIZE_LIMIT, MEMTABLE_FLUSH_FREQ, SSTABLE_MERGE_THRESHOLD, BLOOM_FILTER_FPR, SSTABLE_BLOCK_SIZE

All parameters documented with trade-offs (latency vs bandwidth, throughput vs memory, recovery speed vs storage).

## Residuals & Open Questions

Honest residuals (not blockers):
- B-tree index is in-memory and rebuilt on boot by replaying the append-only log, so **startup is O(n)** (log replay), not O(log n). The index gives O(log n)-ish prefix/range lookups after load.
- DHT-aware routing reduces flood-fill traffic to a bounded subset K of healthy connected peers (with flood-fill fallback), but it is **not** a provably O(log peers)-hop DHT — each routed message still makes one relay hop to the K selected peers.

All four transcendences are implemented, wired, and witnessed by `tools/witness-*.js`. Dead-code paths are removed/wired; zero phantom work.

@.gm/next-step.md
