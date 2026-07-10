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
| Composite | `nevil.js` | Wires all layers into one public API, resolves topology mode presets |

Supporting:
- `keychain-invariants.js` — derivation security property checks (audit only, not used at runtime)

## API Surface

- `close()` — tears down the network layer (all open sockets, the queue-drain timer, and any attached `WebSocketServer`) and unsubscribes graph listeners, so an embedding process can exit cleanly instead of an open socket/timer handle keeping the event loop alive indefinitely

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
- `putTxn(soul, fields)` / `getTxn(soul)` — multi-field write with a crash-durability marker (`_txnComplete`); `getTxn` returns `undefined` if the marker is missing, so a reader never treats a torn/partial write as a confirmed logical unit. In-memory atomicity (no reader ever observes a partial `put()` mid-write) already held for plain `put`/`putAt`/`batchWrite` — verified via exec_js, not something `putTxn` needed to add; `putTxn` closes the separate crash-during-persist durability gap.

### Identity & Auth
- `createIdentity({ passphrase })` — create root keychain (returns {soul, keychain})
- `unlock(soul, passphrase)` — recover keychain elsewhere
- `capability(soul)` — public-key-only (read/verify, no sign)
- `putAt(path, fields)` — signed write under keychain path
- `getAtVerified(soul)` — read with signature verification; returns `{_owner, _path, ...verified fields}` — `_owner`/`_path` are the plain (already-verified) custody values, included on the result alongside every field whose per-field signature checks out
- `network` rejects (drops + Byzantine-penalizes the sender) any `type:'put'` message targeting a keychain-derived soul (64-hex Ed25519 pubkey) that lacks both `sender` and `signature` — an unsigned write can never silently merge into an identity-addressed soul over the wire, closing the gap where omitting both fields skipped auth entirely
- `boxPublicKeyAt(path)` — publish this identity's sub-address X25519 box public key (hex) for sealed-box encryption-for-recipient
- `putEncrypted(soul, field, value, recipientBoxPublicKeyHex)` — write a sealed (confidential, not just signed) field addressed to a recipient's published box key
- `getDecryptedAt(path, soul, field)` — decrypt a sealed field using the current identity's sub-address scalar

### Queries
- `query(spec)` — GraphQL-shaped: soul, select, via, list, filter, sort, limit, offset, mapToRows

### DHT Routing (Transcendence 1: bounded-subset traffic)
- `network._selectRoutingPeers(msg)` — select K healthiest + L adjacent connected peers for a soul's geohash bucket (flood-fill fallback when fewer than K/2 match)
- `network._computeGeohash(soul)` — deterministic geohash bucketing
- `network.updatePeerHealth(peerId, latency, loss)` — track peer health scores
- `network.getHealthyPeers()` — retrieve peers sorted by health
- `network.broadcast(payload, lamportClock)` — starts a `dhtFallbackThreshold` timer; if the message id is never observed looping back through the mesh (the real receipt signal) within the threshold, it force-reflloods to every connected peer instead of staying confined to the original DHT-selected subset
- Config: `dhtK`, `dhtL`, `dhtGeohashLength`, `dhtHealthUpdateFreq`, `dhtFallbackThreshold`, `dhtEnabled`

### Lamport Clocks (Transcendence 2: Causal consistency)
- `graph.localClock` — monotonically incrementing clock counter
- `graph.mergeNode(soul, fields, timestamps, lamportClock)` — merge with clock ordering
- `network.broadcast(payload, lamportClock)` — include clock in messages
- `graph.CLOCK_MAX_JUMP` — enforced in `mergeNode`: a field/batch lamport clock more than `CLOCK_MAX_JUMP` steps ahead of `localClock` is clamped rather than accepted verbatim, so one Byzantine peer can't advertise an arbitrary clock and permanently win every future HAM comparison for a field
- Config: `clockMaxJump`, `clockFastThreshold`, `clockConsensusSpread`

### Reputation Ledger (Transcendence 3: Byzantine-resistant throttling)
- `network.updateReputation(peerId, delta, reason)` — record reputation delta
- `network.getReputation(peerId)` — get cumulative score
- `network.getThrottleState(peerId)` — accept/queue/drop decision
- `network.isByzantineIsolated(peerId, threshold)` — check if isolated
- Delta reasons: 'good', 'malformed', 'replay', 'byzantine', 'routing-help'
- Config: `repAcceptThreshold`, `repQueueMin`, `repDropThreshold`, `repDelta*`, `queueRetryDelay`, `queueMaxRetries`
- Messages from a `queue`-throttled sender are held in `network.messageQueue` (bounded FIFO, `maxQueuedMessages`) and actively drained by `network._drainQueue()` on a `queueRetryDelay` timer: each retry re-checks the sender's current throttle state, delivering once reputation recovers to `accept` and dropping after `queueMaxRetries` if it never does
- Gossip of the reputation ledger (`nevil.js` attaching it to every `put` broadcast) sends only the delta slice accrued since the last gossip, not the full ledger; receivers dedup incoming entries by identity before summing into `reputationCache`, so a re-delivered message can't double-count the same historical delta
- `nevil.mergeReputationLedger(entries)` validates `peerId`/`delta` shape and clamps both the delta magnitude and the accepted lamport-clock jump before applying — a malformed or hostile entry can't blacklist an arbitrary peer or inflate the global clock unboundedly
- `network.reputationCache` (the `peerId -> cumulative score` Map) is FIFO-bounded by `maxReputationLedger` the same as `seen`/`reputationLedger`, via `_setReputationCache()` at every write site — a peer gossiping a stream of fabricated `peerId`s can't grow the cache without limit

### Configurable Conflict Resolution (Transcendence 5: pluggable HAM strategy)
- `graph.resolveConflict` — the active strategy fn: `(incomingTs, incomingVal, currentTs, currentVal, incomingLamport, currentLamport) => boolean`
- `new Graph({ conflictResolution: 'lww' | 'fww' | fn })` — 'lww' (default, `hamWins`: Lamport clock > timestamp > lexical tie-break), 'fww' (`fwwWins`: first write to a field always wins), or a custom fn
- `CONFLICT_STRATEGIES` — exported map of named strategies (`{ lww, fww }`)
- Witness: `tools/witness-conflict-resolution.js` asserts LWW/FWW/custom converge differently and deterministically on the same concurrent input

### Topology Modes (Transcendence 6: explicit AP/CA/CP presets, CA backed by real quorum enforcement)
- `new Nevil({ topology: 'ap' | 'ca' | 'cp', ...opts })` — configures graph conflict strategy + network DHT flag + quorum fraction per CAP trade-off; any opt passed alongside `topology` overrides that preset field (explicit config always wins)
- `nevil.topology` — the resolved mode string, or `null` if unset (fully manual configuration)
- AP (availability + partition tolerance): flood-fill gossip, LWW, no DHT, `quorumFraction: 0` — no coordinator, always accepts local writes, reconverges eventually
- CA (consistency + availability): LWW, no DHT, `quorumFraction: 0.5` — `nevil.put()` actively REJECTS local writes when fewer than half of `opts.peers` are currently connected (`nevil._hasQuorum()`), naming the real CAP tradeoff instead of behaving identically to AP; a single-node/no-configured-peers instance is unaffected (nothing to be a quorum of)
- CP (consistency + partition tolerance): LWW + DHT routing enabled, `quorumFraction: 0` — Lamport clocks (always active in `graph.js`) give causal ordering across a partition; DHT bounds traffic instead of flooding; unlike CA, CP does not reject writes during a partition
- Witness: `tools/witness-topology-modes.js` asserts each preset configures the graph/network/quorum correctly and that explicit opts override the preset

### Confidentiality: Encrypt-for-Recipient (real sealed-box, not just signing)
- `keyPair.toBoxPublicKey()` — derives this keypair's X25519 public key correctly for BOTH root and `.sub()`-derived keys, via `crypto_scalarmult_base(scalar)`. **Not** `crypto_sign_ed25519_pk_to_curve25519(publicKey)` — that conversion assumes a standard RFC 8032 seed-expanded key and silently diverges for any tweaked/derived key (verified: matches only by coincidence at the root, mismatches for every `.sub()` address)
- `keyPair.encryptFor(message)` / `keyPair.decrypt(sealed)` — convenience for a writable keypair sealing/opening against its own published box key
- `encryptFor(boxPublicKeyBuf, message)` (module-level, `keychain.js`) — sender-side: seals a message for a recipient's *published* box public key; the sender never needs the recipient's scalar or even their Ed25519 public key
- `nevil.boxPublicKeyAt(path)` / `nevil.putEncrypted(soul, field, value, recipientBoxPublicKeyHex)` / `nevil.getDecryptedAt(path, soul, field)` — the wired public API: recipient publishes their box key once, senders seal fields onto the graph as opaque ciphertext, only the matching scalar-holder can read them
- Witness: `tools/witness-encrypt-for-recipient.js` asserts a sender holding only the published key can seal, the correct recipient can open, a different derived sub-address cannot, and a read-only (scalar-less) capability cannot

### Proof-of-Work Rate-Limiting (Transcendence 7: optional hashcash-style throttle)
- `Network.solvePoW(soul, difficulty)` — static; iterates nonces until `sha256(soul + ':' + nonce)` has `difficulty` leading hex zeros, returns `{ nonce, difficulty }`
- `network._verifyPoW(soul, pow)` — O(1) hash check; rejects `pow.difficulty` weaker than the network's configured minimum
- `new Network({ powEnabled: true, powDifficulty: N })` — when `powEnabled`, every `type: 'put'` message must carry a valid `pow` field or is dropped and its sender penalized in the reputation ledger (same as a Byzantine write); when a `pow` field is present but `powEnabled` is false, it is still verified if given (never trust unchecked work)
- Orthogonal to the reputation ledger: PoW gates admission per-message: reputation gates a peer's ongoing throughput
- Config: `powEnabled` (default false), `powDifficulty` (default 4)
- Witness: `tools/witness-proof-of-work.js` asserts writes without PoW are rejected when enabled and a solved puzzle is accepted, with solve/verify timing

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

**Eleven Transcendences (Limitations Solved):**
1. **DHT-aware bounded-subset routing** (reduces flood-fill, not log-hop): Selects a bounded subset (K healthiest + L adjacent connected peers in a soul's geohash bucket) for keychain-derived souls; falls back to flood-fill broadcast when fewer than K/2 connected peers match. Each message still relays one hop to those K peers — this reduces O(peers) traffic toward O(K), it is NOT a provably O(log peers)-hop DHT.
2. **Lamport clocks** (causal ordering, actually used): HAM conflict resolution order is `lamportClock > wall-clock ts > canonical-value tie-break`. nevil auto-advances its global `_lamportClock` on every local write and passes the remote message's clock into `graph.mergeNode`. Real causal ordering, no consensus.
3. **Reputation ledger** (single live ledger, peer-to-peer throttling): `network` auto-records a delta when it drops a message (malformed/replay/byzantine/PoW fail); nevil gossips `reputationLedger` with each write; the accept/queue/drop gate operates in the real message flow. No central authority.
4. **B-tree index** (O(log n)-ish lookups, O(n) boot): `BTreeIndex` is wired as the real `Storage` index (`prefixMatch`/`rangeScan`/`get`/`add`/`rebuild`) when `enableSoulIndex`/`enableIndex` is set. `get` binary-searches SSTable ranges. The index is in-memory and rebuilt on boot by replaying the append-only log, so startup is O(n), not O(log n).
5. **Configurable conflict resolution** (pluggable HAM, actually used): `Graph({ conflictResolution })` accepts `'lww'` (default), `'fww'`, or a custom fn; `mergeField` calls `this.resolveConflict(...)` instead of a hardcoded strategy. Enables CA-style topologies where first-write-wins or app-specific merge semantics fit better than last-write-wins.
6. **Explicit topology modes** (AP/CA/CP presets, actually enforced): `Nevil({ topology })` resolves a preset (conflict strategy + DHT flag) before construction; verified via direct inspection of the constructed instance, not just documentation. Per CAP theorem, no mode claims all three properties — each preset states which two it optimizes for.
7. **Optional proof-of-work rate-limiting** (hashcash-style, actually enforced): `Network({ powEnabled, powDifficulty })` gates every `put` message on a valid solved puzzle when enabled; `Network.solvePoW`/`_verifyPoW` do real sha256 iteration/check, not a stub. Orthogonal to and composes with the reputation ledger (PoW gates per-message, reputation gates per-peer throughput over time).
8. **Real encrypt-for-recipient** (was a phantom claim, now implemented): `keychain.js` derives correct X25519 sealed-box keys for BOTH root and derived addresses (the naive `pk_to_curve25519` conversion is provably wrong for derived keys — fixed via `crypto_scalarmult_base(scalar)` instead). `nevil.js` wires `boxPublicKeyAt`/`putEncrypted`/`getDecryptedAt` so field values can be genuinely confidential on the graph, not just signed.
9. **Boot no longer inflates the Lamport clock**: `Storage.load` used to replay every log entry as if it were a fresh local write, incrementing `localClock` once per entry regardless of history — an N-entry log jammed the clock to ~N. Fixed: replay carries each entry's own persisted (per-field) clock; `localClock` converges on the true historical max, exactly as if the writes were being received live.
10. **Compaction no longer discards Lamport clocks**: `Storage.compact` used to write only `{soul, fields, ts}`, silently dropping `node.lamport`. Fixed: compaction persists the per-field lamport map too, so causal ordering survives compact + reboot instead of degrading to timestamp-only HAM.
11. **Reputation ledger now durable across restarts**: previously memory-only (`network.reputationLedger`/`reputationCache` reset to empty on every process restart, so a Byzantine peer was treated as neutral again). Fixed: `Storage` gained a dedicated reputation log (separate file/dbName); `Network.updateReputation` persists via an injected hook, `restoreReputationLedger` replays it on boot before any live traffic.

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
- ✅ Configurable conflict resolution: fully implemented (graph.js), default 'lww' preserves prior behavior exactly. Witness: `tools/witness-conflict-resolution.js` asserts LWW/FWW/custom converge to distinct, correct winners on identical concurrent input.
- ✅ Explicit topology modes: fully implemented (nevil.js), opt-in via `topology` constructor option, explicit opts always override the preset. Witness: `tools/witness-topology-modes.js` asserts each mode's graph/network configuration and the override behavior.
- ✅ Optional proof-of-work: fully implemented (network.js), off by default (`powEnabled: false`), composes with the existing reputation ledger without replacing it. Witness: `tools/witness-proof-of-work.js` asserts unsolved writes are rejected and solved writes accepted, with real solve/verify timing.
- ✅ Real encrypt-for-recipient: fully implemented (keychain.js, nevil.js), fixes a previously-phantom header claim. Witness: `tools/witness-encrypt-for-recipient.js` plus a Nevil-level exec_js run asserting ciphertext opacity on the graph and correct decrypt-only-by-owner.
- ✅ Boot clock integrity: fully implemented (storage.js, graph.js), fixes real clock inflation on every boot. Witness: `tools/witness-boot-clock-integrity.js` asserts a real Nevil instance's localClock does not inflate across a restart.
- ✅ Compaction clock preservation: fully implemented (storage.js), fixes silent loss of causal ordering after compact+reboot. Witness: same script, asserts lamport survives compact+reload.
- ✅ Reputation durability: fully implemented (storage.js, network.js, nevil.js), fixes reputation resetting to neutral on every restart. Witness: `tools/witness-reputation-durability.js` asserts a Byzantine peer's throttle state survives a real restart.

## Configuration & Tuning

All magic constants exposed via constructor options (no hidden defaults):
- Network: DHT_K, DHT_L, DHT_GEOHASH_LENGTH, DHT_HEALTH_UPDATE_FREQ, DHT_FALLBACK_THRESHOLD, DHT_ENABLED
- Graph: CLOCK_MAX_JUMP, CLOCK_FAST_THRESHOLD, CLOCK_CONSENSUS_SPREAD
- Reputation: REP_*_THRESHOLD, REP_DELTA_*, QUEUE_RETRY_DELAY, QUEUE_MAX_RETRIES
- Storage: MEMTABLE_SIZE_LIMIT, MEMTABLE_FLUSH_FREQ, SSTABLE_MERGE_THRESHOLD, BLOOM_FILTER_FPR, SSTABLE_BLOCK_SIZE
- Conflict resolution: `conflictResolution` ('lww' | 'fww' | custom fn) on `Graph`
- Topology: `topology` ('ap' | 'ca' | 'cp') on `Nevil`, resolves to preset opts that any explicit opt overrides
- Proof-of-work: `powEnabled`, `powDifficulty` on `Network`

All parameters documented with trade-offs (latency vs bandwidth, throughput vs memory, recovery speed vs storage).

## Residuals & Open Questions

Honest residuals (not blockers):
- B-tree index is in-memory and rebuilt on boot by replaying the append-only log, so **startup is O(n)** (log replay), not O(log n). The index gives O(log n)-ish prefix/range lookups after load.
- DHT-aware routing reduces flood-fill traffic to a bounded subset K of healthy connected peers (with flood-fill fallback), but it is **not** a provably O(log peers)-hop DHT — each routed message still makes one relay hop to the K selected peers.
- CAP theorem is a hard trade-off, not a limitation to engineer around: the `topology` presets each pick which two of {consistency, availability, partition tolerance} to optimize for — no mode gets all three simultaneously. CA mode enforces a real quorum gate (`quorumFraction: 0.5` by default): `nevil.put()` rejects local writes once fewer than half of `opts.peers` are connected, rather than silently degrading to AP-like always-accept behavior during a partition. This is a real availability sacrifice (CA explicitly does not promise to keep working when partitioned), not just a differently-labeled AP.
- Proof-of-work difficulty is a static per-network constant, not adaptive to observed spam rate. An operator wanting difficulty that scales with attack volume must reconfigure `powDifficulty` and restart, or layer their own adaptive controller on top of `Network.solvePoW`/`_verifyPoW`.
- Encrypt-for-recipient requires the recipient to have published their box public key at least once (`boxPublicKeyAt`) before a sender can seal a message for them — there is no way to derive a usable X25519 key from an Ed25519 soul alone for a derived (non-root) address; this is a real cryptographic constraint of additive Ed25519 tweaking, not an oversight (verified: `pk_to_curve25519` of a derived public key does not match `scalarmult_base` of its corresponding derived scalar).
- Reputation ledger durability persists every delta to its own append-only log (mirrors the graph log's crash-safety), but does not yet compact — a long-running peer with heavy churn grows an ever-larger reputation log on disk. Acceptable at the same scale the main log is (see append-only storage residual above); a future compaction pass would mirror `Storage.compact`'s soul-keyed rewrite, keyed by peerId instead.
- Storage writes use `fs.promises.appendFile` without an explicit fsync; an OS-level crash (not a process crash — the append-only format already handles that via torn-line detection) can still lose the last buffered-but-unflushed write. A durability-critical deployment wanting fsync-per-write would need to add it at the `NodeLogStore.appendEntries` call site; not added by default because it trades throughput for a narrow crash window most deployments don't hit.
- `keychain.js`/`network.js` depend on `sodium-universal`'s `extension_tweak_ed25519_*` functions — a Holepunch-maintained libsodium fork extension, not standard libsodium. If that native binding is ever missing or the fork changes its ABI, identity derivation and signature verification break; there is currently no pure-JS fallback or install-time healthcheck. Documented here as a real single-point-of-failure dependency, not silently assumed always-present.
- Peer list and learned DHT routing keys (`network.opts.peers`, `peerRoutingKeys`) are runtime-only; a restarted peer re-dials only the peers passed at construction time and re-learns routing keys from scratch via live traffic, rather than resuming from a persisted peer table. Acceptable for supervised/configured meshes (peers are usually passed via config at every start); a fully self-healing swarm would need this persisted.
- Soul indexing (`enableSoulIndex`) and disk-backed B-tree persistence are both opt-in, off by default — enabling them is a deployment choice trading boot-time memory/CPU for O(log n)-ish lookups, not something the library forces on every user.
- Graph merges are single-writer per process (no internal locking) — this is safe because Node.js is single-threaded and every public mutation (`put`, `mergeNode`, remote apply) runs to completion synchronously before the event loop yields; the residual is conceptual (worth stating explicitly) rather than a live race, since nothing here spans worker threads or async interleaving mid-merge.
- `ws` is a Node-only peer dependency for the WebSocket transport; browsers use the platform's global `WebSocket` instead (see `network.js`'s runtime branch) — installing `ws` is only required when running as a Node relay/server, not in a browser client.
- Four larger architectural extensions remain genuinely future-scope (not silently dropped, explicitly named): (1) disk-backed SSTable persistence for `BTreeIndex` (currently in-memory, rebuilt from the log on boot — a real O(log n) boot would need SSTables actually written to and read from disk, a substantial I/O-layer addition); (2) hierarchical multi-hop DHT routing (current bounded-subset routing is one relay hop to K peers, not a leveled/recursive log-hop scheme — the honest scope is stated throughout, not misrepresented); (3) an adaptive PoW difficulty controller reacting to observed spam rate (current difficulty is a static per-network constant); (4) a per-soul contention-safe merge path for genuinely concurrent (multi-threaded/multi-process) writers — today's single-writer-per-process safety relies on Node's single-threaded event loop, which is real and sufficient for the current architecture but would need explicit locking if ever extended to worker threads. Each would roughly double this file's line count if built now; scoping them out of this session is an explicit call, not an oversight, and each is independently addable without breaking the existing API.

All eleven transcendences are implemented, wired, and witnessed by `tools/witness-*.js`. Dead-code paths are removed/wired; zero phantom work.

@.gm/next-step.md
