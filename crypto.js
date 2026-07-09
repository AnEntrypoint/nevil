/**
 * crypto.js — the SEA-equivalent security layer.
 *
 * Preference: built on the Web Crypto API (globalThis.crypto.subtle),
 * which is standard in every browser and available natively in Node 19+.
 * Zero external dependencies, and the exact same code path runs in both
 * runtimes — no separate node-crypto branch to keep in sync.
 *
 * Provides: keypair generation, signing/verification (ECDSA P-256),
 * asymmetric encryption via ECDH-derived shared secrets + AES-GCM, and
 * password-based account derivation (PBKDF2), covering the same
 * surface as GUN's SEA (auth, sign, encrypt, secret).
 */

'use strict';

const subtle = globalThis.crypto.subtle;

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// btoa/atob exist in browsers; polyfill minimally for Node.
const btoa = globalThis.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));
const atob = globalThis.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));

/** Generate a signing keypair (ECDSA P-256) + an encryption keypair (ECDH P-256). */
async function pair() {
  const signKey = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const dhKey = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);

  const [pub, priv, epub, epriv] = await Promise.all([
    subtle.exportKey('jwk', signKey.publicKey),
    subtle.exportKey('jwk', signKey.privateKey),
    subtle.exportKey('jwk', dhKey.publicKey),
    subtle.exportKey('jwk', dhKey.privateKey),
  ]);

  return { pub, priv, epub, epriv };
}

async function importSignKey(jwk, usage) {
  return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, [usage]);
}

async function importDhPrivateKey(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
}

async function importDhPublicKey(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/** Sign arbitrary JSON-serializable data with a pair's private signing key. */
async function sign(data, keyPair) {
  const key = await importSignKey(keyPair.priv, 'sign');
  const msg = new TextEncoder().encode(JSON.stringify(data));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msg);
  return { m: data, s: toB64(sig) };
}

/** Verify a { m, s } signed envelope against a public signing key (jwk). */
async function verify(signed, pubJwk) {
  const key = await importSignKey(pubJwk, 'verify');
  const msg = new TextEncoder().encode(JSON.stringify(signed.m));
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(signed.s), msg);
  return ok ? signed.m : undefined;
}

/** Derive a shared AES-GCM key from my epriv + their epub (ECDH). */
async function _sharedKey(theirEpub, myPair) {
  const myPriv = await importDhPrivateKey(myPair.epriv);
  const theirPub = await importDhPublicKey(theirEpub);
  return subtle.deriveKey(
    { name: 'ECDH', public: theirPub },
    myPriv,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt data for a recipient using ECDH(myPair.epriv, theirEpub) -> AES-GCM. */
async function encryptFor(data, myPair, theirEpub) {
  const key = await _sharedKey(theirEpub, myPair);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(data));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  return { ct: toB64(ct), iv: toB64(iv) };
}

/** Decrypt a payload produced by encryptFor, using my epriv + their epub. */
async function decryptFrom(payload, myPair, theirEpub) {
  const key = await _sharedKey(theirEpub, myPair);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Symmetric encrypt with a passphrase-derived key (PBKDF2 -> AES-GCM). Used for local account secrets. */
async function encryptWithPass(data, passphrase, saltB64) {
  const salt = saltB64 ? fromB64(saltB64) : globalThis.crypto.getRandomValues(new Uint8Array(16));
  const baseKey = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(data));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  return { ct: toB64(ct), iv: toB64(iv), salt: toB64(salt) };
}

async function decryptWithPass(payload, passphrase) {
  const salt = fromB64(payload.salt);
  const baseKey = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Deterministic-ish account soul derived from alias, so lookups don't need a directory service. */
async function accountSoul(alias) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode('~account:' + alias));
  return '~' + toB64(digest).slice(0, 22);
}

/** Compute proof-of-work: find nonce s.t. leading_zeros(blake2b(soul || nonce)) >= difficulty. */
async function computePoW(soul, difficulty) {
  // For PoW computation, we use a simpler approach: hash(soul || nonce) with difficulty check
  // On Node, this will use crypto.createHash; in browser, falls back to Web Crypto API.
  let nonce = 0;
  const enc = new TextEncoder();
  while (true) {
    const input = soul + ':' + nonce;
    const digest = await subtle.digest('SHA-256', enc.encode(input));
    const hex = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    const leadingZeros = hex.match(/^0*/)[0].length;
    if (leadingZeros >= difficulty) return nonce;
    nonce++;
  }
}

module.exports = {
  pair,
  sign,
  verify,
  encryptFor,
  decryptFrom,
  encryptWithPass,
  decryptWithPass,
  accountSoul,
  computePoW,
  toB64,
  fromB64,
};
