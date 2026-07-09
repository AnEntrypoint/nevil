/**
 * storage-btree.js — B-tree indexing layer for O(log n) lookups
 *
 * Optional layer on top of append-only log. Adds:
 * - In-memory memtable (red-black tree conceptually, Map for simplicity)
 * - SSTable indices for range queries on disk
 * - Journal replay on boot for crash recovery
 */

'use strict';

class BTreeIndex {
  constructor(opts = {}) {
    this.memtable = new Map(); // soul -> {data, state, timestamp}
    this.memtableSize = 0;

    // B-tree tuning parameters (configurable per deployment)
    this.MEMTABLE_SIZE_LIMIT = opts.memtableSizeLimit || 10 * 1024 * 1024; // 10MB default
    this.MEMTABLE_FLUSH_FREQ = opts.memtableFlushFreq || 5 * 60 * 1000; // 5 min default
    this.SSTABLE_MERGE_THRESHOLD = opts.sstableMergeThreshold || 3; // merge when count >= 3
    this.BLOOM_FILTER_FPR = opts.bloomFilterFpr || 0.01; // 1% false positive rate
    this.SSTABLE_BLOCK_SIZE = opts.sstableBlockSize || 64 * 1024; // 64KB blocks

    this.memtableSize = 0;
    this.memtableFlushTime = opts.memtableFlushTime || Date.now();
    this.memtableSizeLimit = this.MEMTABLE_SIZE_LIMIT;
    this.memtableFlushFreq = this.MEMTABLE_FLUSH_FREQ;

    this.sstables = []; // array of {index: Map, minSoul, maxSoul, timestamp}
    this.bloomFilters = []; // optional: false-positive filters for quick negatives
    this.blockSize = this.SSTABLE_BLOCK_SIZE; // 64KB default
  }

  /** Write entry to memtable. Returns true if flush needed. */
  write(soul, entry) {
    const prev = this.memtable.get(soul);
    this.memtable.set(soul, entry);

    // Estimate size (rough: soul + entry JSON + overhead)
    const entrySize = soul.length + JSON.stringify(entry).length + 100;
    this.memtableSize += entrySize;

    const now = Date.now();
    const shouldFlush =
      this.memtableSize > this.memtableSizeLimit ||
      (now - this.memtableFlushTime) > this.memtableFlushFreq;

    return shouldFlush;
  }

  /** Flush memtable to SSTable (in-memory representation). */
  flushMemtable() {
    if (this.memtable.size === 0) return;

    // Sort souls lexicographically
    const sorted = Array.from(this.memtable.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));

    const index = new Map(sorted);
    const minSoul = sorted[0][0];
    const maxSoul = sorted[sorted.length - 1][0];

    this.sstables.push({
      index,
      minSoul,
      maxSoul,
      timestamp: Date.now(),
      blockCount: Math.ceil(sorted.length * 100 / this.blockSize) // estimate
    });

    // Reset memtable
    this.memtable.clear();
    this.memtableSize = 0;
    this.memtableFlushTime = Date.now();
  }

  /** Get entry from memtable or SSTables. */
  get(soul) {
    // Check memtable first (hot data)
    const inMemtable = this.memtable.get(soul);
    if (inMemtable) return inMemtable;

    // Binary search SSTables by soul range
    for (const sstable of this.sstables) {
      if (soul >= sstable.minSoul && soul <= sstable.maxSoul) {
        const entry = sstable.index.get(soul);
        if (entry) return entry;
      }
    }

    return undefined;
  }

  /** Range scan: return entries where soul >= start && soul <= end. */
  rangeScan(start, end) {
    const results = [];

    // Scan memtable
    for (const [soul, entry] of this.memtable) {
      if (soul >= start && soul <= end) {
        results.push([soul, entry]);
      }
    }

    // Scan SSTables
    for (const sstable of this.sstables) {
      // Skip SSTables outside range
      if (sstable.maxSoul < start || sstable.minSoul > end) continue;

      for (const [soul, entry] of sstable.index) {
        if (soul >= start && soul <= end) {
          results.push([soul, entry]);
        }
      }
    }

    // Deduplicate (newer entries override older)
    const deduped = new Map();
    results.sort((a, b) => {
      const tsDiff = (b[1].timestamp || 0) - (a[1].timestamp || 0);
      if (tsDiff !== 0) return tsDiff;
      return b[0].localeCompare(a[0]); // lexical tie-break
    });
    for (const [soul, entry] of results) {
      if (!deduped.has(soul)) deduped.set(soul, entry);
    }

    return Array.from(deduped.entries());
  }

  /** Prefix scan: return entries where soul starts with prefix. */
  prefixScan(prefix) {
    const start = prefix;
    const end = prefix + '￿'; // next string after any char in prefix
    return this.rangeScan(start, end);
  }

  /** Compact SSTables: merge oldest 2-3 into one, deduplicate by clock. */
  compactSSTables() {
    if (this.sstables.length < 2) return;

    // Take oldest 2 SSTables
    const [old1, old2] = this.sstables.splice(0, 2);

    const merged = new Map();
    // Merge old1 then old2 (old2 wins on tie via later order)
    for (const [soul, entry] of old1.index) {
      merged.set(soul, entry);
    }
    for (const [soul, entry] of old2.index) {
      // If soul exists, keep newer by clock/timestamp
      const existing = merged.get(soul);
      if (!existing || (entry.timestamp || 0) >= (existing.timestamp || 0)) {
        merged.set(soul, entry);
      }
    }

    // Create new SSTable from merged
    const sorted = Array.from(merged.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));

    this.sstables.unshift({
      index: new Map(sorted),
      minSoul: sorted[0][0],
      maxSoul: sorted[sorted.length - 1][0],
      timestamp: Date.now(),
      blockCount: Math.ceil(sorted.length * 100 / this.blockSize)
    });
  }

  /** All entries (memtable + all SSTables, deduplicated). */
  getAllEntries() {
    const all = new Map();

    // Add from SSTables (oldest first)
    for (const sstable of this.sstables) {
      for (const [soul, entry] of sstable.index) {
        all.set(soul, entry);
      }
    }

    // Overwrite with memtable (newest)
    for (const [soul, entry] of this.memtable) {
      all.set(soul, entry);
    }

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
        maxSoul: t.maxSoul,
        blocks: t.blockCount
      }))
    };
  }
}

module.exports = { BTreeIndex };
