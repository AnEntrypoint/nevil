#!/usr/bin/env node
/**
 * witness-unified-clock.js — real fix for two independent Lamport counters
 * (graph.localClock, nevil._lamportClock) that could diverge: on boot,
 * graph.localClock resumes from the replayed log history but
 * nevil._lamportClock used to reset to 0, so the next gossiped write would
 * advertise a clock value far behind what the graph itself already
 * recorded. Now _boot() seeds _lamportClock from the loaded graph's clock.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nevil-clock-unify-witness-'));
  const file = path.join(dir, 'log.ndjson');

  const a = new Nevil({ file });
  await a.ready();
  a.put('s1', { x: 1 });
  a.put('s2', { x: 2 });
  a.put('s3', { x: 3 });
  await new Promise((r) => setTimeout(r, 100));

  const b = new Nevil({ file });
  await b.ready();

  assert.strictEqual(b._lamportClock, b.graph.localClock, 'nevil._lamportClock must be seeded from graph.localClock on boot, not reset to 0');
  assert.ok(b._lamportClock > 0, 'a reboot after real writes must not silently reset the clock to zero');

  fs.rmSync(dir, { recursive: true, force: true });

  const out = { nevilClock: b._lamportClock, graphClock: b.graph.localClock, unified: b._lamportClock === b.graph.localClock };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
