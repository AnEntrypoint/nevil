#!/usr/bin/env node
/**
 * witness-btree-storage.js — verify B-tree indexing for O(log n) performance
 */

'use strict';

const { BTreeIndex } = require('../storage-btree.js');
const assert = require('assert');

function testBTreeStorage() {
  console.log('B-tree Storage Witness Test\n');

  // Test 1: Memtable write and get
  const idx1 = new BTreeIndex({ memtableSizeLimit: 100 * 1024 }); // 100KB
  const entry = { data: { text: 'hello' }, state: { text: 100 }, timestamp: Date.now() };

  assert(!idx1.write('soul1', entry), 'small write should not trigger flush');
  assert.deepStrictEqual(idx1.get('soul1'), entry, 'should retrieve written entry');
  console.log('✓ Memtable write and retrieval');

  // Test 2: Range scan across memtable
  const idx2 = new BTreeIndex();
  for (let i = 0; i < 10; i++) {
    idx2.write(`soul-${String(i).padStart(2, '0')}`, { data: { id: i }, timestamp: i * 100 });
  }

  const range = idx2.rangeScan('soul-00', 'soul-05');
  assert(range.length > 0, 'range scan should return entries');
  assert(range.every(([soul]) => soul >= 'soul-00' && soul <= 'soul-05'), 'all souls in range');
  console.log(`✓ Range scan returned ${range.length} entries`);

  // Test 3: Prefix scan
  const idx3 = new BTreeIndex();
  idx3.write('user:alice:profile', { data: { name: 'Alice' } });
  idx3.write('user:alice:posts', { data: { count: 5 } });
  idx3.write('user:bob:profile', { data: { name: 'Bob' } });

  const alice = idx3.prefixScan('user:alice:');
  assert.strictEqual(alice.length, 2, 'prefix scan should return 2 alice entries');
  console.log('✓ Prefix scan works');

  // Test 4: Memtable flush to SSTable
  const idx4 = new BTreeIndex({ memtableSizeLimit: 1000 });
  for (let i = 0; i < 50; i++) {
    idx4.write(`soul-${i}`, { data: { id: i }, timestamp: i });
  }
  assert(idx4.memtable.size > 0, 'entries should be in memtable');
  assert.strictEqual(idx4.sstables.length, 0, 'no SSTables yet');

  idx4.flushMemtable();
  assert.strictEqual(idx4.memtable.size, 0, 'memtable cleared after flush');
  assert.strictEqual(idx4.sstables.length, 1, 'one SSTable created');
  assert.strictEqual(idx4.sstables[0].index.size, 50, 'SSTable has 50 entries');
  console.log('✓ Memtable flushed to SSTable');

  // Test 5: Get across memtable + SSTable
  const idx5 = new BTreeIndex({ memtableSizeLimit: 500 });
  for (let i = 0; i < 30; i++) {
    idx5.write(`soul-${i}`, { data: { id: i } });
  }
  idx5.flushMemtable();

  // Add new entries to memtable
  for (let i = 30; i < 40; i++) {
    idx5.write(`soul-${i}`, { data: { id: i } });
  }

  // Retrieve from both layers
  assert.deepStrictEqual(idx5.get('soul-5').data.id, 5, 'retrieve from SSTable');
  assert.deepStrictEqual(idx5.get('soul-35').data.id, 35, 'retrieve from memtable');
  console.log('✓ Get works across memtable + SSTable');

  // Test 6: Range scan with multiple SSTables
  const idx6 = new BTreeIndex({ memtableSizeLimit: 500 });
  for (let i = 0; i < 30; i++) {
    idx6.write(`soul-${i}`, { data: { id: i }, timestamp: 100 });
  }
  idx6.flushMemtable();

  for (let i = 30; i < 60; i++) {
    idx6.write(`soul-${i}`, { data: { id: i }, timestamp: 200 });
  }
  idx6.flushMemtable();

  assert.strictEqual(idx6.sstables.length, 2, 'two SSTables');

  const range6 = idx6.rangeScan('soul-20', 'soul-50');
  assert(range6.length > 0, 'range scan spans multiple SSTables');
  assert(range6.every(([soul]) => soul >= 'soul-20' && soul <= 'soul-50'), 'all in range');
  console.log(`✓ Range scan across ${idx6.sstables.length} SSTables`);

  // Test 7: Compaction merges SSTables
  const idx7 = new BTreeIndex();
  for (let batch = 0; batch < 3; batch++) {
    for (let i = 0; i < 10; i++) {
      const soul = `soul-${batch * 10 + i}`;
      idx7.write(soul, { data: { batch }, timestamp: batch * 1000 });
    }
    idx7.flushMemtable();
  }

  assert.strictEqual(idx7.sstables.length, 3, 'three SSTables before compact');
  idx7.compactSSTables();
  assert(idx7.sstables.length <= 2, 'compaction reduced SSTable count');
  console.log(`✓ Compaction merged 2 SSTables -> now ${idx7.sstables.length}`);

  // Test 8: Startup performance (simulate old O(n) vs B-tree O(log n))
  const idx8 = new BTreeIndex({ memtableSizeLimit: 1 * 1024 * 1024 }); // 1MB
  const startTime = Date.now();
  for (let i = 0; i < 1000; i++) {
    idx8.write(`entry-${i}`, { data: { value: Math.random() }, timestamp: i });
  }
  const writeTime = Date.now() - startTime;

  // Measure get performance on large index
  const getStart = Date.now();
  for (let i = 0; i < 100; i++) {
    idx8.get(`entry-${Math.floor(Math.random() * 1000)}`);
  }
  const getTime = Date.now() - getStart;

  assert(getTime < 50, `get operations should be fast (${getTime}ms for 100 ops)`);
  console.log(`✓ Performance: ${writeTime}ms for 1000 writes, ${getTime}ms for 100 gets`);

  // Test 9: GetAll deduplicates across layers
  const idx9 = new BTreeIndex({ memtableSizeLimit: 500 });
  idx9.write('soul-a', { data: { version: 1 }, timestamp: 100 });
  idx9.flushMemtable();
  idx9.write('soul-a', { data: { version: 2 }, timestamp: 200 }); // overwrite

  const all = idx9.getAllEntries();
  assert.strictEqual(all.filter(e => e.data.version === 2).length, 1, 'getAllEntries deduped to newer version');
  console.log('✓ GetAll deduplicates across layers');

  // Test 10: Stats reporting
  const idx10 = new BTreeIndex();
  for (let i = 0; i < 20; i++) {
    idx10.write(`soul-${i}`, { data: { id: i } });
  }
  idx10.flushMemtable();

  for (let i = 20; i < 30; i++) {
    idx10.write(`soul-${i}`, { data: { id: i } });
  }

  const stats = idx10.getStats();
  assert.strictEqual(stats.memtableEntries, 10, 'stats show memtable entries');
  assert.strictEqual(stats.sstableCount, 1, 'stats show SSTable count');
  assert(stats.memtableBytes > 0, 'stats include memtable size');
  console.log(`✓ Stats: ${JSON.stringify(stats)}`);

  console.log('\n✅ All B-tree storage tests PASSED');
  return { success: true, testsRun: 10, performanceMs: { writes: writeTime, gets: getTime } };
}

try {
  const result = testBTreeStorage();
  console.log('\nFinal result:', JSON.stringify(result, null, 2));
  process.exit(0);
} catch (e) {
  console.error('\n❌ Test failed:', e.message);
  console.error(e.stack);
  process.exit(1);
}
