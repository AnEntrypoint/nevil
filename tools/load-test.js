/**
 * load-test.js — real-world load simulator for nevil.
 * Spawns N peers, drives K writes per second for L seconds, measures contention/latency/throughput.
 * No mocking: all peers run real Nevil instances with real WebSocket network.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const Nevil = require('../nevil.js');

async function loadTest(opts = {}) {
  const numPeers = opts.numPeers || 5;
  const writesPerSec = opts.writesPerSec || 10;
  const durationSec = opts.durationSec || 10;
  const logDir = opts.logDir || './load-test-logs';

  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const startTime = Date.now();
  const peers = [];
  const servers = [];
  const results = {
    startTime,
    numPeers,
    writesPerSec,
    durationSec,
    totalWrites: 0,
    peerMetrics: [],
    contention: null,
    errors: []
  };

  // Start server for peer 0 (relay point)
  const serverPromise = new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      servers.push(server);
      resolve(port);
    });
  });
  const port = await serverPromise;

  // Create N peers
  for (let i = 0; i < numPeers; i++) {
    const dataDir = path.join(logDir, `peer-${i}`);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const peerOpts = {
      file: path.join(dataDir, 'log.ndjson'),
      server: i === 0 ? servers[0] : undefined,
      peers: i === 0 ? [] : [`ws://localhost:${port}/nevil`]
    };

    const peer = new Nevil(peerOpts);
    await peer.ready();
    peers.push(peer);
    console.log(`Peer ${i} ready on port ${i === 0 ? port : 'N/A'}`);
  }

  // Let mesh stabilize
  await new Promise((r) => setTimeout(r, 500));

  // Drive writes from peer 0
  const writeInterval = 1000 / writesPerSec;
  const endTime = startTime + durationSec * 1000;
  let writeCount = 0;

  const writeLoop = setInterval(() => {
    if (Date.now() >= endTime) {
      clearInterval(writeLoop);
      return;
    }
    try {
      const soul = `test-${Date.now()}-${writeCount}`;
      peers[0].put(soul, { timestamp: Date.now(), index: writeCount, data: 'x'.repeat(100) });
      writeCount++;
      results.totalWrites++;
    } catch (err) {
      results.errors.push({ time: Date.now(), error: err.message });
    }
  }, writeInterval);

  // Wait for writes to finish
  await new Promise((r) => setTimeout(r, (durationSec * 1000) + 1000));

  // Collect metrics from all peers
  for (let i = 0; i < peers.length; i++) {
    const metrics = peers[i].network.getMetrics();
    results.peerMetrics.push({
      peerId: i,
      metrics
    });
  }

  // Compute contention ratio (messagesSent / (peersConnected * writes))
  const totalMessagesSent = results.peerMetrics.reduce((sum, p) => sum + (p.metrics.messagesSent || 0), 0);
  const avgPeersConnected = results.peerMetrics.reduce((sum, p) => sum + (p.metrics.peersConnected || 0), 0) / numPeers;
  results.contention = avgPeersConnected > 0 ? totalMessagesSent / (avgPeersConnected * results.totalWrites) : 0;

  // Cleanup
  for (const peer of peers) {
    try {
      if (peer.network && peer.network.wss) peer.network.wss.close();
    } catch (e) {}
  }
  for (const server of servers) {
    server.close();
  }

  const duration = Date.now() - startTime;
  results.durationMs = duration;
  results.throughputWritesPerSec = results.totalWrites / (duration / 1000);

  console.log('\n=== Load Test Results ===');
  console.log(`Peers: ${numPeers}, Duration: ${durationSec}s, Writes: ${results.totalWrites}`);
  console.log(`Throughput: ${results.throughputWritesPerSec.toFixed(2)} writes/sec`);
  console.log(`Contention ratio (msgs per write per peer): ${results.contention.toFixed(2)}`);
  console.log(`Peer metrics:`, results.peerMetrics);

  return results;
}

// Run with defaults if called directly
if (require.main === module) {
  loadTest({ numPeers: 5, writesPerSec: 20, durationSec: 10 })
    .then((results) => {
      fs.writeFileSync(path.join('./load-test-logs', 'results.json'), JSON.stringify(results, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('Load test failed:', err);
      process.exit(1);
    });
}

module.exports = { loadTest };
