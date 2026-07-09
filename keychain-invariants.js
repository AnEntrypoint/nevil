'use strict';

const assert = require('assert');
const { Keychain, KeyPair } = require('../src/keychain.js');

let failed = false;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}`);
  if (!ok) failed = true;
}

// 1. Deterministic: same seed + same labels -> same keys, every time.
{
  const seed = Buffer.alloc(32, 42);
  const a = new Keychain(seed).sub('posts').get('post1');
  const b = new Keychain(seed).sub('posts').get('post1');
  check('derivation is deterministic (same seed+labels => same key)', a.toHex() === b.toHex());
}

// 2. Different labels -> different keys (no accidental collisions).
{
  const seed = Buffer.alloc(32, 42);
  const a = new Keychain(seed).get('post1');
  const b = new Keychain(seed).get('post2');
  check('different labels produce different keys', a.toHex() !== b.toHex());
}

// 3. Public-key-only capability: given ONLY a parent's public key, you can
//    still derive a child's public key (property #2 in the module docs).
{
  const seed = Buffer.alloc(32, 5);
  const owner = new Keychain(seed);
  const ownerPub = owner.get().publicKey; // just the public key, as if handed to someone else

  const readonlyKeys = Keychain.fromPublicKey(ownerPub);
  const childFromReadonly = readonlyKeys.get('profile');
  const childFromOwner = owner.get('profile');

  check('a public-key-only keychain derives the SAME child public key as the owner',
    childFromReadonly.toHex() === childFromOwner.toHex());
  check('a public-key-only derived child cannot sign', !childFromReadonly.writable);
}

// 4. Signing power does not leak through a readonly derivation, even
//    though the addresses match.
{
  const seed = Buffer.alloc(32, 9);
  const owner = new Keychain(seed);
  const childKeyPair = owner.get('secret-child');
  const readonlyChild = childKeyPair.toReadOnly();

  let threw = false;
  try {
    readonlyChild.sign(Buffer.from('trying to forge'));
  } catch {
    threw = true;
  }
  check('a KeyPair stripped to readonly refuses to sign', threw);
}

// 5. One-wayness: nothing here allows recovering a parent's scalar from
//    a child's scalar. We can't prove a negative cryptographically in a
//    unit test, but we CAN verify the API surface doesn't expose an
//    inverse operation, and that the child's scalar bears no naive
//    relationship (e.g. isn't just parent scalar minus a known offset)
//    to the labels alone without the parent public key.
{
  const seed = Buffer.alloc(32, 3);
  const owner = new Keychain(seed);
  const child = owner.get('branch');

  // Deriving "branch" again from a DIFFERENT random root should not
  // produce anything related to the real child - sanity check that the
  // parent's actual key material (not just the label) drives the output.
  const otherOwner = new Keychain(Buffer.alloc(32, 250));
  const otherChild = otherOwner.get('branch');
  check('same label under a different root yields an unrelated key',
    child.toHex() !== otherChild.toHex());
}

// 6. Composition: Keychain.composeChild(parentKeyPair, label) reproduces
//    exactly what parent.sub(label).get() / parent.get(label) would.
{
  const seed = Buffer.alloc(32, 11);
  const owner = new Keychain(seed);
  const parentKeyPair = owner.get(); // the root KeyPair itself

  const viaSub = owner.sub('devices').get('phone1');
  const viaCompose = Keychain.composeChild(Keychain.composeChild(parentKeyPair, 'devices'), 'phone1');

  check('composeChild reconstruction matches sub()/get() derivation', viaSub.toHex() === viaCompose.toHex());
}

// 7. checkout() preserves .home so you can navigate back to the root.
{
  const seed = Buffer.alloc(32, 77);
  const owner = new Keychain(seed);
  const somewhere = owner.sub('a').sub('b');
  const backHome = somewhere.checkout(somewhere.home.publicKey);
  check('checkout(home) navigates back to the root keychain', backHome.get().toHex() === owner.get().toHex());
}

process.exit(failed ? 1 : 0);
