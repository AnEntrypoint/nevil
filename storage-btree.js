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

const isNode = typeof window === 'undefined' && typeof process !== 'undefined' && !!process.versions?.node;

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

    // Disk-backed SSTable persistence (opt-in, off by default — the base
    // index is otherwise purely in-memory, rebuilt from the append-only log
    // on every boot in O(n)). When enabled, each flushed SSTable is also
    // serialized to its own file under sstableDir, plus a manifest listing
    // active table files; loadFromDisk() lets boot restore the index
    // straight from these files instead of only replaying the full log,
    // giving a real O(sstable count) boot path for the index specifically
    // (the log remains the durable source of truth either way).
    this.SSTABLE_DISK_ENABLED = isNode && opts.sstableDiskEnabled === true;
    this.sstableDir = opts.sstableDir || './nevil-data/sstables';
    this._nextSstableFileId = 0;
    if (this.SSTABLE_DISK_ENABLED) {
      this.fs = require('fs');
      this.path = require('path');
      if (!this.fs.existsSync(this.sstableDir)) this.fs.mkdirSync(this.sstableDir, { recursive: true });
    }
  }

  /** Serialize one SSTable to its own file and update the manifest. Fire-and-forget from callers that don't await disk I/O on the hot write path; errors are surfaced via the returned promise for callers that do want to await/catch. */
  async _persistSSTable(table, fileId) {
    if (!this.SSTABLE_DISK_ENABLED) return;
    const filePath = this.path.join(this.sstableDir, `sstable-${fileId}.json`);
    const serialized = {
      minSoul: table.minSoul,
      maxSoul: table.maxSoul,
      timestamp: table.timestamp,
      entries: Array.from(table.index.entries()),
    };
    await this.fs.promises.writeFile(filePath, JSON.stringify(serialized), 'utf8');
    table._fileId = fileId;
    await this._writeManifest();
  }

  async _writeManifest() {
    // Serialize concurrent manifest writes the same way NodeLogStore
    // serializes log appends (storage.js): flushMemtable's fire-and-forget
    // persist and a synchronous compactSSTables() triggered right after it
    // can each independently reach this method, and unqueued writeFile calls
    // have no ordering guarantee, so whichever's OS-level completion lands
    // last silently wins even if it snapshotted this.sstables first. Reading
    // this.sstables inside the queued closure (not before enqueuing) ensures
    // each write reflects the state current at its own turn, not a stale one.
    this._manifestWriteQueue = (this._manifestWriteQueue || Promise.resolve()).then(() => {
      const manifest = this.sstables
        .filter((t) => t._fileId !== undefined)
        .map((t) => t._fileId);
      return this.fs.promises.writeFile(this.path.join(this.sstableDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    });
    await this._manifestWriteQueue;
  }

  /** Remove a persisted SSTable's file (called after compaction removes it from memory). */
  async _deleteSSTableFile(fileId) {
    if (!this.SSTABLE_DISK_ENABLED || fileId === undefined) return;
    const filePath = this.path.join(this.sstableDir, `sstable-${fileId}.json`);
    try {
      await this.fs.promises.unlink(filePath);
    } catch (err) {
      if (err?.code === 'ENOENT') return; // already gone — benign
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('BTreeIndex: failed to delete SSTable file', filePath, err?.message || err);
      }
    }
  }

  /**
   * Restore SSTables from disk (called on boot instead of / before log
   * replay repopulates the memtable) — this is the real O(sstable count)
   * boot path the in-memory-only index couldn't offer: reading a handful of
   * pre-sorted SSTable files back is far cheaper than replaying the entire
   * append-only log to rebuild the index from scratch.
   */
  async loadFromDisk() {
    if (!this.SSTABLE_DISK_ENABLED) return false;
    const manifestPath = this.path.join(this.sstableDir, 'manifest.json');
    if (!this.fs.existsSync(manifestPath)) return false;
    let manifest;
    try {
      manifest = JSON.parse(await this.fs.promises.readFile(manifestPath, 'utf8'));
    } catch (err) {
      // Truncated/corrupt manifest from a crash mid-writeFile — the log is
      // still the source of truth, so report no valid snapshot and let the
      // caller fall back to a full log replay instead of aborting boot.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('BTreeIndex: corrupt manifest.json, falling back to log replay', err?.message || err);
      }
      return false;
    }
    this.sstables = [];
    let maxFileId = -1;
    for (const fileId of manifest) {
      const filePath = this.path.join(this.sstableDir, `sstable-${fileId}.json`);
      if (!this.fs.existsSync(filePath)) continue; // torn/missing file — skip, same tolerance as the log's torn-line handling
      let raw;
      try {
        raw = JSON.parse(await this.fs.promises.readFile(filePath, 'utf8'));
      } catch (err) {
        // Truncated/corrupt SSTable file — skip it, same tolerance as a
        // missing file above; its souls are still recoverable from the log.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('BTreeIndex: corrupt sstable file, skipping', filePath, err?.message || err);
        }
        continue;
      }
      const table = {
        index: new Map(raw.entries),
        minSoul: raw.minSoul,
        maxSoul: raw.maxSoul,
        timestamp: raw.timestamp,
        _fileId: fileId,
      };
      this._insertSSTable(table);
      if (fileId > maxFileId) maxFileId = fileId;
    }
    this._nextSstableFileId = maxFileId + 1;
    return true;
  }

  /** Write entry to memtable. Returns true if a flush should follow. */
  write(soul, entry) {
    const existing = this.memtable.get(soul);
    if (existing) this.memtableSize -= soul.length + JSON.stringify(existing).length + 100;
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

  /** Rebuild the whole index from a graph, carrying each node's real data/state. */
  async rebuild(graph) {
    // Tables still mid-flush (fire-and-forget disk persist from flushMemtable)
    // have no _fileId yet — awaiting here first ensures every current table's
    // _fileId is finalized before staleFileIds is computed below, otherwise an
    // in-flight persist would land its file on disk *after* this.sstables has
    // already been replaced, permanently orphaning it (never in staleFileIds,
    // never referenced by the post-rebuild manifest either).
    await Promise.all(this.sstables.map((t) => t._persistPromise).filter(Boolean));

    // Every table being cleared here may have a disk file from a prior flush;
    // rebuild() replaces them all with freshly-flushed tables under new file
    // ids, so the old files must be deleted or they leak on disk forever
    // (unlike compactSSTables, which already deletes the tables it replaces).
    const staleFileIds = this.SSTABLE_DISK_ENABLED
      ? this.sstables.map((t) => t._fileId).filter((id) => id !== undefined)
      : [];
    this.memtable.clear();
    this.memtableSize = 0;
    this.sstables = [];
    // Use write()/flushMemtable()/compactSSTables() directly instead of
    // add(): add() is designed for live traffic where its fire-and-forget
    // disk persist can safely outlive the caller. rebuild() instead needs to
    // know about and await every persist ITS OWN loop triggers before it
    // writes the final manifest below — otherwise a loop-triggered flush's
    // _persistSSTable (which itself calls _writeManifest once the file lands)
    // races the unconditional call at the end of this method and can lose,
    // leaving the manifest referencing fewer tables than actually exist on
    // disk (or none at all if every in-loop persist is still pending).
    const pending = [];
    for (const [soul, node] of graph.nodes) {
      let maxTs = 0;
      for (const v of Object.values(node.state)) if (v > maxTs) maxTs = v;
      const shouldFlush = this.write(soul, { data: node.data, state: node.state, timestamp: maxTs });
      if (shouldFlush) {
        const flushed = this.flushMemtable();
        if (flushed?._persistPromise) pending.push(flushed._persistPromise);
        if (this.sstables.length >= this.SSTABLE_MERGE_THRESHOLD) {
          pending.push(this.compactSSTables());
        }
      }
    }
    if (this.memtable.size > 0) {
      const flushed = this.flushMemtable();
      if (flushed?._persistPromise) pending.push(flushed._persistPromise);
    }
    // Await every persist/compaction the loop above triggered — including
    // ones chained after this point in the shared _compactionPromise queue —
    // before touching stale-file cleanup or the manifest, so _fileId is
    // settled on every table currently in this.sstables.
    await Promise.all(pending);
    await Promise.all(this.sstables.map((t) => t._persistPromise).filter(Boolean));
    if (staleFileIds.length) {
      await Promise.all(staleFileIds.map((id) => this._deleteSSTableFile(id))).catch((err) => {
        if (typeof console !== 'undefined' && console.error) {
          console.error('BTreeIndex: failed to delete stale SSTable file during rebuild', err?.message || err);
        }
      });
    }
    // Rewrite the manifest unconditionally so it reflects the actual current
    // this.sstables set once stale files are gone and every in-loop persist
    // has settled (awaited above) — otherwise this.sstableDir's manifest.json
    // can keep referencing deleted fileIds, or omit just-written ones,
    // indefinitely until an unrelated later flush overwrites it.
    if (this.SSTABLE_DISK_ENABLED) await this._writeManifest();
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

  /** Flush memtable to a new SSTable (in-memory Map). Persists to disk too when SSTABLE_DISK_ENABLED. Returns the new table, or undefined if the memtable was empty. */
  flushMemtable() {
    if (this.memtable.size === 0) return undefined;

    const sorted = Array.from(this.memtable.entries())
      .sort((a, b) => a[0].localeCompare(b[0]));

    const index = new Map(sorted);
    const table = {
      index,
      minSoul: sorted[0][0],
      maxSoul: sorted[sorted.length - 1][0],
      timestamp: Date.now()
    };
    this._insertSSTable(table);

    this.memtable.clear();
    this.memtableSize = 0;
    this.memtableFlushTime = Date.now();

    if (this.SSTABLE_DISK_ENABLED) {
      const fileId = this._nextSstableFileId++;
      table._persistPromise = this._persistSSTable(table, fileId)
        .catch((err) => {
          if (typeof console !== 'undefined' && console.error) {
            console.error('BTreeIndex: failed to persist SSTable to disk', err?.message || err);
          }
        })
        .finally(() => { table._persistPromise = null; });
    }
    return table;
  }

  /**
   * Get entry for a soul: binary-search SSTables for a fast candidate, then
   * always compare it (and any other table whose range contains the soul)
   * against the memtable entry by timestamp — mirroring _collectPairs'
   * timestamp-based dedup used by rangeScan/prefixScan. Two un-compacted
   * SSTables can share the same minSoul (the same soul flushed twice before
   * SSTABLE_MERGE_THRESHOLD merges them), and _insertSSTable's tie-break
   * does not guarantee the newer of a tied pair sorts where the binary
   * search below would land on it first — trusting the first hit
   * unconditionally can return stale data. A plain memtable-always-wins
   * shortcut has the same defect if the memtable ever holds an older
   * timestamp for a soul than an already-flushed SSTable (e.g. after a
   * rebuild() replay). Comparing timestamps across every candidate, exactly
   * like the range/prefix scan path already does, keeps get() consistent
   * with them on identical index state.
   */
  get(soul) {
    let best;
    const inMemtable = this.memtable.get(soul);
    if (inMemtable) best = inMemtable;

    // sstables is sorted ascending by minSoul: find the rightmost table whose
    // range can contain the soul as a fast-path candidate.
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
        if (entry && (!best || (entry.timestamp || 0) >= (best.timestamp || 0))) best = entry;
      }
    }
    // Compaction merges tables by age, not always in a way that preserves
    // strictly sorted, non-overlapping [minSoul, maxSoul] ranges relative to
    // every other table, and un-compacted flushes can leave multiple tables
    // with overlapping/tied ranges for the same soul. The binary search
    // above is a fast-path candidate, not the final answer: scan every table
    // whose range could contain the soul and keep the newest entry, so a hit
    // on one table never shadows a newer value sitting in another.
    for (const t of this.sstables) {
      if (soul < t.minSoul || soul > t.maxSoul) continue;
      const entry = t.index.get(soul);
      if (entry && (!best || (entry.timestamp || 0) >= (best.timestamp || 0))) best = entry;
    }
    return best;
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

  /** Prefix match: return sorted, deduplicated soul strings starting with prefix. */
  prefixMatch(prefix) {
    // A soul flushed to an SSTable and then rewritten (now sitting in the
    // memtable, or in a newer SSTable after the older one hasn't compacted
    // yet) must appear once, not once per source — reuse prefixScan's
    // dedup instead of an independent two-loop-plus-sort with none.
    return this.prefixScan(prefix).map(([soul]) => soul).sort();
  }

  /**
   * Merge the two oldest SSTables into one. Serialized behind
   * _compactionPromise (mirroring _writeManifest's _manifestWriteQueue):
   * add() fires this unawaited on every flush past SSTABLE_MERGE_THRESHOLD,
   * so a synchronous burst (boot replay, rebuild()'s per-soul loop) launches
   * many overlapping calls that would otherwise all race for the same
   * oldest-two-tables pair — only one survives per burst (indexOf-miss
   * guard below no-ops the rest), leaving table count roughly proportional
   * to burst size instead of converging toward the threshold. Chaining onto
   * a single in-flight promise makes concurrent triggers run one-at-a-time
   * instead of overlapping.
   */
  compactSSTables() {
    this._compactionPromise = (this._compactionPromise || Promise.resolve())
      .then(() => this._compactSSTablesOnce());
    return this._compactionPromise;
  }

  async _compactSSTablesOnce() {
    if (this.sstables.length < 2) return;

    // `sstables` is sorted by minSoul for get()'s binary search, not by age —
    // merging positions [0,1] merged by soul-range position, not recency,
    // silently starving tables at higher soul-range positions from ever being
    // compacted under a write pattern spread across the whole keyspace. Pick
    // the two lowest-timestamp tables by value instead of by array position.
    let idx1 = 0;
    let idx2 = 1;
    if (this.sstables[idx2].timestamp < this.sstables[idx1].timestamp) {
      [idx1, idx2] = [idx2, idx1];
    }
    for (let i = 2; i < this.sstables.length; i++) {
      const ts = this.sstables[i].timestamp;
      if (ts < this.sstables[idx1].timestamp) {
        idx2 = idx1;
        idx1 = i;
      } else if (ts < this.sstables[idx2].timestamp) {
        idx2 = i;
      }
    }

    const old1 = this.sstables[idx1];
    const old2 = this.sstables[idx2];

    // A table just flushed by flushMemtable() may still have its
    // fire-and-forget disk persist in flight, with _fileId not yet assigned
    // (set inside _persistSSTable once the write resolves). Wait for it here
    // so oldFileIds below sees the real id instead of undefined, otherwise
    // the original file is spliced out of memory but never deleted from disk.
    if (old1._persistPromise) await old1._persistPromise;
    if (old2._persistPromise) await old2._persistPromise;

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

    // Re-locate old1/old2 by identity rather than trusting idx1/idx2: the
    // await above yields to the event loop, so a concurrent add() may have
    // spliced this.sstables (inserted a new flush, run its own compaction)
    // and shifted every position since idx1/idx2 were computed.
    const pos1 = this.sstables.indexOf(old1);
    const pos2 = this.sstables.indexOf(old2);
    if (pos1 === -1 || pos2 === -1) return;
    const [hi, lo] = pos1 > pos2 ? [pos1, pos2] : [pos2, pos1];
    this.sstables.splice(hi, 1);
    this.sstables.splice(lo, 1);
    const mergedTable = {
      index: new Map(sorted),
      minSoul: sorted[0][0],
      maxSoul: sorted[sorted.length - 1][0],
      timestamp: Date.now()
    };
    this._insertSSTable(mergedTable);

    if (this.SSTABLE_DISK_ENABLED) {
      const oldFileIds = [old1._fileId, old2._fileId].filter((id) => id !== undefined);
      const fileId = this._nextSstableFileId++;
      // Assigned the same way flushMemtable() assigns it on a freshly flushed
      // table, so any later wait-guard (rebuild(), a subsequent compaction
      // picking this table as old1/old2) can detect and await this table's
      // still-in-flight disk write instead of reading undefined as "nothing
      // pending" and racing past it.
      mergedTable._persistPromise = this._persistSSTable(mergedTable, fileId)
        .then(() => Promise.all(oldFileIds.map((id) => this._deleteSSTableFile(id))))
        .catch((err) => {
          if (typeof console !== 'undefined' && console.error) {
            console.error('BTreeIndex: failed to persist compacted SSTable to disk', err?.message || err);
          }
        })
        .finally(() => { mergedTable._persistPromise = null; });
    }
  }

  /** All entries (memtable + all SSTables, deduplicated by newest timestamp — mirrors get()/_collectPairs). */
  getAllEntries() {
    const all = new Map();
    const keep = (soul, entry) => {
      const existing = all.get(soul);
      if (!existing || (entry.timestamp || 0) >= (existing.timestamp || 0)) all.set(soul, entry);
    };
    for (const t of this.sstables) {
      for (const [soul, entry] of t.index) keep(soul, entry);
    }
    for (const [soul, entry] of this.memtable) keep(soul, entry);
    return Array.from(all.values());
  }

  /**
   * Await every currently in-flight disk-backed persistence operation this
   * index has outstanding: per-table `_persistPromise`s (from flushMemtable
   * and compactSSTables), the manifest write queue, and any in-flight
   * compaction. Called from `Storage.close()` so a caller following the
   * documented graceful-shutdown pattern (`close()` then process exit)
   * doesn't leave an orphaned partial `sstable-N.json` with no manifest
   * entry, or a manifest write that never lands. A no-op when
   * SSTABLE_DISK_ENABLED is off (nothing was ever queued to disk). Never
   * rejects: each underlying promise already swallows its own I/O error via
   * its own .catch (see flushMemtable/_compactSSTablesOnce), so there is
   * nothing further to propagate here.
   */
  async waitForPendingDiskWrites() {
    if (!this.SSTABLE_DISK_ENABLED) return;
    await (this._compactionPromise || Promise.resolve()).catch(() => {});
    await Promise.all(this.sstables.map((t) => t._persistPromise).filter(Boolean)).catch(() => {});
    await (this._manifestWriteQueue || Promise.resolve()).catch(() => {});
  }

  /** Get stats for debugging. */
  getStats() {
    return {
      memtableEntries: this.memtable.size,
      memtableBytes: this.memtableSize,
      sstableCount: this.sstables.length,
      totalSSTableEntries: this.sstables.reduce((sum, t) => sum + t.index.size, 0),
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
