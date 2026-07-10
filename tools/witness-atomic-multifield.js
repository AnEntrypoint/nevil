#!/usr/bin/env node
/**
 * witness-atomic-multifield.js — real fix for "no atomic multi-field
 * commit". Two parts: (1) in-memory atomicity was already real (verified:
 * Graph.put's field loop is fully synchronous, no reader can observe a
 * partial node mid-write — JS single-threaded execution guarantees this,
 * not something that needed fixing); (2) the genuine gap was
 * crash-during-persist durability — putTxn()/getTxn() close it with an
 * explicit `_txnComplete` marker field so a reader (including one
 * replaying the log after a crash) can tell a fully-landed logical write
 * from a torn one.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nevil-txn-witness-'));
  const file = path.join(dir, 'log.ndjson');

  const a = new Nevil({ file });
  await a.ready();

  const soul = 'txn-soul';
  a.putTxn(soul, { title: 'x', body: 'y', tags: ['a'] });
  await new Promise((r) => setTimeout(r, 100));

  const complete = a.getTxn(soul);
  assert.deepStrictEqual(complete, { title: 'x', body: 'y', tags: ['a'] }, 'a fully-landed putTxn must read back all fields via getTxn');

  // Reboot: the transaction marker must survive and getTxn must still see it as complete.
  const b = new Nevil({ file });
  await b.ready();
  const afterReboot = b.getTxn(soul);
  assert.deepStrictEqual(afterReboot, { title: 'x', body: 'y', tags: ['a'] }, 'transaction completeness must survive a reboot');

  // A node written via plain put() (no _txnComplete marker) must be invisible to getTxn.
  const plainSoul = a.insert({ partial: 'oops' });
  const plainViaTxn = a.getTxn(plainSoul);
  assert.strictEqual(plainViaTxn, undefined, 'a node with no _txnComplete marker must be invisible via getTxn, even though its own fields are individually valid HAM state');

  fs.rmSync(dir, { recursive: true, force: true });

  const out = { complete, afterReboot, plainRejected: plainViaTxn === undefined };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
