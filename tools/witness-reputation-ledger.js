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

function realInflowTest(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(port, async () => {
      try {
        let received = 0;
        const net = new Network({ server }, (msg) => { received++; });
        const attacker = new WebSocket('ws://localhost:' + port + '/nevil');
        attacker.on('error', (e) => console.log('  attacker error:', e.message));

        let reputationSet = false;
        attacker.on('open', () => {
          if (!reputationSet) return;
          const bad = {
            id: 'bad-' + Date.now(),
            type: 'put',
            soul: 'k',
            fields: { v: 1 },
            sender: 'peerbad',
            signature: 'deadbeef', // never verifies
            lamportClock: 1
          };
          attacker.send(JSON.stringify(bad));
        });

        await waitFor(() => net.sockets.size > 0, 4000);

        // Peer already below the drop threshold.
        net.updateReputation('peerbad', -15, 'byzantine');
        assert.strictEqual(net.getThrottleState('peerbad'), 'drop', 'pre-seeded bad peer is in drop state');
        const repBefore = net.getReputation('peerbad');
        reputationSet = true;
        // Trigger the open handler's send now that reputation is seeded.
        attacker.send(JSON.stringify({
          id: 'bad-' + Date.now(),
          type: 'put',
          soul: 'k',
          fields: { v: 1 },
          sender: 'peerbad',
          signature: 'deadbeef',
          lamportClock: 1
        }));

        await waitFor(() => (net.metrics.signatureDropped || 0) >= 1, 4000);

        assert.strictEqual(received, 0, 'dropped bad-signature message must NOT reach onMessage');
        assert((net.metrics.signatureDropped || 0) >= 1, 'signatureDropped counter incremented');
        const repAfter = net.getReputation('peerbad');
        assert(repAfter < repBefore, 'network auto-recorded a byzantine delta on the drop');
        console.log('✓ Real in-flow: bad-signature message dropped, reputation auto-penalized (' + repBefore + ' => ' + repAfter + ')');

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
