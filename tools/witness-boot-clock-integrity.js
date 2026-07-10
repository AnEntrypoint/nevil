#!/usr/bin/env node
/**
 * witness-boot-clock-integrity.js — real fix for two bugs plugkit's audit
 * surfaced: (1) Storage.load replaying every log entry as a fresh local
 * write inflated graph.localClock to ~N regardless of the entries' real
 * historical clocks; (2) Storage.compact discarded per-field lamport
 * clocks entirely, so causal ordering degraded to timestamp-only HAM
 * after any compaction + reboot.
 *
 * Uses a real Nevil instance against a real temp-dir log file (Node fs),
 * not a mock — reboots it and inspects the rebuilt graph's actual clock
 * state.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nevil-clock-witness-'));
  const file = path.join(dir, 'log.ndjson');

  const a = new Nevil({ file });
  await a.ready();

  // A handful of real local writes, so the log has N > 1 entries with distinct historical clocks.
  a.put('soul-1', { x: 1 });
  a.put('soul-2', { x: 2 });
  a.put('soul-3', { x: 3 });
  await new Promise((r) => setTimeout(r, 100)); // let async persist land

  const clockBeforeReboot = a.graph.localClock;

  const b = new Nevil({ file });
  await b.ready();

  const clockAfterReboot = b.graph.localClock;
  // Bug (pre-fix): reboot re-inflated localClock by re-incrementing once per
  // replayed entry regardless of history, so it would exceed clockBeforeReboot
  // by roughly N extra increments. Fixed: replay uses each entry's own
  // persisted clock, converging on the same max, not a re-inflated count.
  assert.ok(clockAfterReboot <= clockBeforeReboot + 1, `reboot must not inflate the clock: before=${clockBeforeReboot} after=${clockAfterReboot}`);

  // Compaction must preserve per-field lamport clocks across a reboot.
  await a.compact();
  const c = new Nevil({ file });
  await c.ready();
  const rebuiltLamport = c.graph.nodes.get('soul-1')?.lamport?.x;
  assert.ok(rebuiltLamport !== undefined, 'compacted + reloaded graph must retain the field lamport clock, not drop it to undefined');

  fs.rmSync(dir, { recursive: true, force: true });

  const out = { clockBeforeReboot, clockAfterReboot, noInflation: clockAfterReboot <= clockBeforeReboot + 1, rebuiltLamport, clockSurvivesCompaction: rebuiltLamport !== undefined };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
