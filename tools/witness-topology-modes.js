#!/usr/bin/env node
/**
 * witness-topology-modes.js — real topology mode enforcement (AP/CA/CP).
 *
 * Constructs a Nevil instance per mode and asserts the mode actually
 * configures the graph conflict strategy and network DHT flag, per the
 * CAP-theorem trade-off each mode names: AP (availability+partition,
 * flood-fill, no DHT), CA (consistency+availability, LWW, no DHT — no
 * partition tolerance is claimed), CP (consistency+partition, DHT routing
 * + Lamport clocks for causal ordering under a split).
 */

'use strict';

const Nevil = require('../nevil.js');
const { CONFLICT_STRATEGIES } = require('../graph.js');
const assert = require('assert');

function run() {
  const ap = new Nevil({ topology: 'ap' });
  const ca = new Nevil({ topology: 'ca' });
  const cp = new Nevil({ topology: 'cp' });

  assert.strictEqual(ap.topology, 'ap');
  assert.strictEqual(ca.topology, 'ca');
  assert.strictEqual(cp.topology, 'cp');

  assert.strictEqual(ap.opts.dhtEnabled, false, 'AP mode must not force DHT routing');
  assert.strictEqual(ca.opts.dhtEnabled, false, 'CA mode must not force DHT routing (no partition tolerance claimed)');
  assert.strictEqual(cp.opts.dhtEnabled, true, 'CP mode must enable DHT routing for partition tolerance');

  assert.strictEqual(ap.graph.resolveConflict, CONFLICT_STRATEGIES.lww);
  assert.strictEqual(ca.graph.resolveConflict, CONFLICT_STRATEGIES.lww);
  assert.strictEqual(cp.graph.resolveConflict, CONFLICT_STRATEGIES.lww);

  // Explicit opts override the topology preset (explicit config always wins).
  const overridden = new Nevil({ topology: 'ap', dhtEnabled: true });
  assert.strictEqual(overridden.opts.dhtEnabled, true, 'explicit dhtEnabled must override the AP preset');

  const out = {
    apDhtEnabled: ap.opts.dhtEnabled,
    caDhtEnabled: ca.opts.dhtEnabled,
    cpDhtEnabled: cp.opts.dhtEnabled,
    overrideRespected: overridden.opts.dhtEnabled === true,
    modesEnforced: true,
  };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run();
module.exports = { run };
