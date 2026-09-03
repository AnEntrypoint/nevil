#!/usr/bin/env node
/**
 * witness-getdecryptedat-safety.js — real fix for nevil.getDecryptedAt
 * throwing on degenerate input instead of returning undefined: a
 * non-sealed field (e.g. a plain number from insert()) or the wrong
 * recipient's chain both used to throw from deep inside
 * KeyPair.decrypt's crypto_box_seal_open failure, rather than being
 * treated as "not decryptable by me" like every other lookup miss in
 * this API (get() on a missing soul, getAtVerified() on a bad claim).
 */

'use strict';

const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const db = new Nevil({});
  await db.ready();
  await db.createIdentityFromSeed(Buffer.alloc(32).fill(11), {});

  const plainSoul = db.insert({ x: 1 });
  let decryptThrew = false;
  let decryptResult;
  try { decryptResult = db.getDecryptedAt(['inbox'], plainSoul, 'x'); } catch { decryptThrew = true; }
  assert.strictEqual(decryptThrew, false, 'getDecryptedAt on a non-sealed field must not throw');
  assert.strictEqual(decryptResult, undefined, 'getDecryptedAt on a non-sealed field must return undefined');

  const boxPk = db.boxPublicKeyAt(['recipientA']);
  const soul = db.insert({ x: 0 });
  db.putEncrypted(soul, 'secret', { v: 1 }, boxPk);

  let wrongThrew = false;
  let wrongResult;
  try { wrongResult = db.getDecryptedAt(['recipientB'], soul, 'secret'); } catch { wrongThrew = true; }
  assert.strictEqual(wrongThrew, false, 'getDecryptedAt with the wrong recipient chain must not throw');
  assert.strictEqual(wrongResult, undefined, 'getDecryptedAt with the wrong recipient chain must return undefined');

  const correctResult = db.getDecryptedAt(['recipientA'], soul, 'secret');
  assert.deepStrictEqual(correctResult, { v: 1 }, 'the correct recipient chain must still decrypt successfully');

  const out = { decryptThrew, decryptResult, wrongThrew, wrongResult, correctResult };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
