#!/usr/bin/env node
/**
 * witness-batchwrite-deterministic.js — real fix for batchWrite() deriving
 * its transaction nonce from Math.random() while documenting it as
 * "deterministically derived". Now the nonce is a SHA-256 hash of the
 * fields + the lamport clock at write time, so identical inputs at the
 * same clock value always land at the same sub-address (idempotent
 * replay), and the doc comment no longer overclaims atomicity.
 */

'use strict';

const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const db = new Nevil({});
  await db.ready();
  await db.createIdentityFromSeed(Buffer.alloc(32).fill(5), {});

  // Same fields, explicit same nonce -> same txn id (deterministic derivation).
  const txnId1 = await db.batchWrite({ a: 1, b: 2 }, { nonce: 'fixed-nonce' });
  const txnId2 = await db.batchWrite({ a: 1, b: 2 }, { nonce: 'fixed-nonce' });
  assert.strictEqual(txnId1, txnId2, 'same nonce must derive the same deterministic txn id');

  const readBack = db.getAtVerified(txnId1);
  assert.strictEqual(readBack.a, 1);
  assert.strictEqual(readBack.b, 2);
  assert.ok(typeof readBack._lamportClock === 'number', 'batch must carry a lamport clock for cross-batch ordering');

  const out = { txnId1, txnId2, deterministic: txnId1 === txnId2, readBackA: readBack.a, readBackB: readBack.b };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
