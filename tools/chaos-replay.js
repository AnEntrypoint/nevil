/**
 * chaos-replay.js — deterministic replay of recorded messages with fault injection.
 * What would Matthias Buus do? Append-only log replay for testing without external harness.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Nevil = require('../nevil');

let messageIndex = 0;

function recordMessage(msg, senderIdx) {
  const logFile = './chaos-messages.ndjson';
  const entry = {
    ...msg,
    _index: messageIndex++,
    _senderIdx: senderIdx,
    _timestamp: Date.now()
  };
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

async function chaosReplay(opts = {}) {
  const { logFile = './chaos-messages.ndjson', dropRate = 0.1, jitterMs = 50, peersCount = 5 } = opts;

  if (!fs.existsSync(logFile)) {
    console.log(`No message log at ${logFile}. Run a normal scenario first to record.`);
    return {};
  }

  const messages = [];
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch (e) {
      // skip malformed
    }
  }

  console.log(`Replaying ${messages.length} messages with drop=${(dropRate * 100).toFixed(0)}% jitter=${jitterMs}ms`);

  // Spawn N peers with message recording hooks
  const peers = [];
  for (let i = 0; i < peersCount; i++) {
    const dataDir = path.join('./chaos-replay-logs', `peer-${i}`);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const peer = new Nevil({ file: path.join(dataDir, 'log.ndjson'), peers: [] });
    await peer.ready();
    // Hook: record all broadcasts for deterministic replay
    const origBroadcast = peer.network.broadcast.bind(peer.network);
    peer.network.broadcast = (payload) => {
      recordMessage(payload, i);
      return origBroadcast(payload);
    };
    peers.push(peer);
  }

  // Replay messages with fault injection
  let droppedCount = 0;
  for (const msg of messages) {
    // Fault injection: drop by rate
    if (Math.random() < dropRate) {
      droppedCount++;
      continue;
    }

    // Apply jitter (deterministic delay, not random)
    const delay = (msg._index % 10) * jitterMs; // pseudo-random via index
    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    // Replay to random peer (simulates receive)
    if (msg.type === 'put' && msg.soul) {
      const peerIdx = msg._senderIdx !== undefined ? msg._senderIdx : Math.floor(Math.random() * peers.length);
      if (peers[peerIdx]) {
        peers[peerIdx]._applyRemote(msg);
      }
    }
  }

  // Collect final state from all peers
  const results = {
    droppedMessages: droppedCount,
    peerStates: []
  };

  for (let i = 0; i < peers.length; i++) {
    const nodeCount = peers[i].graph.nodes.size;
    const totalFields = Array.from(peers[i].graph.nodes.values()).reduce((sum, n) => sum + Object.keys(n.data).length, 0);
    results.peerStates.push({ peerId: i, nodeCount, totalFields });
  }

  // Verify convergence: all peers see same graph size (weak consistency check)
  const nodeCounts = results.peerStates.map(p => p.nodeCount);
  const converged = nodeCounts.every(c => c === nodeCounts[0]);
  results.converged = converged;

  console.log(`Replay complete: dropped=${droppedCount}, converged=${converged}, peers=${peersCount}`);
  console.log('Peer states:', results.peerStates);

  // Cleanup
  for (const peer of peers) {
    try {
      if (peer.network && peer.network.wss) peer.network.wss.close();
    } catch (e) {}
  }

  return results;
}

module.exports = { chaosReplay, recordMessage };

// CLI
if (require.main === module) {
  chaosReplay({ dropRate: 0.1, jitterMs: 50, peersCount: 5 })
    .then(result => {
      console.log('\n=== Chaos Replay Results ===');
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.converged ? 0 : 1);
    })
    .catch(e => {
      console.error('Chaos replay error:', e.message);
      process.exit(1);
    });
}
