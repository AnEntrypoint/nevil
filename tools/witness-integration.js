#!/usr/bin/env node
/**
 * witness-integration.js — all four transcendences working together.
 *
 * A dumb relay hub forwards every message to the other connected client.
 * Two Nevil nodes both dial the hub. A real local write on A must gossip
 * A -> hub -> B and be applied on B (DHT/flood routing + Lamport clocks +
 * B-tree soul indexing all exercised on the live path). Identity-signed
 * writes are verified both locally and across nodes: a signed putAt must
 * gossip A -> hub -> B and be verifiable on B (signature scheme end-to-end
 * over the real network path, using canonical-JSON signing).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Nevil = require('../nevil.js');
const assert = require('assert');

const HUB = 8794;
const TMP_A = path.join(__dirname, '.witness-int-a.ndjson');
const TMP_B = path.join(__dirname, '.witness-int-b.ndjson');

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = predicate(); } catch (e) { /* keep polling */ }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function main() {
  console.log('Integration Test: All Four Transcendences\n');

  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      wss.clients.forEach((c) => { if (c !== ws && c.readyState === 1) c.send(data); });
    });
  });
  await new Promise((r) => server.listen(HUB, r));

  for (const f of [TMP_A, TMP_B]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const nodeA = new Nevil({ peers: ['ws://localhost:' + HUB], enableSoulIndex: true, file: TMP_A });
  const nodeB = new Nevil({ peers: ['ws://localhost:' + HUB], enableSoulIndex: true, file: TMP_B });
  await nodeA.ready();
  await nodeB.ready();
  await new Promise((r) => setTimeout(r, 300));

  // 1) Real multi-node gossip: A -> hub -> B. nevil auto-advances _lamportClock
  //    on every local write, so gossipped messages clear the replay gate.
  nodeA.put('shared', { hello: 'world' });
  await waitFor(() => { const v = nodeB.get('shared'); return v && v.hello === 'world'; });
  console.log('  nodeB.get("shared") =>', JSON.stringify(nodeB.get('shared')));
  console.log('✓ DHT/routing + Lamport: A.put("shared") gossiped to B (deep-equal apply)');

  // 2) B-tree soul index on a real node after real indexing.
  nodeA.put('user:1', { name: 'alice' });
  await waitFor(() => nodeB.prefixScan('user:').includes('user:1'));
  const scanned = nodeB.prefixScan('user:');
  console.log('  nodeB.prefixScan("user:") =>', JSON.stringify(scanned));
  assert.deepStrictEqual(scanned, ['user:1'], 'B-tree prefix scan returns gossipped soul');
  console.log('✓ B-tree storage: prefix scan over the live index');

  // 3) Identity + signed sub-address write, verified locally (signature end-to-end).
  await nodeA.createIdentity({ passphrase: 'pw' });
  const subSoul = await nodeA.putAt(['posts', '1'], { title: 'x' });
  assert(/^[0-9a-f]{64}$/.test(subSoul), 'putAt returns a 64-hex sub-soul');
  const localVerified = nodeA.getAtVerified(subSoul);
  console.log('  nodeA.getAtVerified(subSoul) =>', JSON.stringify(localVerified));
  assert.strictEqual(localVerified.title, 'x', 'verified title');
  assert.strictEqual(localVerified._owner, nodeA._identity.soul, 'verified owner soul');
  assert.deepStrictEqual(localVerified._path, ['posts', '1'], 'verified path');
  console.log('✓ Identity keychain: putAt + getAtVerified (local signature verify)');

  // 4) Real cross-node delivery of the identity-signed write. After the
  //    canonical-JSON signature fix, the signed putAt must gossip A -> hub
  //    -> B and be verifiable on B (no drop at the signature gate).
  const droppedBefore = nodeB.network.metrics.signatureDropped || 0;
  await waitFor(() => {
    const v = nodeB.getAtVerified(subSoul);
    return v && v.title === 'x' && v._owner === nodeA._identity.soul;
  }, 5000);
  const remoteVerified = nodeB.getAtVerified(subSoul);
  console.log('  nodeB.getAtVerified(subSoul) =>', JSON.stringify(remoteVerified));
  assert.strictEqual(remoteVerified.title, 'x', 'B received and verified title');
  assert.strictEqual(remoteVerified._owner, nodeA._identity.soul, 'B verified owner');
  assert.deepStrictEqual(remoteVerified._path, ['posts', '1'], 'B verified path');
  assert.strictEqual(nodeB.network.metrics.signatureDropped || 0, droppedBefore, 'no signature drops on the signed path');
  console.log('✓ Cross-node putAt: signed write gossiped A -> B and verified on B');

  for (const f of [TMP_A, TMP_B]) if (fs.existsSync(f)) fs.unlinkSync(f);
  server.close();
  console.log('\n✅ All integration tests PASSED');
  return { success: true };
}

(async () => {
  try {
    await main();
    process.exit(0);
  } catch (e) {
    console.error('\n❌ Integration test failed:', e.message);
    console.error(e.stack);
    console.error('\n=== INTEGRATION FAILURE ===');
    console.error('A real cross-node delivery/verification step did not hold. Check the');
    console.error('network signing/broadcast path and the B-tree/prefix-scan index wiring.');
    for (const f of [TMP_A, TMP_B]) if (fs.existsSync(f)) fs.unlinkSync(f);
    process.exit(1);
  }
})();
