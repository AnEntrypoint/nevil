/**
 * storage.js — the RAD-equivalent persistence layer.
 *
 * Preference: an append-only newline-delimited JSON log, not a radix
 * tree. Rationale documented at the top of the project (see README):
 * simpler, trivially crash-safe (a torn last line is just dropped on
 * replay), and reconstructing the graph is a single O(n) pass on boot.
 *
 * Two backends behind one interface (`appendEntries` / `readAll`):
 *   - NodeLogStore: appends to a file with fs, using fs.appendFile.
 *   - BrowserLogStore: appends records to an IndexedDB object store.
 *
 * Both are append-only; compaction (rewriting the log to just current
 * state) is provided separately since it changes semantics.
 */

'use strict';

const { BTreeIndex } = require('./storage-btree.js');

const isNode = typeof window === 'undefined' && typeof process !== 'undefined' && !!process.versions?.node;

/** Iterative max, no arg-spread — Math.max(...arr) throws RangeError past the engine's call-stack argument limit for a node with a very large number of changed fields. */
function maxOf(values) {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return m;
}

class NodeLogStore {
  constructor(filePath, opts = {}) {
    this.fs = require('fs');
    this.path = require('path');
    this.filePath = filePath;
    this.fsyncOnWrite = !!opts.fsyncOnWrite;
    const dir = this.path.dirname(filePath);
    if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
    if (!this.fs.existsSync(filePath)) this.fs.writeFileSync(filePath, '');
  }

  async appendEntries(entries) {
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    // Serialize concurrent appends: two in-flight appendFile calls have no
    // ordering guarantee relative to each other, so a fast local write racing
    // an applied remote write could land out of logical order in the log,
    // diverging replay order from live merge order on next boot.
    const queue = (this._writeQueue || Promise.resolve()).then(async () => {
      // fsyncOnWrite trades throughput for surviving an OS-level crash (not just
      // a process crash — the append-only+torn-line format already handles
      // that): without it, the last buffered-but-unflushed write can be lost.
      if (this.fsyncOnWrite) {
        const fh = await this.fs.promises.open(this.filePath, 'a');
        try {
          await fh.appendFile(lines, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        await this.fs.promises.appendFile(this.filePath, lines, 'utf8');
      }
    });
    // Reset the queue head to a resolved promise on failure — otherwise a
    // single rejected write (disk full, EMFILE, transient permission error)
    // becomes the permanent chain head, and every future append/compact
    // rejects immediately without ever touching the filesystem again, even
    // after the underlying I/O problem clears. The original rejection still
    // propagates to THIS call's awaiter via the un-reset `queue` reference.
    this._writeQueue = queue.catch(() => {});
    await queue;
  }

  async readAll() {
    const raw = await this.fs.promises.readFile(this.filePath, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // torn/partial last line from a crash mid-write — drop it.
        // this is the entire reason the log format is append-only:
        // a corrupt tail can never corrupt earlier, already-fsynced entries.
      }
    }
    return out;
  }

  async compact(entries) {
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
    // Route through the same _writeQueue as appendEntries() — otherwise a
    // concurrent in-flight append and this unqueued write race at the OS
    // level, losing the append entirely or corrupting the log's trailing bytes.
    const queue = (this._writeQueue || Promise.resolve()).then(async () => {
      // Write to a sibling temp file, then rename over the real path — a
      // direct writeFile(filePath, 'w') truncates to zero bytes BEFORE writing
      // new content, so a crash mid-write loses the entire prior log body, not
      // just a torn tail (unlike appendEntries, which only ever adds bytes to
      // an intact file). rename() is atomic on both POSIX and Windows: readers
      // always see either the old complete file or the new complete file.
      const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      if (this.fsyncOnWrite) {
        const fh = await this.fs.promises.open(tmpPath, 'w');
        try {
          await fh.writeFile(lines, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        await this.fs.promises.writeFile(tmpPath, lines, 'utf8');
      }
      await this.fs.promises.rename(tmpPath, this.filePath);
    });
    // Same poisoning-recovery reset as appendEntries(): a failed compact must
    // not permanently disable every future append/compact on this store.
    this._writeQueue = queue.catch(() => {});
    await queue;
  }

  /** Atomic read-modify-write ON the write queue: reads the current file, applies transform(entries), then temp-file+rename writes the result — all as ONE queued task, so no concurrent appendEntries/compact can interleave between the snapshot read and the rewrite. A bare readAll()+compact() runs the read and the write as separate queue tasks, letting an append land in the gap and be silently dropped by the rewrite (the compactReputationLog delta-loss race). */
  async rewriteWith(transform) {
    const queue = (this._writeQueue || Promise.resolve()).then(async () => {
      const raw = await this.fs.promises.readFile(this.filePath, 'utf8');
      const entries = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
      const out = transform(entries);
      const lines = out.map((e) => JSON.stringify(e)).join('\n') + (out.length ? '\n' : '');
      const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      if (this.fsyncOnWrite) {
        const fh = await this.fs.promises.open(tmpPath, 'w');
        try {
          await fh.writeFile(lines, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        await this.fs.promises.writeFile(tmpPath, lines, 'utf8');
      }
      await this.fs.promises.rename(tmpPath, this.filePath);
    });
    this._writeQueue = queue.catch(() => {});
    await queue;
  }

  /** Await the current tail of the write queue — lets a caller (Storage.close()) wait for an in-flight/queued appendEntries or compact to actually reach disk before tearing down, instead of racing process exit against a fire-and-forget persist(). Never rejects: a failed write already resolves its own awaiter via the un-reset queue reference in appendEntries/compact, so drain() only needs to know the queue is IDLE, not whether the last write succeeded. */
  async drain() {
    await (this._writeQueue || Promise.resolve()).catch(() => {});
  }

  /** No file handle is held open between writes (each appendFile/writeFile call opens and closes its own), so there is nothing to release — present for interface parity with BrowserLogStore.close(). */
  close() {}
}

class BrowserLogStore {
  constructor(dbName) {
    this.dbName = dbName;
    this._ready = this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('log', { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async appendEntries(entries) {
    const run = () => this._ready.then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('log', 'readwrite');
      const store = tx.objectStore('log');
      for (const e of entries) store.add(e);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
    // Same ordering guarantee as NodeLogStore: serialize concurrent appends.
    const queue = (this._writeQueue || Promise.resolve()).then(run);
    // Reset on failure — see NodeLogStore.appendEntries for why an unguarded
    // reassignment here would permanently poison every future write.
    this._writeQueue = queue.catch(() => {});
    return queue;
  }

  async readAll() {
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('log', 'readonly');
      const store = tx.objectStore('log');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async compact(entries) {
    const run = () => this._ready.then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('log', 'readwrite');
      const store = tx.objectStore('log');
      store.clear();
      for (const e of entries) store.add(e);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
    // Same ordering guarantee as appendEntries(): serialize against any in-flight append.
    const queue = (this._writeQueue || Promise.resolve()).then(run);
    // Reset on failure — see NodeLogStore.appendEntries for why an unguarded
    // reassignment here would permanently poison every future write.
    this._writeQueue = queue.catch(() => {});
    return queue;
  }

  /** Atomic read-modify-write on the write queue — same contract as NodeLogStore.rewriteWith(): reads the store, applies transform, and overwrites, all within the SAME queued readwrite transaction so no concurrent append interleaves between snapshot and rewrite. */
  async rewriteWith(transform) {
    const run = () => this._ready.then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('log', 'readwrite');
      const store = tx.objectStore('log');
      const getReq = store.getAll();
      getReq.onsuccess = () => {
        const out = transform(getReq.result);
        store.clear();
        for (const e of out) store.add(e);
      };
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
    const queue = (this._writeQueue || Promise.resolve()).then(run);
    this._writeQueue = queue.catch(() => {});
    return queue;
  }

  /** Await the current tail of the write queue — same contract as NodeLogStore.drain(): lets a caller wait for an in-flight/queued write to actually reach IndexedDB before tearing down. Never rejects. */
  async drain() {
    await (this._writeQueue || Promise.resolve()).catch(() => {});
  }

  /** Release the open IndexedDB connection — without this, a discarded Storage/Nevil instance leaks a connection for the page's lifetime, which can block a later indexedDB.deleteDatabase() or a version-upgrade open from another tab. */
  close() {
    this._ready.then((db) => db.close()).catch(() => {});
  }
}

/**
 * Persistence facade used by the rest of the system. Wraps a log store
 * and knows how to replay it into a Graph, and how to persist new writes.
 * Optionally maintains a BTreeIndex for range-query / prefix-scan support.
 */
class Storage {
  constructor(opts = {}) {
    if (isNode) {
      this.log = new NodeLogStore(opts.file || './nevil-data/log.ndjson', { fsyncOnWrite: opts.fsyncOnWrite });
      this.reputationLog = new NodeLogStore(opts.reputationFile || './nevil-data/reputation.ndjson', { fsyncOnWrite: opts.fsyncOnWrite });
      this.peerTableLog = new NodeLogStore(opts.peerTableFile || './nevil-data/peers.ndjson', { fsyncOnWrite: opts.fsyncOnWrite });
    } else {
      this.log = new BrowserLogStore(opts.dbName || 'nevil');
      this.reputationLog = new BrowserLogStore(opts.reputationDbName || `${opts.dbName || 'nevil'}-reputation`);
      this.peerTableLog = new BrowserLogStore(opts.peerTableDbName || `${opts.dbName || 'nevil'}-peers`);
    }
    this.index = opts.enableIndex ? new BTreeIndex(opts) : null;
  }

  /**
   * Drain every in-flight/queued write (main log, reputation log, peer-table
   * log, and — when soul indexing is on — the BTreeIndex's own pending
   * disk-backed SSTable/manifest writes) before releasing the log stores'
   * underlying resources (IndexedDB connections in-browser; a no-op in
   * Node, which holds no file handle open between writes). Without this, a
   * write that already updated in-memory graph state (nevil.js's
   * graph.onAny handler calls storage.persist() unawaited, by design, since
   * that handler is synchronous) can still be sitting in a log store's
   * `_writeQueue` when close() returns — a caller following the documented
   * close()-then-exit shutdown pattern would then lose that write entirely,
   * even though it looked durable from every observable in-process signal
   * (graph.get() already reflected it). Now async: callers doing a graceful
   * shutdown should `await` it; existing fire-and-forget callers (a crash
   * handler, a synchronous teardown path) are unaffected since a dropped
   * returned promise behaves exactly like the prior fire-and-forget close().
   */
  async close() {
    await Promise.all([
      this.log.drain(),
      this.reputationLog.drain(),
      this.peerTableLog.drain(),
      this.index ? this.index.waitForPendingDiskWrites() : Promise.resolve(),
    ]);
    this.log.close();
    this.reputationLog.close();
    this.peerTableLog.close();
  }

  /**
   * Persist the learned peer table (dialed peer URLs + learned DHT routing
   * keys) so a restarted peer resumes from prior mesh knowledge instead of
   * only the peers passed at construction time, re-learning routing keys
   * from scratch via live traffic every restart. Snapshot-style (like
   * `compact`), not append-only — the peer table is small, current-state-
   * only data with no causal-ordering requirement.
   */
  async savePeerTable(peerUrls, routingKeys) {
    const entry = { peerUrls: Array.from(peerUrls), routingKeys: Array.from(routingKeys.entries()) };
    await this.peerTableLog.compact([entry]);
  }

  /** Load a previously-persisted peer table. Returns { peerUrls: [], routingKeys: [] } if none was ever saved. */
  async loadPeerTable() {
    const entries = await this.peerTableLog.readAll();
    const entry = entries[entries.length - 1];
    return entry || { peerUrls: [], routingKeys: [] };
  }

  /**
   * Replay the log into a fresh Graph on boot. Each entry replays with its
   * OWN persisted lamportClock (when present) rather than omitting it —
   * mergeNode only self-advances localClock past what it's given, so
   * replaying N historical entries no longer inflates localClock to ~N;
   * it converges on the true max clock seen across the log, exactly as if
   * those writes were being received live. `graphOpts` carries the
   * conflictResolution strategy (and any other Graph constructor option)
   * so a rebooted graph keeps the same conflict strategy it was
   * constructed with, not the class default.
   */
  async load(GraphClass, graphOpts) {
    const entries = await this.log.readAll();
    const g = new GraphClass(graphOpts);
    // When disk-backed SSTables are enabled, restore the index straight from
    // its own files first — cheaper than rebuilding every soul from scratch.
    // This is still only a head start, not a substitute for replay: any soul
    // that was sitting in the in-memory memtable (never flushed) at the time
    // of an unclean shutdown is absent from the disk snapshot but IS present
    // in the log, so the per-entry index.add() below always runs regardless
    // of disk-restore status — add() is idempotent, so re-adding a soul
    // already covered by a loaded SSTable is harmless, and it's the only way
    // to backfill souls the disk snapshot missed.
    if (this.index) await this.index.loadFromDisk();
    for (const entry of entries) {
      if (typeof entry?.soul !== 'string' || !entry.soul) {
        // A non-string/empty soul (undefined, number, etc.) is not a torn
        // line (JSON.parse succeeded) — it's a malformed entry that must
        // never be allowed to key a graph node, or it durably round-trips
        // through every future persist/load cycle. Skip + warn, same
        // pattern as the catch-block below for unexpected replay errors.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('storage.load: skipping log entry with invalid soul', entry?.soul);
        }
        continue;
      }
      try {
        g.mergeNode(entry.soul, entry.fields, entry.ts, entry.lamportClock);
        if (this.index) {
          const node = g.nodes.get(entry.soul);
          const maxTs = node ? maxOf(Object.values(node.state)) : Date.now();
          this.index.add(entry.soul, { data: node?.data ?? null, state: node?.state ?? null, timestamp: maxTs });
        }
      } catch (err) {
        // mergeNode() itself never throws (invalid fields/timestamps return []
        // rather than raising), so reaching here means something unexpected —
        // e.g. this.index.add throwing on a malformed entry. Surface it instead
        // of silently masking it: a single bad entry still must not abort the
        // whole boot replay, but a diagnostic trail beats a truncated boot with
        // no sign anything was skipped.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('storage.load: skipping log entry after unexpected error', entry?.soul, err?.message || err);
        }
      }
    }
    return g;
  }

  /** Persist a batch of graph writes (called after every accepted merge). Carries the field-level lamportClock map so a future boot replays real causal order, not a re-inflated local count. */
  async persist(soul, fields, ts, lamportClock) {
    // Reject before appending — a non-string/empty soul (e.g. undefined,
    // which JSON.stringify silently drops from the object entirely) would
    // otherwise write a garbage-keyed entry that durably round-trips through
    // load() and pollutes graph.nodes on every future boot.
    if (typeof soul !== 'string' || !soul) throw new TypeError('storage.persist: soul must be a non-empty string');
    await this.log.appendEntries([{ soul, fields, ts, lamportClock }]);
    // The durable write above already succeeded once this line runs — an
    // index.add() failure past this point is an in-memory index desync, not
    // a durability failure, so it must not surface through the same
    // rejection path/message as an appendEntries failure (which callers like
    // nevil.js's _onPersistError log as "write remains in-memory, not yet
    // durable" — false for this case, since the log entry is already on
    // disk). Tag the error so a caller can tell the two apart.
    if (this.index) {
      try {
        const maxTs = ts ? maxOf(Object.values(ts)) : Date.now();
        this.index.add(soul, { data: fields, state: ts, timestamp: maxTs });
      } catch (err) {
        const indexErr = err instanceof Error ? err : new Error(String(err));
        indexErr.durable = true;
        indexErr.indexOnly = true;
        throw indexErr;
      }
    }
  }

  /** Append one reputation-ledger entry ({peerId, delta, reason, timestamp}) to durable storage, so throttle/Byzantine state survives a restart instead of resetting every peer to neutral. */
  async persistReputationEntry(entry) {
    await this.reputationLog.appendEntries([entry]);
  }

  /** Replay the persisted reputation ledger — called on boot to rebuild Network's in-memory ledger/cache. */
  async loadReputationLedger() {
    return this.reputationLog.readAll();
  }

  /**
   * Rewrite the reputation log to one summed entry per peerId, mirroring
   * `compact()`'s soul-keyed rewrite but keyed by peerId instead — without
   * this, a long-running peer with heavy reputation churn grows an
   * ever-larger append-only reputation log with no bound, unlike the main
   * graph log which already has this compaction path. The summed entry
   * preserves the peer's cumulative score (what `restoreReputationLedger`
   * actually needs) while collapsing however many individual deltas it took
   * to reach it; the most recent reason/timestamp is kept for diagnostics.
   */
  async compactReputationLog() {
    // rewriteWith runs read+sum+rewrite as ONE queued write task, so a
    // concurrent persistReputationEntry() append can never land between the
    // snapshot read and the rewrite and be silently dropped by it.
    await this.reputationLog.rewriteWith((entries) => {
      const summed = new Map(); // peerId -> { peerId, delta, reason, timestamp }
      for (const entry of entries) {
        if (!entry || typeof entry.peerId !== 'string' || typeof entry.delta !== 'number') continue;
        const prior = summed.get(entry.peerId);
        summed.set(entry.peerId, {
          peerId: entry.peerId,
          delta: (prior ? prior.delta : 0) + entry.delta,
          reason: entry.reason,
          timestamp: entry.timestamp,
        });
      }
      return Array.from(summed.values());
    });
  }

  /**
   * Rewrite the log to just the current graph state — call periodically.
   * Carries each field's persisted lamport clock (node.lamport) so
   * compaction doesn't erase causal ordering on the next boot.
   *
   * `purgeDeleted: true` additionally reclaims souls that are fully
   * tombstoned (every field null, as `nevil.delete()` leaves them) —
   * without this, delete() only ever nulls fields; the soul and its
   * history persist in the log and every replica forever. Purging drops
   * the soul from the compacted log AND from the in-memory graph/index,
   * so a later boot never sees it again. This is local-only: other peers
   * that already replicated the tombstone keep it until they purge too.
   */
  async compact(graph, opts = {}) {
    const entries = [];
    const purgedSouls = [];
    for (const [soul, node] of graph.nodes) {
      const isFullyTombstoned = opts.purgeDeleted && Object.keys(node.data).length > 0
        && Object.values(node.data).every((v) => v === null || v === undefined);
      if (isFullyTombstoned) {
        purgedSouls.push(soul);
        continue;
      }
      entries.push({ soul, fields: node.data, ts: node.state, lamportClock: node.lamport });
    }
    // Persist FIRST, delete from live graph.nodes only after that succeeds —
    // otherwise a failed log.compact() (disk full, permission error) leaves
    // memory ahead of disk: the soul vanishes from the running process while
    // the still-intact on-disk log (never successfully rewritten) still
    // contains it, so a reload from that same log would resurrect it. A
    // thrown compact() must never durably diverge in-memory state from what
    // was actually committed.
    await this.log.compact(entries);
    // Re-check each purge candidate against the LIVE graph, not the
    // pre-await snapshot: a concurrent write (e.g. a remote revival applied
    // via nevil._applyRemote -> graph.mergeNode -> storage.persist) can land
    // on graph.nodes and its own log entry while log.compact()'s I/O is in
    // flight above. Deleting unconditionally from the stale purgedSouls list
    // would drop that revived, now-live soul from the graph even though the
    // log (and index) still correctly hold its revived data — a durable,
    // non-self-healing divergence. A soul is only deleted here if it is
    // STILL fully tombstoned at this point in time.
    for (const soul of purgedSouls) {
      const node = graph.nodes.get(soul);
      if (!node) continue;
      const stillTombstoned = Object.keys(node.data).length > 0
        && Object.values(node.data).every((v) => v === null || v === undefined);
      if (stillTombstoned) graph.nodes.delete(soul);
    }
    if (this.index) {
      await this.index.rebuild(graph);
      this.index.flushMemtable();
      if (this.index.sstables.length >= this.index.SSTABLE_MERGE_THRESHOLD) {
        this.index.compactSSTables();
      }
    }
  }
}

module.exports = { Storage, BTreeIndex, NodeLogStore, BrowserLogStore, isNode };
