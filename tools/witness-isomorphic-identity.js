#!/usr/bin/env node
/**
 * witness-isomorphic-identity.js — real fix for insert()/createIdentity()
 * calling require('crypto').randomUUID()/randomBytes, which throws in a
 * browser (no require()). Both now use globalThis.crypto (Web Crypto),
 * available natively in Node 19+ and every browser — the same isomorphism
 * crypto.js already relies on.
 */

'use strict';

const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const db = new Nevil({});
  await db.ready();

  const soul = db.insert({ x: 1 });
  assert.ok(typeof soul === 'string' && soul.length > 0, 'insert() must produce a soul via globalThis.crypto, not require(\'crypto\')');

  const { soul: idSoul } = await db.createIdentity({ passphrase: 'test-pass' });
  assert.ok(typeof idSoul === 'string' && idSoul.length === 64, 'createIdentity() must produce a 64-hex-char soul via globalThis.crypto.getRandomValues');

  const out = { insertSoul: soul, identitySoul: idSoul };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
