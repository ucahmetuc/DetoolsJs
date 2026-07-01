'use strict';

// Conditional Run Length Encoding (CRLE) — detools/compression/crle.py.
//
// Stream of segments, each: [kind:1][size:varint][data].
//   kind SCATTERED(0): `size` literal bytes follow.
//   kind REPEATED(1):  `size` is the repetition count, 1 byte follows.
// Runs of >= MINIMUM_REPEATED_SIZE identical bytes become REPEATED segments;
// everything else is SCATTERED.
//
// CRLE uses its own unsigned varint (NOT the signed pack_size used elsewhere):
//   each byte holds 7 bits, high bit = continuation, last byte clears it.

const MINIMUM_REPEATED_SIZE = 6;
const SCATTERED = 0;
const REPEATED = 1;

function crlePackSize(value) {
  const bytes = [];
  bytes.push(0x80 | (value & 0x7f));
  value = Math.floor(value / 128);
  while (value > 0) {
    bytes.push(0x80 | (value & 0x7f));
    value = Math.floor(value / 128);
  }
  bytes[bytes.length - 1] &= 0x7f;
  return bytes;
}

function crleUnpackSize(buf, position) {
  let value = 0;
  let mul = 1;
  let byte;
  do {
    if (position >= buf.length) {
      throw new Error('CRLE: truncated size varint.');
    }
    byte = buf[position++];
    value += (byte & 0x7f) * mul;
    mul *= 128;
  } while (byte & 0x80);
  return { value, position };
}

/**
 * Compress a full buffer to a CRLE stream identical to detools' output.
 * (Feeding the whole buffer at once produces the same bytes as detools'
 * incremental compress()+flush(), because CRLE only emits a segment once it
 * is definitively complete.)
 */
function compress(buffer) {
  const out = [];

  if (buffer.length === 0) {
    // Matches CrleCompressor.flush() for the empty case.
    out.push(SCATTERED);
    out.push(...crlePackSize(0));
    return Buffer.from(out);
  }

  let i = 0;
  const n = buffer.length;

  while (i < n) {
    // Find the next run of >= MINIMUM_REPEATED_SIZE identical bytes.
    let runStart = -1;
    let runLen = 0;
    let j = i;
    while (j < n) {
      let k = j + 1;
      while (k < n && buffer[k] === buffer[j]) k++;
      if (k - j >= MINIMUM_REPEATED_SIZE) {
        runStart = j;
        runLen = k - j;
        break;
      }
      j = k;
    }

    if (runStart === -1) {
      // Remainder is all scattered.
      emitScattered(out, buffer, i, n - i);
      i = n;
    } else {
      if (runStart > i) {
        emitScattered(out, buffer, i, runStart - i);
      }
      // REPEATED segment.
      out.push(REPEATED);
      out.push(...crlePackSize(runLen));
      out.push(buffer[runStart]);
      i = runStart + runLen;
    }
  }

  return Buffer.from(out);
}

function emitScattered(out, buffer, start, length) {
  out.push(SCATTERED);
  out.push(...crlePackSize(length));
  for (let i = 0; i < length; i++) out.push(buffer[start + i]);
}

/**
 * Decompress a full CRLE stream, decoding until the input is exhausted.
 * Throws on a malformed stream (bad kind byte or a segment that runs past
 * the end of the buffer) rather than producing silently-wrong output.
 */
function decompress(buffer) {
  const out = [];
  let pos = 0;
  const n = buffer.length;

  while (pos < n) {
    const kind = buffer[pos];
    pos += 1;
    if (kind === SCATTERED) {
      const r = crleUnpackSize(buffer, pos);
      pos = r.position;
      if (pos + r.value > n) {
        throw new Error('CRLE: scattered segment runs past end of data.');
      }
      for (let i = 0; i < r.value; i++) {
        out.push(buffer[pos + i]);
      }
      pos += r.value;
    } else if (kind === REPEATED) {
      const r = crleUnpackSize(buffer, pos);
      pos = r.position;
      if (pos >= n) {
        throw new Error('CRLE: repeated segment missing its byte.');
      }
      const byte = buffer[pos];
      pos += 1;
      for (let i = 0; i < r.value; i++) out.push(byte);
    } else {
      throw new Error(`CRLE: bad segment kind ${kind}`);
    }
  }

  return Buffer.from(out);
}

module.exports = { compress, decompress, crlePackSize, crleUnpackSize };
