'use strict';

// Heatshrink (LZSS) codec compatible with the heatshrink2 library detools
// uses. The encoder is a faithful transliteration of the upstream
// heatshrink_encoder.c (atomicobject/heatshrink) so its output is
// byte-identical to detools' heatshrink patches for the same parameters.
//
// Stream is MSB-first bits:
//   literal : tag bit 1, then 8 data bits
//   backref : tag bit 0, then window_sz2 index bits (distance = index + 1),
//             then lookahead_sz2 count bits (length = count + 1)
// detools prepends a 1-byte header: bitstruct 'u4u4' of
//   (window_sz2 - 4, lookahead_sz2 - 3).  Defaults 8/7 -> header byte 0x44.

const DEFAULT_WINDOW_SZ2 = 8;
const DEFAULT_LOOKAHEAD_SZ2 = 7;
const MATCH_NOT_FOUND = 0xffff;
const HEATSHRINK_LITERAL_MARKER = 0x01;
const HEATSHRINK_BACKREF_MARKER = 0x00;

function packHeaderByte(windowSz2, lookaheadSz2) {
  return (((windowSz2 - 4) & 0x0f) << 4) | ((lookaheadSz2 - 3) & 0x0f);
}

function unpackHeaderByte(byte) {
  return {
    windowSz2: ((byte >> 4) & 0x0f) + 4,
    lookaheadSz2: (byte & 0x0f) + 3,
  };
}

// ---------------------------------------------------------------------------
// Encoder: a direct port of heatshrink_encoder.c, driven by sinking the whole
// input and then finishing (the same way heatshrink2's Encoder is used).
// ---------------------------------------------------------------------------

// States.
const NOT_FULL = 0;
const FILLED = 1;
const SEARCH = 2;
const YIELD_TAG_BIT = 3;
const YIELD_LITERAL = 4;
const YIELD_BR_INDEX = 5;
const YIELD_BR_LENGTH = 6;
const SAVE_BACKLOG = 7;
const FLUSH_BITS = 8;
const DONE = 9;

class HeatshrinkEncoder {
  constructor(windowSz2, lookaheadSz2) {
    this.windowSz2 = windowSz2;
    this.lookaheadSz2 = lookaheadSz2;
    const bufSz = 2 << windowSz2;
    this.buffer = new Uint8Array(bufSz);
    this.index = new Int32Array(bufSz);
    this.inputSize = 0;
    this.matchScanIndex = 0;
    this.matchLength = 0;
    this.matchPos = 0;
    this.outgoingBits = 0;
    this.outgoingBitsCount = 0;
    this.isFinishing = false;
    this.state = NOT_FULL;
    this.currentByte = 0;
    this.bitIndex = 0x80;
    this.out = [];
  }

  get inputBufferSize() {
    return 1 << this.windowSz2;
  }
  get inputOffset() {
    return this.inputBufferSize;
  }

  // Push `count` bits (value `bits`) MSB-first into the output.
  pushBits(count, bits) {
    for (let i = count - 1; i >= 0; i--) {
      if (bits & (1 << i)) this.currentByte |= this.bitIndex;
      this.bitIndex >>= 1;
      if (this.bitIndex === 0) {
        this.bitIndex = 0x80;
        this.out.push(this.currentByte);
        this.currentByte = 0;
      }
    }
  }

  pushOutgoingBits() {
    let count;
    let bits;
    if (this.outgoingBitsCount > 8) {
      count = 8;
      bits = this.outgoingBits >> (this.outgoingBitsCount - 8);
    } else {
      count = this.outgoingBitsCount;
      bits = this.outgoingBits;
    }
    if (count > 0) {
      this.pushBits(count, bits & 0xff);
      this.outgoingBitsCount -= count;
    }
    return count;
  }

  doIndexing() {
    const last = new Int32Array(256).fill(-1);
    const data = this.buffer;
    const index = this.index;
    const end = this.inputOffset + this.inputSize;
    for (let i = 0; i < end; i++) {
      const v = data[i];
      index[i] = last[v];
      last[v] = i;
    }
  }

  findLongestMatch(start, end, maxlen) {
    const buf = this.buffer;
    const index = this.index;
    let matchMaxlen = 0;
    let matchIndex = MATCH_NOT_FOUND;
    let pos = index[end];

    while (pos >= start) {
      if (buf[pos + matchMaxlen] !== buf[end + matchMaxlen]) {
        pos = index[pos];
        continue;
      }
      let len = 1;
      while (len < maxlen && buf[pos + len] === buf[end + len]) len++;
      if (len > matchMaxlen) {
        matchMaxlen = len;
        matchIndex = pos;
        if (len === maxlen) break;
      }
      pos = index[pos];
    }

    const breakEven = 1 + this.windowSz2 + this.lookaheadSz2;
    if (matchMaxlen > (breakEven >> 3)) {
      return { pos: end - matchIndex, length: matchMaxlen };
    }
    return { pos: MATCH_NOT_FOUND, length: 0 };
  }

  stepSearch() {
    const windowLength = 1 << this.windowSz2;
    const lookaheadSz = 1 << this.lookaheadSz2;
    const msi = this.matchScanIndex;
    const fin = this.isFinishing;

    if (msi > this.inputSize - (fin ? 1 : lookaheadSz)) {
      return fin ? FLUSH_BITS : SAVE_BACKLOG;
    }

    const end = this.inputOffset + msi;
    const start = end - windowLength;

    let maxPossible = lookaheadSz;
    if (this.inputSize - msi < lookaheadSz) {
      maxPossible = this.inputSize - msi;
    }

    const { pos, length } = this.findLongestMatch(start, end, maxPossible);

    if (pos === MATCH_NOT_FOUND) {
      this.matchScanIndex++;
      this.matchLength = 0;
    } else {
      this.matchPos = pos;
      this.matchLength = length;
    }
    return YIELD_TAG_BIT;
  }

  yieldTagBit() {
    if (this.matchLength === 0) {
      this.pushBits(1, HEATSHRINK_LITERAL_MARKER);
      return YIELD_LITERAL;
    }
    this.pushBits(1, HEATSHRINK_BACKREF_MARKER);
    this.outgoingBits = this.matchPos - 1;
    this.outgoingBitsCount = this.windowSz2;
    return YIELD_BR_INDEX;
  }

  yieldLiteral() {
    const processedOffset = this.matchScanIndex - 1;
    const inputOffset = this.inputOffset + processedOffset;
    this.pushBits(8, this.buffer[inputOffset]);
    return SEARCH;
  }

  yieldBrIndex() {
    if (this.pushOutgoingBits() > 0) return YIELD_BR_INDEX;
    this.outgoingBits = this.matchLength - 1;
    this.outgoingBitsCount = this.lookaheadSz2;
    return YIELD_BR_LENGTH;
  }

  yieldBrLength() {
    if (this.pushOutgoingBits() > 0) return YIELD_BR_LENGTH;
    this.matchScanIndex += this.matchLength;
    this.matchLength = 0;
    return SEARCH;
  }

  saveBacklog() {
    const inputBufSz = this.inputBufferSize;
    const msi = this.matchScanIndex;
    const rem = inputBufSz - msi;
    const shiftSz = inputBufSz + rem;
    this.buffer.copyWithin(0, inputBufSz - rem, inputBufSz - rem + shiftSz);
    this.matchScanIndex = 0;
    this.inputSize -= inputBufSz - rem;
    return NOT_FULL;
  }

  flushBitBuffer() {
    if (this.bitIndex === 0x80) {
      return DONE;
    }
    this.out.push(this.currentByte);
    return DONE;
  }

  // Process the state machine until it needs input (NOT_FULL) or is DONE.
  poll() {
    while (true) {
      switch (this.state) {
        case NOT_FULL:
          return;
        case FILLED:
          this.doIndexing();
          this.state = SEARCH;
          break;
        case SEARCH:
          this.state = this.stepSearch();
          break;
        case YIELD_TAG_BIT:
          this.state = this.yieldTagBit();
          break;
        case YIELD_LITERAL:
          this.state = this.yieldLiteral();
          break;
        case YIELD_BR_INDEX:
          this.state = this.yieldBrIndex();
          break;
        case YIELD_BR_LENGTH:
          this.state = this.yieldBrLength();
          break;
        case SAVE_BACKLOG:
          this.state = this.saveBacklog();
          break;
        case FLUSH_BITS:
          this.state = this.flushBitBuffer();
          break;
        case DONE:
          return;
        default:
          throw new Error(`heatshrink: bad state ${this.state}`);
      }
    }
  }

  sink(data, offset) {
    const writeOffset = this.inputOffset + this.inputSize;
    const ibs = this.inputBufferSize;
    const rem = ibs - this.inputSize;
    const cpSz = Math.min(rem, data.length - offset);
    this.buffer.set(data.subarray(offset, offset + cpSz), writeOffset);
    this.inputSize += cpSz;
    if (this.inputSize === ibs) {
      this.state = FILLED;
    }
    return cpSz;
  }

  finish() {
    this.isFinishing = true;
    if (this.state === NOT_FULL) this.state = FILLED;
  }
}

function compress(buffer, opts = {}) {
  const windowSz2 = opts.windowSz2 || DEFAULT_WINDOW_SZ2;
  const lookaheadSz2 = opts.lookaheadSz2 || DEFAULT_LOOKAHEAD_SZ2;

  const enc = new HeatshrinkEncoder(windowSz2, lookaheadSz2);

  let offset = 0;
  while (offset < buffer.length) {
    offset += enc.sink(buffer, offset);
    enc.poll();
  }
  enc.finish();
  enc.poll();

  const header = Buffer.from([packHeaderByte(windowSz2, lookaheadSz2)]);
  return Buffer.concat([header, Buffer.from(enc.out)]);
}

// ---------------------------------------------------------------------------
// Decoder.
// ---------------------------------------------------------------------------

class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.bytePos = 0;
    this.bitMask = 0x80;
  }
  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (this.bytePos >= this.buffer.length) return null;
      value = (value << 1) | (this.buffer[this.bytePos] & this.bitMask ? 1 : 0);
      this.bitMask >>= 1;
      if (this.bitMask === 0) {
        this.bitMask = 0x80;
        this.bytePos += 1;
      }
    }
    return value;
  }
}

function decompress(buffer) {
  if (buffer.length === 0) return Buffer.alloc(0);
  const { windowSz2, lookaheadSz2 } = unpackHeaderByte(buffer[0]);
  const br = new BitReader(buffer.subarray(1));

  const out = [];
  while (true) {
    const tag = br.readBits(1);
    if (tag === null) break;
    if (tag === 1) {
      const byte = br.readBits(8);
      if (byte === null) break; // padding
      out.push(byte & 0xff);
    } else {
      const index = br.readBits(windowSz2);
      if (index === null) break;
      const count = br.readBits(lookaheadSz2);
      if (count === null) break;
      const distance = index + 1;
      const length = count + 1;
      const start = out.length - distance;
      for (let k = 0; k < length; k++) {
        // Heatshrink's window is zero-initialised, so a backref reaching
        // before the produced output reads zero bytes.
        const src = start + k;
        out.push(src >= 0 ? out[src] : 0);
      }
    }
  }

  return Buffer.from(out);
}

module.exports = { compress, decompress, packHeaderByte, unpackHeaderByte };
