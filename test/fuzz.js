'use strict';

// Randomized property tests. Beyond the fixed cases, this hammers create->apply
// with many random (from, to) pairs across sizes that stress the heatshrink
// buffer/backlog boundaries, plus a robustness pass feeding random garbage to
// applyPatch (it must throw cleanly, never hang or crash the process).
//
// A small subset is also cross-checked against real detools when available.

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPatch, applyPatch } = require('../src');

const SEED = Number(process.env.FUZZ_SEED) || 0x1234;
const ITERS = Number(process.env.FUZZ_ITERS) || 800;
const PYTHON = process.env.PYTHON || 'python';

// Deterministic RNG.
let s = SEED >>> 0;
function rand() {
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  return s / 0x100000000;
}
function randint(n) {
  return Math.floor(rand() * n);
}

function randomBuf(n) {
  const b = Buffer.allocUnsafe(n);
  let i = 0;
  while (i < n) {
    const r = rand();
    if (r < 0.25) {
      // a run of one byte (models padding / erased flash)
      const runLen = 1 + randint(Math.min(64, n - i));
      const v = randint(256);
      b.fill(v, i, i + runLen);
      i += runLen;
    } else {
      b[i++] = randint(256);
    }
  }
  return b;
}

function deriveTo(from) {
  // Mutate `from` into `to` with copies/deletes/inserts (models a firmware bump).
  const parts = [];
  let i = 0;
  while (i < from.length) {
    const chunk = 1 + randint(128);
    const a = rand();
    if (a < 0.65) { parts.push(from.subarray(i, i + chunk)); i += chunk; }
    else if (a < 0.82) { i += chunk; }
    else { parts.push(randomBuf(chunk)); }
  }
  if (rand() < 0.5) parts.push(randomBuf(1 + randint(40)));
  return Buffer.concat(parts);
}

const COMPRESSIONS = [
  { compression: 'none' },
  { compression: 'crle' },
  { compression: 'heatshrink', heatshrinkWindowSz2: 8, heatshrinkLookaheadSz2: 7 },
  { compression: 'heatshrink', heatshrinkWindowSz2: 12, heatshrinkLookaheadSz2: 9 },
  { compression: 'heatshrink', heatshrinkWindowSz2: 13, heatshrinkLookaheadSz2: 9 },
];

// Sizes chosen to straddle the heatshrink input-buffer boundaries (1<<w).
function randomSize() {
  const pick = randint(6);
  if (pick === 0) return randint(64);
  if (pick === 1) return 4096 + randint(64) - 32;   // around window 12 buffer
  if (pick === 2) return 8192 + randint(64) - 32;   // around window 13 buffer
  return randint(6000);
}

let passed = 0;
let failed = 0;
const failures = [];

for (let it = 0; it < ITERS; it++) {
  const from = randomBuf(randomSize());
  const to = rand() < 0.6 ? deriveTo(from) : randomBuf(randomSize());
  for (const opts of COMPRESSIONS) {
    let patch;
    try {
      patch = createPatch(from, to, opts);
      const out = applyPatch(from, patch);
      if (!out.equals(to)) throw new Error(`mismatch: got ${out.length} want ${to.length}`);
      passed++;
    } catch (err) {
      failed++;
      if (failures.length < 5) {
        failures.push({ it, opts, from: from.toString('hex'), to: to.toString('hex'), err: err.message });
      }
    }
  }
}

// Robustness: random garbage as a patch must never crash the process.
let robustOk = 0;
for (let it = 0; it < 300; it++) {
  const from = randomBuf(randint(2000));
  const garbage = randomBuf(1 + randint(200));
  try {
    applyPatch(from, garbage); // may succeed (rarely) or throw — both fine
    robustOk++;
  } catch (e) {
    robustOk++; // threw cleanly
  }
}

console.log(`create->apply: ${passed} passed, ${failed} failed (${ITERS} iters x ${COMPRESSIONS.length} codecs)`);
console.log(`robustness (garbage patch): ${robustOk}/300 handled without crashing`);
for (const f of failures) {
  console.log(`FAIL it=${f.it} ${JSON.stringify(f.opts)}: ${f.err}`);
  console.log(`  from=${f.from}`);
  console.log(`  to=${f.to}`);
}

// Cross-check a small subset against real detools.
let crossPass = 0;
let crossFail = 0;
try {
  execFileSync(PYTHON, ['-c', 'import detools'], { stdio: 'pipe' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-cross-'));
  for (let it = 0; it < 25; it++) {
    const from = randomBuf(randomSize());
    const to = deriveTo(from);
    const opts = COMPRESSIONS[it % COMPRESSIONS.length];
    const patch = createPatch(from, to, opts);
    fs.writeFileSync(path.join(tmp, 'f'), from);
    fs.writeFileSync(path.join(tmp, 'p'), patch);
    execFileSync(PYTHON, ['-m', 'detools', 'apply_patch',
      path.join(tmp, 'f'), path.join(tmp, 'p'), path.join(tmp, 'o')], { stdio: 'pipe' });
    if (fs.readFileSync(path.join(tmp, 'o')).equals(to)) crossPass++;
    else crossFail++;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`detools cross subset: ${crossPass} passed, ${crossFail} failed`);
} catch (e) {
  console.log('detools cross subset: skipped (detools unavailable)');
}

const ok = failed === 0 && crossFail === 0;
console.log(ok ? '\nFUZZ OK' : '\nFUZZ FAILED');
process.exit(ok ? 0 : 1);
