'use strict';

// Byte-identity oracle: compares our heatshrink encoder's raw output against
// the real heatshrink2 C library (the one detools uses) for many inputs and
// parameter sets. Our compress() prepends a 1-byte detools header; we strip
// it to compare the raw heatshrink stream that heatshrink2 produces.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const hs = require('../src/compression/heatshrink');
const { buildPayload } = require('../src/create');
const { createControl } = require('../src/bsdiff');

const PYTHON = process.env.PYTHON || 'python';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-oracle-'));

const PY = `
import sys
from heatshrink2.core import Encoder, Writer
inp, outp, w, l = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
data = open(inp,'rb').read()
enc = Encoder(Writer(window_sz2=w, lookahead_sz2=l))
out = enc.fill(data) + enc.finish()
open(outp,'wb').write(out)
`;

function heatshrink2Raw(data, w, l) {
  const inp = path.join(tmp, 'in.bin');
  const outp = path.join(tmp, 'out.hs');
  fs.writeFileSync(inp, data);
  execFileSync(PYTHON, ['-c', PY, inp, outp, String(w), String(l)], { stdio: 'pipe' });
  return fs.readFileSync(outp);
}

function rnd(n, seed) {
  const o = Buffer.allocUnsafe(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    o[i] = (s >>> 24) & 0xff;
  }
  return o;
}

function mutate(buf, seed) {
  const parts = [];
  let s = seed >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 0xffffffff);
  let i = 0;
  while (i < buf.length) {
    const c = 1 + Math.floor(r() * 200);
    const a = r();
    if (a < 0.6) { parts.push(buf.subarray(i, i + c)); i += c; }
    else if (a < 0.8) { i += c; }
    else { parts.push(rnd(c, s)); }
  }
  return Buffer.concat(parts);
}

// A realistic bsdiff payload (what we actually feed the compressor).
function payloadFor(from, to) {
  return buildPayload(createControl(from, to));
}

const base = rnd(60000, 7);
const inputs = [
  ['empty', Buffer.alloc(0)],
  ['one byte', Buffer.from([0x41])],
  ['text', Buffer.from('the quick brown fox jumps over the lazy dog '.repeat(20))],
  ['zeros 5k', Buffer.alloc(5000, 0)],
  ['zeros then data', Buffer.concat([Buffer.alloc(3000, 0), rnd(3000, 5)])],
  ['repeated AB', Buffer.from('AB'.repeat(4000))],
  ['random 10k', rnd(10000, 3)],
  ['payload small', payloadFor(Buffer.from('the quick brown fox'), Buffer.from('the quick red fox jumps'))],
  ['payload 60k', payloadFor(base, mutate(base, 99))],
];

const PARAMS = [
  [8, 7],
  [12, 9],
  [13, 9],
  [11, 4],
];

let passed = 0;
let failed = 0;

for (const [w, l] of PARAMS) {
  for (const [name, data] of inputs) {
    const ours = hs.compress(data, { windowSz2: w, lookaheadSz2: l }).subarray(1); // strip header
    let ref;
    try {
      ref = heatshrink2Raw(data, w, l);
    } catch (e) {
      console.log(`skip  ${w}/${l} ${name} (oracle error)`);
      continue;
    }
    const identical = ours.equals(ref);
    // Sanity: our own decoder must round-trip our output too.
    const rt = hs.decompress(Buffer.concat([hs.compress(data, { windowSz2: w, lookaheadSz2: l })]));
    const rtOk = rt.equals(data);
    if (identical && rtOk) {
      passed++;
      console.log(`  ok  ${w}/${l} ${name} (${ours.length} B)`);
    } else {
      failed++;
      console.log(`FAIL  ${w}/${l} ${name}: identical=${identical} roundtrip=${rtOk} ours=${ours.length} ref=${ref.length}`);
      if (!identical) {
        // show first differing byte
        const n = Math.min(ours.length, ref.length);
        let d = -1;
        for (let i = 0; i < n; i++) if (ours[i] !== ref[i]) { d = i; break; }
        if (d < 0) d = n;
        console.log(`      first diff at byte ${d}: ours=${ours.subarray(Math.max(0,d-2),d+3).toString('hex')} ref=${ref.subarray(Math.max(0,d-2),d+3).toString('hex')}`);
      }
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(failed === 0 ? 0 : 1);
