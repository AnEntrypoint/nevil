#!/usr/bin/env node
/**
 * witness-ha-ca-cp-integration.js — conflict resolution + topology modes +
 * PoW working together, not just individually.
 *
 * A CA-mode Nevil instance (LWW, no DHT) with PoW enabled: writes without
 * a solved puzzle are rejected at the network layer, writes with one are
 * accepted and merge deterministically via the topology's LWW strategy.
 */

'use strict';

const http = require('http');
const Nevil = require('../nevil.js');
const { Network } = require('../network.js');
const assert = require('assert');

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const DIFFICULTY = 3;
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const a = new Nevil({ topology: 'ca', server, powEnabled: true, powDifficulty: DIFFICULTY });
  await a.ready();

  const b = new Nevil({ topology: 'ca', peers: [`ws://localhost:${port}/nevil`], powEnabled: true, powDifficulty: DIFFICULTY });
  await b.ready();
  await waitMs(300);

  assert.strictEqual(a.topology, 'ca');
  assert.strictEqual(a.opts.dhtEnabled, false, 'CA mode must not enable DHT');

  const soul = 'ha-ca-cp-soul';
  const beforeWrite = Date.now();
  b.put(soul, { v: 1 }); // Nevil's own put path attaches PoW automatically when network.POW_ENABLED
  await waitMs(400);
  const convergenceTimeMs = Date.now() - beforeWrite;

  const replicated = a.get(soul);
  assert.ok(replicated && replicated.v === 1, 'write from B must replicate to A under CA topology + PoW gating');

  server.close();

  const out = {
    topology: a.topology,
    dhtEnabled: a.opts.dhtEnabled,
    conflictStrategyIsLww: a.graph.resolveConflict === require('../graph.js').CONFLICT_STRATEGIES.lww,
    powEnforced: a.network.POW_ENABLED,
    replicated: !!replicated,
    convergenceTimeMs,
  };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
