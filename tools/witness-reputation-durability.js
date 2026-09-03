#!/usr/bin/env node
/**
 * witness-reputation-durability.js — real fix for the reputation ledger
 * being in-memory only. Records a Byzantine penalty on one Nevil instance
 * pointed at a real temp-dir file, reboots a fresh instance against the
 * same files, and asserts the penalty (and resulting throttle state)
 * survived the restart instead of resetting to neutral.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nevil-reputation-witness-'));
  const file = path.join(dir, 'log.ndjson');
  const reputationFile = path.join(dir, 'reputation.ndjson');

  const a = new Nevil({ file, reputationFile });
  await a.ready();

  a.network.updateReputation('byzantine-peer', -3, 'byzantine');
  a.network.updateReputation('byzantine-peer', -3, 'byzantine');
  a.network.updateReputation('byzantine-peer', -3, 'byzantine');
  a.network.updateReputation('byzantine-peer', -3, 'byzantine');
  await new Promise((r) => setTimeout(r, 100)); // let async persist land

  const scoreBeforeReboot = a.network.getReputation('byzantine-peer');
  const throttleBeforeReboot = a.network.getThrottleState('byzantine-peer');
  assert.strictEqual(scoreBeforeReboot, -12);
  assert.strictEqual(throttleBeforeReboot, 'drop', 'score -12 must be below REP_DROP_THRESHOLD (-10)');

  const b = new Nevil({ file, reputationFile });
  await b.ready();

  const scoreAfterReboot = b.network.getReputation('byzantine-peer');
  const throttleAfterReboot = b.network.getThrottleState('byzantine-peer');

  assert.strictEqual(scoreAfterReboot, scoreBeforeReboot, 'reputation must survive a restart, not reset to 0');
  assert.strictEqual(throttleAfterReboot, 'drop', 'restarted peer must still throttle the previously-Byzantine peer');

  fs.rmSync(dir, { recursive: true, force: true });

  const out = { scoreBeforeReboot, scoreAfterReboot, throttleBeforeReboot, throttleAfterReboot, survivedRestart: scoreAfterReboot === scoreBeforeReboot };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
