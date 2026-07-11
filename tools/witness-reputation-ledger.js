#!/usr/bin/env node
/**
 * witness-reputation-ledger.js — reputation tracking + live throttle gating.
 *
 * Keeps the correct unit checks (append-only ledger, throttle states, Byzantine
 * isolation) and adds a REAL in-flow test: a bad-signature message from a peer
 * with reputation already below the drop threshold is dropped on the live
 * receive path, and the network auto-records a further 'byzantine' delta.
 */

'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { Network } = require('../network.js');
const assert = require('assert');

function unitChecks() {
  console.log('Reputation Ledger Witness Test\n');

  const net1 = new Network({});
  assert.strictEqual(net1.getReputation('peer-a'), 0, 'initial reputation is 0');
  net1.updateReputation('peer-a', 1, 'good');
  net1.updateReputation('peer-a', 1, 'good');
  assert.strictEqual(net1.getReputation('peer-a'), 2, 'ledger sums deltas');
  assert.strictEqual(net1.reputationLedger.length, 2, 'ledger records every delta (append-only)');
  console.log('✓ Append-only ledger sums correctly');

  const net2 = new Network({});
  net2.updateReputation('peer-b', 1, 'good');
  net2.updateReputation('peer-b', -1, 'malformed');
  net2.updateReputation('peer-b', -5, 'replay');
  net2.updateReputation('peer-b', -3, 'byzantine');
  net2.updateReputation('peer-b', 10, 'routing-help');
  assert.strictEqual(net2.getReputation('peer-b'), 1 - 1 - 5 - 3 + 10, 'mixed deltas sum correctly');
  assert.strictEqual(net2.getReputationLedger('peer-b').length, 5, 'ledger filters by peer');
  console.log('✓ Delta rules applied correctly');

  const net3 = new Network({});
  net3.updateReputation('peer-c', 10, 'good');
  assert.strictEqual(net3.getThrottleState('peer-c'), 'accept', 'rep >= 0 => accept');
  net3.updateReputation('peer-d', -5, 'malformed');
  assert.strictEqual(net3.getThrottleState('peer-d'), 'queue', 'rep in [-10,0) => queue');
  net3.updateReputation('peer-e', -15, 'byzantine');
  assert.strictEqual(net3.getThrottleState('peer-e'), 'drop', 'rep < -10 => drop');
  console.log('✓ Throttle gating: accept / queue / drop');

  const net4 = new Network({});
  net4.updateReputation('peer-f', -25, 'byzantine');
  assert(net4.isByzantineIsolated('peer-f', -20), 'rep -25 < -20 is isolated');
  assert(!net4.isByzantineIsolated('peer-f', -30), 'rep -25 not < -30 is not isolated');
  console.log('✓ Byzantine isolation detection works');
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function realInflowTest(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(port, async () => {
      try {
        let received = 0;
        const net = new Network({ server }, (msg) => { received++; });
        const attacker = new WebSocket('ws://localhost:' + port + '/nevil');
        attacker.on('error', (e) => console.log('  attacker error:', e.message));

        await waitFor(() => net.sockets.size > 0, 4000);

        // Penalties for a bad-signature message are charged to the CONNECTION
        // (not the unauthenticated msg.sender field — otherwise an attacker
        // could frame an arbitrary victim identity by fabricating `sender`).
        // The connection starts neutral (reputation 0) so the cheap
        // already-drop-throttled gate does NOT short-circuit before the
        // signature check runs — that early-exit path is a distinct,
        // separately-verified optimization (see below), not this test's target.
        const connKey = net._getPeerKey(Array.from(net.sockets)[0]);
        const repBefore = net.getReputation(connKey);
        const senderRepBefore = net.getReputation('peerbad');
        attacker.send(JSON.stringify({
          id: 'bad-' + Date.now(),
          type: 'put',
          soul: 'k',
          fields: { v: 1 },
          sender: 'peerbad',
          signature: 'deadbeef', // never verifies
          lamportClock: 1
        }));

        await waitFor(() => (net.metrics.signatureDropped || 0) >= 1, 4000);

        assert.strictEqual(received, 0, 'dropped bad-signature message must NOT reach onMessage');
        assert((net.metrics.signatureDropped || 0) >= 1, 'signatureDropped counter incremented');
        const repAfter = net.getReputation(connKey);
        assert(repAfter < repBefore, 'network auto-recorded a byzantine delta on the connection, not the unauthenticated sender field');
        assert.strictEqual(net.getReputation('peerbad'), senderRepBefore, 'unauthenticated msg.sender must NOT be penalized (would let an attacker frame an arbitrary victim identity)');
        console.log('✓ Real in-flow: bad-signature message dropped, connection auto-penalized (' + repBefore + ' => ' + repAfter + '), sender field left untouched');

        // Second, separate check: once the CONNECTION itself is drop-throttled,
        // further messages are cheaply rejected before paying signature-verify
        // cost at all (no signatureDropped increment, no further Byzantine delta).
        net.updateReputation(connKey, -15, 'byzantine');
        assert.strictEqual(net.getThrottleState(connKey), 'drop', 'connection now in drop state');
        const sigDroppedBefore = net.metrics.signatureDropped;
        attacker.send(JSON.stringify({
          id: 'bad2-' + Date.now(),
          type: 'put',
          soul: 'k',
          fields: { v: 1 },
          sender: 'peerbad',
          signature: 'deadbeef',
          lamportClock: 2
        }));
        await waitMs(200);
        assert.strictEqual(net.metrics.signatureDropped, sigDroppedBefore, 'a drop-throttled connection is rejected before signature verification runs');
        console.log('✓ Real in-flow: already drop-throttled connection short-circuited before signature verification');

        attacker.close();
        server.close();
        resolve();
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

(async () => {
  try {
    unitChecks();
    await realInflowTest(8793);
    console.log('\n✅ All reputation ledger tests PASSED');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ Reputation ledger test failed:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
