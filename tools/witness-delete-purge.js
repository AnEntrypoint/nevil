#!/usr/bin/env node
/**
 * witness-delete-purge.js — real fix for delete() being a soft tombstone
 * only (every field nulled, but the soul + its full history persist in
 * the log and every replica forever). `compact({ purgeDeleted: true })`
 * now reclaims fully-tombstoned souls from both the in-memory graph and
 * the compacted log, so a later boot never sees them again (local-only —
 * other peers that already replicated the tombstone keep it until they
 * purge too, which is the honest scope: this is not a distributed
 * right-to-be-forgotten protocol).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nevil-purge-witness-'));
  const file = path.join(dir, 'log.ndjson');

  const a = new Nevil({ file });
  await a.ready();

  const soul = a.insert({ title: 'to be forgotten', body: 'sensitive' });
  await new Promise((r) => setTimeout(r, 100));

  a.delete(soul);
  await new Promise((r) => setTimeout(r, 100));

  const afterDeleteBeforePurge = a.get(soul); // still present, all-null (soft tombstone)
  assert.ok(afterDeleteBeforePurge && Object.values(afterDeleteBeforePurge).every((v) => v === null), 'delete() must leave an all-null tombstone before purge');

  await a.compact({ purgeDeleted: true });
  const afterPurge = a.get(soul);
  assert.strictEqual(afterPurge, undefined, 'compact({purgeDeleted:true}) must remove the tombstoned soul from the in-memory graph');

  const b = new Nevil({ file });
  await b.ready();
  const afterReboot = b.get(soul);
  assert.strictEqual(afterReboot, undefined, 'a rebooted instance must not see the purged soul — it must be gone from the compacted log too');

  fs.rmSync(dir, { recursive: true, force: true });

  const out = { tombstonedBeforePurge: !!afterDeleteBeforePurge, goneAfterPurge: afterPurge === undefined, goneAfterReboot: afterReboot === undefined };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
