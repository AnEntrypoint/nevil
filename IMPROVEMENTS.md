# nevil — Complete Improvement Audit

A full, layer-by-layer list of everything that can be improved across the project, produced by auditing every core source file, the docs, the witness suite, and project/packaging hygiene. Findings are grounded in real line numbers from the code as it stands on branch `claude/project-improvement-audit-cn0aap`.

Severity legend: **[C]** critical · **[H]** high · **[M]** medium · **[L]** low.

Coverage: `graph.js`, `crypto.js`, `keychain.js`, `network.js`, `iroh-transport.js`, `storage.js`, `storage-btree.js`, `query.js`, `nevil.js`, `package.json`, docs, `tools/`, project hygiene.

---

## 1. Security

| # | Sev | File:line | Issue | Fix |
|---|-----|-----------|-------|-----|
| S1 | **H** | network.js:442-458 | **Wire signature gate authenticates the signer but never binds it to the target soul.** Any peer with its own valid keypair can `put` to *any* keychain soul with `sender`/`signature` valid for itself — `sender === soul`/custody is never checked. Identity-addressed souls are not actually write-protected on the wire; protection depends entirely on every reader using `getAtVerified`. | Verify `msg.sender` is authorized for `msg.soul` (self-address or documented parent/path) before accepting; penalize otherwise. At minimum document that the wire gate does not enforce custody. |
| S2 | **H** | network.js:442, 494, 634, 647 | **All admission checks key on `msg.type === 'put'`.** A message with `type` omitted/renamed targeting a keychain soul skips the signature *and* PoW gates yet still reaches `onMessage` and is relayed. | Gate on "is graph-mutating" independent of the attacker-controlled `type` string, or reject non-whitelisted `type` targeting a keychain soul. |
| S3 | **H** | network.js:528-591 | **Unauthenticated reputation gossip can censor any peer in one window.** `REP_GOSSIP_MAX_ENTRIES_PER_TARGET`=5 × `REP_GOSSIP_DELTA_MIN`=-5 = -25 from a single connection (distinct fake timestamps defeat `entryKey` dedup), past the -10 drop threshold. Repeatable per window / per connection; remotely-triggerable DoS/censorship of honest peers. Contradicts AGENTS.md's "one gossip entry can't cross the drop threshold" framing. | Bound *cumulative* gossip-driven negative delta per victim to strictly above the drop threshold; decay gossip-sourced reputation; and/or require corroboration from N distinct connections. |
| S4 | **M** | network.js:477-490, 229-235 | **Signed messages become replayable after reconnect/eviction.** `peerClocks` replay guard is keyed by `connKey` (address:port) which resets on reconnect; the only cross-connection guard is the 5000-entry `seen` FIFO. After eviction a captured signed put replays on a fresh connection. | Track replay state keyed by authenticated `msg.sender`; persist a per-sender high-water Lamport clock. |
| S5 | **M** | network.js:255, 363-367 | **`maxPayloadBytes` frame cap is not enforced on browser-dialed sockets.** Browser `WebSocket` has no `maxPayload`; `handleMessage` does no size check before `JSON.parse`. A malicious relay can OOM a browser client with a huge frame. Contradicts AGENTS.md "caps the raw frame size at both … sites." | Add an explicit byte-length check on `raw` at the top of `handleMessage` (runtime-agnostic) before parsing. |
| S6 | **M** | network.js:511-591, 431 | **Gossip/routing-key state is processed for `queue`-throttled senders** (only `drop` connections short-circuit). A throttled peer keeps poisoning reputation and biasing routing. | Also skip gossip application / routing-key learning when the connection is not in `accept` state. |
| S7 | **M** | crypto.js:21 | **PBKDF2 = 100,000 iterations, below current guidance (~600k SHA-256)** for wrapping the root seed. Payload records the count, so raising the default is backward-compatible. | Raise to ≥600,000, or move to scrypt/Argon2. |
| S8 | **M** | keychain.js:307-313 | **A bare 32-byte buffer is silently seed-expanded, not treated as a public key.** `new Keychain(pubKeyBytes)` yields an unrelated *writable* identity instead of a read-only capability — silent wrong-key hazard. | Reject bare 32-byte buffers; force explicit `{as:'seed'}` / `Keychain.fromPublicKey(...)`. |
| S9 | **M** | query.js:40, 78 | **Field selection/filter uses `in`, exposing prototype members.** `select:['toString']` returns the function; `filter:{constructor:…}` compares against `Object.prototype.constructor`; `__proto__` assignment hits the accessor. | Replace `f in node` with `Object.prototype.hasOwnProperty.call(node, f)` in both spots. |
| S10 | **L** | keychain.js:278-292, crypto.js:77,81,109 | **Secret key/scalar/plaintext material never zeroed.** `secretKey` buffers GC'd un-wiped; scalar long-lived; seed serialized to an immutable string. | `sodium.sodium_memzero(secretKey)` after scalar extraction; zero transient `Uint8Array`s post-encrypt. |
| S11 | **L** | crypto.js:93 vs 63-65 | **`decryptWithPass` skips the ≥16-byte salt check that `encryptWithPass` enforces.** Defense-in-depth gap on tampered payloads. | Apply the same salt-length floor on decrypt. |
| S12 | **L** | crypto.js:59-67 | **Salt reuse permitted via `saltB64`.** IV-random mitigates GCM nonce reuse, but per-payload key separation is lost. | Default to fresh random salt (already default); document/remove the param. |
| S13 | **L** | network.js:23-25 | **`randomId` fallback uses non-cryptographic `Math.random()`.** Id collisions cause legit messages to be dropped as already-seen. | Fall back to `crypto.getRandomValues`-based hex. |
| S14 | **L** | network.js:555, 582 | **Gossip `entry.reason`/`entry.timestamp` not type-validated** before use in `entryKey` (objects stringify to `[object Object]`, weakening dedup). | Validate `reason` is a string and `timestamp` a finite number. |

---

## 2. Correctness & CRDT convergence

| # | Sev | File:line | Issue | Fix |
|---|-----|-----------|-------|-----|
| X1 | **M** | graph.js:54-60, 85 | **HAM tie-break uses non-canonical (insertion-order) JSON for object values.** Two peers holding the same logical object with different key order compute different canonical strings and pick different winners on an equal-ts/equal-lamport tie → permanent divergence. | Canonicalize with recursively sorted keys before comparing (reuse in `stringifyCircular`). |
| X2 | **H** | storage-btree.js:309 (bounds :261,266-267,430) | **`get()` compares souls with code-unit order against `localeCompare`-derived range bounds.** A soul that IS in a table can be judged outside `[minSoul,maxSoul]` and skipped → real `get()` miss. `_collectPairs`/`_insertSSTable` share the mix. | Use ONE comparison convention everywhere (prefer plain `<`/`>`). |
| X3 | **M** | storage.js:24-28, 359, 394 | **`maxOf([])` returns 0, poisoning index timestamps** for empty-state nodes; such a soul loses every timestamp comparison and is silently shadowed. | Fall back to `Date.now()` when `values.length===0`, or seed off `-Infinity` + validate. |
| X4 | **M** | nevil.js:931, 938, 185 | **`batchWrite` double-advances `_lamportClock`,** so the stamped `_lamportClock` field is behind the gossip envelope clock → peers ordering by field vs envelope disagree. | Stamp the field from the same counter the broadcast uses. |
| X5 | **M** | network.js:670 | **`broadcast` spreads `payload` last,** so a `payload` carrying `id`/`lamportClock` overrides the generated id and the explicit clock argument (breaks dedup / defeats the param). | Spread `payload` first, then set `id`/`lamportClock`; or reject reserved keys. |
| X6 | **M** | network.js:881, 904-905 | **`send_ms` latency measured cumulatively across the relay loop** (single `sendStart` before the loop, recorded per peer inside it) → inflated p90/p99. | Capture `sendStart` per-iteration or record one sample per relay. |
| X7 | **L** | storage-btree.js:311 vs 474 | **`get()` and `getAllEntries()` break timestamp ties in opposite directions** (SSTable wins in `get`, memtable wins in `getAllEntries`) → same state returns different entries. | Make both prefer the memtable (most recent write). |
| X8 | **L** | query.js:52-60 | **Sort comparator over mixed-type keys yields a non-total order** (both `<` and `>` false → 0), producing engine-dependent ordering. | Compare `typeof` first or coerce; or require homogeneous sort keys. |
| X9 | **L** | graph.js:379-381 | **`put()` sub-ms timestamp uses fractional `+0.001` increments,** accruing float drift and drifting ahead of wall clock under same-ms bursts. | Use an integer monotonic counter; rely on the Lamport clock for ordering. |
| X10 | **L** | graph.js:42-51 | **`stringifyCircular` mislabels shared (non-circular) refs as `[Circular]`,** losing information and risking value-graph collisions. | Track only the current ancestor path (delete on the way up). |
| X11 | **L** | keychain.js:115 | **Degenerate numeric labels: `sub(-0)` collides with `sub(0)`; `NaN`/`Infinity` silently "work".** | Normalize `-0`→`0`; reject non-finite numeric labels. |
| X12 | **L** | network.js:1028-1032 | **Flood-fill fallback can still under-deliver** (fires only at `selected.size < ceil(K/2)`; L-adjacent padding can mask poor target coverage). | Verify/comment the interaction; consider coverage-based fallback. |

---

## 3. Crash-durability & data integrity

| # | Sev | File:line | Issue | Fix |
|---|-----|-----------|-------|-----|
| D1 | **M** | storage-btree.js:59, 77 | **SSTable + manifest written with bare `writeFile` (no temp+rename atomicity),** unlike the log store's own discipline. A crash mid-write silently discards a flushed SSTable's index contribution. | Route both writes through temp-file+`rename`. |
| D2 | **L** | storage.js:101-113, 132-144 | **`compact()`/`rewriteWith` don't fsync the containing directory after `rename`,** so even with `fsyncOnWrite` the new name may not be durable across a crash. | Open the parent dir and `fh.sync()` after `rename`. |

---

## 4. Resource leaks, unbounded growth & performance

| # | Sev | File:line | Issue | Fix |
|---|-----|-----------|-------|-----|
| R1 | **[C]** | nevil.js:85, 115 | **Pre-boot writes/subscriptions are silently discarded.** Constructor's `this.graph` is replaced by a fresh instance in `_boot()` (`storage.load` builds a new Graph). Any `put`/`on`/`subscribe` before `ready()` resolves lands on the throwaway graph and is lost — the exact "fire-and-forget before `ready()`" pattern the code's own comment (92-93) advertises. | Replay into the constructor graph (don't return a new instance), or buffer/queue pre-boot ops behind `_ready`, or make pre-boot mutations throw. |
| R2 | **M** | graph.js:113, 236-239 | **`MAX_FIELDS_PER_NODE` caps per-message fields, not per-node.** Many small under-cap puts grow a soul's field maps / the `nodes` map without bound. Name/AGENTS.md imply a per-node cap. | Enforce against resulting node size, or rename to `maxFieldsPerMessage` and add a per-node/soul-count bound. |
| R3 | **M** | network.js:866-878, 884, 1072 | **`writeRateScale` (adaptive backpressure) is computed on every relay but never applied.** Header advertises a live throttle; the value is only read in `getMetrics`. Worse, `_updateBackpressure` calls `getMetrics` per relay → six `_computePercentile` sorts of up to 1000 samples per message, discarded. | Apply `writeRateScale` to actually throttle, or remove the machinery and the per-relay `getMetrics` call. |
| R4 | **M** | iroh-transport.js:129-141 | **`_acceptLoop` busy-spins on repeated `acceptNext()` errors** (no delay on non-close throw) → pins a CPU core if the endpoint persistently errors. | Add backoff before `continue`; add a consecutive-error ceiling that closes the transport. |
| R5 | **M** | iroh-transport.js:62-73 | **`send()`'s `_sendChain` promise queue is unbounded** (no write backpressure); a stalled peer grows memory with queued frame bodies. `send` returns `true` even if the write later fails, skewing metrics. | Bound pending-write depth/bytes and return `false`/close past a threshold; surface real write completion. |
| R6 | **L** | storage.js:406-408, 425-443 | **Reputation log grows unbounded unless `compactReputationLog()` is called manually** (nothing auto-triggers it). | Document at the append site or expose a size-threshold auto-trigger. |
| R7 | **M** | network.js:672, 889 | **`_selectRoutingPeers` runs twice per broadcast** (once in `broadcast`, again in `_relay`). | Pass the computed `routedPeers` into `_relay`, or memoize per message id. |
| R8 | **L** | network.js:733-777, 818-844 | **`require('sodium-universal')`/`require('crypto')` re-invoked per message** on the hot path. | Require once at module load or memoize on the instance. |
| R9 | **L** | nevil.js:189-191 | **`getState(soul)` (full shallow clone) called inside the per-changed-field gossip loop** → O(fields²) per write. `graphNode` is hoisted; `getState` isn't. | Hoist `const state = this.graph.getState(soul)` above the loop. |
| R10 | **L** | graph.js:434-446 | **`_notify` re-clones the node once per listener** (O(L·F) alloc per notification). | Hoist a single snapshot if strict per-listener isolation isn't required; else document the cost. |
| R11 | **L** | storage.js:330-375 | **`load()` re-adds every log entry to the index even when disk SSTables are restored** → disk-restore gives near-zero index boot speedup in the common case (documented residual). | Skip `index.add` for souls whose restored SSTable timestamp already dominates; or restore only the memtable-tail. |
| R12 | **L** | storage-btree.js:303-314 | **`get()` is a linear scan over all SSTables** despite header/AGENTS.md claiming a binary search; the array is kept sorted for a search that doesn't exist. | Implement the documented binary search (needs fixed comparison + non-overlapping ranges) or correct the docs. |

---

## 5. Error handling & validation

| # | Sev | File:line | Issue | Fix |
|---|-----|-----------|-------|-----|
| E1 | **M** | keychain.js:201 | **`KeyPair.decrypt` throws `RangeError` on short/truncated sealed input** (`Buffer.alloc(len - 48)` negative) instead of failing closed — crashes the read path on attacker-written short ciphertext. | Guard `ct.length < crypto_box_SEALBYTES` up front, throw `'decryption failed'`. |
| E2 | **M** | nevil.js:312-342 | **`_applyRemote` only shape-checks `msg.soul`, not `msg.fields`/`msg.ts`** despite a comment claiming it's the sole shape-validation point. | Reject non-object/array `fields`/`ts` before merging. |
| E3 | **M** | iroh-transport.js:222-251, network.js:188 | **A failed iroh `bind()` produces an unhandled promise rejection** (`_startIroh` wraps only `dial`, not `create()`/`bind()`; `_irohReady` assigned with no `.catch`). Fatal under strict unhandled-rejection mode. | Attach `.catch` at assignment; leave `_irohTransport` unset so callers degrade gracefully. |
| E4 | **M** | nevil.js:95 | **`_ready` rejection swallowed** (`this._ready.catch(()=>{})`) → a boot failure leaves a half-initialized instance with no signal for `put`/`get`/`on`. | Record `this._bootError` in the catch; have read/mutate methods throw it if set. |
| E5 | **L** | keychain.js:165-171 | **`KeyPair.verify` returns `false` for any throw,** conflating sodium-unavailable with a bad signature — contradicts AGENTS.md's claim that verify distinguishes the two. | Rethrow/log assertion/type errors distinctly from a normal verify-false. |
| E6 | **L** | keychain.js:145-148 | **`KeyPair` constructor doesn't validate key sizes** → wrong-sized values assert deep in native code. | Validate `publicKey`/`scalar` are 32-byte Buffers. |
| E7 | **L** | crypto.js:16 | **`globalThis.crypto.subtle` dereferenced at module load** → cryptic `TypeError` at require-time on environments lacking Web Crypto. | Guard with a clear "requires Web Crypto (Node 19+/browser)" error. |
| E8 | **L** | graph.js:220, 368 | **`soul` unvalidated in `put`/`mergeNode`** → a non-string soul becomes a distinct node and desyncs. | Validate `typeof soul==='string' && length>0`; mergeNode should reject-and-warn. |
| E9 | **L** | query.js:195-202, 246-253 | **`limit`/`offset` accept `NaN`** (passes `typeof==='number'`), silently returning `[]` — unlike the negative case which throws. | Validate `Number.isInteger && >=0`, throw otherwise. |
| E10 | **L** | query.js:97-98 | **`$in` with a non-array value silently excludes** (returns false) instead of throwing like other operator errors. | Throw `'$in requires an array'`. |
| E11 | **L** | nevil.js:799-803 | **`putEncrypted` doesn't validate `value`/recipient key** — `JSON.stringify(undefined)` → opaque libsodium failure; hex key unchecked here. | Reject `value===undefined`; validate 64-char hex recipient key upfront. |
| E12 | **L** | nevil.js:177 | **`savePeerTable` failure swallowed** with a bare no-op catch → mesh-resume silently never works, no log. | Route through a throttled logger. |
| E13 | **L** | nevil.js:274-294 | **`close()` doesn't await the boot promise** → can resolve while `_boot` microtasks still settle. | `await this._ready.catch(()=>{})` early in `close()`. |
| E14 | **L** | storage.js:192-201 | **`BrowserLogStore.readAll()` bypasses the write queue** → can read pre-append state mid-write. | Chain `readAll` onto `_writeQueue`, or document reads are only safe pre-`ready()`. |
| E15 | **L** | iroh-transport.js:65, network.js:900 | **Over-max outbound iroh frame `return false` is a silent black hole** (`_relay` treats `false` as a non-fatal skip). | Log/emit when an outbound frame is refused for size. |

---

## 6. API consistency, footguns & maintainability

| # | Sev | File:line | Issue | Fix |
|---|-----|-----------|-------|-----|
| A1 | **L** | nevil.js:187, 370, 1012-1044 | **Composite reaches into private internals of `Graph`/`Network`** (raw `nodes` Map; re-implements reputation-gossip rate-limit against `network._seenReputationEntries`/`_gossipTargetsByConn`). Refactors silently break it; logic duplicated with `network.js`. | Expose `graph.getNode(soul)` and `network.mergeGossipEntries(entries, connKey)`; delegate. |
| A2 | **L** | nevil.js:529 | **`on()`/`subscribe()` initial snapshot passes `changedFields=[]`,** so field-driven listeners see no fields on the first call. Undocumented. | Pass current field names on the initial call, or document the `[]` contract. |
| A3 | **L** | query.js:166 | **`sort`/`limit`/`offset` on a single-node (non-list) selection are silently ignored.** | Document scope, or throw when they appear where they can't take effect. |
| A4 | **L** | query.js:141 | **Dead redundant `if (!node) return null;`** (already checked at :125, not reassigned). | Remove line 141. |
| A5 | **L** | network.js:1155-1157 vs 590 | **`getReputationLedger` omits gossip-sourced deltas** applied to `reputationCache` → ledger and score disagree; gossip influence undebuggable. | Record gossip adjustments in an inspectable structure, or document the divergence. |
| A6 | **L** | iroh-transport.js:181-190 | **`_register` replace path relies on synchronous `existing.close()` emitting before the new mapping is set** — fragile if `_close`/`_emit` ever becomes async. | Set the new mapping before closing the old, with an explicit identity guard. |
| A7 | **L** | graph.js:413-432 | **Nested object-field mutation inside a listener corrupts the store** (shallow copy shares nested refs) — documented read-only contract. | Consider a dev-mode deep freeze to fail violations loudly. |

---

## 7. Documentation accuracy (doc-vs-code drift)

| # | Sev | Location | Issue | Fix |
|---|-----|----------|-------|-----|
| DOC1 | **M** | README.md:390-393 | **README claims `network.broadcast()` auto-records every message to `chaos-messages.ndjson`** — no such hook exists; recording lives only in `tools/chaos-replay.js`, and the field names don't match. | Correct the README to describe how recording actually works, or implement the hook. |
| DOC2 | **M** | README.md:329-338 vs nevil.js:916 | **`batchWrite` filed under "Future Optimizations" while simultaneously asserting it was added** — it is implemented and witnessed. Contradictory. | Move `batchWrite` into the implemented API. |
| DOC3 | **M** | storage-btree.js:6-8, 28 (AGENTS.md) | **Header + AGENTS.md claim `get` binary-searches SSTable ranges; it's a linear scan** (see R12). | Implement the search or correct the docs. |
| DOC4 | **M** | storage-btree.js:103-147 | **`loadFromDisk` documented as O(sstable count); it's O(total entries)** (parses every SSTable file). | Correct to "O(entries in persisted SSTables), avoiding graph re-merge." |
| DOC5 | **L** | AGENTS.md/README Layers tables | **`iroh-transport.js` (real tracked source) is missing from both Layers tables.** | Add an `iroh-transport.js` row to both. |
| DOC6 | **L** | AGENTS.md status, CHANGELOG:37,51,65 | **Witness-suite count "22 scripts" vs actual 23** (CHANGELOG top says 23 — internally inconsistent). 11 committed witnesses are never named in AGENTS.md's per-feature lines. | Normalize to 23; ideally generate the count. |
| DOC7 | **L** | nevil.js:916, 694, 660; AGENTS.md API Surface | **`batchWrite`, `createIdentityFromSeed`, and `createIdentity`'s `alias` option are absent from the documented API surface.** | Add them, or mark internal. |

---

## 8. Test / witness coverage gaps

Documented opt-in features whose only "witness" is an ephemeral `node -e` command — no committed `tools/witness-*.js`, so the suite (and future CI) never re-exercises them.

| # | Sev | Feature | Fix |
|---|-----|---------|-----|
| T1 | **M** | Adaptive PoW difficulty (only static `witness-proof-of-work.js` exists) | Add `tools/witness-adaptive-pow.js` (ratchet up under burst, relax in quiet window). |
| T2 | **M** | Hierarchical multi-hop DHT relay (`dhtMultihopEnabled`/`_hops`) | Commit the 3-node A–B–C chain witness. |
| T3 | **M** | Disk-backed SSTable persistence (`sstableDiskEnabled` restore) | Add a restart-cycle witness (write→files land→restore on fresh `Storage`). |
| T4 | **M** | Per-soul async lock (`withSoulLock`) | Witness same-soul serialize / different-soul concurrent. |
| T5 | **M** | Reputation log compaction (`compactReputationLog`) | Witness 500 entries → summed-per-peer. |
| T6 | **M** | Peer table persistence | Witness fresh instance resuming from a persisted table only. |
| T7 | **L** | fsync-per-write (`fsyncOnWrite`) | Witness write completes via `fh.sync()`. |
| T8 | **L** | Sodium healthcheck (`checkSodiumHealth`) | Witness passes with real install / throws when a required fn is removed. |

---

## 9. Project hygiene, packaging, CI & licensing

| # | Sev | Location | Issue | Fix |
|---|-----|----------|-------|-----|
| P1 | **[C]** | AGENTS.md:17,206; README.md:513,529 | **`.gm/constraints.md` referenced (incl. clickable links + "32 constraints verified") but does not exist and `.gm/` is git-ignored** — dead on every fresh clone. | Move constraints to a tracked path and repoint, or drop the "documented in …" clause. |
| P2 | **[C]** | AGENTS.md:22 | **`.gm/prd.yml` named as the system of record for all deferred work, but is absent / git-ignored.** | Commit to a tracked location or name where work is actually tracked. |
| P3 | **H** | AGENTS.md:265 (CLAUDE.md→AGENTS.md chain) | **Checked-in `AGENTS.md` `@`-includes the git-ignored, machine-rewritten `.gm/next-step.md`** — resolves to nothing on a fresh clone. | Remove the `@.gm/next-step.md` include from the committed doc. |
| P4 | **H** | repo root | **No `LICENSE` file despite `"license":"MIT"`** in package.json and MIT-implying docs — incomplete/unenforceable grant. | Add a root `LICENSE` with MIT text + copyright holder/year. |
| P5 | **H** | package.json (`"scripts":{}`) | **No `npm test` / witness runner** despite 23 witness scripts every commit message leans on. No single pass/fail signal. | Add `scripts.test` (or `witness`) that runs all `tools/witness-*.js` and aggregates exit codes. |
| P6 | **H** | `.github/` (absent) | **No CI/CD** — the correctness-critical witness suite never runs automatically. | Add a GitHub Actions workflow (`npm ci` → witness runner); iroh witness self-skips so CI stays green. |
| P7 | **H** | package-lock.json vs package.json:22-24 | **Lockfile lists `@number0/iroh` as a hard `dependency` (pinned 1.0.0) while the manifest has it only in `optionalDependencies`** → `npm ci` errors ("out of sync"); defeats the "ws-only/browser installs never break" design. | Regenerate the lockfile from the current manifest and commit. |
| P8 | **H** | package.json:18-20 vs iroh engines | **`engines.node ">=19"` is below iroh's required `>=20.3.0`** — opting into `irohEnabled` on Node 19–20.2 fails. | Raise `engines.node` to `>=20.3.0`, or document the split and gate the iroh `require` on a version check. |
| P9 | **M** | package.json:8 | **`sodium-universal: "^5.0.1"` is a caret range for a crypto-critical, fork-specific dep** (the `extension_tweak_ed25519_*` functions) — any 5.x can silently drop them. | Pin exactly or use `~5.0.1`; upgrade deliberately after re-running the healthcheck/witnesses. |
| P10 | **M** | package.json | **Missing publish-hygiene fields:** no `repository`, `files` allowlist, `author`, `keywords` — an `npm publish` would ship `tools/`, `.gm/`, etc. | Add `files`, `repository`, `author`. |
| P11 | **L** | `monogun-data/log.ndjson` | **Stray committed runtime log under a prior project name** ("monogun"); `.gitignore` covers `nevil-data/` but not `monogun-data/`. | `git rm -r monogun-data/`; add `monogun-data/` (or `*-data/`) to `.gitignore`. |
| P12 | **L** | `.wfgy/lessons.md` | **WFGY harness scratch committed to the product repo** (unlike `.gm/`, which is fully ignored) — inconsistent treatment. | Decide intent; if not shipping, `git rm` and add `.wfgy/` to `.gitignore`. |
| P13 | **L** | `.gitignore:1` vs docs | **Blanket-ignoring `.gm/` collides with docs treating `.gm/*` as authoritative deliverables** (ties off P1–P3). | Move genuine deliverables out of `.gm/`, or stop referencing `.gm/` from committed docs. |
| P14 | **L** | package.json `1.0.0`; CHANGELOG:5 `[Unreleased]`; no git tags | **1.0.0 declared but newest CHANGELOG section is still `[Unreleased]` and there's no `v1.0.0` tag** — consumers can't map the shipped version to a changelog/tag. | Cut a real `[1.0.0]` heading and tag the release. |

---

## 10. Development infrastructure (external, but blocking)

| # | Sev | Location | Issue | Fix |
|---|-----|----------|-------|-----|
| I1 | **H** | `gm-plugkit` npm package (repo `AnEntrypoint/gm`) | **The project's `gm` harness (`.gm/next-step.md` workflow) is currently unbootable.** The published `gm-plugkit@latest` (2.0.1990) `package.json` `files` allowlist omits `"wrapper/"`, so the 5 ESM modules `plugkit-wasm-wrapper.js` imports (`wasi-shim`, `wasm-bridge`, `fs-atomic`, `kv-store`, `task-manager`) are excluded from every published tarball — the watcher cannot load. A stale `plugkit.sha256` (pins wasm to `874f5a…` vs the actually-published `eacc4a…`) is a second, independent break in the same version. | Fix is in `AnEntrypoint/gm` (add `"wrapper/"` to the `files` allowlist; regenerate the wasm sha manifest) + npm republish — outside this repo. Flagged here so it's tracked. |

---

## Highest-leverage fixes (start here)

1. **R1** — pre-boot data-loss race (`nevil.js`): a documented usage pattern silently loses writes.
2. **S1 / S2** — wire-level identity-write bypass (wrong-signer + non-`put` type).
3. **S3** — remotely-triggerable peer censorship via unauthenticated gossip.
4. **X1 / X2** — CRDT divergence (non-canonical tie-break) and dropped `get()` hits (comparison-convention mismatch).
5. **P4 / P5 / P6 / P7** — LICENSE, witness runner, CI, and the lockfile/manifest drift: together these close every packaging critical/high and make the claimed witness suite actually enforceable.
