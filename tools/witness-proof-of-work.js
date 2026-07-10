#!/usr/bin/env node
/**
 * witness-proof-of-work.js — real hashcash-style rate-limiting.
 *
 * Starts a loopback ws server with powEnabled:true and dials it from a
 * spam peer that sends writes with no PoW (all rejected) and an honest
 * peer that solves the puzzle first (accepted). Measures puzzle solve
 * time (difficulty-dependent) and verify time (must stay fast).
 */

'use strict';

const http = require('http');
const { Network } = require('../network.js');
const assert = require('assert');

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectPair(port, extraOpts) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const received = [];
    const netA = new Network({ server, ...extraOpts }, () => {});
    let netB;
    server.listen(port, () => {
      try {
        netB = new Network({ peers: [`ws://localhost:${port}/nevil`], ...extraOpts }, (msg) => received.push(msg));
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

async function run() {
  const DIFFICULTY = 3; // kept low so the witness runs fast
  const { server, netA, netB, received } = await connectPair(8795, { powEnabled: true, powDifficulty: DIFFICULTY });

  // Spam: no PoW attached, must be rejected. netA broadcasts (the proven direction), netB receives.
  // Distinct spam senders so the Byzantine reputation penalty from spam doesn't
  // bleed into the honest sender's own (separate) reputation.
  const beforeSpam = received.length;
  for (let i = 0; i < 5; i++) {
    netA.broadcast({ type: 'put', soul: `spam-${i}`, fields: {}, ts: {}, sender: `spammer-${i}`, lamportClock: 1 });
  }
  await waitMs(300);
  const rejections = 5 - (received.length - beforeSpam); // none of the spam should have landed

  // Honest: solves the puzzle, must be accepted.
  const soul = 'honest-soul';
  const solveStart = Date.now();
  const pow = Network.solvePoW(soul, DIFFICULTY);
  const puzzle_time_ms = Date.now() - solveStart;

  const verifyStart = Date.now();
  const verified = netB._verifyPoW(soul, pow);
  const verify_time_ms = Date.now() - verifyStart;
  assert.ok(verified, 'honest peer solved puzzle must verify');

  const beforeHonest = received.length;
  netA.broadcast({ type: 'put', soul, fields: { ok: true }, ts: { ok: Date.now() }, pow, sender: 'honest-peer', lamportClock: 2 });
  await waitMs(300);
  const accepted = received.length > beforeHonest && received[received.length - 1].soul === soul;
  assert.ok(accepted, 'honest write with valid PoW must be accepted');
  assert.strictEqual(rejections, 5, 'all spam writes without PoW must be rejected');

  netA.close();
  netB.close();
  server.close();

  const out = { rejections, puzzle_time_ms, verify_time_ms, accepted };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
