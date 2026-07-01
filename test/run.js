'use strict';

// Self-contained round-trip tests: create a patch with detools-js, apply it
// with detools-js, and check the result equals the new data. Cross-checks
// against real `detools` (Python) are done by test/cross-detools.js.

const assert = require('assert');
const { createPatch, applyPatch, packSize, unpackSize, ByteReader } = require('../src');
const { codecs } = require('../src/compression');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log('      ' + err.message);
  }
}

// --- pack_size round-trips ----------------------------------------------
function roundtripSize(v) {
  const buf = packSize(v);
  const r = new ByteReader(buf, 0);
  const out = unpackSize(r);
  assert.strictEqual(out, v, `pack/unpack ${v} -> ${out}`);
  assert.strictEqual(r.position, buf.length, `consumed all bytes for ${v}`);
}

check('pack_size round-trip', () => {
  for (const v of [0, 1, -1, 63, 64, -64, 65, 127, 128, 8191, 8192,
                   100000, -100000, 16777215, 2147483647, -2147483647]) {
    roundtripSize(v);
  }
});

// --- patch round-trips ---------------------------------------------------
function randomBuf(n, seed) {
  // Deterministic LCG so tests are reproducible.
  const out = Buffer.allocUnsafe(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

function mutate(buf, seed) {
  // Copy then apply a few inserts/deletes/overwrites to model a firmware bump.
  const parts = [];
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  let i = 0;
  while (i < buf.length) {
    const chunk = 1 + Math.floor(rnd() * 200);
    const action = rnd();
    if (action < 0.6) {
      parts.push(buf.subarray(i, i + chunk)); // copy
      i += chunk;
    } else if (action < 0.8) {
      i += chunk; // delete
    } else {
      parts.push(randomBuf(chunk, s)); // insert
    }
  }
  parts.push(Buffer.from('appended-tail-data'));
  return Buffer.concat(parts);
}

const cases = [
  ['empty->empty', Buffer.alloc(0), Buffer.alloc(0)],
  ['empty->data', Buffer.alloc(0), Buffer.from('hello world')],
  ['identical', Buffer.from('the quick brown fox'), Buffer.from('the quick brown fox')],
  ['small text', Buffer.from('the quick brown fox'), Buffer.from('the quick red fox jumps')],
  ['repeated bytes', Buffer.alloc(5000, 0xab), Buffer.concat([Buffer.alloc(2500, 0xab), Buffer.alloc(2500, 0xcd)])],
  ['random 8k', randomBuf(8192, 1), randomBuf(8192, 2)],
  ['firmware-like', randomBuf(20000, 7), null], // filled below
];
cases[cases.length - 1][2] = mutate(cases[cases.length - 1][1], 99);

// Self round-trip every implemented codec.
for (const compression of Object.keys(codecs)) {
  for (const [name, from, to] of cases) {
    check(`${compression}: ${name}`, () => {
      const patch = createPatch(from, to, { compression });
      const out = applyPatch(from, patch);
      assert.ok(out.equals(to), `result mismatch (got ${out.length} bytes, want ${to.length})`);
    });
  }
}

// Heatshrink with the priority firmware config (window 12 / lookahead 9).
if (codecs.heatshrink) {
  for (const [name, from, to] of cases) {
    check(`heatshrink 12/9: ${name}`, () => {
      const patch = createPatch(from, to, {
        compression: 'heatshrink',
        heatshrinkWindowSz2: 12,
        heatshrinkLookaheadSz2: 9,
      });
      const out = applyPatch(from, patch);
      assert.ok(out.equals(to), `result mismatch (got ${out.length} bytes, want ${to.length})`);
    });
  }
}

// --- corrupt / mismatched input must throw, not silently corrupt ----------
check('apply rejects wrong (too-short) from-data', () => {
  // A patch that genuinely copies a long run from `from`, so applying it
  // against a truncated from-file must be detected.
  const from = randomBuf(2000, 42);
  const to = Buffer.concat([from.subarray(0, 1900), Buffer.from('NEW TAIL')]);
  const patch = createPatch(from, to, { compression: 'none' });
  assert.ok(applyPatch(from, patch).equals(to)); // sanity: correct from works
  assert.throws(() => applyPatch(from.subarray(0, 50), patch), /from-data|past/i);
});

check('apply rejects truncated patch', () => {
  const from = Buffer.from('the quick brown fox');
  const to = Buffer.from('the quick red fox jumps');
  const patch = createPatch(from, to, { compression: 'none' });
  const truncated = patch.subarray(0, patch.length - 3);
  assert.throws(() => applyPatch(from, truncated));
});

check('apply rejects trailing garbage', () => {
  const from = Buffer.from('the quick brown fox');
  const to = Buffer.from('the quick red fox jumps');
  const patch = createPatch(from, to, { compression: 'none' });
  const extended = Buffer.concat([patch, Buffer.from([0, 0, 0])]);
  assert.throws(() => applyPatch(from, extended), /trailing|too long|past/i);
});

check('createPatch rejects out-of-scope compression', () => {
  assert.throws(() => createPatch(Buffer.from('a'), Buffer.from('b'), { compression: 'lzma' }),
    /not supported/i);
});

// --- arm-cortex-m4 data-format round-trip (real compiled firmware) ---------
(() => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, 'fixtures', 'arm');
  let from;
  let to;
  try {
    from = fs.readFileSync(path.join(dir, 'fw1.bin'));
    to = fs.readFileSync(path.join(dir, 'fw2.bin'));
  } catch (e) {
    console.log('skip  arm-cortex-m4 data-format (fixtures missing)');
    return;
  }
  const zeroSeg = {
    fromDataOffsetBegin: 0, fromDataOffsetEnd: 0, fromDataBegin: 0, fromDataEnd: 0,
    fromCodeBegin: 0, fromCodeEnd: 0,
    toDataOffsetBegin: 0, toDataOffsetEnd: 0, toDataBegin: 0, toDataEnd: 0,
    toCodeBegin: 0, toCodeEnd: 0,
  };
  for (const compression of ['none', 'crle', 'heatshrink']) {
    check(`arm-cortex-m4 + ${compression}: round-trip`, () => {
      const patch = createPatch(from, to, {
        compression,
        heatshrinkWindowSz2: 12,
        heatshrinkLookaheadSz2: 9,
        dataFormat: 'arm-cortex-m4',
        dataSegment: zeroSeg,
      });
      assert.ok(applyPatch(from, patch).equals(to), 'arm data-format round-trip mismatch');
    });
  }
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
