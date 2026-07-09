const assert = require('assert');
const fs = require('fs');
const Nevil = require('./nevil.js');

function log(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}`);
  if (!ok) process.exitCode = 1;
}

async function testNetworkMetricsExist() {
  const dir = './test/tmp-metrics-' + Date.now();
  const db = new Nevil({ file: dir + '/log.ndjson', peers: [] });
  await db.ready();

  const metrics = db.network.getMetrics();
  log('network has getMetrics() method', typeof metrics === 'object' && metrics !== null);
  log('metrics has messagesReceived', typeof metrics.messagesReceived === 'number');
  log('metrics has messagesSent', typeof metrics.messagesSent === 'number');
  log('metrics has bytesSent', typeof metrics.bytesSent === 'number');
  log('metrics has peersConnected', typeof metrics.peersConnected === 'number');

  db.put('test1', { value: 'hello' });
  const metrics2 = db.network.getMetrics();
  log('metrics are stable after put', metrics2.messagesReceived === 0 && metrics2.messagesSent === 0);

  fs.rmSync(dir, { recursive: true, force: true });
}

async function testStorageStillWorks() {
  const dir = './test/tmp-storage-check-' + Date.now();
  const db = new Nevil({ file: dir + '/log.ndjson', peers: [] });
  await db.ready();

  db.put('node1', { greeting: 'hello', count: 1 });
  await new Promise((r) => setTimeout(r, 50));

  const db2 = new Nevil({ file: dir + '/log.ndjson', peers: [] });
  await db2.ready();

  const state = db2.get('node1');
  log('storage replay works after metrics added', state && state.greeting === 'hello' && state.count === 1);

  fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  await testNetworkMetricsExist();
  await testStorageStillWorks();
  console.log('All tests passed');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
