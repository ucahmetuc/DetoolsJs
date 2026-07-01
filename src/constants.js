'use strict';

// Mirrors detools/common.py.

const PATCH_TYPE_SEQUENTIAL = 0;
const PATCH_TYPE_IN_PLACE = 1;
const PATCH_TYPE_HDIFFPATCH = 2;

const COMPRESSION = {
  none: 0,
  lzma: 1,
  crle: 2,
  bz2: 3,
  heatshrink: 4,
  zstd: 5,
  lz4: 6,
};

const COMPRESSION_NAME = Object.fromEntries(
  Object.entries(COMPRESSION).map(([name, num]) => [num, name])
);

/**
 * Pack the 1-byte patch header: bitstruct 'p1u3u4'
 *  - 1 padding bit (0)
 *  - 3 bits patch type
 *  - 4 bits compression
 * => byte = (patchType << 4) | compression
 */
function packHeader(patchType, compression) {
  return Buffer.from([((patchType & 0x07) << 4) | (compression & 0x0f)]);
}

/**
 * Unpack the 1-byte header into { patchType, compression }.
 */
function unpackHeader(byte) {
  return {
    patchType: (byte >> 4) & 0x07,
    compression: byte & 0x0f,
  };
}

module.exports = {
  PATCH_TYPE_SEQUENTIAL,
  PATCH_TYPE_IN_PLACE,
  PATCH_TYPE_HDIFFPATCH,
  COMPRESSION,
  COMPRESSION_NAME,
  packHeader,
  unpackHeader,
};
