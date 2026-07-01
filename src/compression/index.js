'use strict';

// Registry of payload codecs. Each codec exposes:
//   compress(buffer, opts) -> Buffer   (produces a stream detools can decode)
//   decompress(buffer)     -> Buffer   (used by this package's own apply)
//
// Scope is intentionally limited to the codecs whose logic is wholly
// detools' own (none, crle) plus heatshrink (an open, fully documented
// bitstream reimplemented in pure JS). The other detools compressions
// (lzma, bz2, zstd, lz4) delegate to external C libraries and are out of
// scope here.

const none = require('./none');
const crle = require('./crle');
const heatshrink = require('./heatshrink');

const codecs = { none, crle, heatshrink };

function getCodec(name) {
  const codec = codecs[name];
  if (!codec) {
    throw new Error(
      `Compression '${name}' is not supported. Available: ${Object.keys(codecs).join(', ')}.`
    );
  }
  return codec;
}

module.exports = { getCodec, codecs };
