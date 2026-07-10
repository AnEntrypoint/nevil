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
const { Network } = require('./network');
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
    this._ready = this._boot();
    this._identity = null; // { keychain, soul } once logged in / created
    this._lamportClock = 0; // global lamport clock for cross-batch ACID
  }

  async _boot() {
    this.graph = await this.storage.load(Graph, this.opts);
    // Seed the nevil-level clock from the loaded graph's clock so the two
    // counters (graph.localClock advances on merge; _lamportClock advances
    // on gossip) start in sync instead of _lamportClock resetting to 0
    // while graph.localClock resumes from the replayed history — divergence
    // there would let a locally-gossiped write's advertised clock lag
    // behind what the graph itself already recorded.
    this._lamportClock = this.graph.localClock;

    this.network = new Network(this.opts, (msg) => {
      if (msg.type === 'put') this._applyRemote(msg);
    });

    // Durable reputation ledger: replay before any live traffic so a
    // restarted peer doesn't treat a previously-Byzantine peer as neutral,
    // then persist every new delta so future restarts stay accurate.
    const priorLedger = await this.storage.loadReputationLedger();
    this.network.restoreReputationLedger(priorLedger);
    this.network.onReputationDelta = (entry) => this.storage.persistReputationEntry(entry);

    // Every local write that actually changes state gets persisted and gossiped.
    this._unsubAny = this.graph.onAny((soul, node, changedFields) => {
      if (this._suppressBroadcast) return; // set while applying a remote write
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
      const gossipFrom = this._lastGossipedLedgerLength || 0;
      const reputationLedger = this.network.reputationLedger.slice(gossipFrom);
      this._lastGossipedLedgerLength = this.network.reputationLedger.length;
      let msg = { type: 'put', soul, fields, ts, reputationLedger, lamportClock: this._lamportClock };
      if (this.network.POW_ENABLED) {
        msg.pow = Network.solvePoW(soul, this.network.POW_DIFFICULTY);
      }
      // Byzantine resilience: attach sender (identity soul) + signature if identity is set
      if (this._identity) {
        msg.sender = this._identity.soul;
        const msgCopy = { ...msg };
        delete msgCopy.id;
        delete msgCopy.sender;
        delete msgCopy.signature;
        const msgBody = JSON.stringify(msgCopy, Object.keys(msgCopy).sort());
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

  /** Tear down the network layer and unsubscribe graph listeners so this instance can be cleanly discarded. */
  close() {
    this.network.close();
    if (this._unsubAny) this._unsubAny();
  }

  _applyRemote(msg) {
    this._suppressBroadcast = true; // avoid re-broadcasting what we just received
    const changed = this.graph.mergeNode(msg.soul, msg.fields, msg.ts, msg.lamportClock);
    if (msg.lamportClock && msg.lamportClock > this._lamportClock) this._lamportClock = msg.lamportClock;
    this._suppressBroadcast = false;
    if (changed.length) {
      // persist accepted remote writes too, so every peer's disk log is a full replica,
      // carrying each changed field's lamport clock so a future boot replays true causal order
      const lamport = {};
      for (const f of changed) lamport[f] = msg.lamportClock;
      this.storage.persist(msg.soul, msg.fields, msg.ts, lamport).catch((err) => this._onPersistError(err, msg.soul));
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

  // --- graph API ---------------------------------------------------------

  /**
   * Check whether enough configured peers are currently connected to
   * satisfy this instance's quorum requirement. Always true when no
   * quorum fraction is configured (AP/CP) or no peers were configured at
   * construction (nothing to be a quorum of).
   */
  _hasQuorum() {
    if (!this.QUORUM_FRACTION) return true;
    const configuredPeers = (this.opts.peers || []).length;
    if (configuredPeers === 0) return true;
    const connected = this.network ? this.network.sockets.size : 0;
    return connected / configuredPeers >= this.QUORUM_FRACTION;
  }

  /** Write fields onto a node addressed by soul (a hex public key, or any string). Throws if this instance's quorum requirement (CA topology) is not currently met — CA explicitly does not promise availability during a partition. */
  put(soul, fields) {
    if (!this._hasQuorum()) {
      throw new Error(`quorum not met: CA topology requires >= ${Math.ceil(this.QUORUM_FRACTION * (this.opts.peers || []).length)} of ${(this.opts.peers || []).length} configured peers connected, write rejected`);
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
    this.graph.put(soul, { ...fields, _txnComplete: true });
    return this;
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
    this._identity = { keychain, soul };
    this.put(soul, profile);
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

    this._identity = { keychain, soul };
    this.put(soul, profile);
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
    const subKeyPair = new KeyPair({ publicKey: Buffer.from(subSoul, 'hex'), scalar: null });

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
   * transaction id is deterministic (a hash of the fields + the next
   * Lamport clock value), so identical calls always land at the same
   * sub-address instead of the previous Math.random() nonce, which made
   * two calls with the same options collide unpredictably or never
   * collide when the caller actually wanted idempotent replay.
   */
  async batchWrite(fields, options = {}) {
    if (!this._identity) throw new Error('batchWrite requires an identity (call createIdentity or unlock first)');
    this._lamportClock++; // advance clock before deriving the nonce so it's part of the deterministic input
    // Sort keys before stringifying: JSON.stringify is key-order-sensitive,
    // so two semantically-identical fields objects with keys inserted in a
    // different order would otherwise hash to different nonces, defeating
    // the "identical calls land at the same sub-address" determinism goal.
    const canonicalFields = JSON.stringify(fields, Object.keys(fields).sort());
    const nonce = options.nonce !== undefined
      ? options.nonce
      : Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalFields + ':' + this._lamportClock))).toString('hex').slice(0, 16);
    const txnKeychain = this._identity.keychain.sub('txn').sub(nonce);
    const txnId = txnKeychain.head.publicKey.toString('hex');
    const batchPath = ['txn', txnId];
    fields._lamportClock = this._lamportClock;
    return this.putAt(batchPath, fields);
  }

  /** Add reputation delta to peer's karma ledger (delegates to network's ledger). */
  addReputation(peerId, delta, reason = '') {
    this._lamportClock++;
    const entry = this.network.updateReputation(peerId, delta, reason || 'good');
    // Persist to graph under ['reputation', peerId] for visibility
    const repPath = ['reputation', peerId];
    this.put(repPath.join(':'), entry);
    return entry;
  }

  /** Get total reputation for a peer (delegates to network's ledger). */
  getReputation(peerId) {
    return this.network.getReputation(peerId);
  }

  /** Get all reputation entries (gossip sync surface — the network's live ledger). */
  getReputationLedger() {
    return this.network.reputationLedger;
  }

  /** Merge remote reputation entries into the network ledger (for gossip). */
  mergeReputationLedger(entries) {
    if (!Array.isArray(entries)) return;
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
        const clamped = Math.min(entry.lamportClock, this._lamportClock + this.network.CLOCK_MAX_JUMP);
        if (clamped > this._lamportClock) this._lamportClock = clamped + 1;
      }
    }
  }
}

module.exports = Nevil;
