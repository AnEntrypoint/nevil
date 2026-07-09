/**
 * graph.js — the core graph engine.
 *
 * Design: GUN's data model is a graph of nodes, where each node is a flat
 * map of field -> value, and each field carries its own HAM timestamp
 * (Hypothetical Amnesia Machine: last-write-wins by timestamp, with a
 * tie-break on lexical value so concurrent writes converge identically
 * on every peer without coordination). Relationships between nodes are
 * just fields whose value is a soul-reference: { '#': 'node-id' }.
 *
 * This module is intentionally the only place that understands HAM and
 * the graph shape. Storage, networking, and crypto all move opaque node
 * objects around; none of them need to know how conflicts are resolved.
 */

'use strict';

const REF = '#'; // key used inside a value to mark it as a soul-reference

/** True if `v` is a soul-reference ({ '#': 'someSoul' }) rather than a plain value. */
function isRef(v) {
  return v !== null && typeof v === 'object' && typeof v[REF] === 'string' && Object.keys(v).length === 1;
}

function ref(soul) {
  return { [REF]: soul };
}

/**
 * HAM decision: given the incoming (field, value, timestamp) and what's
 * currently stored, decide whether the incoming write wins.
 *
 * Rule: higher timestamp wins. On exact tie, higher lexical value wins
 * (deterministic tie-break so all peers converge without a coordinator).
 * This mirrors GUN's HAM state machine but is written from scratch here.
 */
function hamWins(incomingTs, incomingVal, currentTs, currentVal) {
  if (currentTs === undefined) return true;
  if (incomingTs > currentTs) return true;
  if (incomingTs < currentTs) return false;
  // exact timestamp tie: deterministic tie-break
  return String(incomingVal) > String(currentVal);
}

class Graph {
  constructor(opts = {}) {
    // soul -> { field: value, ..., _meta: { field: { state: ts } } }
    this.nodes = new Map();
    this.listeners = new Map(); // soul -> Set<fn(node, changedFields)>
    this.wildcardListeners = new Set(); // fn(soul, node, changedFields)
    this.localClock = 0; // Lamport clock: monotonically increasing counter
    this.opts = opts;

    // Lamport clock configuration (tunable per deployment)
    this.CLOCK_MAX_JUMP = opts.clockMaxJump || 1000; // max clock steps ahead
    this.CLOCK_FAST_THRESHOLD = opts.clockFastThreshold || 1000; // steps/sec for Byzantine detection
    this.peerClocks = new Map(); // peerId -> lastClock seen (for replay detection)
  }

  _ensureNode(soul) {
    if (!this.nodes.has(soul)) {
      this.nodes.set(soul, { data: {}, state: {} });
    }
    return this.nodes.get(soul);
  }

  /**
   * Merge a single field write into the graph, applying HAM.
   * Returns true if the write was accepted (changed local state).
   */
  mergeField(soul, field, value, ts) {
    const node = this._ensureNode(soul);
    const currentTs = node.state[field];
    const currentVal = node.data[field];

    if (!hamWins(ts, value, currentTs, currentVal)) {
      return false; // stale write, drop it — this is how eventual consistency works
    }

    node.data[field] = value;
    node.state[field] = ts;
    return true;
  }

  /**
   * Merge a whole node-shaped patch: { soul, field: value, ... } plus a
   * parallel timestamp map. This is the unit that gets sent over the wire
   * and written to the storage log. Optional lamportClock for external messages.
   */
  mergeNode(soul, fields, timestamps, lamportClock) {
    // Lamport clock ordering: if incoming clock is provided, it's an external message
    if (lamportClock !== undefined) {
      if (lamportClock > this.localClock) {
        this.localClock = lamportClock;
      }
      this.localClock++; // increment after receiving external message
    }

    const changed = [];
    for (const field of Object.keys(fields)) {
      const ts = timestamps[field];
      if (this.mergeField(soul, field, fields[field], ts)) {
        changed.push(field);
      }
    }
    if (changed.length) this._notify(soul, changed);
    return changed;
  }

  /** Convenience for local writes: stamps every field with now() and increments localClock. */
  put(soul, fields) {
    const now = Date.now() + Math.random() / 1000; // sub-ms jitter avoids same-ms tie floods
    const timestamps = {};
    for (const f of Object.keys(fields)) timestamps[f] = now;
    this.localClock++; // increment on every local write
    return this.mergeNode(soul, fields, timestamps); // don't pass lamportClock; it's a local write
  }

  get(soul) {
    const node = this.nodes.get(soul);
    return node ? { ...node.data } : undefined;
  }

  getState(soul) {
    const node = this.nodes.get(soul);
    return node ? { ...node.state } : {};
  }

  on(soul, fn) {
    if (!this.listeners.has(soul)) this.listeners.set(soul, new Set());
    this.listeners.get(soul).add(fn);
    return () => this.listeners.get(soul)?.delete(fn);
  }

  onAny(fn) {
    this.wildcardListeners.add(fn);
    return () => this.wildcardListeners.delete(fn);
  }

  _notify(soul, changedFields) {
    const node = this.get(soul);
    this.listeners.get(soul)?.forEach((fn) => fn(node, changedFields));
    this.wildcardListeners.forEach((fn) => fn(soul, node, changedFields));
  }

  /** Serialize the whole graph (used by storage snapshotting). */
  toJSON() {
    const out = {};
    for (const [soul, node] of this.nodes) {
      out[soul] = { data: node.data, state: node.state };
    }
    return out;
  }

  /** Load a previously serialized graph (used by storage on boot). */
  static fromJSON(obj) {
    const g = new Graph();
    for (const soul of Object.keys(obj || {})) {
      g.nodes.set(soul, { data: obj[soul].data || {}, state: obj[soul].state || {} });
    }
    return g;
  }
}

module.exports = { Graph, isRef, ref, hamWins, REF };
