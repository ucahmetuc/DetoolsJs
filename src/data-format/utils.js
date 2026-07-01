'use strict';

// Port of detools/data_format/utils.py — the block bookkeeping shared by all
// architecture data-formats. A "block" records a run of matched
// address→value pairs whose from/to spacing is identical, so the values can
// be zeroed in both binaries (shrinking the bsdiff) and restored on apply.

const { packSize, unpackSize } = require('../pack-size');

// Offsets/addresses are non-negative and < 2^53, so pack_usize/unpack_usize
// reduce to the signed varint used everywhere else.
const packUsize = packSize;
const unpackUsize = unpackSize;

class Blocks {
  constructor() {
    this._blocks = []; // { fromOffset, toAddress, values:[] }
  }
  get length() {
    return this._blocks.length;
  }
  append(fromOffset, toAddress, values) {
    this._blocks.push({ fromOffset, toAddress, values });
  }
  [Symbol.iterator]() {
    return this._blocks[Symbol.iterator]();
  }

  // Returns { header: Buffer, data: Buffer }.
  toBytes() {
    const header = [packSize(this._blocks.length)];
    const data = [];
    for (const { fromOffset, toAddress, values } of this._blocks) {
      header.push(packSize(fromOffset));
      header.push(packSize(toAddress));
      header.push(packSize(values.length));
    }
    for (const { values } of this._blocks) {
      for (const v of values) data.push(packSize(v));
    }
    return { header: Buffer.concat(header), data: Buffer.concat(data) };
  }

  static unpackHeader(reader) {
    const header = [];
    const n = unpackSize(reader);
    for (let i = 0; i < n; i++) {
      const fromOffset = unpackSize(reader);
      const toAddress = unpackSize(reader);
      const numberOfValues = unpackSize(reader);
      header.push({ fromOffset, toAddress, numberOfValues });
    }
    return header;
  }

  static fromReader(header, reader) {
    const blocks = new Blocks();
    for (const { fromOffset, toAddress, numberOfValues } of header) {
      const values = [];
      for (let i = 0; i < numberOfValues; i++) values.push(unpackSize(reader));
      blocks.append(fromOffset, toAddress, values);
    }
    return blocks;
  }
}

// Longest-matching-blocks over the *delta* sequences of the from/to address
// lists, mirroring detools' difflib usage (without the autojunk heuristic —
// that only changes which valid blocks get chosen, not correctness, and our
// patches are decoded by our own/detools' readers, not compared byte-for-byte).
function getMatchingBlocks(fromAddresses, toAddresses) {
  const a = [];
  const b = [];
  for (let i = 0; i < fromAddresses.length - 1; i++) a.push(fromAddresses[i + 1] - fromAddresses[i]);
  for (let i = 0; i < toAddresses.length - 1; i++) b.push(toAddresses[i + 1] - toAddresses[i]);

  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    if (!b2j.has(b[j])) b2j.set(b[j], []);
    b2j.get(b[j]).push(j);
  }

  function findLongest(alo, ahi, blo, bhi) {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      const indices = b2j.get(a[i]) || [];
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    return [besti, bestj, bestsize];
  }

  const queue = [[0, a.length, 0, b.length]];
  const matching = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k > 0) {
      matching.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  matching.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return matching;
}

// Build a patch block for one instruction/pointer category. Mutates `ffrom`
// and `fto` (Buffers) by zeroing the matched value locations. `fromDict` /
// `toDict` are Maps of address → value. Returns { header, data } bytes.
function createPatchBlock(ffrom, fto, fromDict, toDict, overwriteSize = 4) {
  const blocks = new Blocks();
  if (fromDict.size === 0 || toDict.size === 0) return blocks.toBytes();

  const fromSorted = [...fromDict.entries()].sort((x, y) => x[0] - y[0]);
  const toSorted = [...toDict.entries()].sort((x, y) => x[0] - y[0]);
  const fromAddresses = fromSorted.map((e) => e[0]);
  const fromValues = fromSorted.map((e) => e[1]);
  const toAddresses = toSorted.map((e) => e[0]);
  const toValues = toSorted.map((e) => e[1]);
  const matching = getMatchingBlocks(fromAddresses, toAddresses);

  for (const [fromOffset, toOffset, size0] of matching) {
    if (size0 < 8) continue; // block overhead too big
    const size = size0 + 1;
    const diffs = [];
    let nonZero = 0;
    for (let i = 0; i < size; i++) {
      const d = fromValues[fromOffset + i] - toValues[toOffset + i];
      diffs.push(d);
      if (d !== 0) nonZero++;
    }
    if (nonZero < 8) continue; // too similar to be worth a block

    blocks.append(fromOffset, toAddresses[toOffset], diffs);

    for (let i = 0; i < size; i++) {
      const fa = fromAddresses[fromOffset + i];
      ffrom.fill(0, fa, fa + overwriteSize);
      const ta = toAddresses[toOffset + i];
      fto.fill(0, ta, ta + overwriteSize);
    }
  }

  return blocks.toBytes();
}

function createDataPointersPatchBlock(ffrom, fto, fromDataOffset, fromDataBegin,
                                      fromDataEnd, fromDataPointers, toDataPointers,
                                      overwriteSize = 4) {
  if (fromDataEnd === 0) {
    return { header: Buffer.from([0]), data: { header: Buffer.alloc(0), data: Buffer.alloc(0) } };
  }
  const header = Buffer.concat([
    Buffer.from([1]),
    packUsize(fromDataOffset),
    packUsize(fromDataBegin),
    packUsize(fromDataEnd),
  ]);
  const data = createPatchBlock(ffrom, fto, fromDataPointers, toDataPointers, overwriteSize);
  return { header, data };
}

function createCodePointersPatchBlock(ffrom, fto, fromCodeBegin, fromCodeEnd,
                                      fromCodePointers, toCodePointers, overwriteSize = 4) {
  if (fromCodeEnd === 0) {
    return { header: Buffer.from([0]), data: { header: Buffer.alloc(0), data: Buffer.alloc(0) } };
  }
  const header = Buffer.concat([
    Buffer.from([1]),
    packUsize(fromCodeBegin),
    packUsize(fromCodeEnd),
  ]);
  const data = createPatchBlock(ffrom, fto, fromCodePointers, toCodePointers, overwriteSize);
  return { header, data };
}

function unpackPointersHeader(reader) {
  const dataPresent = reader.readByte() === 1;
  let fromDataOffset = 0;
  let fromDataBegin = 0;
  let fromDataEnd = 0;
  if (dataPresent) {
    fromDataOffset = unpackUsize(reader);
    fromDataBegin = unpackUsize(reader);
    fromDataEnd = unpackUsize(reader);
  }
  const codePresent = reader.readByte() === 1;
  let fromCodeBegin = 0;
  let fromCodeEnd = 0;
  if (codePresent) {
    fromCodeBegin = unpackUsize(reader);
    fromCodeEnd = unpackUsize(reader);
  }
  const dataPointersHeader = dataPresent ? Blocks.unpackHeader(reader) : null;
  const codePointersHeader = codePresent ? Blocks.unpackHeader(reader) : null;
  return {
    dataPresent, codePresent, dataPointersHeader, codePointersHeader,
    fromDataOffset, fromDataBegin, fromDataEnd, fromCodeBegin, fromCodeEnd,
  };
}

function unpackPointersBlocks(reader, dataPresent, codePresent, dataHeader, codeHeader) {
  const dataBlocks = dataPresent ? Blocks.fromReader(dataHeader, reader) : new Blocks();
  const codeBlocks = codePresent ? Blocks.fromReader(codeHeader, reader) : new Blocks();
  return { dataBlocks, codeBlocks };
}

module.exports = {
  Blocks,
  packUsize,
  unpackUsize,
  getMatchingBlocks,
  createPatchBlock,
  createDataPointersPatchBlock,
  createCodePointersPatchBlock,
  unpackPointersHeader,
  unpackPointersBlocks,
};
