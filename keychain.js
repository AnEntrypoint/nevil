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
 * Verified byte-for-byte against `keypear` directly; see test/keychain.test.js.
 */

'use strict';

const sodium = require('sodium-universal');

function toBuf(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  throw new TypeError('expected Buffer, Uint8Array, or string');
}

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

  verify(message, signature) {
    return sodium.crypto_sign_verify_detached(toBuf(signature), toBuf(message), this.publicKey);
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

/** tweak = blake2b(parentPublicKey || label) -> (tweakScalar, tweakPublicKey), exactly as keypear computes it. */
function deriveTweak(parentPublicKey, label) {
  const labelBuf = toBuf(label);
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
    this.tweak = null;
  }

  static fromPublicKey(publicKeyHexOrBytes) {
    const publicKey = typeof publicKeyHexOrBytes === 'string' ? Buffer.from(publicKeyHexOrBytes, 'hex') : toBuf(publicKeyHexOrBytes);
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
    const head = this.tweak ? this.base.derive(this.tweak) : this.base;
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
    const child = Object.create(Keychain.prototype);
    child.home = this.home;
    child.base = this.get(); // fold in the current tweak before descending
    child.tweak = label;
    return child;
  }

  /** Jump to an absolute keypair/public key, keeping `.home` for navigating back to the root. */
  checkout(publicKeyOrKeyPair) {
    const target = publicKeyOrKeyPair instanceof KeyPair ? publicKeyOrKeyPair : new KeyPair({ publicKey: toBuf(publicKeyOrKeyPair), scalar: null });
    const c = Object.create(Keychain.prototype);
    c.home = this.home;
    c.base = target;
    c.tweak = null;
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

module.exports = { Keychain, KeyPair };
