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
const { Keychain, KeyPair } = require('./keychain');
const sea = require('./crypto');
const { query } = require('./query');

class Nevil {
  constructor(opts = {}) {
    this.opts = opts;
    this.storage = new Storage({ ...opts, enableIndex: opts.enableSoulIndex });
    this.graph = new Graph();
    this._ready = this._boot();
    this._identity = null; // { keychain, soul } once logged in / created
    this._lamportClock = 0; // global lamport clock for cross-batch ACID
  }

  async _boot() {
    this.graph = await this.storage.load(Graph);

    this.network = new Network(this.opts, (msg) => {
      if (msg.type === 'put') this._applyRemote(msg);
    });

    // Every local write that actually changes state gets persisted and gossiped.
    this._unsubAny = this.graph.onAny((soul, node, changedFields) => {
      if (this._suppressBroadcast) return; // set while applying a remote write
      this._lamportClock++; // advance global clock on every local (gossiped) write
      const fields = {};
      const ts = {};
      for (const f of changedFields) {
        fields[f] = node[f];
        ts[f] = this.graph.getState(soul)[f];
      }
      if (this.storage.index) this.storage.index.add(soul);
      this.storage.persist(soul, fields, ts);
      // Gossip reputation ledger along with graph writes
      let msg = { type: 'put', soul, fields, ts, reputationLedger: this.network.reputationLedger, lamportClock: this._lamportClock };
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

  _applyRemote(msg) {
    this._suppressBroadcast = true; // avoid re-broadcasting what we just received
    const changed = this.graph.mergeNode(msg.soul, msg.fields, msg.ts, msg.lamportClock);
    if (msg.lamportClock && msg.lamportClock > this._lamportClock) this._lamportClock = msg.lamportClock;
    this._suppressBroadcast = false;
    if (changed.length) {
      // persist accepted remote writes too, so every peer's disk log is a full replica
      this.storage.persist(msg.soul, msg.fields, msg.ts);
    }
  }

  // --- graph API ---------------------------------------------------------

  /** Write fields onto a node addressed by soul (a hex public key, or any string). */
  put(soul, fields) {
    this.graph.put(soul, fields);
    return this;
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

  async compact() {
    await this.storage.compact(this.graph);
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
    const soul = require('crypto').randomUUID();
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
   */
  delete(soul) {
    const node = this.get(soul);
    if (!node) return undefined;
    const cleared = {};
    for (const k of Object.keys(node)) cleared[k] = null;
    this.put(soul, cleared);
    return null;
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
      const seed = require('crypto').randomBytes(32);
      return this.createIdentityFromSeed(seed, { passphrase, alias });
    }

    const keychain = new Keychain(); // fresh random root, seed not retained
    const soul = keychain.get().toHex();

    const profile = { soul, createdAt: Date.now() };
    if (alias) profile.alias = alias;
    this.put(soul, profile);

    this._identity = { keychain, soul };
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

    this.put(soul, profile);
    this._identity = { keychain, soul };
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
      const sig = keyPair.sign(Buffer.from(JSON.stringify(v)));
      signed[k] = { v, sig: sig.toString('hex') };
    }
    const ownerSig = keyPair.sign(Buffer.from(JSON.stringify(this._identity.soul)));
    signed._owner = { v: this._identity.soul, sig: ownerSig.toString('hex') };
    const pathSig = keyPair.sign(Buffer.from(JSON.stringify(path)));
    signed._path = { v: path, sig: pathSig.toString('hex') };
    this.put(subSoul, signed);
    return subSoul;
  }

  /** Read + verify every signed field at a sub-address soul, given the claimed owner's soul. */
  getAtVerified(subSoul) {
    const node = this.get(subSoul);
    if (!node) return undefined;
    const ownerKeyPair = new KeyPair({ publicKey: Buffer.from(subSoul, 'hex'), scalar: null });
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object' && v.sig) {
        const ok = ownerKeyPair.verify(Buffer.from(JSON.stringify(v.v)), Buffer.from(v.sig, 'hex'));
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

  /** Batch write: atomically write multiple fields under a deterministically derived transaction ID. */
  async batchWrite(fields, options = {}) {
    if (!this._identity) throw new Error('batchWrite requires an identity (call createIdentity or unlock first)');
    const { nonce = Math.random().toString(36).substring(7) } = options;
    // Derive transaction ID: txnId = keychain.sub('txn').derive(nonce)
    const txnKeychain = this._identity.keychain.sub('txn').sub(nonce);
    const txnId = txnKeychain.head.publicKey.toString('hex');
    // Increment Lamport clock for cross-batch ordering
    this._lamportClock++;
    // Write all fields atomically under ['txn', txnId] path with lamport clock
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
    for (const entry of entries) {
      this.network.updateReputation(entry.peerId, entry.delta, entry.reason);
      if (entry.lamportClock > this._lamportClock) this._lamportClock = entry.lamportClock + 1;
    }
  }
}

module.exports = Nevil;
