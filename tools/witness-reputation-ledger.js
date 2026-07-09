#!/usr/bin/env node
/**
 * witness-reputation-ledger.js — verify reputation tracking and throttle gating
 */

'use strict';

const { Network } = require('../network.js');
const assert = require('assert');

function testReputationLedger() {
  console.log('Reputation Ledger Witness Test\n');

  // Test 1: Append-only ledger records deltas
  const net1 = new Network({});
  assert.strictEqual(net1.getReputation('peer-a'), 0, 'Initial reputation should be 0');

  net1.updateReputation('peer-a', 1, 'good');
  assert.strictEqual(net1.getReputation('peer-a'), 1, 'Reputation should increment by 1');
  assert.strictEqual(net1.reputationLedger.length, 1, 'Ledger should have 1 entry');

  net1.updateReputation('peer-a', 1, 'good');
  assert.strictEqual(net1.getReputation('peer-a'), 2, 'Reputation should increment again');
  assert.strictEqual(net1.reputationLedger.length, 2, 'Ledger should have 2 entries');

  console.log('✓ Append-only ledger records all deltas');

  // Test 2: Delta rules applied correctly
  const net2 = new Network({});
  net2.updateReputation('peer-b', 1, 'good');
  net2.updateReputation('peer-b', -1, 'malformed');
  net2.updateReputation('peer-b', -5, 'replay');
  net2.updateReputation('peer-b', -3, 'byzantine');
  net2.updateReputation('peer-b', 10, 'routing-help');

  const finalRep = net2.getReputation('peer-b');
  assert.strictEqual(finalRep, 1 - 1 - 5 - 3 + 10, 'Deltas should sum to 2');
  assert.strictEqual(net2.reputationLedger.length, 5, 'Ledger should have 5 entries');

  const ledger = net2.getReputationLedger('peer-b');
  assert.strictEqual(ledger.length, 5, 'Filtering ledger by peer should return 5 entries');
  assert.strictEqual(ledger[2].reason, 'replay', 'Third entry should be replay');

  console.log('✓ Delta rules applied correctly');

  // Test 3: Throttle gating states
  const net3 = new Network({});

  // Good reputation: accept
  net3.updateReputation('peer-c', 10, 'good');
  assert.strictEqual(net3.getThrottleState('peer-c'), 'accept', 'rep >= 0 should accept');

  // Neutral reputation: queue ([-10, 0))
  net3.updateReputation('peer-d', -5, 'malformed');
  assert.strictEqual(net3.getThrottleState('peer-d'), 'queue', 'rep in [-10,0) should queue');

  // Bad reputation: drop
  net3.updateReputation('peer-e', -15, 'byzantine');
  assert.strictEqual(net3.getThrottleState('peer-e'), 'drop', 'rep < -10 should drop');

  console.log('✓ Throttle gating: accept/queue/drop states correct');

  // Test 4: Byzantine isolation detection
  const net4 = new Network({});
  net4.updateReputation('peer-f', -25, 'byzantine');

  assert(net4.isByzantineIsolated('peer-f', -20), 'rep -25 < threshold -20 should be isolated');
  assert(!net4.isByzantineIsolated('peer-f', -30), 'rep -25 not < threshold -30 should not be isolated');
  assert(net4.isByzantineIsolated('peer-f'), 'rep -25 with default threshold -20 should be isolated');

  console.log('✓ Byzantine isolation detection works');

  // Test 5: Message queue initialization
  const net5 = new Network({});
  assert(Array.isArray(net5.messageQueue), 'messageQueue should be initialized as array');
  assert.strictEqual(net5.messageQueue.length, 0, 'messageQueue should start empty');

  console.log('✓ Message queue initialized');

  // Test 6: Multiple peers tracked independently
  const net6 = new Network({});
  net6.updateReputation('peer-g', 5, 'good');
  net6.updateReputation('peer-h', -8, 'malformed');
  net6.updateReputation('peer-i', -20, 'byzantine');

  assert.strictEqual(net6.getReputation('peer-g'), 5, 'peer-g should have rep 5');
  assert.strictEqual(net6.getReputation('peer-h'), -8, 'peer-h should have rep -8');
  assert.strictEqual(net6.getReputation('peer-i'), -20, 'peer-i should have rep -20');

  assert.strictEqual(net6.getThrottleState('peer-g'), 'accept', 'peer-g should accept');
  assert.strictEqual(net6.getThrottleState('peer-h'), 'queue', 'peer-h should queue');
  assert.strictEqual(net6.getThrottleState('peer-i'), 'drop', 'peer-i should drop');

  console.log('✓ Multiple peers tracked independently with correct throttle states');

  console.log('\n✅ All reputation ledger tests PASSED');
  return { success: true, testsRun: 6 };
}

try {
  const result = testReputationLedger();
  console.log('\nFinal result:', JSON.stringify(result, null, 2));
  process.exit(0);
} catch (e) {
  console.error('\n❌ Test failed:', e.message);
  console.error(e.stack);
  process.exit(1);
}
