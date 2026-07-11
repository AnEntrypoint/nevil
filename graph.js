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
    // soul -> { data: { field: value, ... }, state: { field: ts, ... }, lamport: { field: clock, ... } }
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
    // Wall-clock counterpart to CLOCK_MAX_JUMP: bounds how far a field's HAM
    // timestamp may sit ahead of our own Date.now() observation, so a
    // Byzantine ts (e.g. Number.MAX_SAFE_INTEGER or Infinity) can't
    // permanently win every future tie-break the way an unbounded lamport
    // clock could before CLOCK_MAX_JUMP was enforced.
    this.TS_MAX_JUMP_MS = opts.tsMaxJumpMs || 5 * 60 * 1000;

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
    // localClock-at-entry: every ceiling/clamp below derives from this fixed
    // snapshot, never from this.localClock directly, because this.localClock
    // itself must not move until the loop below proves at least one field
    // was actually accepted — a message that contributes zero accepted data
    // (every field non-finite-ts, or every field losing HAM/FWW) must not be
    // able to ratchet localClock forward at all. Only real acceptance earns
    // a clock advance.
    const clockAtEntry = this.localClock;
    let batchClock; // per-field incomingClock for this batch
    let scalarAdvanceTo; // candidate localClock value, applied only on acceptance
    if (!perField && lamportClock !== undefined) {
      // Clamp a Byzantine batch clock the same way the per-field path does,
      // so a single external message can't jump localClock arbitrarily far
      // ahead and permanently win every subsequent HAM comparison. Advance
      // target sits one past max(clockAtEntry, clamped) — matching prior
      // "increment after receiving external message" semantics — so the
      // next local write's clock unambiguously exceeds this received one.
      batchClock = lamportClock > clockAtEntry + this.CLOCK_MAX_JUMP
        ? clockAtEntry + this.CLOCK_MAX_JUMP
        : lamportClock;
      scalarAdvanceTo = Math.max(clockAtEntry, batchClock) + 1;
    } else if (!perField) {
      batchClock = clockAtEntry + 1; // local write's candidate clock, applied only on acceptance
      scalarAdvanceTo = batchClock;
    }

    // Per-field lamport clamp ceiling computed ONCE, before the loop, from
    // the localClock value as it stood at message entry — not re-derived
    // from this.localClock after each field, which would let a per-field
    // 'staircase' map (field1: maxJump, field2: 2*maxJump, ...) advance
    // localClock by ~fieldCount * CLOCK_MAX_JUMP in a single call instead of
    // the documented single-message bound of CLOCK_MAX_JUMP.
    const perFieldCeiling = clockAtEntry + this.CLOCK_MAX_JUMP;
    let maxAcceptedClock = clockAtEntry;
    // Fixed, receiver-independent sanity ceiling for a field with no prior
    // stored ts (nothing yet to protect a tie-break against): a hardcoded
    // constant, identical on every peer regardless of receive time, unlike
    // Date.now() + TS_MAX_JUMP_MS. Only screens out genuinely absurd values
    // (e.g. Number.MAX_SAFE_INTEGER-class poisoning) that Number.isFinite
    // alone would let through.
    const ABSOLUTE_TS_SANITY_CEILING = 253402300799999; // year 9999 (fixed constant, not wall-clock)

    const changed = [];
    for (const field of fieldNames) {
      const ts = timestamps[field];
      if (!Number.isFinite(ts)) {
        this._warnRejected(`field '${field}' has a non-finite timestamp, skipping`);
        continue;
      }
      // Per-field ts ceiling derived from THIS FIELD's own currently-stored
      // ts (message/protocol-derived state, identical across every peer that
      // has merged the same prior history) rather than the receiving peer's
      // own Date.now() — a wall-clock-relative ceiling means two honest
      // peers merging the IDENTICAL message at different real moments can
      // land on different accept/reject outcomes for a borderline ts (one
      // peer's ceiling has advanced past it by the time it merges, the
      // other's hasn't), diverging on whether the field even changes at all,
      // not just which value wins. Bounding against the field's own history
      // is deterministic: currentTs (like localClock) only advances via
      // messages actually merged, never via real elapsed time. A field with
      // no prior ts yet has nothing to protect, so only the fixed absolute
      // sanity ceiling applies.
      const currentFieldTs = this.nodes.get(soul)?.state[field];
      const tsCeiling = currentFieldTs !== undefined
        ? currentFieldTs + this.TS_MAX_JUMP_MS
        : ABSOLUTE_TS_SANITY_CEILING;
      if (ts > tsCeiling) {
        this._warnRejected(`field '${field}' has a timestamp too far ahead of its recorded history, skipping`);
        continue;
      }

      let incomingClock = perField ? lamportClock[field] : batchClock;
      if (perField && incomingClock !== undefined && !Number.isFinite(incomingClock)) {
        this._warnRejected(`field '${field}' has a non-finite lamport clock, skipping`);
        continue;
      }
      // Byzantine clock guard: a peer advertising an implausibly large jump
      // ahead of our own clock would otherwise win every future HAM
      // comparison for this field forever (CLOCK_MAX_JUMP was previously
      // declared but never enforced). Clamp the accepted clock to at most
      // CLOCK_MAX_JUMP past our localClock-at-entry so one malicious message
      // can't permanently poison a field's conflict-resolution ordering.
      if (incomingClock !== undefined && incomingClock > perFieldCeiling) {
        incomingClock = perFieldCeiling;
      }
      const currentLamport = this.nodes.get(soul)?.lamport[field];
      // maxAcceptedClock only tracks clocks from fields mergeField actually
      // accepted — a rejected/losing write must not contribute to the clock
      // advance below, or a stream of garbage-ts/FWW-losing messages could
      // silently ratchet localClock with zero real data ever landing.
      if (this.mergeField(soul, field, fields[field], ts, incomingClock, currentLamport)) {
        changed.push(field);
        if (incomingClock !== undefined && incomingClock > maxAcceptedClock) {
          maxAcceptedClock = incomingClock;
        }
      }
    }
    // Advance localClock at most once, after the loop, and only when the
    // message actually contributed accepted data — never unconditionally
    // pre-loop. Local writes and scalar-clocked external writes advance to
    // clockAtEntry + 1 (matching prior single-write semantics); per-field
    // writes advance to the highest accepted (already-clamped) clock seen.
    if (changed.length) {
      const advanceTo = perField ? maxAcceptedClock : scalarAdvanceTo;
      if (advanceTo > this.localClock) this.localClock = advanceTo;
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

  /**
   * Each listener runs in its own try/catch: this fires synchronously inside
   * mergeNode/put, which itself runs synchronously inside network.js's raw
   * ws.on('message', ...) handler with no surrounding try/catch there — an
   * uncaught throw from one subscriber would otherwise propagate all the way
   * out and crash the process on the next inbound message it touches, and
   * would also prevent every OTHER subscriber (and the caller's post-merge
   * relay logic) from running at all.
   *
   * Each listener also receives its OWN shallow copy of the node, not a
   * shared reference — this.get(soul) is called fresh per invocation, so an
   * in-place field mutation by one listener (e.g. normalizing a value before
   * use) can never leak into what a later listener in the same notify pass
   * observes, including unrelated wildcard listeners.
   */
  _notify(soul, changedFields) {
    this.listeners.get(soul)?.forEach((fn) => {
      try {
        fn(this.get(soul), changedFields);
      } catch (err) {
        this._warnRejected(`listener for soul '${soul}' threw: ${err?.message || err}`);
      }
    });
    this.wildcardListeners.forEach((fn) => {
      try {
        fn(soul, this.get(soul), changedFields);
      } catch (err) {
        this._warnRejected(`wildcard listener threw: ${err?.message || err}`);
      }
    });
  }
}

module.exports = { Graph, isRef, ref, hamWins, fwwWins, CONFLICT_STRATEGIES, REF };
