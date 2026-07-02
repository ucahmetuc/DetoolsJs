'use strict';

const { unpackSize, ByteReader } = require('./pack-size');
const { unpackHeader, PATCH_TYPE_SEQUENTIAL, COMPRESSION_NAME } = require('./constants');
const { getCodec } = require('./compression');
const dataFormat = require('./data-format');

/**
 * Apply a sequential detools patch (this package's own applier, all-JS).
 *
 * @param {Buffer} fromData
 * @param {Buffer} patch
 * @returns {Buffer} the reconstructed new binary
 */
function applyPatch(fromData, patch) {
  const reader = new ByteReader(patch, 0);
  const headerByte = reader.readByte();
  const { patchType, compression } = unpackHeader(headerByte);

  if (patchType !== PATCH_TYPE_SEQUENTIAL) {
    throw new Error(
      `Only sequential patches are supported, got patch type ${patchType}.`
    );
  }

  const compressionName = COMPRESSION_NAME[compression];
  if (!compressionName) {
    throw new Error(`Unknown compression number ${compression}.`);
  }

  const toSize = unpackSize(reader);
  if (toSize < 0) {
    throw new Error('Corrupt patch: negative to_size.');
  }
  if (toSize === 0) {
    return Buffer.alloc(0);
  }

  const compressedPayload = patch.subarray(reader.position);
  const payload = getCodec(compressionName).decompress(compressedPayload);

  const pr = new ByteReader(payload, 0);

  // dfpatch (data format). 0 => no transform. Otherwise the from-data is
  // normalised (fromZeroed) and a dfdiff buffer restores the address fields.
  const dfpatchSize = unpackSize(pr);
  let fromForDiff = fromData;
  let dfdiff = null;
  if (dfpatchSize > 0) {
    const dataFormatNum = unpackSize(pr);
    const name = dataFormat.DATA_FORMAT_NAME[dataFormatNum];
    if (!name) {
      throw new Error(`Unknown data format number ${dataFormatNum}.`);
    }
    if (pr.position + dfpatchSize > payload.length) {
      throw new Error('Corrupt patch: data-format patch extends past patch data.');
    }
    const dfpatchBytes = payload.subarray(pr.position, pr.position + dfpatchSize);
    pr.position += dfpatchSize;
    const readers = dataFormat.createReaders(name, fromData, dfpatchBytes, toSize);
    fromForDiff = readers.fromZeroed;
    dfdiff = readers.dfdiff;
  }

  const out = Buffer.allocUnsafe(toSize);
  let toPos = 0;
  let fromPos = 0;

  while (toPos < toSize) {
    // Diff segment.
    const diffSize = unpackSize(pr);
    if (diffSize < 0 || toPos + diffSize > toSize) {
      throw new Error('Corrupt patch: diff data too long.');
    }
    if (pr.position + diffSize > payload.length) {
      throw new Error('Corrupt patch: diff extends past patch data.');
    }
    if (fromPos < 0 || fromPos + diffSize > fromForDiff.length) {
      throw new Error('Corrupt patch or wrong from-data: diff reads past end of from-data.');
    }
    for (let i = 0; i < diffSize; i++) {
      out[toPos + i] = (payload[pr.position + i] + fromForDiff[fromPos + i]) & 0xff;
    }
    pr.position += diffSize;
    toPos += diffSize;
    fromPos += diffSize;

    // Extra segment.
    const extraSize = unpackSize(pr);
    if (extraSize < 0 || toPos + extraSize > toSize) {
      throw new Error('Corrupt patch: extra data too long.');
    }
    if (pr.position + extraSize > payload.length) {
      throw new Error('Corrupt patch: extra extends past patch data.');
    }
    payload.copy(out, toPos, pr.position, pr.position + extraSize);
    pr.position += extraSize;
    toPos += extraSize;

    // Adjustment (signed seek in from-data; validated lazily by the next diff).
    fromPos += unpackSize(pr);
  }

  if (pr.position !== payload.length) {
    throw new Error('Corrupt patch: trailing data after end of patch.');
  }

  // Restore the normalised address fields (dfdiff is zero everywhere else).
  if (dfdiff !== null) {
    for (let i = 0; i < toSize; i++) {
      out[i] = (out[i] + dfdiff[i]) & 0xff;
    }
  }

  return out;
}

module.exports = { applyPatch };
