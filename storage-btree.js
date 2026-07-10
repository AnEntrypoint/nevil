/**
 * storage-btree.js — soul index layer for prefix/range queries.
 *
 * Optional layer on top of the append-only log. Holds a memtable (in-memory
 * Map) plus flushed SSTables (also in-memory Maps keyed by soul). This is the
 * indexing structure, not a disk-backed B-tree: the on-disk log in storage.js
 * is already the durable store. Ranges are found by binary search over the
 * SSTable min/max soul bounds, so lookups stay cheap as tables accumulate.
 */

'use strict';

class BTreeIndex {
  constructor(opts = {}) {
    this.memtable = new Map(); // soul -> {data, state, timestamp}
    this.memtableSize = 0;

    // Tuning parameters (configurable per deployment).
    this.MEMTABLE_SIZE_LIMIT = opts.memtableSizeLimit || 10 * 1024 * 1024; // 10MB default
    this.MEMTABLE_FLUSH_FREQ = opts.memtableFlushFreq || 5 * 60 * 1000; // 5 min default
    this.SSTABLE_MERGE_THRESHOLD = opts.sstableMergeThreshold || 3; // merge when count >= 3

    this.memtableSizeLimit = this.MEMTABLE_SIZE_LIMIT;
    this.memtableFlushTime = opts.memtableFlushTime || Date.now();

    // SSTables kept sorted ascending by minSoul so get() can binary-search.
    this.sstables = []; // [{index: Map, minSoul, maxSoul, timestamp}]
  }

  /** Write entry to memtable. Returns true if a flush should follow. */
  write(soul, entry) {
    this.memtable.set(soul, entry);

    const entrySize = soul.length + JSON.stringify(entry).length + 100;
    this.memtableSize += entrySize;

    const now = Date.now();
    return (
      this.memtableSize > this.memtableSizeLimit ||
      (now - this.memtableFlushTime) > this.MEMTABLE_FLUSH_FREQ
    );
  }

  /** Record a soul in the index (idempotent). Flushes/compacts as needed. */
  add(soul, entry) {
    if (!entry) entry = { data: null, state: null, timestamp: Date.now() };
    const shouldFlush = this.write(soul, entry);
    if (shouldFlush) {
      this.flushMemtable();
      if (this.sstables.length >= this.SSTABLE_MERGE_THRESHOLD) {
        this.compactSSTables();
      }
    }
  }

  /** Rebuild the whole index from a graph (souls only; values are null). */
  rebuild(graph) {
    this.memtable.clear();
    this.memtableSize = 0;
    this.sstables = [];
    for (const soul of graph.nodes.keys()) {
      this.add(soul);
    }
  }

  /** Insert a flushed table in sorted position by minSoul. */
  _insertSSTable(table) {
    let lo = 0;
    let hi = this.sstables.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sstables[mid].minSoul < table.minSoul) lo = mid + 1;
      else hi = mid;
    }
    this.sstables.splice(lo, 0, table);
  }

  /** Flush memtable to a new SSTable (in-memory Map). */
  flushMemtable() {
    if (this.memtable.size === 0) return;

    const sorted = Array.from(this.memtable.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));

    const index = new Map(sorted);
    this._insertSSTable({
      index,
      minSoul: sorted[0][0],
      maxSoul: sorted[sorted.length - 1][0],
      timestamp: Date.now()
    });

    this.memtable.clear();
    this.memtableSize = 0;
    this.memtableFlushTime = Date.now();
  }

  /** Get entry for a soul via memtable, then binary search over SSTables. */
  get(soul) {
    const inMemtable = this.memtable.get(soul);
    if (inMemtable) return inMemtable;

    // sstables is sorted ascending by minSoul: find the rightmost table whose
    // range can contain the soul, then confirm against its maxSoul.
    let lo = 0;
    let hi = this.sstables.length - 1;
    let cand = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.sstables[mid].minSoul <= soul) {
        cand = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (cand >= 0) {
      const t = this.sstables[cand];
      if (soul <= t.maxSoul) {
        const entry = t.index.get(soul);
        if (entry) return entry;
      }
    }
    return undefined;
  }

  /** Collect [soul, entry] pairs for souls in [start, end). */
  _collectPairs(start, end) {
    const results = [];
    for (const [soul, entry] of this.memtable) {
      if (soul >= start && soul < end) results.push([soul, entry]);
    }
    for (const t of this.sstables) {
      if (t.maxSoul < start || t.minSoul >= end) continue;
      for (const [soul, entry] of t.index) {
        if (soul >= start && soul < end) results.push([soul, entry]);
      }
    }
    const deduped = new Map();
    results.sort((a, b) => {
      const tsDiff = (b[1].timestamp || 0) - (a[1].timestamp || 0);
      if (tsDiff !== 0) return tsDiff;
      return b[0].localeCompare(a[0]);
    });
    for (const [soul, entry] of results) {
      if (!deduped.has(soul)) deduped.set(soul, entry);
    }
    return Array.from(deduped.entries());
  }

  /** Range scan: return sorted soul strings in [start, end). */
  rangeScan(start, end) {
    return this._collectPairs(start, end)
      .map(([soul]) => soul)
      .sort();
  }

  /** Prefix scan: return [soul, entry] pairs for souls starting with prefix. */
  prefixScan(prefix) {
    // '￿' as an upper bound mis-includes/excludes souls containing
    // supplementary-plane (astral) characters, since those encode as
    // surrogate pairs that can compare above or below it depending on the
    // leading surrogate's code unit. Filtering by startsWith is exact for
    // any Unicode content, at the cost of a linear scan over the range
    // collected by a (still efficient) '￿'-bounded pre-filter.
    const end = prefix + '￿￿';
    return this._collectPairs(prefix, end).filter(([soul]) => soul.startsWith(prefix));
  }

  /** Prefix match: return sorted soul strings starting with prefix. */
  prefixMatch(prefix) {
    const out = [];
    for (const soul of this.memtable.keys()) {
      if (soul.startsWith(prefix)) out.push(soul);
    }
    for (const t of this.sstables) {
      for (const soul of t.index.keys()) {
        if (soul.startsWith(prefix)) out.push(soul);
      }
    }
    return out.sort();
  }

  /** Merge the two oldest SSTables into one (newer entry wins on tie). */
  compactSSTables() {
    if (this.sstables.length < 2) return;

    // Skip the newest table (last flushed); merge the two oldest.
    const idx1 = 0;
    const idx2 = 1;
    const old1 = this.sstables[idx1];
    const old2 = this.sstables[idx2];

    const merged = new Map();
    for (const [soul, entry] of old1.index) merged.set(soul, entry);
    for (const [soul, entry] of old2.index) {
      const existing = merged.get(soul);
      if (!existing || (entry.timestamp || 0) >= (existing.timestamp || 0)) {
        merged.set(soul, entry);
      }
    }

    const sorted = Array.from(merged.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));

    this.sstables.splice(idx1, 2);
    this._insertSSTable({
      index: new Map(sorted),
      minSoul: sorted[0][0],
      maxSoul: sorted[sorted.length - 1][0],
      timestamp: Date.now()
    });
  }

  /** All entries (memtable + all SSTables, deduplicated). */
  getAllEntries() {
    const all = new Map();
    for (const t of this.sstables) {
      for (const [soul, entry] of t.index) all.set(soul, entry);
    }
    for (const [soul, entry] of this.memtable) all.set(soul, entry);
    return Array.from(all.values());
  }

  /** Get stats for debugging. */
  getStats() {
    return {
      memtableEntries: this.memtable.size,
      memtableBytes: this.memtableSize,
      sstableCount: this.sstables.length,
      totalSSTables: this.sstables.reduce((sum, t) => sum + t.index.size, 0),
      sstableDetails: this.sstables.map((t, i) => ({
        index: i,
        entries: t.index.size,
        minSoul: t.minSoul,
        maxSoul: t.maxSoul
      }))
    };
  }
}

module.exports = { BTreeIndex };
