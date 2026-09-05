/**
 * crypto.js — passphrase-wrapping only (PBKDF2 -> AES-GCM via Web Crypto).
 *
 * Ed25519 signing and encrypt-for-recipient (sealed-box) live in
 * keychain.js — this module's scope is narrower: wrap/unwrap an arbitrary
 * JSON-serializable payload under a human passphrase, used by nevil.js to
 * seal a root identity seed so it can be recovered elsewhere with unlock().
 *
 * Built on globalThis.crypto.subtle so it runs unmodified in Node (>=19,
 * per package.json engines) and the browser alike — no Node-only `crypto`
 * module dependency.
 */

'use strict';

const PBKDF2_ITERATIONS = 210000; // OWASP-recommended floor for PBKDF2-HMAC-SHA256
// Ceiling on an untrusted payload's claimed iteration count: a crafted or
// corrupted sealedSeed naming an astronomical iterations value must not be
// able to hang the deriving process indefinitely at decrypt time.
const PBKDF2_MAX_ITERATIONS = 5000000;
const SALT_BYTES = 16;
const MIN_SALT_BYTES = 8; // floor for an explicitly supplied saltB64
const IV_BYTES = 12; // AES-GCM standard nonce size

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(str) {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError('passphrase must be a non-empty string');
  }
}

async function deriveKey(passphrase, saltBytes, iterations, usage) {
  // NFC-normalize first: a passphrase containing combining/composed Unicode
  // characters that a user's OS or input method might represent differently
  // across sessions must still derive the same key deterministically.
  const passBytes = new TextEncoder().encode(passphrase.normalize('NFC'));
  const baseKey = await globalThis.crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

/** Seal `data` (any JSON-serializable value) under `passphrase`. Returns a plain, JSON-safe payload object. */
async function encryptWithPass(data, passphrase, saltB64) {
  assertPassphrase(passphrase);

  let saltBytes;
  if (saltB64 !== undefined) {
    if (typeof saltB64 !== 'string' || saltB64.length === 0) {
      throw new TypeError('saltB64 must be a non-empty base64 string when provided');
    }
    saltBytes = fromBase64(saltB64);
    if (saltBytes.length < MIN_SALT_BYTES) {
      throw new TypeError(`saltB64 must decode to at least ${MIN_SALT_BYTES} bytes`);
    }
  } else {
    saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  }

  let plaintext;
  try {
    plaintext = JSON.stringify(data);
  } catch (err) {
    throw new TypeError(`encryptWithPass: data is not JSON-serializable: ${err.message}`);
  }
  // A bare function/Symbol, or an object whose toJSON() returns undefined,
  // makes JSON.stringify return undefined at the root without throwing —
  // must fail loud here, not silently seal a zero-length plaintext that
  // only surfaces as an opaque SyntaxError much later at decrypt time.
  if (plaintext === undefined) {
    throw new TypeError('encryptWithPass: data must serialize to a JSON value (JSON.stringify returned undefined)');
  }

  const iterations = PBKDF2_ITERATIONS;
  const key = await deriveKey(passphrase, saltBytes, iterations, 'encrypt');
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  return {
    salt: toBase64(saltBytes),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iterations,
  };
}

/** Unseal a payload produced by encryptWithPass. Throws on wrong passphrase or a malformed/corrupted payload. */
async function decryptWithPass(payload, passphrase) {
  assertPassphrase(passphrase);
  if (
    payload === null || typeof payload !== 'object' ||
    typeof payload.salt !== 'string' || typeof payload.iv !== 'string' || typeof payload.ciphertext !== 'string'
  ) {
    throw new TypeError('decryptWithPass: payload must be a sealed object with salt/iv/ciphertext strings');
  }

  // Legacy payloads sealed before `iterations` existed default to today's
  // constant; an untrusted claimed value is clamped, never trusted verbatim.
  let iterations = payload.iterations === undefined ? PBKDF2_ITERATIONS : payload.iterations;
  if (!Number.isFinite(iterations) || iterations <= 0) {
    throw new TypeError('decryptWithPass: payload.iterations must be a positive finite number');
  }
  if (iterations > PBKDF2_MAX_ITERATIONS) iterations = PBKDF2_MAX_ITERATIONS;

  let saltBytes, ivBytes, ciphertextBytes;
  try {
    saltBytes = fromBase64(payload.salt);
    ivBytes = fromBase64(payload.iv);
    ciphertextBytes = fromBase64(payload.ciphertext);
  } catch (err) {
    throw new TypeError('decryptWithPass: payload salt/iv/ciphertext must be valid base64');
  }

  const key = await deriveKey(passphrase, saltBytes, iterations, 'decrypt');
  let plaintextBuf;
  try {
    plaintextBuf = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ciphertextBytes);
  } catch (err) {
    throw new Error('decryptWithPass: wrong passphrase or corrupted payload');
  }
  return JSON.parse(new TextDecoder().decode(plaintextBuf));
}

module.exports = { encryptWithPass, decryptWithPass, PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS };
