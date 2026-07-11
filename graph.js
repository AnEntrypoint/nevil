/**
 * graph.js — the core graph engine.
 *
 * Design: GUN's data model is a graph of nodes, where each node is a flat
 * map of field -> value, and each field carries its own HAM timestamp
 * (Hypothetical Amnesia Machine: last-write-wins) plus a Lamport clock.
 * Conflict ordering is clock > timestamp > value (lexical): the higher
 * Lamport clock wins, ties broken by timestamp, then by canonical value
 * so concurrent writes converge identically on every peer even across
 * clock skew and without coordination. Relationships between nodes are
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
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (!Object.prototype.hasOwnProperty.call(v, REF)) return false;
  return typeof v[REF] === 'string' && Object.keys(v).length === 1;
}

function ref(soul) {
  return { [REF]: soul };
}

/**
 * JSON.stringify with circular references replaced by a back-reference path
 * (e.g. "[Circular:root.a.b]") instead of throwing — keeps the HAM tie-break
 * deterministic and distinguishing for circular values, where a bare
 * `String(v)` fallback would collapse every plain object to the constant
 * "[object Object]" and make the tie-break always false regardless of which
 * value is "incoming", breaking cross-peer convergence.
 */
function stringifyCircular(v) {
  const seen = new Map();
  return JSON.stringify(v, function replacer(key, val) {
    if (val !== null && typeof val === 'object') {
      if (seen.has(val)) return `[Circular:${seen.get(val)}]`;
      seen.set(val, key ? `${seen.get(this) || 'root'}.${key}` : 'root');
    }
    return val;
  });
}

/** Canonical comparable form: refs compare by soul, objects by JSON, scalars by String. */
function canonicalValue(v) {
  if (isRef(v)) return REF + v[REF];
  if (v !== null && typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return stringifyCircular(v); }
  }
  return String(v);
}

/**
 * HAM decision: given the incoming (field, value, timestamp, lamport) and
 * what's currently stored, decide whether the incoming write wins.
 *
 * Ordering: Lamport clock dominates; on equal clock the higher timestamp
 * wins; on equal timestamp a deterministic lexical tie-break on the
 * canonical value decides. This mirrors GUN's HAM state machine but with
 * a Lamport clock so convergence holds even across clock skew without a
 * coordinator. Written from scratch here.
 */
function hamWins(incomingTs, incomingVal, currentTs, currentVal, incomingLamport, currentLamport) {
  if (currentTs === undefined) return true;
  if (incomingLamport !== undefined && currentLamport !== undefined && incomingLamport !== currentLamport) {
    return incomingLamport > currentLamport;
  }
  if (incomingTs > currentTs) return true;
  if (incomingTs < currentTs) return false;
  // exact timestamp tie: deterministic tie-break on canonical value.
  // Numeric values compare numerically first — a lexical string compare
  // ("9" > "10") would otherwise pick the numerically smaller value.
  if (typeof incomingVal === 'number' && typeof currentVal === 'number') {
    return incomingVal > currentVal;
  }
  return canonicalValue(incomingVal) > canonicalValue(currentVal);
}

/** First-write-wins: incoming only wins if there is no current value at all. */
function fwwWins(incomingTs, incomingVal, currentTs, currentVal) {
  return currentTs === undefined;
}

/** Named strategies pluggable into Graph({ conflictResolution }). */
const CONFLICT_STRATEGIES = {
  lww: hamWins,
  fww: fwwWins,
};

class Graph {
  constructor(opts = {}) {
    // soul -> { field: value, ..., _meta: { field: { state: ts } } }
    this.nodes = new Map();
    this.listeners = new Map(); // soul -> Set<fn(node, changedFields)>
    this.wildcardListeners = new Set(); // fn(soul, node, changedFields)
    this.localClock = 0; // Lamport clock: monotonically increasing counter
    this.opts = opts;

    // Lamport clock configuration (tunable per deployment). Per-peer clock
    // monotonicity/replay detection lives in network.js (its own peerClocks
    // map, matched to its own per-connection message flow) — not duplicated
    // here, since graph.js has no notion of peer connections.
    this.CLOCK_MAX_JUMP = opts.clockMaxJump || 1000; // max clock steps ahead
    this.MAX_FIELDS_PER_NODE = opts.maxFieldsPerNode || 1000; // caps synchronous per-message work

    // Conflict resolution strategy: 'lww' (default), 'fww', or a custom
    // fn(incomingTs, incomingVal, currentTs, currentVal, incomingLamport, currentLamport) -> boolean
    const strategy = opts.conflictResolution || 'lww';
    this.resolveConflict = typeof strategy === 'function' ? strategy : CONFLICT_STRATEGIES[strategy];
    if (!this.resolveConflict) throw new Error(`unknown conflictResolution strategy: ${strategy}`);
  }

  _warnRejected(reason) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`nevil graph: mergeNode rejected input (${reason})`);
    }
  }

  _ensureNode(soul) {
    if (!this.nodes.has(soul)) {
      this.nodes.set(soul, { data: {}, state: {}, lamport: {} });
    }
    return this.nodes.get(soul);
  }

  /**
   * Serialize concurrent async merges to the SAME soul. Every public
   * mutation here already runs to completion synchronously within one
   * microtask (mergeField/mergeNode contain no `await`), so single-threaded
   * Node callers are already safe without this — that residual is real and
   * documented (see AGENTS.md). This exists for the one case that residual
   * doesn't cover: a caller wrapping mergeNode in their own async pipeline
   * (e.g. awaiting a signature-verify step per field before calling
   * mergeNode) where two concurrent async call-chains for the same soul
   * could otherwise interleave their non-atomic multi-step logic around
   * mergeNode even though mergeNode itself stays atomic. `withSoulLock`
   * gives such a caller an explicit, opt-in serialization point per soul
   * (not global — different souls never block each other) instead of
   * inventing their own locking or assuming Node's synchronity covers a
   * multi-await pipeline it doesn't.
   */
  async withSoulLock(soul, fn) {
    this._soulLocks = this._soulLocks || new Map();
    const prior = this._soulLocks.get(soul) || Promise.resolve();
    let release;
    const mine = prior.then(() => new Promise((resolve) => { release = resolve; }));
    this._soulLocks.set(soul, mine);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this._soulLocks.get(soul) === mine) this._soulLocks.delete(soul);
    }
  }

  /**
   * Merge a single field write into the graph, applying HAM.
   * Returns true if the write was accepted (changed local state).
   */
  mergeField(soul, field, value, ts, incomingLamport, currentLamport) {
    const node = this._ensureNode(soul);
    const currentTs = node.state[field];
    const currentVal = node.data[field];

    if (!this.resolveConflict(ts, value, currentTs, currentVal, incomingLamport, currentLamport)) {
      return false; // stale write, drop it — this is how eventual consistency works
    }

    node.data[field] = value;
    node.state[field] = ts;
    if (incomingLamport !== undefined) node.lamport[field] = incomingLamport;
    return true;
  }

  /**
   * Merge a whole node-shaped patch: { soul, field: value, ... } plus a
   * parallel timestamp map. This is the unit that gets sent over the wire
   * and written to the storage log. `lamportClock` is either a single
   * scalar applied to every field in this batch (the live network/local-
   * write path), a per-field map matching `timestamps`'s shape (the replay
   * path — storage persists/compacts node.lamport per field, since
   * different fields on the same soul can carry different historical
   * clocks), or omitted for a local write clocked with the next local
   * Lamport value.
   */
  mergeNode(soul, fields, timestamps, lamportClock) {
    // Never throws: this runs on the untrusted remote path (nevil.js's
    // _applyRemote calls it directly on network input with no try/catch),
    // so a malformed message must be rejected, not crash the process. Still
    // logged distinctly from a legitimate no-op merge — a caller building
    // directly on mergeNode (unlike put(), which throws before delegating
    // here) otherwise gets silent, indistinguishable data loss.
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      this._warnRejected('fields must be a plain object');
      return [];
    }
    if (timestamps === null || typeof timestamps !== 'object' || Array.isArray(timestamps)) {
      this._warnRejected('timestamps must be a plain object');
      return [];
    }
    const fieldNames = Object.keys(fields);
    if (fieldNames.length > this.MAX_FIELDS_PER_NODE) {
      this._warnRejected(`field count ${fieldNames.length} exceeds MAX_FIELDS_PER_NODE (${this.MAX_FIELDS_PER_NODE})`);
      return [];
    }
    const perField = lamportClock !== null && typeof lamportClock === 'object';
    let batchClock;
    if (!perField && lamportClock !== undefined) {
      // Clamp a Byzantine batch clock the same way the per-field path does,
      // so a single external message can't jump localClock arbitrarily far
      // ahead and permanently win every subsequent HAM comparison.
      const clamped = lamportClock > this.localClock + this.CLOCK_MAX_JUMP
        ? this.localClock + this.CLOCK_MAX_JUMP
        : lamportClock;
      if (clamped > this.localClock) this.localClock = clamped;
      this.localClock++; // increment after receiving external message
      batchClock = clamped;
    } else if (!perField) {
      this.localClock++; // local write advances the local clock
      batchClock = this.localClock;
    }

    const changed = [];
    for (const field of fieldNames) {
      const ts = timestamps[field];
      let incomingClock = perField ? lamportClock[field] : batchClock;
      // Byzantine clock guard: a peer advertising an implausibly large jump
      // ahead of our own clock would otherwise win every future HAM
      // comparison for this field forever (CLOCK_MAX_JUMP was previously
      // declared but never enforced). Clamp the accepted clock to at most
      // CLOCK_MAX_JUMP past our current localClock so one malicious message
      // can't permanently poison a field's conflict-resolution ordering.
      if (incomingClock !== undefined && incomingClock > this.localClock + this.CLOCK_MAX_JUMP) {
        incomingClock = this.localClock + this.CLOCK_MAX_JUMP;
      }
      if (perField && incomingClock !== undefined && incomingClock > this.localClock) this.localClock = incomingClock;
      const currentLamport = this.nodes.get(soul)?.lamport[field];
      if (this.mergeField(soul, field, fields[field], ts, incomingClock, currentLamport)) {
        changed.push(field);
      }
    }
    if (changed.length) this._notify(soul, changed);
    return changed;
  }

  /** Convenience for local writes: stamps every field with a monotonic ts and advances localClock via mergeNode. */
  put(soul, fields) {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError('put(soul, fields): fields must be a plain object');
    }
    // Monotonic within-process: real ties are broken by the Lamport clock (mergeNode
    // advances localClock on every local write), so this ts only needs to never repeat
    // or go backwards locally — Date.now() alone can repeat under tight-loop writes.
    // Only ever nudges ahead of Date.now() by the sub-millisecond amount needed to
    // stay monotonic under a same-millisecond write burst; once real time catches
    // back up, _lastPutTs tracks Date.now() again instead of drifting away from it
    // forever (the prior Math.max(Date.now(), prev+0.001) never came back down).
    const prev = this._lastPutTs || 0;
    this._lastPutTs = prev < Date.now() ? Date.now() : prev + 0.001;
    const now = this._lastPutTs;
    const timestamps = {};
    for (const f of Object.keys(fields)) timestamps[f] = now;
    return this.mergeNode(soul, fields, timestamps); // local write: mergeNode clocks it
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
    return () => {
      const set = this.listeners.get(soul);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(soul);
    };
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
      out[soul] = { data: node.data, state: node.state, lamport: node.lamport };
    }
    return out;
  }

  /** Load a previously serialized graph (used by storage on boot). */
  static fromJSON(obj) {
    const g = new Graph();
    for (const soul of Object.keys(obj || {})) {
      g.nodes.set(soul, {
        data: obj[soul].data || {},
        state: obj[soul].state || {},
        lamport: obj[soul].lamport || {},
      });
    }
    return g;
  }
}

module.exports = { Graph, isRef, ref, hamWins, fwwWins, CONFLICT_STRATEGIES, REF };
