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
 * SoulIndex — optional in-memory index for range queries and prefix scans.
 * Not persisted; rebuilt on boot from the log. Keyed by soul for fast prefix
 * lookups (e.g. all souls starting with 'user:' or 'post:').
 */
class SoulIndex {
  constructor() {
    this.souls = new Set(); // all known souls
  }

  add(soul) {
    this.souls.add(soul);
  }

  prefixMatch(prefix) {
    return Array.from(this.souls).filter((s) => s.startsWith(prefix)).sort();
  }

  rangeScan(start, end) {
    return Array.from(this.souls)
      .filter((s) => s >= start && s < end)
      .sort();
  }

  rebuild(graph) {
    this.souls.clear();
    for (const soul of graph.nodes.keys()) {
      this.souls.add(soul);
    }
  }
}

/**
 * Persistence facade used by the rest of the system. Wraps a log store
 * and knows how to replay it into a Graph, and how to persist new writes.
 * Optionally maintains a SoulIndex for range-query support.
 */
class Storage {
  constructor(opts = {}) {
    if (isNode) {
      this.log = new NodeLogStore(opts.file || './monogun-data/log.ndjson');
    } else {
      this.log = new BrowserLogStore(opts.dbName || 'monogun');
    }
    this.index = opts.enableIndex ? new SoulIndex() : null;
  }

  /** Replay the log into a fresh Graph on boot. */
  async load(GraphClass) {
    const entries = await this.log.readAll();
    const g = new GraphClass();
    for (const entry of entries) {
      g.mergeNode(entry.soul, entry.fields, entry.ts);
      if (this.index) this.index.add(entry.soul);
    }
    return g;
  }

  /** Persist a batch of graph writes (called after every accepted merge). */
  async persist(soul, fields, ts) {
    await this.log.appendEntries([{ soul, fields, ts }]);
    if (this.index) this.index.add(soul);
  }

  /** Rewrite the log to just the current graph state — call periodically. */
  async compact(graph) {
    const entries = [];
    for (const [soul, node] of graph.nodes) {
      entries.push({ soul, fields: node.data, ts: node.state });
    }
    await this.log.compact(entries);
    if (this.index) this.index.rebuild(graph);
  }
}

module.exports = { Storage, StorageIndex: SoulIndex, NodeLogStore, BrowserLogStore, isNode };
