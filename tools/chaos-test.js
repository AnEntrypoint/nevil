/**
 * chaos-test.js — in-process chaos testing for nevil
 *
 * Spawns 5 Nevil instances with a shared mock network layer.
 * Injects faults: message drops, latency jitter, peer kills.
 * Records all messages to chaos-log.ndjson for replay analysis.
 */

'use strict';

const Nevil = require('../nevil');
const fs = require('fs');
const path = require('path');

class MockNetwork {
  constructor() {
    this.peers = new Map(); // peerId -> Nevil instance
    this.messages = []; // all messages for recording
    this.dropRate = 0.1; // drop 10% of messages
    this.latencyJitter = 50; // 50ms jitter
  }

  broadcast(peerId, msg) {
    this.messages.push({ timestamp: Date.now(), peerId, msg });
    // Simulate drop
    if (Math.random() < this.dropRate) {
      console.log(`[chaos] dropped message ${msg.id} from peer ${peerId}`);
      return;
    }
    // Simulate latency jitter
    const delay = Math.random() * this.latencyJitter;
    setTimeout(() => {
      for (const [otherId, otherPeer] of this.peers) {
        if (otherId !== peerId) {
          otherPeer._receiveFromPeer(msg);
        }
      }
    }, delay);
  }

  kill(peerId) {
    console.log(`[chaos] killed peer ${peerId}`);
    this.peers.delete(peerId);
  }

  record(filename) {
    const ndjson = this.messages
      .map(m => JSON.stringify(m))
      .join('\n');
    fs.writeFileSync(filename, ndjson);
    console.log(`recorded ${this.messages.length} messages to ${filename}`);
  }
}

async function runChaosTest() {
  console.log('=== nevil chaos test ===');
  const mockNet = new MockNetwork();
  const peers = [];

  // Spawn 5 in-process Nevil instances
  for (let i = 0; i < 5; i++) {
    const db = new Nevil({ file: `/tmp/nevil-chaos-${i}.log` });
    await db.ready();
    peers.push(db);
    mockNet.peers.set(`peer-${i}`, db);

    // Hook: intercept broadcasts to mock network
    const origBroadcast = db.graph.network.broadcast.bind(db.graph.network);
    db.graph.network.broadcast = (payload) => {
      mockNet.broadcast(`peer-${i}`, payload);
      return { id: payload.id };
    };

    console.log(`spawned peer-${i}`);
  }

  // Run test: write to each peer, kill peer-2 mid-test, verify convergence
  console.log('--- phase 1: baseline writes ---');
  for (let i = 0; i < 10; i++) {
    const soul = `test-${i}`;
    await peers[0].put(soul, { value: i, ts: Date.now() });
  }

  console.log('--- phase 2: kill peer-2 ---');
  mockNet.kill('peer-2');
  peers[2].graph.nodes.clear();

  console.log('--- phase 3: continue writes ---');
  for (let i = 10; i < 20; i++) {
    const soul = `test-${i}`;
    await peers[1].put(soul, { value: i, ts: Date.now() });
  }

  console.log('--- phase 4: verify convergence ---');
  // Wait for gossip to settle
  await new Promise(resolve => setTimeout(resolve, 1000));

  let converged = true;
  const peer0Nodes = peers[0].graph.nodes.size;
  for (let i = 1; i < 5; i++) {
    if (i === 2) continue; // killed peer
    const peerNodes = peers[i].graph.nodes.size;
    if (peerNodes !== peer0Nodes) {
      console.log(`peer-${i} has ${peerNodes} nodes, peer-0 has ${peer0Nodes} — divergence!`);
      converged = false;
    }
  }

  if (converged) {
    console.log(`✓ consistency check passed: all peers converged to ${peer0Nodes} nodes`);
  } else {
    console.log(`✗ consistency check failed: peers diverged`);
  }

  // Record messages
  const logPath = path.join(__dirname, 'chaos-log.ndjson');
  mockNet.record(logPath);

  console.log('--- test complete ---');
}

runChaosTest().catch(err => {
  console.error('chaos test error:', err);
  process.exit(1);
});
