#!/usr/bin/env node
/**
 * witness-dht-sparse-delivery.js — real fix for DHT-on-by-default silently
 * truncating delivery of writes to NON-keychain souls (most insert()/put()
 * calls). Before the fix, _getPrefixMatches' "non-keychain soul:
 * flood-fill" comment lied: because it returned ALL peers as "matching",
 * _selectRoutingPeers' useBucket check saw a full match and picked only
 * the top K+L healthiest, with no fallback ever triggering. Now a
 * non-keychain soul always flood-fills.
 */

'use strict';

const http = require('http');
const { Network } = require('../network.js');
const assert = require('assert');

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const K = 2; // deliberately small so the bug (K+L truncation) would be obvious
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const hub = new Network({ server, dhtK: K, dhtL: 1 }, () => {});
  const peers = [];
  const received = [];
  for (let i = 0; i < 5; i++) {
    const r = [];
    received.push(r);
    peers.push(new Network({ peers: [`ws://localhost:${port}/nevil`], dhtK: K, dhtL: 1 }, (msg) => r.push(msg)));
  }
  await waitMs(400); // let all 5 sockets connect

  // A random-UUID soul (NOT a 64-hex keychain-derived soul) — this is the
  // common case for insert()/put() without an identity.
  const soul = 'a1b2c3d4-not-a-keychain-soul';
  hub.broadcast({ type: 'put', soul, fields: { v: 1 }, lamportClock: 1 });
  await waitMs(400);

  const deliveredCount = received.filter((r) => r.some((m) => m.soul === soul)).length;
  assert.strictEqual(deliveredCount, 5, `non-keychain soul write must flood-fill to all 5 peers, not just the top K+L=${K + 1}; got ${deliveredCount}`);

  server.close();

  const out = { deliveredCount, expectedCount: 5, allDelivered: deliveredCount === 5 };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
