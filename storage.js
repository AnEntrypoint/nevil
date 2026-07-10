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

class NodeLogStore {
  constructor(filePath) {
    this.fs = require('fs');
    this.path = require('path');
    this.filePath = filePath;
    const dir = this.path.dirname(filePath);
    if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
    if (!this.fs.existsSync(filePath)) this.fs.writeFileSync(filePath, '');
  }

  async appendEntries(entries) {
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await this.fs.promises.appendFile(this.filePath, lines, 'utf8');
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
    await this.fs.promises.writeFile(this.filePath, lines, 'utf8');
  }
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
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('log', 'readwrite');
      const store = tx.objectStore('log');
      for (const e of entries) store.add(e);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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
    const db = await this._ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('log', 'readwrite');
      const store = tx.objectStore('log');
      store.clear();
      for (const e of entries) store.add(e);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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
      this.log = new NodeLogStore(opts.file || './nevil-data/log.ndjson');
      this.reputationLog = new NodeLogStore(opts.reputationFile || './nevil-data/reputation.ndjson');
    } else {
      this.log = new BrowserLogStore(opts.dbName || 'nevil');
      this.reputationLog = new BrowserLogStore(opts.reputationDbName || `${opts.dbName || 'nevil'}-reputation`);
    }
    this.index = opts.enableIndex ? new BTreeIndex(opts) : null;
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
    for (const entry of entries) {
      g.mergeNode(entry.soul, entry.fields, entry.ts, entry.lamportClock);
      if (this.index) this.index.add(entry.soul);
    }
    return g;
  }

  /** Persist a batch of graph writes (called after every accepted merge). Carries the field-level lamportClock map so a future boot replays real causal order, not a re-inflated local count. */
  async persist(soul, fields, ts, lamportClock) {
    await this.log.appendEntries([{ soul, fields, ts, lamportClock }]);
    if (this.index) this.index.add(soul);
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
        && Object.values(node.data).every((v) => v === null);
      if (isFullyTombstoned) {
        purgedSouls.push(soul);
        continue;
      }
      entries.push({ soul, fields: node.data, ts: node.state, lamportClock: node.lamport });
    }
    for (const soul of purgedSouls) {
      graph.nodes.delete(soul);
      if (this.index) this.index.remove?.(soul);
    }
    await this.log.compact(entries);
    if (this.index) {
      this.index.rebuild(graph);
      this.index.flushMemtable();
      if (this.index.sstables.length >= this.index.SSTABLE_MERGE_THRESHOLD) {
        this.index.compactSSTables();
      }
    }
  }
}

module.exports = { Storage, BTreeIndex, NodeLogStore, BrowserLogStore, isNode };
