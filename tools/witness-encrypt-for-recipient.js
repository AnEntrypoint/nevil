#!/usr/bin/env node
/**
 * witness-encrypt-for-recipient.js — real sealed-box asymmetric encryption
 * between two parties, addressing the previously-phantom "encrypt-for-
 * recipient" claim in nevil.js's header (signing existed, encryption did
 * not).
 *
 * A recipient's derived (non-root) sub-address publishes its X25519
 * public key; a sender who holds ONLY that published value seals a
 * message; only the matching scalar-holder can open it. Wrong recipient
 * and read-only capability must both fail to decrypt.
 */

'use strict';

const { Keychain, encryptFor } = require('../keychain.js');
const assert = require('assert');

function run() {
  const recipient = new Keychain();
  const recipientInbox = recipient.sub('inbox');
  const recipientKp = recipientInbox.get();

  const publishedXpk = recipientKp.toBoxPublicKey();
  const sealed = encryptFor(publishedXpk, 'top secret field value');

  const opened = recipientKp.decrypt(sealed).toString();
  assert.strictEqual(opened, 'top secret field value', 'recipient must decrypt their own sealed message');

  const wrongKp = recipient.sub('other').get();
  let wrongRecipientRejected = false;
  try { wrongKp.decrypt(sealed); } catch { wrongRecipientRejected = true; }
  assert.ok(wrongRecipientRejected, 'a different derived sub-address must not decrypt');

  const readonly = recipientKp.toReadOnly();
  let readOnlyRejected = false;
  try { readonly.decrypt(sealed); } catch { readOnlyRejected = true; }
  assert.ok(readOnlyRejected, 'a read-only capability must not decrypt (no scalar held)');

  const out = { opened, wrongRecipientRejected, readOnlyRejected };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run();
module.exports = { run };
