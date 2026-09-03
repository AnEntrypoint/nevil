/**
 * keychain.js — deterministic hierarchical Ed25519 keypairs, implementing
 * the exact scheme used by Mathias Buus's keypear (holepunchto/keypear).
 *
 * WHY THIS REPLACES THE PASSWORD-DERIVED ACCOUNT SYSTEM:
 * The previous account model derived a soul from a hash of an alias and
 * stored an encrypted private key blob on the graph. That works, but
 * every child object (a post, a comment, a device) still needed its own
 * independently-generated keypair with no structural relationship to its
 * owner. Keychain derivation gives us a whole addressable tree from ONE
 * root secret, with three properties that fall directly out of the math
 * and don't exist in the old model:
 *
 *   1. FORWARD-ONLY DERIVATION (parent -> child, one-way).
 *      keys.sub('posts').sub(postId) derives a child keypair from a
 *      parent. The tweak seed is blake2b(parentPublicKey || label), so
 *      computing a child's keys requires the parent's key material, but
 *      the reverse is a hash-preimage problem: nobody holding only a
 *      child's private key can work backward to the parent's private
 *      key, or sideways to a sibling's.
 *
 *   2. PUBLIC-KEY-ONLY DERIVATION (capability without signing power).
 *      Because the tweak seed only needs the parent's PUBLIC key (not
 *      its private key), anyone holding just a parent's public key can
 *      compute every descendant's public key/address and therefore
 *      verify or reference that whole subtree -- without being able to
 *      sign as any node in it. Handing out a subtree's public key is
 *      safe read/verify/addressing capability sharing: "children can be
 *      made, but the parent can't be reconstructed" from that direction.
 *
 *   3. RECONSTRUCTION BY NONCE UNROLLING / KEY COMPOSITION.
 *      If you separately have the label chain (the sequence of names
 *      used at each level) and any one private key on the path, you can
 *      unroll forward to every key below it, or compose a child directly
 *      from a known parent keypair + a tweak label
 *      (Keychain.composeChild(parentKeyPair, label)) without the parent
 *      ever handing over their private key.
 *
 * IMPLEMENTATION NOTE -- why this wraps sodium-universal instead of
 * reimplementing the curve math:
 * An earlier version of this module reimplemented Ed25519 scalar/point
 * tweaking from scratch on top of @noble/curves. Cross-checking that
 * implementation against the real `keypear` package (installed
 * side-by-side and used as an oracle) showed the ROOT key derivation
 * matched byte-for-byte (standard RFC 8032 seed expansion), but the
 * CHILD/tweak derivation did not: keypear's `extension_tweak_ed25519_*`
 * functions are a Holepunch-maintained libsodium fork extension with an
 * undocumented internal clamping/reduction step that isn't derivable
 * from public libsodium docs. Rather than ship a scheme that LOOKS like
 * keypear's derivation but silently produces different keys (which
 * would be a correctness bug users could easily miss until two
 * implementations failed to interoperate), this module calls the real
 * extension functions via `sodium-universal` -- Holepunch's own
 * isomorphic wrapper (native bindings in Node, WASM/JS in the browser).
 * Verified byte-for-byte against `keypear` directly (audited via exec_js
 * witness, not a standing test file).
 *
 * ENCRYPT-FOR-RECIPIENT: the tweaked Ed25519 scalar this module derives is
 * NOT interchangeable with `crypto_sign_ed25519_pk_to_curve25519` for a
 * derived (non-root) key -- that conversion assumes a standard RFC 8032
 * seed-expanded secret key, and point-addition tweaking does not preserve
 * the sign-bit relationship it depends on (verified: they diverge for any
 * `.sub()`-derived key, matching only coincidentally at the root). The
 * correct primitive is `crypto_scalarmult_base(scalar)`, which is exact
 * for every scalar, tweaked or not: a writable KeyPair derives and
 * publishes its OWN X25519 public key via `toBoxPublicKey()`; senders
 * seal messages against that published value, never by converting the
 * Ed25519 public key directly.
 */

'use strict';

const sodium = require('sodium-universal');

// Required functions from the Holepunch libsodium fork extension this module
// depends on (see file header: extension_tweak_ed25519_* is not standard
// libsodium). If the native binding is missing or a future sodium-universal
// version changes its ABI, calls deep inside sign/derive would otherwise
// throw a cryptic "not a function" far from the actual cause. Checked once,
// eagerly, at module load — fail loud and specific instead of a confusing
// crash the first time an identity is derived or a message is signed.
const REQUIRED_SODIUM_FUNCTIONS = [
  'extension_tweak_ed25519_base',
  'extension_tweak_ed25519_sign_detached',
  'extension_tweak_ed25519_pk_add',
  'extension_tweak_ed25519_scalar_add',
  'extension_tweak_ed25519_sk_to_scalar',
  'crypto_sign_verify_detached',
  'crypto_sign_seed_keypair',
  'crypto_sign_keypair',
  'crypto_generichash_batch',
  'crypto_scalarmult_base',
  'crypto_box_seal',
  'crypto_box_seal_open',
];

function checkSodiumHealth() {
  const missing = REQUIRED_SODIUM_FUNCTIONS.filter((name) => typeof sodium[name] !== 'function');
  if (missing.length) {
    throw new Error(
      `keychain.js: sodium-universal is missing required function(s): ${missing.join(', ')}. ` +
      `This module depends on the Holepunch libsodium fork's extension_tweak_ed25519_* ` +
      `functions (see file header) — a partial/incompatible install after a bad upgrade, or ` +
      `a missing native binding, would otherwise fail deep inside sign()/derive() with a ` +
      `cryptic error far from this actual cause.`
    );
  }
}
checkSodiumHealth();

function toBuf(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  if (typeof x === 'number') return Buffer.concat([Buffer.from([0]), Buffer.from(String(x), 'utf8')]);
  throw new TypeError('expected Buffer, Uint8Array, string, or number');
}

// Every label TYPE gets its own leading type-tag byte before hashing, so no
// two label types/values can ever collide on the same tweak seed --
// including a string whose literal first byte happens to equal the number
// branch's 0x00 tag (e.g. '\x0042'), which toBuf() alone does not
// distinguish from sub(42) (both reduce to the same UTF-8 bytes). Tagging
// here (once, at the point labels actually get hashed) rather than inside
// toBuf() keeps toBuf()'s other callers -- raw message/signature/public-key
// byte coercion, which must NOT be tagged -- unaffected. Also accepts
// boolean/null labels (falsy values sub() must treat as real, distinct
// labels), which toBuf() itself does not handle.
function toLabelBuf(x) {
  if (typeof x === 'string') return Buffer.concat([Buffer.from([1]), Buffer.from(x, 'utf8')]);
  if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Buffer.concat([Buffer.from([2]), toBuf(x)]);
  if (typeof x === 'boolean') return Buffer.from([3, x ? 1 : 0]);
  if (x === null) return Buffer.from([4]);
  return toBuf(x); // numbers already self-tag with 0x00 inside toBuf()
}

// Distinguishes "no tweak yet" from a legitimate falsy label (0, '', false,
// null all pass through sub() as real labels) -- `tweak === null` cannot
// serve as the unset sentinel because sub(null) must itself derive a real,
// distinct child. No caller can pass this symbol as a label (module-private).
const UNSET_TWEAK = Symbol('unset-tweak');

/** A single derived keypair: a public key, and (if writable) the tweaked private scalar. */
class KeyPair {
  constructor({ publicKey, scalar }) {
    this.publicKey = publicKey; // Buffer(32)
    this.scalar = scalar || null; // Buffer(32) tweaked signing scalar, or null if readonly
  }

  get writable() {
    return this.scalar !== null;
  }

  /** Sign a message with the tweaked scalar. Throws if this is a readonly (public-key-only) instance. */
  sign(message) {
    if (!this.writable) throw new Error('cannot sign: this is a public-key-only (readonly) keypair');
    const sig = Buffer.alloc(sodium.crypto_sign_BYTES);
    sodium.extension_tweak_ed25519_sign_detached(sig, toBuf(message), this.scalar);
    return sig;
  }

  /** Returns false (never throws) for a malformed signature -- e.g. sodium asserts on a
   * signature shorter than crypto_sign_BYTES, which is untrusted-input shaped (any graph
   * node's stored sig), not a programmer error, so it must fail closed like a bad signature. */
  verify(message, signature) {
    try {
      return sodium.crypto_sign_verify_detached(toBuf(signature), toBuf(message), this.publicKey);
    } catch {
      return false;
    }
  }

  /**
   * This keypair's X25519 public key, for sealed-box encryption-for-recipient.
   * Must be derived from the SCALAR (via crypto_scalarmult_base), not from
   * the Ed25519 public key -- see the module-level note on why. Requires
   * the scalar (writable keypair); a read-only capability cannot publish
   * this on the holder's behalf, only the scalar-holder can.
   */
  toBoxPublicKey() {
    if (!this.writable) throw new Error('cannot derive box public key: this is a public-key-only (readonly) keypair');
    const xpk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
    sodium.crypto_scalarmult_base(xpk, this.scalar);
    return xpk;
  }

  /** Seal a message for this keypair's own published box public key (anyone can call this with just the pubkey; convenience when you already hold the writable pair). */
  encryptFor(message) {
    const xpk = this.toBoxPublicKey();
    const pt = toBuf(message);
    const sealed = Buffer.alloc(pt.length + sodium.crypto_box_SEALBYTES);
    sodium.crypto_box_seal(sealed, pt, xpk);
    return sealed;
  }

  /** Open a sealed-box message addressed to this keypair. Throws if this is read-only or the seal doesn't verify. */
  decrypt(sealed) {
    if (!this.writable) throw new Error('cannot decrypt: this is a public-key-only (readonly) keypair');
    const xpk = this.toBoxPublicKey();
    const ct = toBuf(sealed);
    const pt = Buffer.alloc(ct.length - sodium.crypto_box_SEALBYTES);
    const ok = sodium.crypto_box_seal_open(pt, ct, xpk, this.scalar);
    if (!ok) throw new Error('decryption failed: not sealed for this keypair, or corrupted');
    return pt;
  }

  /**
   * Derive a child KeyPair from this one and a label (Buffer/string).
   * Mirrors keypear's `_getTweak` + `add`: tweak = blake2b(thisPublicKey
   * || label), then
   *   childPublicKey = thisPublicKey (+) tweakPublicKey   (curve point add)
   *   childScalar    = thisScalar    (+) tweakScalar      (mod L, only if writable)
   */
  derive(label) {
    const tweak = deriveTweak(this.publicKey, label);
    return combine(this, tweak);
  }

  /** Public-key-only capability derived from this instance (drops signing power even if held). */
  toReadOnly() {
    return new KeyPair({ publicKey: this.publicKey, scalar: null });
  }

  toHex() {
    return this.publicKey.toString('hex');
  }
}

/**
 * Sender-side sealed-box encryption against a recipient's PUBLISHED X25519
 * public key (the output of `recipientKeyPair.toBoxPublicKey()`) -- the
 * sender never needs the recipient's Ed25519 public key or scalar for this.
 */
function encryptFor(boxPublicKey, message) {
  const xpk = toBuf(boxPublicKey);
  if (xpk.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error(
      `encryptFor: recipient box public key must be ${sodium.crypto_box_PUBLICKEYBYTES} bytes ` +
      `(got ${xpk.length}) — the recipient must have published a valid key via boxPublicKeyAt() ` +
      `first; a missing/truncated/malformed published key produces this error instead of an ` +
      `opaque libsodium failure deeper in crypto_box_seal`
    );
  }
  const pt = toBuf(message);
  const sealed = Buffer.alloc(pt.length + sodium.crypto_box_SEALBYTES);
  sodium.crypto_box_seal(sealed, pt, xpk);
  return sealed;
}

/** tweak = blake2b(parentPublicKey || label) -> (tweakScalar, tweakPublicKey), exactly as keypear computes it. */
function deriveTweak(parentPublicKey, label) {
  const labelBuf = toLabelBuf(label);
  const seed = Buffer.alloc(32);
  sodium.crypto_generichash_batch(seed, [parentPublicKey, labelBuf]);

  const tweakPublicKey = Buffer.alloc(32);
  const tweakScalar = Buffer.alloc(32);
  sodium.extension_tweak_ed25519_base(tweakScalar, tweakPublicKey, seed);

  return { scalar: tweakScalar, publicKey: tweakPublicKey };
}

/** childKeyPair = baseKeyPair (+) tweak, on both the public-key point and (if writable) the scalar. */
function combine(base, tweak) {
  const publicKey = Buffer.alloc(32);
  sodium.extension_tweak_ed25519_pk_add(publicKey, base.publicKey, tweak.publicKey);

  if (!base.writable) return new KeyPair({ publicKey, scalar: null });

  const scalar = Buffer.alloc(32);
  sodium.extension_tweak_ed25519_scalar_add(scalar, base.scalar, tweak.scalar);
  return new KeyPair({ publicKey, scalar });
}

/** Build a root KeyPair from a 32-byte seed (standard Ed25519 seed expansion). */
function keyPairFromSeed(seed) {
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
  const scalar = Buffer.alloc(32);
  sodium.extension_tweak_ed25519_sk_to_scalar(scalar, secretKey);
  return new KeyPair({ publicKey, scalar });
}

/** Build a fresh random root KeyPair. */
function randomKeyPair() {
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_keypair(publicKey, secretKey);
  const scalar = Buffer.alloc(32);
  sodium.extension_tweak_ed25519_sk_to_scalar(scalar, secretKey);
  return new KeyPair({ publicKey, scalar });
}

/**
 * Keychain — the top-level API, matching keypear's shape:
 *   new Keychain()               -> fresh random root
 *   new Keychain(seedBytes)      -> deterministic root from a 32-byte seed
 *   new Keychain(publicKeyBytes) -> readonly root (address-only capability)
 *   keys.get(label?)             -> a KeyPair (tweaked if label given)
 *   keys.sub(label)               -> a child Keychain, tweaked by label
 */
class Keychain {
  constructor(seedOrPublicKeyOrKeyPair) {
    if (seedOrPublicKeyOrKeyPair instanceof KeyPair) {
      this.home = seedOrPublicKeyOrKeyPair;
    } else if (seedOrPublicKeyOrKeyPair instanceof Uint8Array || Buffer.isBuffer(seedOrPublicKeyOrKeyPair)) {
      const bytes = toBuf(seedOrPublicKeyOrKeyPair);
      if (bytes.length !== 32) throw new RangeError('seed/public key must be exactly 32 bytes');
      // Convention (matches keypear's own ambiguity): a bare 32-byte
      // buffer is treated as a SEED for a fresh writable root. Use
      // Keychain.fromPublicKey() to build a readonly root explicitly.
      this.home = keyPairFromSeed(bytes);
    } else if (seedOrPublicKeyOrKeyPair == null) {
      this.home = randomKeyPair();
    } else {
      throw new TypeError('unsupported Keychain constructor argument');
    }
    this.base = this.home;
    this.tweak = UNSET_TWEAK;
  }

  static fromPublicKey(publicKeyHexOrBytes) {
    let publicKey;
    if (typeof publicKeyHexOrBytes === 'string') {
      if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHexOrBytes)) {
        throw new RangeError('public key hex string must be exactly 64 hex chars (32 bytes)');
      }
      publicKey = Buffer.from(publicKeyHexOrBytes, 'hex');
    } else {
      publicKey = toBuf(publicKeyHexOrBytes);
      if (publicKey.length !== 32) throw new RangeError('public key must be exactly 32 bytes');
    }
    return new Keychain(new KeyPair({ publicKey, scalar: null }));
  }

  /** Ensures the argument is a Keychain instance (mirrors keypear's Keychain.from). */
  static from(keychainOrKeyPairOrPublicKey) {
    if (keychainOrKeyPairOrPublicKey instanceof Keychain) return keychainOrKeyPairOrPublicKey;
    if (keychainOrKeyPairOrPublicKey instanceof KeyPair) return new Keychain(keychainOrKeyPairOrPublicKey);
    return Keychain.fromPublicKey(keychainOrKeyPairOrPublicKey);
  }

  /** Get a KeyPair from this chain's head, optionally tweaked by a label first. */
  get(label) {
    // sub() can legitimately store a falsy label (0, '', false, null), so a
    // truthy check here would skip derive() entirely and silently return
    // the parent's own key material instead of the intended child's --
    // UNSET_TWEAK is the only value that means "no tweak".
    const head = this.tweak !== UNSET_TWEAK ? this.base.derive(this.tweak) : this.base;
    return label === undefined ? head : head.derive(label);
  }

  get head() {
    return this.get();
  }

  get publicKey() {
    return this.head.publicKey;
  }

  /** A new sub-Keychain, tweaked by a label. Chainable: keys.sub('a').sub('b'). */
  sub(label) {
    if (label === undefined) throw new TypeError('sub() requires a label; use get() for the untweaked head');
    const child = Object.create(Keychain.prototype);
    child.home = this.home;
    child.base = this.get(); // fold in the current tweak before descending
    child.tweak = label;
    return child;
  }

  /** Jump to an absolute keypair/public key, keeping `.home` for navigating back to the root. */
  checkout(publicKeyOrKeyPair) {
    let target;
    if (publicKeyOrKeyPair instanceof KeyPair) {
      target = publicKeyOrKeyPair;
    } else {
      const publicKey = toBuf(publicKeyOrKeyPair);
      if (publicKey.length !== 32) throw new RangeError('public key must be exactly 32 bytes');
      target = new KeyPair({ publicKey, scalar: null });
    }
    const c = Object.create(Keychain.prototype);
    c.home = this.home;
    c.base = target;
    c.tweak = UNSET_TWEAK;
    return c;
  }

  /**
   * Compose a child key directly from a known parent KeyPair + tweak
   * label, without needing a live Keychain wrapping it. This is the
   * explicit "hand someone the parent and the tweak" reconstruction
   * path: given any parent KeyPair (writable or readonly) and the label
   * used at that level, recompute exactly the child derive() would
   * produce.
   */
  static composeChild(parentKeyPair, label) {
    return parentKeyPair.derive(label);
  }
}

module.exports = { Keychain, KeyPair, encryptFor, checkSodiumHealth };
