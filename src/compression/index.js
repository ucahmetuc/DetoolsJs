'use strict';

// Payload codec registry. Each codec: compress(buffer, opts) / decompress(buffer).
// Scope is limited to detools' own logic (none, crle) plus heatshrink (open,
// pure-JS). lzma/bz2/zstd/lz4 wrap external C libraries and are out of scope.

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
