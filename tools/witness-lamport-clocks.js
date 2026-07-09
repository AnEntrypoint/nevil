#!/usr/bin/env node
/**
 * witness-lamport-clocks.js — real Lamport clock convergence.
 *
 * Two Graph instances receive clocked writes and must converge identically:
 * the higher Lamport clock wins a same-timestamp field; external merges
 * advance the local clock; and concurrent equal-timestamp reference writes
 * resolve to the same soul on both graphs via the deterministic tie-break.
 */

'use strict';

const { Graph, ref } = require('../graph.js');
const assert = require('assert');

function testLamportClocks() {
  console.log('Lamport Clock Witness Test\n');

  // Concurrent same-timestamp field writes: higher clock wins on both graphs.
  const gA = new Graph();
  const gB = new Graph();
  gA.mergeNode('s', { x: 1 }, { x: 100 }, 5); // A applies clock 5
  gB.mergeNode('s', { x: 2 }, { x: 100 }, 7); // B applies clock 7

  gA.mergeNode('s', { x: 2 }, { x: 100 }, 7); // A receives B's clock-7 write
  gB.mergeNode('s', { x: 1 }, { x: 100 }, 5); // B receives A's clock-5 write (rejected)

  const aVal = gA.get('s').x;
  const bVal = gB.get('s').x;
  console.log('  gA.x =', aVal, ' gB.x =', bVal);
  assert.strictEqual(aVal, 2, 'clock-7 value wins on A');
  assert.strictEqual(bVal, 2, 'clock-7 value wins on B');
  assert.strictEqual(aVal, bVal, 'both graphs converge on the clock-7 value');
  console.log('✓ Clock decides: both graphs settle on the higher-clock write');

  // Local clock advances on external merges.
  assert(gA.localClock > 7, 'local clock advanced past the highest seen external clock');
  console.log('✓ localClock advanced to ' + gA.localClock + ' after external merges');

  // Deterministic resolution of concurrent equal-timestamp reference writes.
  const gC = new Graph();
  const gD = new Graph();
  gC.mergeNode('s2', { r: ref('peerAAAA') }, { r: 100 }, 5);
  gD.mergeNode('s2', { r: ref('peerBBBB') }, { r: 100 }, 5);
  gC.mergeNode('s2', { r: ref('peerBBBB') }, { r: 100 }, 5); // C learns D's ref
  gD.mergeNode('s2', { r: ref('peerAAAA') }, { r: 100 }, 5); // D learns C's ref

  const cSoul = gC.get('s2').r['#'];
  const dSoul = gD.get('s2').r['#'];
  console.log('  resolved ref on C =', cSoul, ' on D =', dSoul);
  assert.strictEqual(cSoul, dSoul, 'concurrent refs resolve identically (deterministic tie-break)');
  assert.strictEqual(cSoul, 'peerBBBB', 'lexically-higher soul wins the tie');
  console.log('✓ Concurrent equal-timestamp refs converge deterministically');

  console.log('\n✅ All Lamport clock tests PASSED');
  return { success: true };
}

try {
  testLamportClocks();
  process.exit(0);
} catch (e) {
  console.error('\n❌ Lamport clock test failed:', e.message);
  console.error(e.stack);
  process.exit(1);
}
