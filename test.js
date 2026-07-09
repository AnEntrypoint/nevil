'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const { Graph, hamWins } = require('./graph');
const sea = require('./crypto');
const MonoGun = require('./monogun');

function log(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}`);
  if (!ok) process.exitCode = 1;
}

async function testGraphHAM() {
  const g = new Graph();
  g.mergeNode('a', { x: 1 }, { x: 100 });
  g.mergeNode('a', { x: 2 }, { x: 50 }); // older timestamp, should be dropped
  assert.strictEqual(g.get('a').x, 1);
  log('HAM drops stale (older-timestamp) writes', g.get('a').x === 1);

  g.mergeNode('a', { x: 3 }, { x: 200 }); // newer, should win
  log('HAM accepts newer writes', g.get('a').x === 3);

  assert.strictEqual(hamWins(100, 'b', 100, 'a'), true); // tie -> lexical tiebreak
  log('HAM tie-break is deterministic', hamWins(100, 'b', 100, 'a') === true);
}

async function testGraphListeners() {
  const g = new Graph();
  let fired = null;
  g.on('n1', (node, changed) => (fired = { node, changed }));
  g.put('n1', { hello: 'world' });
  log('listener fires on local put', fired && fired.node.hello === 'world');
}

async function testCrypto() {
  const alice = await sea.pair();
  const bob = await sea.pair();

  const signed = await sea.sign({ msg: 'hi' }, alice);
  const verified = await sea.verify(signed, alice.pub);
  log('sign/verify round trip', verified && verified.msg === 'hi');

  const tampered = { ...signed, s: signed.s.slice(0, -2) + 'AA' };
  const badVerify = await sea.verify(tampered, alice.pub).catch(() => undefined);
  log('tampered signature fails verification', badVerify === undefined);

  const cipher = await sea.encryptFor('secret payload', alice, bob.epub);
  const plain = await sea.decryptFrom(cipher, bob, alice.epub);
  log('ECDH+AES-GCM encrypt/decrypt round trip', plain === 'secret payload');

  const passEnc = await sea.encryptWithPass({ k: 'v' }, 'correct horse');
  const passDec = await sea.decryptWithPass(passEnc, 'correct horse');
  log('passphrase encrypt/decrypt round trip', passDec.k === 'v');

  let wrongPassFailed = false;
  try {
    await sea.decryptWithPass(passEnc, 'wrong password');
  } catch {
    wrongPassFailed = true;
  }
  log('wrong passphrase fails to decrypt', wrongPassFailed);
}

async function testStorageReplay() {
  const dir = './test/tmp-storage-' + Date.now();
  const db1 = new MonoGun({ file: dir + '/log.ndjson', peers: [] });
  await db1.ready();
  db1.put('node1', { greeting: 'hello' });
  db1.put('node1', { count: 1 });
  await new Promise((r) => setTimeout(r, 50)); // let async persist land

  // fresh instance pointed at the same file should replay identical state
  const db2 = new MonoGun({ file: dir + '/log.ndjson', peers: [] });
  await db2.ready();
  const state = db2.get('node1');
  log('storage replay reconstructs graph state', state && state.greeting === 'hello' && state.count === 1);

  fs.rmSync(dir, { recursive: true, force: true });
}

async function testIdentityFlow() {
  const dir = './test/tmp-account-' + Date.now();
  const db = new MonoGun({ file: dir + '/log.ndjson', peers: [] });
  await db.ready();

  const seed = Buffer.alloc(32, 123);
  const { soul } = await db.createIdentityFromSeed(seed, { passphrase: 'hunter2', alias: 'alice' });
  log('identity created, soul is a hex public key', /^[0-9a-f]{64}$/.test(soul));

  const subSoul = await db.putAt(['profile'], { bio: 'hello, I am alice' });
  log('signed sub-address write returns a hex soul', /^[0-9a-f]{64}$/.test(subSoul));

  const verified = db.getAtVerified(subSoul);
  log('signed write + verified read round trip', verified.bio === 'hello, I am alice');
  log('verified read carries the owner soul', verified._owner === soul);

  const unlocked = await db.unlock(soul, 'hunter2');
  log('unlock() with correct passphrase reconstructs the same identity', unlocked.soul === soul);

  let wrongUnlockFailed = false;
  try {
    await db.unlock(soul, 'wrong-pass');
  } catch {
    wrongUnlockFailed = true;
  }
  log('unlock() with wrong passphrase fails', wrongUnlockFailed);

  // createIdentity() (random seed, not createIdentityFromSeed) should
  // also support passphrase recovery transparently.
  const { soul: soul2 } = await db.createIdentity({ passphrase: 'another-pass', alias: 'bob' });
  const unlocked2 = await db.unlock(soul2, 'another-pass');
  log('createIdentity({passphrase}) is itself recoverable via unlock()', unlocked2.soul === soul2);

  fs.rmSync(dir, { recursive: true, force: true });
}

async function testKeychainCapabilitySharing() {
  const dir = './test/tmp-cap-' + Date.now();
  const db = new MonoGun({ file: dir + '/log.ndjson', peers: [] });
  await db.ready();

  const seed = Buffer.alloc(32, 55);
  const { soul } = await db.createIdentityFromSeed(seed);
  const subSoul = await db.putAt(['posts', 'post1'], { title: 'hello world' });

  // Someone with ONLY the owner's public soul (no seed, no private key)
  // can derive the exact same sub-address and verify it, but not sign as it.
  const capability = db.capability(soul);
  const derivedSubKeyPair = capability.sub('posts').get('post1');
  log('a public-key-only capability derives the identical sub-address',
    derivedSubKeyPair.toHex() === subSoul);
  log('the capability-derived keypair cannot sign', !derivedSubKeyPair.writable);

  const verified = db.getAtVerified(subSoul);
  log('the post is independently verifiable via that derived address', verified.title === 'hello world');

  fs.rmSync(dir, { recursive: true, force: true });
}

async function testGraphQLQuery() {
  const dir = './test/tmp-query-' + Date.now();
  const db = new MonoGun({ file: dir + '/log.ndjson', peers: [] });
  await db.ready();

  db.put('user1', { name: 'Alice', bio: 'hi' });
  db.put('post1', { title: 'First post', body: '...' });
  db.put('post2', { title: 'Second post', body: '...' });
  db.link('post1', 'author', 'user1');
  db.link('post2', 'author', 'user1');
  db.put('user1', { posts: [{ '#': 'post1' }, { '#': 'post2' }] });

  const result = db.query({
    soul: 'post1',
    select: ['title'],
    author: { via: 'author', select: ['name'] },
  });
  log('query resolves a single linked field', result.title === 'First post' && result.author.name === 'Alice');

  const userResult = db.query({
    soul: 'user1',
    select: ['name'],
    userPosts: { via: 'posts', list: true, select: ['title'] },
  });
  log('query resolves a list of linked fields with aliasing',
    userResult.name === 'Alice' &&
    Array.isArray(userResult.userPosts) &&
    userResult.userPosts.length === 2 &&
    userResult.userPosts[0].title === 'First post');

  const multi = db.query({ souls: ['post1', 'post2'], select: ['title'] });
  log('query resolves multiple root souls at once', multi.length === 2 && multi[1].title === 'Second post');

  fs.rmSync(dir, { recursive: true, force: true });
}

async function testNetworkSync() {
  const dirA = './test/tmp-net-a-' + Date.now();
  const dirB = './test/tmp-net-b-' + Date.now();

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const peerA = new MonoGun({ file: dirA + '/log.ndjson', server, peers: [] });
  await peerA.ready();

  const peerB = new MonoGun({ file: dirB + '/log.ndjson', peers: [`ws://localhost:${port}/monogun`] });
  await peerB.ready();

  await new Promise((r) => setTimeout(r, 300)); // let the websocket handshake complete

  peerA.put('shared', { fromA: true, ts: Date.now() });

  await new Promise((r) => setTimeout(r, 400)); // let flood-fill propagate

  const seenOnB = peerB.get('shared');
  log('write on peer A propagates to peer B over the network', seenOnB && seenOnB.fromA === true);

  peerB.put('shared', { fromB: true });
  await new Promise((r) => setTimeout(r, 400));
  const seenOnA = peerA.get('shared');
  log('write on peer B propagates back to peer A', seenOnA && seenOnA.fromB === true);

  server.close();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  process.exit(process.exitCode || 0); // ws keeps the process alive otherwise
}

async function testSQLGraphQLAPI() {
  const dir = './test/tmp-sql-' + Date.now();
  const db = new MonoGun({ file: dir + '/log.ndjson', peers: [] });
  await db.ready();

  // Test CRUD API
  const post1 = db.insert({ title: 'First', published: true, views: 10 });
  const post2 = db.insert({ title: 'Second', published: true, views: 50 });
  const post3 = db.insert({ title: 'Draft', published: false, views: 5 });

  log('insert generates soul', typeof post1 === 'string' && post1.length > 0);
  log('get after insert', db.get(post1).title === 'First');

  // Test update
  const updated = db.update(post1, { views: 20 });
  log('update returns merged node', updated.title === 'First' && updated.views === 20);

  // Test select with filter
  const published = db.select({
    souls: [post1, post2, post3],
    select: ['title'],
    filter: { published: true }
  });
  log('filter: published=true returns 2 posts', published.length === 2);

  // Test sort
  const sorted = db.select({
    souls: [post1, post2, post3],
    select: ['title', 'views'],
    sort: ['views', 'desc']
  });
  log('sort desc by views: first is post2 (50 views)', sorted[0].views === 50);

  // Test limit/offset
  const page = db.select({
    souls: [post1, post2, post3],
    select: ['title'],
    limit: 2,
    offset: 1
  });
  log('limit 2 offset 1 on 3 items returns 2', page.length === 2);

  // Test mapToRows (SQL-style result)
  const rows = db.select({
    souls: [post1, post2],
    select: ['title'],
    mapToRows: true
  });
  log('mapToRows removes soul field', !('soul' in rows[0]) && 'title' in rows[0]);

  // Test subscribe alias
  let fired = false;
  const unsub = db.subscribe(post1, () => {
    fired = true;
  });
  db.update(post1, { views: 30 });
  unsub();
  log('subscribe listener fires on update', fired);

  // Test query with nested filters and sort
  db.put('user1', { name: 'Alice' });
  db.link(post1, 'author', 'user1');
  db.link(post2, 'author', 'user1');
  const authoredPosts = db.query({
    soul: 'user1',
    select: ['name'],
    posts: {
      via: [post1, post2],
      list: true,
      select: ['title', 'views'],
      filter: { published: true },
      sort: ['views', 'desc']
    }
  });
  log('query with nested filter and sort on list', authoredPosts.name === 'Alice');

  // Test delete
  db.delete(post3);
  const deleted = db.get(post3);
  log('delete clears node', deleted && Object.keys(deleted).every(k => deleted[k] === null));

  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  await testGraphHAM();
  await testGraphListeners();
  await testCrypto();
  await testStorageReplay();
  await testIdentityFlow();
  await testKeychainCapabilitySharing();
  await testGraphQLQuery();
  await testSQLGraphQLAPI();
  await testNetworkSync();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
