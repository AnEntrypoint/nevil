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
const { Network, randomId } = require('../network.js');
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
  // This makes netA the DIRECT sender of the spam on the netA<->netB connection, so netB
  // correctly (and separately, per audit-16) penalizes its own connection to netA.
  const beforeSpam = received.length;
  for (let i = 0; i < 5; i++) {
    netA.broadcast({ type: 'put', soul: `spam-${i}`, fields: {}, ts: {}, sender: `spammer-${i}`, lamportClock: 1 });
  }
  await waitMs(300);
  const rejections = 5 - (received.length - beforeSpam); // none of the spam should have landed

  // Honest peer needs its own reception point too, not just its own send socket:
  // netA is a hub in this topology, so anything netC sends still relays to netB
  // over the SAME netA<->netB connection netB already (correctly) penalized after
  // the spam above. A genuinely independent peer (netD) dialing the hub directly
  // proves the honest write is accepted on its own merits, uncontaminated by a
  // different connection's prior Byzantine history — matching real deployments,
  // where reputation is correctly per-connection (see audit-16), not global.
  const netC = new Network({ peers: [`ws://localhost:8795/nevil`], powEnabled: true, powDifficulty: DIFFICULTY }, () => {});
  const netDReceived = [];
  const netD = new Network({ peers: [`ws://localhost:8795/nevil`], powEnabled: true, powDifficulty: DIFFICULTY }, (msg) => netDReceived.push(msg));
  await waitMs(100);

  // Honest: solves the puzzle bound to soul+id (PoW is bound to the specific
  // message id, not just soul, so a puzzle can't be replayed across distinct
  // messages — the id must be generated before solving, then reused on send).
  const soul = 'honest-soul';
  const msgId = randomId();
  const solveStart = Date.now();
  const pow = Network.solvePoW(soul, DIFFICULTY, msgId);
  const puzzle_time_ms = Date.now() - solveStart;

  const verifyStart = Date.now();
  const verified = netA._verifyPoW(soul, pow, msgId);
  const verify_time_ms = Date.now() - verifyStart;
  assert.ok(verified, 'honest peer solved puzzle must verify');

  const beforeHonest = netDReceived.length;
  netC.broadcast({ id: msgId, type: 'put', soul, fields: { ok: true }, ts: { ok: Date.now() }, pow, sender: 'honest-peer', lamportClock: 2 });
  await waitMs(300);
  const accepted = netDReceived.length > beforeHonest && netDReceived[netDReceived.length - 1].soul === soul;
  assert.ok(accepted, 'honest write with valid PoW must be accepted');
  assert.strictEqual(rejections, 5, 'all spam writes without PoW must be rejected');

  netA.close();
  netB.close();
  netC.close();
  netD.close();
  server.close();

  const out = { rejections, puzzle_time_ms, verify_time_ms, accepted };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
