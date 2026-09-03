#!/usr/bin/env node
/**
 * witness-btree-storage.js — real soul index over the append-only Storage.
 *
 * Exercises the actual Storage index contract (BTreeIndex) against the real
 * Storage class, including persist/load round-trip. Uses a temp log file so it
 * never clobbers real node data, and removes it afterwards.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Storage, BTreeIndex } = require('../storage.js');
const { Graph } = require('../graph.js');
const assert = require('assert');

const TMP = path.join(__dirname, '.witness-tmp-log.ndjson');

async function testBTreeStorage() {
  console.log('B-tree Storage Witness Test\n');

  if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
  const s = new Storage({ enableIndex: true, file: TMP });

  assert(s.index instanceof BTreeIndex, 'Storage.enableIndex should build a BTreeIndex');
  console.log('✓ Storage with enableIndex exposes a BTreeIndex');

  s.index.add('user:1');
  s.index.add('user:2');
  s.index.add('post:9');

  const prefixed = s.index.prefixMatch('user:');
  console.log('  prefixMatch("user:") =>', JSON.stringify(prefixed));
  assert.deepStrictEqual(prefixed, ['user:1', 'user:2'], 'prefixMatch returns sorted user souls');

  const ranged = s.index.rangeScan('post:', 'user:');
  console.log('  rangeScan("post:","user:") =>', JSON.stringify(ranged));
  assert.deepStrictEqual(ranged, ['post:9'], 'rangeScan returns sorted souls in [post:, user:)');

  const got = s.index.get('user:1');
  console.log('  get("user:1") =>', JSON.stringify(got));
  assert(got, 'get("user:1") returns the stored entry (truthy)');

  const missing = s.index.get('nope:0');
  console.log('  get("nope:0") =>', JSON.stringify(missing));
  assert.strictEqual(missing, undefined, 'get of a missing soul returns undefined');

  // Real persist -> load round-trip through the append-only log + index.
  await s.persist('user:1', { name: 'alice' }, { name: Date.now() });
  const g = await s.load(Graph);
  const loaded = g.get('user:1');
  console.log('  load().get("user:1") =>', JSON.stringify(loaded));
  assert(loaded && loaded.name === 'alice', 'persisted entry reloads through Storage.load');

  if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
  console.log('\n✅ All B-tree storage tests PASSED');
  return { success: true };
}

(async () => {
  try {
    await testBTreeStorage();
    process.exit(0);
  } catch (e) {
    console.error('\n❌ B-tree storage test failed:', e.message);
    console.error(e.stack);
    if (fs.existsSync(TMP)) fs.unlinkSync(TMP);
    process.exit(1);
  }
})();
