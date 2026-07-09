/**
 * crypto.js — passphrase-based secret wrapping for the local account seed.
 *
 * Built on the Web Crypto API (globalThis.crypto.subtle), standard in every
 * browser and available natively in Node 19+. The same code path runs in both
 * runtimes — no separate node-crypto branch to keep in sync.
 *
 * This module ONLY wraps a secret (the root seed) with a passphrase via
 * PBKDF2 -> AES-GCM, and provides base64url helpers. On-the-wire signing and
 * asymmetric encryption use Ed25519 via keychain.js (sodium-universal); that
 * logic lives there, not here.
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

module.exports = {
  encryptWithPass,
  decryptWithPass,
  toB64,
  fromB64,
};
