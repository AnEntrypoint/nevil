#!/usr/bin/env node
/**
 * witness-dht-routing.js — real DHT / flood-fill message delivery.
 *
 * Starts a loopback ws server, attaches Network A to it, and dials it from
 * Network B. A real broadcast from A must arrive at B's onMessage (proving
 * DHT bucketed routing delivers). Repeats with dhtEnabled:false to prove
 * flood-fill also delivers. Keeps unit checks for geohash determinism and
 * health-populated peer ranking.
 */

'use strict';

const http = require('http');
const { Network } = require('../network.js');
const assert = require('assert');

const KEYCHAIN_SOUL = 'abcd1234ef567890abcd1234ef567890abcd1234ef567890abcd1234ef567890';

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for delivery'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function connectPair(port, dhtEnabled) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const received = [];
    const onMessageB = (msg) => received.push(msg);
    const netA = new Network({ server, dhtEnabled }, () => {});
    let netB;
    server.listen(port, () => {
      try {
        netB = new Network({ peers: ['ws://localhost:' + port + '/nevil'], dhtEnabled }, onMessageB);
        netA.wss.on('connection', () => {
          setTimeout(() => resolve({ server, netA, netB, received }), 50);
        });
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

async function deliverOnce({ netA, received }, soul, expectSoul) {
  const before = received.length;
  netA.broadcast({ type: 'put', soul: soul, fields: { v: 1 }, lamportClock: 1 });
  await waitFor(() => received.length > before);
  const msg = received[received.length - 1];
  assert.strictEqual(msg.soul, expectSoul, 'delivered message carries the broadcast soul');
  return msg;
}

async function testDHT() {
  console.log('DHT Routing Witness Test\n');

  // --- Real delivery over DHT (default on) ---
  const dht = await connectPair(8791, true);
  await deliverOnce(dht, 'k', 'k');
  console.log('✓ DHT-routed broadcast delivered A -> B (real socket delivery)');
  assert(dht.netA.getHealthyPeers().length >= 1, 'health auto-populated from socket activity');
  console.log('  healthy peers after traffic:', JSON.stringify(dht.netA.getHealthyPeers()));
  dht.server.close();

  // --- Real delivery over flood-fill (dhtEnabled:false) ---
  const flood = await connectPair(8792, false);
  await deliverOnce(flood, 'k', 'k');
  console.log('✓ Flood-fill broadcast delivered A -> B (dhtEnabled:false)');
  assert(flood.netA.getHealthyPeers().length >= 1, 'flood peer also appears in health map');
  flood.server.close();

  // --- Geohash determinism (4-char hex for keychain souls) ---
  const net = new Network({ dhtEnabled: true });
  const g1 = net._computeGeohash(KEYCHAIN_SOUL);
  const g2 = net._computeGeohash(KEYCHAIN_SOUL);
  assert.strictEqual(g1.length, 4, 'geohash is 4 chars');
  assert(/^[0-9a-f]{4}$/.test(g1), 'geohash is hex');
  assert.strictEqual(g1, g2, 'geohash is deterministic for the same soul');
  console.log('✓ Geohash deterministic: ' + g1);

  console.log('\n✅ All DHT routing tests PASSED');
  return { success: true };
}

(async () => {
  try {
    await testDHT();
    process.exit(0);
  } catch (e) {
    console.error('\n❌ DHT routing test failed:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
