'use strict';

// Cross-compatibility tests against the real `detools` Python package.
//   Direction A: detools-js create  -> detools apply        (primary goal)
//   Direction B: detools     create -> detools-js apply     (format reader)
//
// Requires python with detools installed and on PATH. Set PYTHON env to
// override the interpreter (default: "python").

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createPatch, applyPatch } = require('../src');

const PYTHON = process.env.PYTHON || 'python';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'detools-cross-'));

// Optional heatshrink params (default detools 8/7).
const HS_W = process.env.HS_WINDOW ? parseInt(process.env.HS_WINDOW, 10) : 8;
const HS_L = process.env.HS_LOOKAHEAD ? parseInt(process.env.HS_LOOKAHEAD, 10) : 7;

let passed = 0;
let failed = 0;
let skipped = 0;

function detools(args) {
  return execFileSync(PYTHON, ['-m', 'detools', ...args], { stdio: 'pipe' });
}

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    if (err && err.skip) {
      skipped++;
      console.log(`skip  ${name} (${err.message})`);
      return;
    }
    failed++;
    console.log(`FAIL  ${name}`);
    console.log('      ' + (err.stderr ? err.stderr.toString() : err.message));
  }
}

function randomBuf(n, seed) {
  const out = Buffer.allocUnsafe(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

function mutate(buf, seed) {
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
      parts.push(buf.subarray(i, i + chunk));
      i += chunk;
    } else if (action < 0.8) {
      i += chunk;
    } else {
      parts.push(randomBuf(chunk, s));
    }
  }
  return Buffer.concat(parts);
}

const base = randomBuf(20000, 7);
const cases = [
  ['small text', Buffer.from('the quick brown fox'), Buffer.from('the quick red fox jumps over')],
  ['repeated', Buffer.alloc(5000, 0xab), Buffer.concat([Buffer.alloc(2500, 0xab), Buffer.alloc(2500, 0xcd)])],
  ['random 8k', randomBuf(8192, 1), randomBuf(8192, 2)],
  ['firmware-like 20k', base, mutate(base, 99)],
];

// Which compressions to cross-check. We test everything we implement; codecs
// not yet implemented will surface as failures we can see.
const COMPRESSIONS = (process.env.COMPRESSIONS || 'none,crle,heatshrink').split(',');

let detoolsAvailable = true;
try {
  execFileSync(PYTHON, ['-c', 'import detools'], { stdio: 'pipe' });
} catch (e) {
  detoolsAvailable = false;
}

for (const compression of COMPRESSIONS) {
  for (const [name, from, to] of cases) {
    const id = `${compression}/${name}`;
    const fromFile = path.join(tmp, 'from.bin');
    const toFile = path.join(tmp, 'to.bin');
    const patchFile = path.join(tmp, 'patch.bin');
    const outFile = path.join(tmp, 'out.bin');

    // Direction A: our create -> detools apply
    check(`A js-create -> detools-apply : ${id}`, () => {
      if (!detoolsAvailable) {
        const e = new Error('detools not available');
        e.skip = true;
        throw e;
      }
      fs.writeFileSync(fromFile, from);
      fs.writeFileSync(toFile, to);
      const patch = createPatch(from, to, {
        compression,
        heatshrinkWindowSz2: HS_W,
        heatshrinkLookaheadSz2: HS_L,
      });
      fs.writeFileSync(patchFile, patch);
      detools(['apply_patch', fromFile, patchFile, outFile]);
      const out = fs.readFileSync(outFile);
      if (!out.equals(to)) {
        throw new Error(`detools reconstructed ${out.length} bytes, want ${to.length}`);
      }
    });

    // Direction B: detools create -> our apply
    check(`B detools-create -> js-apply : ${id}`, () => {
      if (!detoolsAvailable) {
        const e = new Error('detools not available');
        e.skip = true;
        throw e;
      }
      fs.writeFileSync(fromFile, from);
      fs.writeFileSync(toFile, to);
      const createArgs = ['create_patch', '-c', compression];
      if (compression === 'heatshrink') {
        createArgs.push('--heatshrink-window-sz2', String(HS_W),
                        '--heatshrink-lookahead-sz2', String(HS_L));
      }
      createArgs.push(fromFile, toFile, patchFile);
      detools(createArgs);
      const patch = fs.readFileSync(patchFile);
      const out = applyPatch(from, patch);
      if (!out.equals(to)) {
        throw new Error(`js reconstructed ${out.length} bytes, want ${to.length}`);
      }
    });
  }
}

// --- arm-cortex-m4 data-format, both directions (real compiled firmware) ---
(() => {
  const dir = path.join(__dirname, 'fixtures', 'arm');
  let from;
  let to;
  try {
    from = fs.readFileSync(path.join(dir, 'fw1.bin'));
    to = fs.readFileSync(path.join(dir, 'fw2.bin'));
  } catch (e) {
    console.log('skip  arm-cortex-m4 cross (fixtures missing)');
    return;
  }
  if (!detoolsAvailable) {
    console.log('skip  arm-cortex-m4 cross (detools unavailable)');
    return;
  }
  const fromFile = path.join(tmp, 'af');
  const toFile = path.join(tmp, 'at');
  const patchFile = path.join(tmp, 'ap');
  const outFile = path.join(tmp, 'ao');
  fs.writeFileSync(fromFile, from);
  fs.writeFileSync(toFile, to);
  const hexEnd = (base, buf) => '0x' + (base + buf.length).toString(16);
  const BASE = 0x08000000;
  const zeroSeg = {
    fromDataOffsetBegin: 0, fromDataOffsetEnd: 0, fromDataBegin: 0, fromDataEnd: 0,
    fromCodeBegin: 0, fromCodeEnd: 0, toDataOffsetBegin: 0, toDataOffsetEnd: 0,
    toDataBegin: 0, toDataEnd: 0, toCodeBegin: 0, toCodeEnd: 0,
  };

  // A: our arm patch -> detools apply
  check('A js-create arm -> detools-apply', () => {
    const patch = createPatch(from, to, { compression: 'heatshrink', dataFormat: 'arm-cortex-m4', dataSegment: zeroSeg });
    fs.writeFileSync(patchFile, patch);
    detools(['apply_patch', fromFile, patchFile, outFile]);
    if (!fs.readFileSync(outFile).equals(to)) throw new Error('detools mismatch');
  });

  // B: detools arm patch -> our apply
  check('B detools-create arm -> js-apply', () => {
    detools(['create_patch', '-c', 'heatshrink', '--data-format', 'arm-cortex-m4',
      '--from-code-addresses', `0x${BASE.toString(16)}-${hexEnd(BASE, from)}`,
      '--to-code-addresses', `0x${BASE.toString(16)}-${hexEnd(BASE, to)}`,
      fromFile, toFile, patchFile]);
    const out = applyPatch(from, fs.readFileSync(patchFile));
    if (!out.equals(to)) throw new Error('js mismatch');
  });
})();

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(failed === 0 ? 0 : 1);
