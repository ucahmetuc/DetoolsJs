#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { createPatch, applyPatch } = require('../src');

function usage() {
  console.error(
    [
      'Usage:',
      '  detools-js create_patch [-c C] [--heatshrink-window-sz2 N] [--heatshrink-lookahead-sz2 N] <fromfile> <tofile> <patchfile>',
      '  detools-js apply_patch  <fromfile> <patchfile> <tofile>',
      '',
      'Compression (create_patch): none (default), crle, heatshrink',
      'Heatshrink defaults: window-sz2=8, lookahead-sz2=7 (window<=13, lookahead<window)',
      'Data format (create_patch): --data-format arm-cortex-m4 with, e.g.,',
      '  --from-code-addresses 0x8000000-0x8001abc --to-code-addresses 0x8000000-0x8001b40',
      '  (optional: --from/--to-data-offsets, --from/--to-data-addresses)',
    ].join('\n')
  );
  process.exit(1);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function requireValue(flag, value) {
  if (value === undefined) fail(`Missing value for ${flag}.`);
  return value;
}

function requireInt(flag, value) {
  const n = parseInt(requireValue(flag, value), 10);
  if (Number.isNaN(n)) fail(`Value for ${flag} must be an integer, got '${value}'.`);
  return n;
}

// Parse a "BEGIN-END" address/offset range (hex or decimal), e.g. 0x08000000-0x08001ab9.
function requireRange(flag, value) {
  const v = requireValue(flag, value);
  const m = /^(.+)-(.+)$/.exec(v);
  if (!m) fail(`Value for ${flag} must be BEGIN-END, got '${v}'.`);
  const begin = parseInt(m[1], m[1].startsWith('0x') ? 16 : 10);
  const end = parseInt(m[2], m[2].startsWith('0x') ? 16 : 10);
  if (Number.isNaN(begin) || Number.isNaN(end)) fail(`Bad range for ${flag}: '${v}'.`);
  return [begin, end];
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--compression') {
      opts.compression = requireValue(a, argv[++i]);
    } else if (a.startsWith('--compression=')) {
      opts.compression = a.slice('--compression='.length);
    } else if (a === '--heatshrink-window-sz2') {
      opts.heatshrinkWindowSz2 = requireInt(a, argv[++i]);
    } else if (a === '--heatshrink-lookahead-sz2') {
      opts.heatshrinkLookaheadSz2 = requireInt(a, argv[++i]);
    } else if (a === '--data-format') {
      opts.dataFormat = requireValue(a, argv[++i]);
    } else if (a === '--from-data-offsets') {
      opts._fromDataOffsets = requireRange(a, argv[++i]);
    } else if (a === '--from-data-addresses') {
      opts._fromDataAddresses = requireRange(a, argv[++i]);
    } else if (a === '--from-code-addresses') {
      opts._fromCodeAddresses = requireRange(a, argv[++i]);
    } else if (a === '--to-data-offsets') {
      opts._toDataOffsets = requireRange(a, argv[++i]);
    } else if (a === '--to-data-addresses') {
      opts._toDataAddresses = requireRange(a, argv[++i]);
    } else if (a === '--to-code-addresses') {
      opts._toCodeAddresses = requireRange(a, argv[++i]);
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, opts } = parseArgs(rest);

  if (command === 'create_patch') {
    if (positional.length !== 3) usage();
    const [fromfile, tofile, patchfile] = positional;
    const fromData = fs.readFileSync(fromfile);
    const toData = fs.readFileSync(tofile);
    let dataSegment;
    if (opts.dataFormat) {
      const r = (v, i) => (v ? v[i] : 0);
      dataSegment = {
        fromDataOffsetBegin: r(opts._fromDataOffsets, 0),
        fromDataOffsetEnd: r(opts._fromDataOffsets, 1),
        fromDataBegin: r(opts._fromDataAddresses, 0),
        fromDataEnd: r(opts._fromDataAddresses, 1),
        fromCodeBegin: r(opts._fromCodeAddresses, 0),
        fromCodeEnd: r(opts._fromCodeAddresses, 1),
        toDataOffsetBegin: r(opts._toDataOffsets, 0),
        toDataOffsetEnd: r(opts._toDataOffsets, 1),
        toDataBegin: r(opts._toDataAddresses, 0),
        toDataEnd: r(opts._toDataAddresses, 1),
        toCodeBegin: r(opts._toCodeAddresses, 0),
        toCodeEnd: r(opts._toCodeAddresses, 1),
      };
    }
    const patch = createPatch(fromData, toData, {
      compression: opts.compression || 'none',
      heatshrinkWindowSz2: opts.heatshrinkWindowSz2,
      heatshrinkLookaheadSz2: opts.heatshrinkLookaheadSz2,
      dataFormat: opts.dataFormat,
      dataSegment,
    });
    fs.writeFileSync(patchfile, patch);
    console.error(
      `Wrote ${patch.length} byte patch (${opts.compression || 'none'}) to ${patchfile}.`
    );
  } else if (command === 'apply_patch') {
    if (positional.length !== 3) usage();
    const [fromfile, patchfile, tofile] = positional;
    const fromData = fs.readFileSync(fromfile);
    const patch = fs.readFileSync(patchfile);
    const toData = applyPatch(fromData, patch);
    fs.writeFileSync(tofile, toData);
    console.error(`Wrote ${toData.length} bytes to ${tofile}.`);
  } else {
    usage();
  }
}

try {
  main();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
