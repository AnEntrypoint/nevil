#!/usr/bin/env node
/**
 * witness-query-pagination-zero.js — real fix for query.js treating
 * limit:0/offset:0 as falsy and silently ignoring them (`if (sub.limit)`
 * style checks skip valid zero values). Fixed to `!= null` checks at both
 * the nested-selection and root-level query paths.
 */

'use strict';

const Nevil = require('../nevil.js');
const assert = require('assert');

async function run() {
  const db = new Nevil({});
  await db.ready();
  const s1 = db.insert({ name: 'a' });
  const s2 = db.insert({ name: 'b' });
  const s3 = db.insert({ name: 'c' });

  const zeroLimit = db.query({ souls: [s1, s2, s3], select: ['name'], limit: 0 });
  assert.strictEqual(zeroLimit.length, 0, 'limit:0 must return an empty array, not ignore the limit');

  const zeroOffset = db.query({ souls: [s1, s2, s3], select: ['name'], offset: 0, limit: 2 });
  assert.strictEqual(zeroOffset.length, 2, 'offset:0 must apply (a no-op skip), limit:2 must cap results');

  const out = { zeroLimitLength: zeroLimit.length, zeroOffsetLength: zeroOffset.length };
  console.log(JSON.stringify(out));
  return out;
}

if (require.main === module) run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
