/**
 * nevil.js — the monolithic composite.
 *
 * A single, from-scratch implementation covering the same ground as the
 * GUN ecosystem (GUN core + SEA + RAD + DAM/AXE), PLUS a hierarchical
 * deterministic keychain (keypear-style Ed25519 tweaking) used as the
 * primary identity and addressing system.
 *
 * Layers, each a stated preference (details in the file headers):
 *   - graph.js:     HAM last-write-wins CRDT (kept — it fits the model)
 *   - keychain.js:  keypear-style deterministic Ed25519 derivation —
 *                   THE addressing scheme: souls are public keys
 *   - crypto.js:    Web Crypto API, isomorphic — used for passphrase
 *                   wrapping of a keychain's root seed and for
 *                   encrypt-for-recipient between two parties
 *   - storage.js:   append-only log instead of a radix tree
 *   - network.js:   WebSocket + flood-fill gossip instead of a DHT
 *   - query.js:     a GraphQL-shaped query surface over the graph
 *
 * WHY KEYCHAINS BECOME THE ADDRESSING SYSTEM, NOT JUST AN AUTH FEATURE:
 * Once every node's soul can be a deterministically-derived public key,
 * "create an account" and "create any addressable sub-object" become the
 * same operation: `keychain.sub(label)`. A user's root keychain IS their
 * account; `user.sub('posts').sub(postId)` IS a post's address, with no
 * separate ID-generation scheme, no collision risk, and a structural
 * parent/child relationship the old alias-hash system didn't have.
 *
 * This file is the only place that wires the layers together: local
 * writes go graph -> storage -> network; remote writes go network ->
 * graph (storage persists them too, so every peer's log is a full
 * replica).
 */

'use strict';

const { Graph, isRef, ref } = require('./graph');
const { Storage } = require('./storage');
const { Network, randomId, canonicalJSON } = require('./network');
const { Keychain, KeyPair, encryptFor: keychainEncryptFor } = require('./keychain');
const sea = require('./crypto');
const { query } = require('./query');

// Topology presets: AP (availability+partition, no coordinator, eventual
// consistency — local writes always accepted even if isolated), CA
// (consistency+availability, no partition tolerance — a real quorum gate
// REJECTS local writes when fewer than `quorumFraction` of expected peers
// are connected, since CA explicitly does not promise to keep working
// during a partition; this is what actually distinguishes CA from AP,
// not just a different label on identical flood-fill LWW config), CP
// (consistency+partition tolerance — DHT routing + Lamport clocks give
// causal ordering under partition, at the cost of full availability
// during a split, but unlike CA it does NOT reject writes: partitioned
// peers keep accepting locally and reconcile via causal ordering on
// heal). Per CAP theorem no topology gets all three; `topology` just
// picks which two this instance optimizes for and configures the
// graph/network/quorum-gate accordingly. Any opt explicitly passed
// overrides the preset (explicit config always wins over topology default).
const TOPOLOGY_PRESETS = {
  ap: { conflictResolution: 'lww', dhtEnabled: false, quorumFraction: 0 },
  ca: { conflictResolution: 'lww', dhtEnabled: false, quorumFraction: 0.5 },
  cp: { conflictResolution: 'lww', dhtEnabled: true, quorumFraction: 0 },
};

function resolveTopologyOpts(opts) {
  if (!opts.topology) return opts;
  const mode = String(opts.topology).toLowerCase();
  const preset = TOPOLOGY_PRESETS[mode];
  if (!preset) throw new Error(`unknown topology: ${opts.topology} (expected ap, ca, or cp)`);
  return { ...preset, ...opts };
}

class Nevil {
  constructor(opts = {}) {
    opts = resolveTopologyOpts(opts);
    this.opts = opts;
    this.topology = opts.topology ? String(opts.topology).toLowerCase() : null;
    // Quorum: fraction of configured peers (opts.peers.length) that must be
    // CONNECTED for a local write to be accepted. 0 (AP/CP default) means
    // no gate — always accept, matching each mode's real CAP tradeoff (see
    // TOPOLOGY_PRESETS comment). Only meaningful with a nonzero configured
    // peer list; with no peers configured there is nothing to be a quorum
    // of, so the gate never fires (single-node/dev usage is unaffected).
    this.QUORUM_FRACTION = opts.quorumFraction || 0;
    this.storage = new Storage({ ...opts, enableIndex: opts.enableSoulIndex });
    this.graph = new Graph(opts);
    this._closed = false; // set by close(); _boot() checks this after every await to abort a torn-down boot
    this._ready = this._boot();
    // A rejected _boot() (e.g. storage I/O failure, malformed peer URL) would
    // otherwise be an unhandled promise rejection that crashes the process
    // under Node's default --unhandled-rejections=throw, even for callers
    // who never call ready() (e.g. fire-and-forget put() usage). Attach a
    // no-op catch to a throwaway derived promise so Node sees the rejection
    // handled; ready() below still returns the original _ready promise, so
    // a caller that DOES await it still observes the failure.
    this._ready.catch(() => {});
    this._identity = null; // { keychain, soul } once logged in / created
    this._lamportClock = 0; // global lamport clock for cross-batch ACID
  }

  async _boot() {
    this.graph = await this.storage.load(Graph, this.opts);
    if (this._closed) return this;

    // Peer table persistence: resume mesh knowledge from a prior run instead
    // of only ever dialing opts.peers passed at construction — without this,
    // a restarted peer forgets every peer it learned about via live traffic
    // and re-discovers the mesh from scratch each time.
    const priorPeerTable = await this.storage.loadPeerTable();
    if (this._closed) return this;
    const configuredPeers = new Set(this.opts.peers || []);
    const resumedPeers = (priorPeerTable.peerUrls || []).filter((u) => !configuredPeers.has(u));
    this._bootOpts = resumedPeers.length
      ? { ...this.opts, peers: [...(this.opts.peers || []), ...resumedPeers] }
      : this.opts;
    this._priorRoutingKeys = new Map(priorPeerTable.routingKeys || []);
    // Seed the nevil-level clock from the loaded graph's clock so the two
    // counters (graph.localClock advances on merge; _lamportClock advances
    // on gossip) start in sync instead of _lamportClock resetting to 0
    // while graph.localClock resumes from the replayed history — divergence
    // there would let a locally-gossiped write's advertised clock lag
    // behind what the graph itself already recorded.
    this._lamportClock = this.graph.localClock;

    // Durable reputation ledger: load and hand to Network BEFORE it opens any
    // socket (dial/listen happen synchronously inside the Network constructor
    // below), so there is no boot window where live traffic is evaluated
    // against an empty ledger with no persist hook wired — a penalty assessed
    // in that window would otherwise be silently lost across restart.
    const priorLedger = await this.storage.loadReputationLedger();
    if (this._closed) return this;
    this.network = new Network({
      ...this._bootOpts,
      priorReputationLedger: priorLedger,
      // Must not be fire-and-forget uncaught: persistReputationEntry is async
      // and rejects on real I/O failure (disk full, permission error). With
      // no .catch, network.js's updateReputation() call site (fire-and-forget
      // by design — it must not need to know this hook returns a Promise)
      // turns that rejection into an unhandled promise rejection that crashes
      // the whole process. Matches the graceful-degradation pattern already
      // used for storage.persist(...) at the graph.onAny/_applyRemote sites below.
      onReputationDelta: (entry) => this.storage.persistReputationEntry(entry).catch((err) => this._onPersistError(err, entry.peerId)),
    }, (msg) => {
      if (msg.type === 'put') this._applyRemote(msg);
    });
    // Seed the gossip watermark from the restored ledger's total-ever-pushed
    // count (not raw .length — once the FIFO starts shifting, .length stays
    // capped at maxReputationLedger while the true position keeps advancing,
    // so a length-only cursor silently misaligns and drops entries from gossip).
    this._lastGossipedLedgerLength = (this.network.reputationLedgerShifted || 0) + this.network.reputationLedger.length;
    // Restore previously-learned routing-bucket knowledge (see network.js
    // peerRoutingKeys) — these keys are keyed by peerKey (address:port),
    // which is only meaningful once that same peer reconnects, but seeding
    // them means routing preference is warm from the first message instead
    // of cold every restart.
    for (const [pk, rk] of this._priorRoutingKeys) this.network.peerRoutingKeys.set(pk, rk);
    // Periodically snapshot the live peer table (dialed URLs + learned
    // routing keys) so the NEXT restart resumes from this run's mesh
    // knowledge instead of only construction-time opts.peers.
    this._peerTableSaveTimer = setInterval(() => {
      const dialedUrls = Array.from(this.network.sockets)
        .map((ws) => ws._dialUrl)
        .filter(Boolean);
      this.storage.savePeerTable(dialedUrls, this.network.peerRoutingKeys).catch(() => {});
    }, this.opts.peerTableSaveFreq || 30000);
    if (this._peerTableSaveTimer.unref) this._peerTableSaveTimer.unref();

    // Every local write that actually changes state gets persisted and gossiped.
    this._unsubAny = this.graph.onAny((soul, node, changedFields) => {
      if (this._isSuppressedNotify(soul, changedFields)) return; // this exact notify IS the direct echo of an in-flight _applyRemote merge
      this._lamportClock++; // advance global clock on every local (gossiped) write
      const fields = {};
      const ts = {};
      const lamport = {};
      const graphNode = this.graph.nodes.get(soul);
      for (const f of changedFields) {
        fields[f] = node[f];
        ts[f] = this.graph.getState(soul)[f];
        lamport[f] = graphNode?.lamport[f];
      }
      // persist() also updates the soul index with real entry data. Not
      // awaited (this handler is sync, called from graph.onAny), but its
      // rejection is caught explicitly — an uncaught rejection here (e.g.
      // disk full, permission error) would otherwise crash the process on
      // an otherwise-recoverable I/O error.
      this.storage.persist(soul, fields, ts, lamport).catch((err) => this._onPersistError(err, soul));
      // Gossip only reputation deltas accrued since the last gossip, not the
      // entire ledger every message — attaching up to maxReputationLedger
      // (20000) entries on every single put both bloats bandwidth per-message
      // and causes receivers to re-sum the SAME historical deltas repeatedly
      // (see network.js handleMessage reputationLedger merge), inflating
      // reputationCache far beyond the real sum of distinct deltas.
      // gossipFrom is expressed against the array's CURRENT indices: subtract
      // however many entries have shifted out since the cursor was recorded,
      // clamped to 0 so a cursor that predates a shift doesn't go negative
      // and silently re-send/skip the wrong slice.
      const totalPushed = (this.network.reputationLedgerShifted || 0) + this.network.reputationLedger.length;
      const gossipFrom = Math.max(0, (this._lastGossipedLedgerLength || 0) - (this.network.reputationLedgerShifted || 0));
      const reputationLedger = this.network.reputationLedger.slice(gossipFrom);
      this._lastGossipedLedgerLength = totalPushed;
      const msgId = randomId();
      let msg = { id: msgId, type: 'put', soul, fields, ts, reputationLedger, lamportClock: this._lamportClock };
      if (this.network.POW_ENABLED) {
        // Bind the puzzle to fields/ts too, not just soul+id — otherwise a
        // relaying peer could swap this write's actual content in transit
        // while keeping the same valid PoW solution (see network.js _verifyPoW).
        msg.pow = Network.solvePoW(soul, this.network.POW_DIFFICULTY, msgId, fields, ts);
      }
      // Byzantine resilience: attach sender (identity soul) + signature if identity is set
      if (this._identity) {
        msg.sender = this._identity.soul;
        const msgCopy = { ...msg };
        delete msgCopy.id;
        delete msgCopy.sender;
        delete msgCopy.signature;
        // canonicalJSON, not JSON.stringify(msgCopy, Object.keys(msgCopy).sort())
        // — the array-form replacer is a recursive key ALLOWLIST at every
        // nesting level, so nested `fields` content always serialized as
        // `{}` and was never actually covered by the signature. Must stay
        // byte-for-byte consistent with the verify side in network.js.
        const msgBody = canonicalJSON(msgCopy);
        const keyPair = this._identity.keychain.get();
        if (keyPair.writable) {
          const sig = keyPair.sign(Buffer.from(msgBody));
          msg.signature = sig.toString('hex');
        }
      }
      this.network.broadcast(msg);
    });

    return this;
  }

  ready() {
    return this._ready;
  }

  /**
   * Tear down the network layer, close the storage backend (releasing its
   * IndexedDB connections in-browser / file handles in Node), and unsubscribe
   * graph listeners so this instance can be cleanly discarded. `this.network`
   * is only assigned inside the async `_boot()` kicked off (not awaited) by
   * the constructor, so a caller that closes before `ready()` resolves (a
   * failed-fast request handler, a test harness tearing down after a
   * construction error) would otherwise crash on `this.network` being
   * undefined. `this.storage` is assigned synchronously in the constructor,
   * so it is always present by the time close() can be called.
   */
  close() {
    // Set first: a _boot() suspended on an in-flight await checks this flag
    // immediately after resuming and aborts instead of finishing construction
    // of a network/timer/listener that this call already intended to tear down.
    this._closed = true;
    if (this._peerTableSaveTimer) { clearInterval(this._peerTableSaveTimer); this._peerTableSaveTimer = null; }
    if (this.network) this.network.close();
    if (this.storage) this.storage.close();
    if (this._unsubAny) this._unsubAny();
  }

  _applyRemote(msg) {
    // Mirrors the local-path guard in put() — a non-string/empty msg.soul
    // arriving over the network must never reach mergeNode/storage.persist,
    // or a garbage-keyed node durably pollutes graph.nodes and round-trips
    // through disk on every future boot. network.js's keychain-soul check
    // (_isKeychainDerived) string-coerces and simply mismatches a non-string
    // soul rather than rejecting it, so this guard is the only place on the
    // remote-apply path that actually validates shape.
    if (typeof msg.soul !== 'string' || !msg.soul) return;
    // Push a stack frame (soul + the field set this merge is about to write)
    // rather than setting a single scalar: mergeNode's fan-out (graph._notify)
    // runs synchronously, and its per-soul listeners run BEFORE its wildcard
    // (onAny) listener — so a graph.on(soul, fn) listener reacting to this
    // remote write by synchronously calling put() on the SAME soul triggers
    // its own nested mergeNode -> _notify -> onAny call, which fires and
    // unwinds entirely BEFORE the outer mergeNode's own _notify reaches its
    // wildcard loop. A single scalar equal-by-soul check can't tell that
    // nested, genuinely-new-fields notify apart from the outer merge's own
    // direct echo (both compare equal on soul alone) and would wrongly
    // suppress the nested write's broadcast too. Matching on the frame's
    // declared field set (via _isSuppressedNotify, consumed at most once) as
    // well as soul means a nested write carrying different field names (the
    // realistic shape of this pattern — a normalization/derived-field
    // listener writes NEW fields, not the ones the remote message carried)
    // is correctly let through and broadcast.
    const frame = { soul: msg.soul, fields: new Set(Object.keys(msg.fields || {})), consumed: false };
    this._suppressStack = this._suppressStack || [];
    this._suppressStack.push(frame);
    let changed;
    try {
      changed = this.graph.mergeNode(msg.soul, msg.fields, msg.ts, msg.lamportClock);
      // Adopt graph.localClock (already CLOCK_MAX_JUMP-clamped by mergeNode),
      // never the raw msg.lamportClock — a Byzantine peer advertising an
      // arbitrary huge clock must not poison every future gossip from this node.
      if (this.graph.localClock > this._lamportClock) this._lamportClock = this.graph.localClock;
    } finally {
      this._suppressStack.pop();
    }
    if (changed.length) {
      // persist accepted remote writes too, so every peer's disk log is a full replica,
      // carrying each changed field's lamport clock so a future boot replays true causal order.
      // Persist ONLY the fields HAM actually accepted (`changed`), not the full msg.fields —
      // msg.fields can include fields HAM correctly rejected as stale (e.g. lost a concurrent
      // write). Logging those too meant a rejected field still got durably written with no
      // lamport entry (lamport[field] stayed undefined), so on next boot's replay, mergeNode's
      // per-field lamport comparison fell through to the ts/lexical tie-break and could let the
      // previously-rejected write "win" retroactively — a real live-merge-vs-replay divergence.
      const fields = {};
      const ts = {};
      const lamport = {};
      for (const f of changed) {
        fields[f] = msg.fields[f];
        ts[f] = msg.ts[f];
        lamport[f] = msg.lamportClock;
      }
      this.storage.persist(msg.soul, fields, ts, lamport).catch((err) => this._onPersistError(err, msg.soul));
    }
  }

  /**
   * Default persist-failure handler: log and keep running rather than let
   * an unhandled promise rejection crash the process. The write already
   * landed in-memory (graph state is correct); only the durable log write
   * failed, so this is a durability-degradation event, not data loss of
   * the current in-memory state. Callers wanting custom handling (retry,
   * alerting, etc.) can override `nevil.onPersistError`.
   */
  _onPersistError(err, soul) {
    if (this.onPersistError) return this.onPersistError(err, soul);
    console.error(`nevil: storage.persist failed for soul ${soul} (write remains in-memory, not yet durable):`, err);
  }

  /**
   * Decide whether the wildcard-listener notify currently firing (soul +
   * changedFields) IS the direct echo of an in-flight _applyRemote merge for
   * that same soul, as opposed to a nested write a listener made during that
   * merge's own fan-out (see _applyRemote's frame-push comment for the full
   * ordering argument). Checked against every currently-open frame (not just
   * the top of stack) since a nested DIFFERENT-soul _applyRemote could sit
   * between two same-soul frames on the stack. A frame is consumed (matched)
   * at most once — after that, any further same-soul/same-fields notify
   * (e.g. a second, unrelated local write that happens to touch the same
   * field names) is a genuinely new event and must broadcast normally.
   */
  _isSuppressedNotify(soul, changedFields) {
    const stack = this._suppressStack;
    if (!stack || !stack.length) return false;
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i];
      if (frame.consumed || frame.soul !== soul) continue;
      if (changedFields.every((f) => frame.fields.has(f))) {
        frame.consumed = true;
        return true;
      }
    }
    return false;
  }

  // --- graph API ---------------------------------------------------------

  /**
   * Check whether enough configured peers are currently connected to
   * satisfy this instance's quorum requirement. Always true when no
   * quorum fraction is configured (AP/CP) or no peers were configured at
   * construction (nothing to be a quorum of).
   */
  _hasQuorum() {
    if (!this.QUORUM_FRACTION) return true;
    const configuredPeers = this._quorumPeerCount();
    if (configuredPeers === 0) return true;
    const connected = this._quorumConnectedCount();
    return connected / configuredPeers >= this.QUORUM_FRACTION;
  }

  // Denominator for the quorum gate: the actually-dialed peer set (opts.peers
  // plus any peers resumed from a persisted peer table during _boot()), not
  // just construction-time opts.peers — otherwise a CA node relying on
  // peer-table persistence (opts.peers: []) would always see configuredPeers
  // === 0 and silently bypass the quorum gate regardless of how many resumed
  // peers are actually dialed.
  _quorumPeerCount() {
    return ((this._bootOpts || this.opts).peers || []).length;
  }

  /**
   * Numerator for the quorum gate: connected sockets that correspond to a
   * configured/resumed peer URL, NOT raw `network.sockets.size`. That raw
   * count includes every unauthenticated inbound connection accepted via
   * `opts.server`'s WebSocketServer (network.js's `_startServer`) with no
   * identity check at all — an attacker who can reach the relay endpoint
   * could otherwise force a CA node's quorum gate to pass during a genuine
   * partition from its real configured peers, just by opening throwaway
   * connections. `network._dial()` stamps `ws._dialUrl` on every socket IT
   * initiated (network.js:167); inbound/server-attached sockets never get
   * that property, so filtering on it (matched against the same configured
   * peer set `_quorumPeerCount()` uses as the denominator) restricts the
   * numerator to sockets that are actually one of the peers being quorate over.
   */
  _quorumConnectedCount() {
    if (!this.network) return 0;
    const configuredPeers = new Set((this._bootOpts || this.opts).peers || []);
    let count = 0;
    for (const ws of this.network.sockets) {
      // readyState 1 === OPEN in both Node's `ws` and the browser's native
      // WebSocket. network.js adds a socket to `sockets` at dial time
      // (before the connection handshake completes) and only removes it on
      // close, so without this check a still-CONNECTING socket to a peer
      // that will never actually come up counts toward quorum for the
      // duration of the connection attempt.
      if (ws._dialUrl && ws.readyState === 1 && configuredPeers.has(ws._dialUrl)) count++;
    }
    return count;
  }

  /** Write fields onto a node addressed by soul (a hex public key, or any string). Throws if this instance's quorum requirement (CA topology) is not currently met — CA explicitly does not promise availability during a partition. */
  put(soul, fields) {
    if (typeof soul !== 'string' || !soul) throw new TypeError('put: soul must be a non-empty string');
    if (!this._hasQuorum()) {
      const configuredPeers = this._quorumPeerCount();
      throw new Error(`quorum not met: CA topology requires >= ${Math.ceil(this.QUORUM_FRACTION * configuredPeers)} of ${configuredPeers} configured peers connected, write rejected`);
    }
    this.graph.put(soul, fields);
    return this;
  }

  /**
   * Write multiple fields with a durability guarantee that a reader never
   * observes a partially-persisted result after a crash: `put()` is
   * already atomic in-memory (JS's single-threaded execution means no
   * reader can observe a mid-batch state — verified via exec_js witness),
   * but a process crash between the in-memory write and the async
   * `storage.persist()` completing could leave some fields durable and
   * others not if a caller made multiple separate `put()` calls. `putTxn`
   * closes that gap for a single logical write: all fields land in ONE
   * `put()` call (already atomic) plus a `_txnComplete` marker field, and
   * `getTxn`/boot replay treat a node missing that marker as not-yet-
   * visible (its fields are real on disk, but the caller's logical unit
   * of work wasn't confirmed complete).
   */
  putTxn(soul, fields) {
    return this.put(soul, { ...fields, _txnComplete: true });
  }

  /** Read a node written via putTxn(); returns undefined if the transaction marker is missing (crash left it partially visible from the caller's perspective, even though whatever fields did land are individually valid HAM state). */
  getTxn(soul) {
    const node = this.get(soul);
    if (!node || node._txnComplete !== true) return undefined;
    const { _txnComplete, ...fields } = node;
    return fields;
  }

  /** Read the current value of a node. */
  get(soul) {
    return this.graph.get(soul);
  }

  /** Subscribe to changes on a node. Returns an unsubscribe function. */
  on(soul, fn) {
    const current = this.graph.get(soul);
    if (current) fn(current, []);
    return this.graph.on(soul, fn);
  }

  /** Create a relationship: node[field] = soul-reference to targetSoul. */
  link(soul, field, targetSoul) {
    return this.put(soul, { [field]: ref(targetSoul) });
  }

  /** Resolve a field if it's a reference, otherwise return its plain value. */
  resolve(soul, field) {
    const node = this.get(soul);
    if (!node) return undefined;
    const v = node[field];
    return isRef(v) ? this.get(v['#']) : v;
  }

  /** `{ purgeDeleted: true }` reclaims souls left fully null by delete() — see Storage.compact for the local-only semantics. */
  async compact(opts = {}) {
    await this.storage.compact(this.graph, opts);
  }

  /** Rewrite the reputation log to one summed entry per peerId — see Storage.compactReputationLog. Call periodically the same way compact() is called for the main graph log. */
  async compactReputationLog() {
    await this.storage.compactReputationLog();
  }

  // --- Soul indexing for range queries (optional) -------------------------

  /**
   * Prefix scan: find all souls starting with a prefix (e.g., 'user:').
   * Requires enableSoulIndex: true in constructor options.
   */
  prefixScan(prefix) {
    if (!this.storage.index) throw new Error('soul indexing disabled; set enableSoulIndex: true in constructor');
    return this.storage.index.prefixMatch(prefix);
  }

  /**
   * Range scan: find all souls in lexicographic range [start, end).
   * Requires enableSoulIndex: true in constructor options.
   */
  rangeScan(start, end) {
    if (!this.storage.index) throw new Error('soul indexing disabled; set enableSoulIndex: true in constructor');
    return this.storage.index.rangeScan(start, end);
  }

  // --- GraphQL-shaped query surface + SQL/GraphQL aliases ---------------

  /**
   * Query the graph with a nested selection-set, GraphQL-style:
   *   db.query({ soul: userSoul, select: ['name', 'bio'],
   *              posts: { via: 'posts', select: ['title'] } })
   * See query.js for the full shape and rationale.
   * Supports enhanced syntax: filter, sort, limit, offset (SQL/GraphQL users).
   */
  query(q) {
    return query(this.graph, q);
  }

  select(q) {
    return this.query(q);
  }

  // --- SQL/GraphQL-familiar mutation surface ------

  /**
   * Insert a new record: create a soul and put fields onto it.
   * Compatible with SQLite INSERT and GraphQL createX patterns.
   */
  insert(fields) {
    const soul = globalThis.crypto.randomUUID();
    this.put(soul, fields);
    return soul;
  }

  /**
   * Update record(s): merge fields onto an existing soul.
   * Compatible with SQLite UPDATE and GraphQL updateX patterns.
   */
  update(soul, fields) {
    this.put(soul, fields);
    return this.get(soul);
  }

  /**
   * Delete a soul by clearing all its fields.
   * Compatible with SQLite DELETE and GraphQL deleteX patterns.
   * Returns true if the soul had fields and was cleared, false if it was
   * already absent/empty — callers can distinguish "deleted something"
   * from "there was nothing to delete" instead of always getting null.
   */
  delete(soul) {
    // Same guard put() applies: without it, a non-string/empty soul just
    // misses this.get() and silently returns false instead of surfacing the
    // same TypeError put()/insert()/update() throw for the identical input.
    if (typeof soul !== 'string' || !soul) throw new TypeError('delete: soul must be a non-empty string');
    const node = this.get(soul);
    const hasLiveField = node && Object.values(node).some((v) => v !== null && v !== undefined);
    if (!hasLiveField) return false; // nothing to clear: soul absent, or already fully tombstoned
    const cleared = {};
    for (const k of Object.keys(node)) cleared[k] = null;
    this.put(soul, cleared);
    return true;
  }

  /**
   * Subscription alias: GraphQL-familiar .subscribe() over .on().
   */
  subscribe(soul, fn) {
    return this.on(soul, fn);
  }

  // --- Identity: keychain-based accounts ----------------------------------

  /**
   * Create a brand-new identity. The account's soul IS its root public
   * key -- no alias-hash indirection. If `passphrase` is given, a random
   * 32-byte seed is generated and sealed with it so the identity can
   * later be recovered with unlock(); without a passphrase, the identity
   * exists only in memory for this process unless you separately persist
   * `keychain` yourself (e.g. via Keychain's own seed).
   */
  async createIdentity({ passphrase, alias } = {}) {
    if (passphrase) {
      const seed = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)));
      return this.createIdentityFromSeed(seed, { passphrase, alias });
    }

    const keychain = new Keychain(); // fresh random root, seed not retained
    const soul = keychain.get().toHex();

    const profile = { soul, createdAt: Date.now() };
    if (alias) profile.alias = alias;
    // Set _identity BEFORE put() so the onAny broadcast handler signs this
    // write like any other identity-owned message — this.soul IS a
    // keychain-derived (64-hex) address, so an unsigned broadcast of it
    // would now be rejected by the network's own auth-bypass guard on
    // receipt (a keychain-derived soul's put must carry sender+signature).
    // If put() throws (e.g. CA quorum not met), roll _identity back so a
    // caller isn't left signing/gossiping future writes under a soul whose
    // profile node was never actually persisted.
    this._identity = { keychain, soul };
    try {
      this.put(soul, profile);
    } catch (err) {
      this._identity = null;
      throw err;
    }
    return { soul, keychain };
  }

  /**
   * Create an identity from an explicit 32-byte seed (deterministic —
   * same seed always reconstructs the same identity/tree), and wrap
   * that seed with a passphrase so it can be recovered with unlock().
   */
  async createIdentityFromSeed(seed, { passphrase, alias } = {}) {
    const keychain = new Keychain(seed);
    const soul = keychain.get().toHex();

    const profile = { soul, createdAt: Date.now() };
    if (alias) profile.alias = alias;

    if (passphrase) {
      const sealed = await sea.encryptWithPass({ seed: Buffer.from(seed).toString('hex') }, passphrase);
      profile.sealedSeed = sealed;
    }

    // Same rollback rationale as createIdentity above.
    this._identity = { keychain, soul };
    try {
      this.put(soul, profile);
    } catch (err) {
      this._identity = null;
      throw err;
    }
    return { soul, keychain };
  }

  /** Recover an identity by soul + passphrase (decrypts the sealed root seed). */
  async unlock(soul, passphrase) {
    const profile = this.get(soul);
    if (!profile || !profile.sealedSeed) throw new Error('no recoverable identity at that soul');
    const { seed } = await sea.decryptWithPass(profile.sealedSeed, passphrase);
    const keychain = new Keychain(Buffer.from(seed, 'hex'));
    if (keychain.get().toHex() !== soul) throw new Error('wrong passphrase or corrupted identity');
    this._identity = { keychain, soul };
    return { soul, keychain };
  }

  /**
   * A read-only capability for ANY soul (public key) -- no private
   * material needed. Anyone can derive this subtree's public
   * addresses/verify its signed writes, but cannot sign as it. This is
   * the "hand out the parent's public key" sharing model from
   * keychain.js.
   */
  capability(soul) {
    return Keychain.fromPublicKey(soul);
  }

  /**
   * Write to a sub-address of the current identity, signed with that
   * sub-address's own derived key. `path` is an array of labels, e.g.
   * ['posts', postId] -> identity.sub('posts').sub(postId).
   * Returns the sub-address's soul (hex public key) so it can be linked
   * to from elsewhere in the graph.
   */
  async putAt(path, fields) {
    if (!this._identity) throw new Error('no active identity — call createIdentityFromSeed or unlock first');
    // Mirrors graph.put()'s own guard: without it, a string/array `fields`
    // silently explodes into one signed field per character/index via
    // Object.entries below, instead of being rejected up front.
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError('putAt: fields must be a plain object');
    }
    let chain = this._identity.keychain;
    for (const label of path) chain = chain.sub(label);
    const keyPair = chain.get();
    const subSoul = keyPair.toHex();

    const signed = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) {
        throw new Error(`putAt: field "${k}" is undefined — JSON.stringify(undefined) produces no signable value; use null to explicitly clear a field instead`);
      }
      // Sign {field name, value} together, not just the value — otherwise a
      // validly-signed {v, sig} pair from one field could be copy-pasted
      // onto a different field name on the same node (e.g. "title" ->
      // "isAdmin") and getAtVerified would still accept the signature,
      // since it never covered which field it was for.
      const sig = keyPair.sign(Buffer.from(JSON.stringify({ k, v })));
      signed[k] = { v, sig: sig.toString('hex') };
    }
    const ownerSig = keyPair.sign(Buffer.from(JSON.stringify(this._identity.soul)));
    signed._owner = { v: this._identity.soul, sig: ownerSig.toString('hex') };
    const pathSig = keyPair.sign(Buffer.from(JSON.stringify(path)));
    signed._path = { v: path, sig: pathSig.toString('hex') };
    this.put(subSoul, signed);
    return subSoul;
  }

  /**
   * Publish the current identity's box (X25519) public key for a given
   * sub-address path, so senders can seal messages for it. Returns hex.
   * See keychain.js's module note: this is NOT derivable from the Ed25519
   * soul alone by a third party — the scalar-holder must publish it once.
   */
  boxPublicKeyAt(path) {
    if (!this._identity) throw new Error('no active identity — call createIdentityFromSeed or unlock first');
    let chain = this._identity.keychain;
    for (const label of path) chain = chain.sub(label);
    return chain.get().toBoxPublicKey().toString('hex');
  }

  /**
   * Write a sealed (confidentiality, not just signed) field to soul,
   * addressed to a recipient's published box public key (hex, from
   * `boxPublicKeyAt`/`toBoxPublicKey`). Only the recipient's matching
   * scalar can decrypt; the graph/network only ever see ciphertext.
   */
  putEncrypted(soul, field, value, recipientBoxPublicKeyHex) {
    const sealed = keychainEncryptFor(Buffer.from(recipientBoxPublicKeyHex, 'hex'), JSON.stringify(value));
    this.put(soul, { [field]: sealed.toString('hex') });
    return this;
  }

  /** Decrypt a sealed field written by putEncrypted, using the current identity's sub-address scalar at `path`. */
  getDecryptedAt(path, soul, field) {
    if (!this._identity) throw new Error('no active identity — call createIdentityFromSeed or unlock first');
    let chain = this._identity.keychain;
    for (const label of path) chain = chain.sub(label);
    const node = this.get(soul);
    if (!node || typeof node[field] !== 'string') return undefined; // no field, or not a sealed-hex string (never sealed at all)
    try {
      const opened = chain.get().decrypt(Buffer.from(node[field], 'hex'));
      return JSON.parse(opened.toString());
    } catch {
      return undefined; // wrong recipient, corrupted ciphertext, or field was never actually sealed
    }
  }

  /**
   * Read + verify every signed field at a sub-address soul, including
   * chain-of-custody: `_owner`/`_path` must be present, self-consistent
   * (subSoul really is `owner.sub(...path)`, not just self-signed by
   * whoever created the node), not merely that each field's signature
   * verifies against the node's OWN public key. Without the custody
   * check, an attacker can generate any keypair, self-sign an arbitrary
   * `_owner`/`_path` claim, and getAtVerified would return it as if it
   * were legitimately authored by that owner.
   */
  getAtVerified(subSoul) {
    const node = this.get(subSoul);
    if (!node) return undefined;
    const subSoulBuf = Buffer.from(subSoul, 'hex');
    if (subSoulBuf.length !== 32) return undefined; // not a keychain-derived (Ed25519) soul — nothing to verify
    const subKeyPair = new KeyPair({ publicKey: subSoulBuf, scalar: null });

    if (!node._owner || !node._path) return undefined; // no custody claim at all — nothing to trust
    const ownerOk = subKeyPair.verify(Buffer.from(JSON.stringify(node._owner.v)), Buffer.from(node._owner.sig, 'hex'));
    const pathOk = subKeyPair.verify(Buffer.from(JSON.stringify(node._path.v)), Buffer.from(node._path.sig, 'hex'));
    if (!ownerOk || !pathOk) return undefined;

    // Recompute subSoul from the claimed owner + path (public-key-only
    // derivation) and require it match the actual soul this node lives at —
    // this is what proves subSoul was really derived from that owner, not
    // just self-signed by an unrelated keypair.
    let expectedChain;
    try {
      expectedChain = Keychain.fromPublicKey(node._owner.v);
      for (const label of node._path.v) expectedChain = expectedChain.sub(label);
    } catch {
      return undefined; // malformed owner soul or path
    }
    if (expectedChain.get().toHex() !== subSoul) return undefined; // custody chain doesn't match — forged claim

    // Custody markers are already verified above (their own unwrapped
    // signing scheme, not the {k, v} field scheme) — surface their plain
    // values on the result so callers can read back _owner/_path, same as
    // any other verified field. Previously these were skipped entirely in
    // the loop below with no replacement, so a caller could never actually
    // read the verified owner/path back from getAtVerified despite the
    // custody check having already proven them authentic.
    const out = { _owner: node._owner.v, _path: node._path.v };
    for (const [k, v] of Object.entries(node)) {
      if (k === '_owner' || k === '_path') continue; // handled above
      if (v && typeof v === 'object' && v.sig) {
        // Verify against {k, v} together, matching putAt's signing scheme —
        // a signature only ever covers the specific field name it was made
        // for, so it cannot be replayed onto a different field on the same
        // (or any other) node.
        const ok = subKeyPair.verify(Buffer.from(JSON.stringify({ k, v: v.v })), Buffer.from(v.sig, 'hex'));
        out[k] = ok ? v.v : undefined;
      }
    }
    return out;
  }

  // expose the crypto and keychain modules directly for advanced use
  get sea() {
    return sea;
  }

  get Keychain() {
    return Keychain;
  }

  /**
   * Write multiple fields under one labeled, signed sub-address so they
   * can be read back together via `['txn', txnId]`. NOT a transaction in
   * the ACID sense: `putAt` still merges fields independently (per-field
   * eventual consistency, same as every other write in this system) —
   * there is no isolation and no rollback on partial failure. The
   * transaction id is deterministic (a hash of the fields alone), so
   * identical calls always land at the same sub-address instead of the
   * previous Math.random() nonce, which made two calls with the same
   * options collide unpredictably or never collide when the caller
   * actually wanted idempotent replay. The Lamport clock is deliberately
   * NOT part of the digest input: it is shared, ever-advancing instance
   * state (also mutated by every other put()/putAt() and by incoming
   * remote writes), so folding it into the "deterministic" nonce would
   * make two calls with identical fields hash to different sub-addresses
   * depending on unrelated concurrent traffic — the opposite of the
   * idempotent-replay guarantee this method promises.
   */
  async batchWrite(fields, options = {}) {
    if (!this._identity) throw new Error('no active identity — call createIdentityFromSeed or unlock first');
    // Sort keys before stringifying: JSON.stringify is key-order-sensitive,
    // so two semantically-identical fields objects with keys inserted in a
    // different order would otherwise hash to different nonces, defeating
    // the "identical calls land at the same sub-address" determinism goal.
    const canonicalFields = JSON.stringify(fields, Object.keys(fields).sort());
    const nonce = options.nonce !== undefined
      ? options.nonce
      : Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalFields))).toString('hex').slice(0, 16);
    const txnKeychain = this._identity.keychain.sub('txn').sub(nonce);
    const txnId = txnKeychain.head.publicKey.toString('hex');
    const batchPath = ['txn', txnId];
    this._lamportClock++; // advance clock for the persisted write metadata only, after the digest is derived
    // Stamp onto a shallow copy, never the caller's own object: mutating
    // `fields` in place here means a second batchWrite(fields) call reusing
    // the same reference would compute canonicalFields (above) over the
    // leftover _lamportClock key from the prior call, breaking this method's
    // own idempotent-replay guarantee (identical calls landing at the same
    // sub-address).
    const stamped = { ...fields, _lamportClock: this._lamportClock };
    return this.putAt(batchPath, stamped);
  }

  /**
   * Guard against the same pre-boot race close() was fixed for: `this.network`
   * is only assigned inside the async _boot() the constructor kicks off
   * without awaiting, so any method dereferencing it can be called before
   * boot completes (e.g. a caller reacting to a synchronous event that fires
   * before `ready()` resolves).
   */
  _requireNetwork(methodName) {
    if (!this.network) throw new Error(`nevil.${methodName}(): called before boot completed — await ready() first`);
    return this.network;
  }

  /**
   * Add reputation delta to peer's karma ledger (delegates to network's
   * ledger), then mirror the entry onto the graph for visibility. The quorum
   * check (the same gate `put()` itself applies) runs FIRST, before the
   * network ledger is touched: `network.updateReputation` commits
   * synchronously and unconditionally (ledger push + cache update + durable
   * persist hook), so applying it before a `put()` that can throw on CA
   * quorum loss would leave the caller with an exception while the delta had
   * already landed with no way to roll it back. Checking quorum up front
   * means a rejected call never mutates network state at all.
   */
  addReputation(peerId, delta, reason = '') {
    if (!this._hasQuorum()) {
      const configuredPeers = this._quorumPeerCount();
      throw new Error(`quorum not met: CA topology requires >= ${Math.ceil(this.QUORUM_FRACTION * configuredPeers)} of ${configuredPeers} configured peers connected, write rejected`);
    }
    this._lamportClock++;
    const entry = this._requireNetwork('addReputation').updateReputation(peerId, delta, reason || 'good');
    // Persist to graph under ['reputation', peerId] for visibility. Quorum
    // was already confirmed above, so put()'s own quorum check cannot fire
    // here; it still runs put()'s other guards (soul validation, etc.).
    const repPath = ['reputation', peerId];
    this.put(repPath.join(':'), entry);
    return entry;
  }

  /** Get total reputation for a peer (delegates to network's ledger). */
  getReputation(peerId) {
    return this._requireNetwork('getReputation').getReputation(peerId);
  }

  /** Get reputation ledger entries: all entries if peerId is omitted, or only that peer's entries (matching network.js's own filtered signature) if given. */
  getReputationLedger(peerId) {
    const network = this._requireNetwork('getReputationLedger');
    return peerId === undefined ? network.reputationLedger : network.getReputationLedger(peerId);
  }

  /** Merge remote reputation entries into the network ledger (for gossip). */
  mergeReputationLedger(entries) {
    this._requireNetwork('mergeReputationLedger');
    if (!Array.isArray(entries)) return;
    // Clamp ceiling is fixed once per call (relative to the clock's value
    // BEFORE this batch), not re-derived from _lamportClock on every
    // iteration — otherwise each entry's clamp ceiling ratchets up from the
    // previous entry's already-clamped result, letting an N-entry batch
    // advance the clock by ~N * CLOCK_MAX_JUMP in a single call instead of
    // being bounded by CLOCK_MAX_JUMP overall, same as any other message.
    const ceiling = this._lamportClock + this.network.CLOCK_MAX_JUMP;
    for (const entry of entries) {
      // Validate shape before applying: an unvalidated caller-supplied
      // peerId/delta previously let a single call blacklist an arbitrary
      // honest peer (unbounded negative delta) or inflate the global Lamport
      // clock without limit (same poisoning class CLOCK_MAX_JUMP guards
      // against elsewhere — apply the same clamp here).
      if (!entry || typeof entry.peerId !== 'string' || typeof entry.delta !== 'number' || !Number.isFinite(entry.delta)) continue;
      const delta = Math.max(-100, Math.min(100, entry.delta));
      this.network.updateReputation(entry.peerId, delta, entry.reason);
      if (typeof entry.lamportClock === 'number' && Number.isFinite(entry.lamportClock)) {
        const clamped = Math.min(entry.lamportClock, ceiling);
        if (clamped > this._lamportClock) this._lamportClock = clamped;
      }
    }
  }
}

module.exports = Nevil;
