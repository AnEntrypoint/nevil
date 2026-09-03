#!/usr/bin/env node
/**
 * witness-conflict-resolution.js — real conflict resolution strategies.
 *
 * Three peers, concurrent writes to the same soul/field, each Graph
 * instance configured with a different strategy. Verifies LWW picks the
 * latest timestamp, FWW keeps the first write, and a custom fn (max value)
 * picks the highest value. All three converge deterministically.
 */

'use strict';

const { Graph } = require('../graph.js');
const assert = require('assert');

function run() {
  const soul = 'concurrent-soul';
  const t0 = Date.now();

  // Concurrent writes from 3 peers: same fixed lamportClock simulates true
  // concurrency (no causal order between them), so ordering falls through
  // to each strategy's own rule (timestamp for LWW/FWW, value for custom).
  const CONCURRENT_CLOCK = 1;

  const lww = new Graph({ conflictResolution: 'lww' });
  lww.mergeNode(soul, { field: 'peerA' }, { field: t0 }, CONCURRENT_CLOCK);
  lww.mergeNode(soul, { field: 'peerB' }, { field: t0 + 100 }, CONCURRENT_CLOCK);
  lww.mergeNode(soul, { field: 'peerC' }, { field: t0 + 50 }, CONCURRENT_CLOCK);
  const lww_winner = lww.get(soul).field;
  assert.strictEqual(lww_winner, 'peerB', 'LWW must keep the latest timestamp');

  const fww = new Graph({ conflictResolution: 'fww' });
  fww.mergeNode(soul, { field: 'peerA' }, { field: t0 }, CONCURRENT_CLOCK);
  fww.mergeNode(soul, { field: 'peerB' }, { field: t0 + 100 }, CONCURRENT_CLOCK);
  fww.mergeNode(soul, { field: 'peerC' }, { field: t0 + 50 }, CONCURRENT_CLOCK);
  const fww_winner = fww.get(soul).field;
  assert.strictEqual(fww_winner, 'peerA', 'FWW must keep the first write regardless of timestamp');

  const custom = new Graph({
    conflictResolution: (its, iv, cts, cv) => cts === undefined || iv > cv,
  });
  custom.mergeNode(soul, { field: 3 }, { field: t0 }, CONCURRENT_CLOCK);
  custom.mergeNode(soul, { field: 9 }, { field: t0 + 100 }, CONCURRENT_CLOCK);
  custom.mergeNode(soul, { field: 5 }, { field: t0 + 50 }, CONCURRENT_CLOCK);
  const custom_winner = custom.get(soul).field;
  assert.strictEqual(custom_winner, 9, 'custom strategy must keep the highest value');

  const convergence_ms = Date.now() - t0;
  const out = { lww_winner, fww_winner, custom_winner, convergence_ms };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run();
module.exports = { run };
