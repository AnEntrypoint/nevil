#!/usr/bin/env node
/**
 * witness-dht-routing.js — verify DHT routing peer selection logic
 * Tests: geohash computation, health scoring, fallback broadcast
 */

'use strict';

const { Network } = require('../network.js');
const assert = require('assert');

function testDHTRouting() {
  console.log('DHT Routing Witness Test\n');

  // Test 1: Geohash computation
  const net = new Network({ dhtEnabled: true, dhtK: 2, dhtL: 1 });
  const soul1 = 'abcd1234efgh5678' + 'a'.repeat(48); // Valid 64-char hex (keypair soul)
  const soul2 = 'regular-soul-name';

  const gh1 = net._computeGeohash(soul1);
  const gh2 = net._computeGeohash(soul2);
  console.log(`✓ Geohash(keypair soul): ${gh1}`);
  console.log(`✓ Geohash(regular soul): ${gh2}`);
  assert(gh1.length === 4, 'Geohash must be 4 chars');
  assert(gh2.length === 4, 'Geohash must be 4 chars');

  // Test 2: Health scoring and peer selection
  for (let i = 0; i < 5; i++) {
    net.updatePeerHealth(`peer-${i}`, 10 + i * 5, 0.01 * i); // latency: 10, 15, 20, 25, 30
  }

  const healthyPeers = net.getHealthyPeers();
  console.log(`\n✓ Healthy peers (sorted by latency): ${JSON.stringify(healthyPeers)}`);
  assert(healthyPeers.length === 5, 'All 5 peers should have health scores');
  assert(healthyPeers[0] === 'peer-0', 'peer-0 has lowest latency, should be first');

  // Test 3: Peer selection via DHT
  const msg = { id: 'test-msg', soul: soul1 };
  const selected = net._selectRoutingPeers(msg);
  console.log(`\n✓ Peers selected for routing (K=2, L=1): ${JSON.stringify(Array.from(selected))}`);
  assert(selected.size >= 2, 'Should select at least K=2 peers');
  assert(selected.size <= 5, 'Should not select more than available peers');

  // Test 4: Fallback to broadcast when no healthy peers
  const netNoHealth = new Network({ dhtEnabled: true, dhtK: 3 });
  const selectedFallback = netNoHealth._selectRoutingPeers(msg);
  console.log(`\n✓ Fallback broadcast (no healthy peers): ${selectedFallback.size} peers selected`);
  // When no health info available, should fallback to broadcasting to all (which is 0 here since no sockets)

  // Test 5: DHT disable switch
  const netDisabled = new Network({ dhtEnabled: false });
  for (let i = 0; i < 3; i++) {
    netDisabled.updatePeerHealth(`peer-${i}`, 10, 0);
  }
  const selectedDisabled = netDisabled._selectRoutingPeers(msg);
  console.log(`\n✓ DHT disabled (broadcast mode): ${selectedDisabled.size} peers`);
  assert(selectedDisabled.size === 3, 'With DHT disabled, should select all peers (broadcast)');

  // Test 6: Metrics collection
  const metrics = net.getMetrics();
  console.log(`\n✓ Network metrics: ${JSON.stringify(metrics.latencies, null, 2)}`);
  assert(metrics.peersConnected === 0, 'No connected peers (local test)');

  console.log('\n✅ All DHT routing tests PASSED');
  return { success: true, testsRun: 6, peersSelected: selected.size };
}

try {
  const result = testDHTRouting();
  console.log('\nFinal result:', JSON.stringify(result, null, 2));
  process.exit(0);
} catch (e) {
  console.error('\n❌ Test failed:', e.message);
  console.error(e.stack);
  process.exit(1);
}
