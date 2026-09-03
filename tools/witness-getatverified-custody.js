#!/usr/bin/env node
/**
 * witness-getatverified-custody.js — real fix for getAtVerified only
 * checking each field's signature against the node's OWN public key,
 * never that the claimed _owner/_path chain of custody is real. Before
 * the fix, an attacker could generate any keypair, self-sign an
 * arbitrary _owner/_path claim, and getAtVerified would return it as
 * legitimate. The fix recomputes owner.sub(...path) and requires it
 * matches the actual soul.
 */

'use strict';

const Nevil = require('../nevil.js');
const { Keychain } = require('../keychain.js');
const assert = require('assert');

async function run() {
  const db = new Nevil({});
  await db.ready();
  await db.createIdentityFromSeed(Buffer.alloc(32).fill(3), {});

  const legitSoul = await db.putAt(['posts', 'p1'], { title: 'real post' });
  const legit = db.getAtVerified(legitSoul);
  assert.strictEqual(legit.title, 'real post', 'legitimate custody chain must verify');

  // Forge: a completely unrelated keypair self-signs fields AND a false
  // _owner/_path claim pointing at db's real identity, at a soul the
  // attacker fully controls (their own derived address, not db's).
  const attacker = new Keychain();
  const attackerKp = attacker.get();
  const forgedSoul = attackerKp.toHex();
  const forgedFields = {};
  const sig = attackerKp.sign(Buffer.from(JSON.stringify('forged title')));
  forgedFields.title = { v: 'forged title', sig: sig.toString('hex') };
  const ownerSig = attackerKp.sign(Buffer.from(JSON.stringify(db._identity.soul))); // claims db's identity as owner
  forgedFields._owner = { v: db._identity.soul, sig: ownerSig.toString('hex') };
  const pathSig = attackerKp.sign(Buffer.from(JSON.stringify(['posts', 'p1'])));
  forgedFields._path = { v: ['posts', 'p1'], sig: pathSig.toString('hex') };
  db.put(forgedSoul, forgedFields);

  const forged = db.getAtVerified(forgedSoul);
  assert.strictEqual(forged, undefined, 'a forged custody claim (self-signed by an unrelated keypair) must be rejected');

  // No custody claim at all (plain put, no _owner/_path) must also be rejected.
  const bareSoul = db.insert({ title: 'not signed at all' });
  const bare = db.getAtVerified(bareSoul);
  assert.strictEqual(bare, undefined, 'a node with no _owner/_path claim must be rejected, not silently returned');

  const out = { legitTitle: legit.title, forgedRejected: forged === undefined, bareRejected: bare === undefined };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
