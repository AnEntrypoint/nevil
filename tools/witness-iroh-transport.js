'use strict';

/**
 * witness-iroh-transport.js — real 2-node iroh QUIC connection carrying a signed
 * nevil write end to end. Node A creates an identity, does a signed putAt over the
 * iroh transport (relay disabled, direct/LAN), and node B's getAtVerified confirms
 * the write with its per-field signature intact — proving the QUIC transport swap
 * changes bytes-on-wire only, never the signature-verification admission pipeline.
 *
 * Requires the optional native binding @number0/iroh; skips (exit 0) with a clear
 * message if it is absent, so the witness suite stays green on a ws-only install.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

try { require('@number0/iroh'); }
catch { console.log('SKIP witness-iroh-transport: @number0/iroh not installed (optional Node-only transport)'); process.exit(0); }

const Nevil = require('../nevil');

async function run() {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'nevil-iroh-witness-A-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'nevil-iroh-witness-B-'));
  const A = new Nevil({ file: path.join(dirA, 'log.ndjson'), peers: [], irohEnabled: true, irohRelay: false });
  const B = new Nevil({ file: path.join(dirB, 'log.ndjson'), peers: [], irohEnabled: true, irohRelay: false });
  await A.ready();
  await B.ready();

  const bAddr = await B.irohNodeAddr();
  assert(bAddr, 'B must expose an iroh node address');
  await A.dialIroh(bAddr);
  await new Promise((r) => setTimeout(r, 700)); // let the QUIC handshake + accept settle

  const { soul } = await A.createIdentity({ passphrase: 'witness passphrase' });
  assert(/^[0-9a-f]{64}$/.test(soul), 'identity soul is a 64-hex Ed25519 pubkey');

  const postSoul = await A.putAt(['posts', 'p1'], { title: 'signed over quic' });
  assert(/^[0-9a-f]{64}$/.test(postSoul), 'derived post soul is a 64-hex Ed25519 pubkey');

  let verified = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    verified = B.getAtVerified(postSoul);
    if (verified && verified.title) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  assert(verified, 'B must receive and verify the signed write over iroh');
  assert.strictEqual(verified.title, 'signed over quic', 'verified title matches');
  assert(verified._owner, 'verified result carries the _owner custody value');

  const aSockets = A.network.sockets.size;
  const bSockets = B.network.sockets.size;

  const closeStart = Date.now();
  await A.close();
  await B.close();
  const closeMs = Date.now() - closeStart;
  assert(closeMs < 5000, 'close() tears down the iroh endpoint without hanging');

  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });

  const out = { postSoul, title: verified.title, owner: verified._owner.slice(0, 16), aSockets, bSockets, closeMs, verifiedOverIroh: true };
  console.log(JSON.stringify(out));
  return out;
}

run().catch((e) => { console.error('witness-iroh-transport FAILED:', e.message); process.exit(1); });
