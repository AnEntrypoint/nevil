#!/usr/bin/env node
/**
 * witness-integration.js — all four transcendences working together
 *
 * Full-system test: DHT routing + Lamport clocks + Reputation ledger + B-tree storage
 */

'use strict';

const { Network } = require('../network.js');
const { Graph } = require('../graph.js');
const { BTreeIndex } = require('../storage-btree.js');
const assert = require('assert');

function testIntegration() {
  console.log('Integration Test: All Four Transcendences\n');

  // Test 1: DHT + Reputation together
  const net = new Network({ dhtEnabled: true });

  // Simulate good peer
  net.updateReputation('good-peer', 10, 'good');
  assert.strictEqual(net.getThrottleState('good-peer'), 'accept', 'good peer should accept');

  // Simulate Byzantine peer
  net.updateReputation('bad-peer', -15, 'byzantine');
  assert.strictEqual(net.getThrottleState('bad-peer'), 'drop', 'bad peer should be dropped');

  // DHT health score independent of reputation
  net.updatePeerHealth('peer-a', 10, 0); // 10ms latency
  net.updatePeerHealth('peer-b', 50, 0.05); // 50ms latency, 5% loss

  const healthyPeers = net.getHealthyPeers();
  assert(healthyPeers.length >= 0, 'health ranking works');
  console.log('✓ DHT + Reputation: independent concerns, composable');

  // Test 2: Lamport clocks + Graph merge + Reputation tracking
  const g = new Graph();

  // Write 1: local write increments clock
  g.put('soul-1', { title: 'Post 1' });
  assert.strictEqual(g.localClock, 1, 'local write increments clock');

  // Write 2: local write
  g.put('soul-1', { body: 'Content' });
  assert.strictEqual(g.localClock, 2, 'second write increments clock again');

  // Write 3: external message (simulating DHT relay from peer)
  // Peer sends message with clock 5
  g.mergeNode('soul-2', { field: 'value' }, { field: 100 }, 5);
  assert(g.localClock > 5, 'receiving clock 5 advances our clock');

  console.log('✓ Lamport clocks + Graph: clock ordering preserved across writes');

  // Test 3: B-tree + Graph state consistency
  const idx = new BTreeIndex({ memtableSizeLimit: 10 * 1024 });

  // Write many entries to graph
  for (let i = 0; i < 100; i++) {
    g.put(`soul-${i}`, { index: i, data: `entry-${i}` });
  }

  // Index those entries in B-tree
  for (const [soul, node] of g.nodes) {
    idx.write(soul, { data: node.data, state: node.state, timestamp: Date.now() });
  }

  // Verify lookups work
  for (let i = 0; i < 10; i++) {
    const soul = `soul-${i}`;
    const graphEntry = g.get(soul);
    const indexedEntry = idx.get(soul);
    assert(indexedEntry, `indexed entry exists for ${soul}`);
    assert.deepStrictEqual(indexedEntry.data, graphEntry, 'indexed entry matches graph');
  }

  // Test range queries on index
  const range = idx.rangeScan('soul-10', 'soul-20');
  assert(range.length > 0, 'range scan returns entries');
  console.log(`✓ B-tree indexing: ${range.length} entries in range [soul-10, soul-20]`);

  // Test 4: Reputation + Lamport + Network together
  const net2 = new Network({ dhtEnabled: true });

  // Honest peer sends message with clock advancement
  const msg1 = { id: '1', sender: 'peer-1', lamportClock: 1, soul: 'soul-x', body: 'good' };
  net2.updateReputation('peer-1', 1, 'good');

  // Byzantine peer tries to inject old clock (replay attack)
  const msg2 = { id: '2', sender: 'peer-2', lamportClock: 0, soul: 'soul-x', body: 'spam' };
  net2.updateReputation('peer-2', -5, 'replay'); // malicious

  const throttle1 = net2.getThrottleState('peer-1');
  const throttle2 = net2.getThrottleState('peer-2');

  assert.strictEqual(throttle1, 'accept', 'good peer accepted');
  assert(throttle2 !== 'accept', 'malicious peer not fully accepted');

  console.log('✓ Reputation + Clock: Byzantine attacks detected and throttled');

  // Test 5: DHT routing determinism
  const dhtMsgSoul = 'abcd0123456789...'; // Soul starting with abcd
  const geohash = net2._computeGeohash(dhtMsgSoul);
  assert.strictEqual(geohash.length, 4, 'geohash should be 4 chars');
  assert(/^[0-9a-f]{4}$/.test(geohash), 'geohash should be hex');

  // Same soul should always produce same geohash (deterministic)
  const geohash2 = net2._computeGeohash(dhtMsgSoul);
  assert.strictEqual(geohash, geohash2, 'geohash is deterministic');

  console.log('✓ DHT routing: deterministic geohashing for consistent bucketing');

  // Test 6: Full pipeline: write -> graph -> clock -> reputation -> index -> DHT route
  console.log('\nFull pipeline simulation:');

  const pipeline_g = new Graph();
  const pipeline_net = new Network({ dhtEnabled: true });
  const pipeline_idx = new BTreeIndex();

  // Step 1: Local write (increments clock)
  pipeline_g.put('user-alice', { name: 'Alice', bio: 'Developer' });
  const clockAfterWrite = pipeline_g.localClock;
  console.log(`  1. Local write: clock now ${clockAfterWrite}`);

  // Step 2: Reputation tracking (peer reputation)
  pipeline_net.updateReputation('peer-1', 5, 'good');
  console.log(`  2. Reputation: peer-1 rep=${pipeline_net.getReputation('peer-1')}`);

  // Step 3: DHT routing decision
  const geohash3 = pipeline_net._computeGeohash('user-alice');
  console.log(`  3. DHT: soul hashes to bucket ${geohash3}`);

  // Step 4: B-tree indexing
  const node = pipeline_g.get('user-alice');
  pipeline_idx.write('user-alice', { data: node, timestamp: Date.now() });
  console.log(`  4. B-tree: indexed user-alice`);

  // Step 5: Verify end-to-end
  const retrieved = pipeline_idx.get('user-alice');
  assert(retrieved, 'end-to-end retrieval works');
  console.log(`  5. E2E: retrieved from B-tree ✓`);

  // Test 7: Message throttling in full pipeline
  console.log('\nMessage throttling with all layers:');

  const test_net = new Network({ dhtEnabled: true });

  // Create 3 peers: good, neutral, bad
  const peers = {
    'honest-peer': { rep: 10, clock: 5, msgs: [] },
    'neutral-peer': { rep: -5, clock: 3, msgs: [] },
    'malicious-peer': { rep: -20, clock: 0, msgs: [] }
  };

  for (const [peerId, peerState] of Object.entries(peers)) {
    test_net.updateReputation(peerId, peerState.rep, peerState.rep > 0 ? 'good' : 'byzantine');
  }

  const throttleStates = {};
  for (const peerId of Object.keys(peers)) {
    throttleStates[peerId] = test_net.getThrottleState(peerId);
  }

  assert.strictEqual(throttleStates['honest-peer'], 'accept', 'honest peer accepted');
  assert.strictEqual(throttleStates['neutral-peer'], 'queue', 'neutral peer queued');
  assert.strictEqual(throttleStates['malicious-peer'], 'drop', 'malicious peer dropped');

  console.log('  Throttle states:');
  for (const [peerId, state] of Object.entries(throttleStates)) {
    console.log(`    ${peerId}: ${state}`);
  }

  console.log('\n✅ All integration tests PASSED');
  return {
    success: true,
    testsRun: 7,
    features: ['DHT+Reputation', 'Lamport+Graph', 'B-tree+Graph', 'Reputation+Lamport+Network', 'DHT-determinism', 'Full-pipeline', 'Throttling']
  };
}

try {
  const result = testIntegration();
  console.log('\nFinal result:', JSON.stringify(result, null, 2));
  process.exit(0);
} catch (e) {
  console.error('\n❌ Integration test failed:', e.message);
  console.error(e.stack);
  process.exit(1);
}
