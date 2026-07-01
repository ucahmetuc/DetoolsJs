'use strict';

const { packSize } = require('./pack-size');
const { packHeader, PATCH_TYPE_SEQUENTIAL, COMPRESSION } = require('./constants');
const { createControl } = require('./bsdiff');
const { getCodec } = require('./compression');
const dataFormat = require('./data-format');

/**
 * Build the uncompressed sequential payload:
 *   dfpatch                          (pack_size(0) when no data-format)
 *   then for each control entry:
 *     pack_size(diff_len) + diff
 *     pack_size(extra_len) + extra
 *     pack_size(adjustment)
 */
function buildPayload(controls, dfpatch) {
  const parts = [dfpatch || packSize(0)];

  for (const { diff, extra, adjustment } of controls) {
    parts.push(packSize(diff.length));
    parts.push(diff);
    parts.push(packSize(extra.length));
    parts.push(extra);
    parts.push(packSize(adjustment));
  }

  return Buffer.concat(parts);
}

/**
 * Create a detools-compatible sequential bsdiff patch.
 *
 * @param {Buffer} fromData   old binary
 * @param {Buffer} toData     new binary
 * @param {object} [options]
 * @param {string} [options.compression='none']
 * @param {number} [options.heatshrinkWindowSz2=8]   heatshrink only (<=13 for device RAM)
 * @param {number} [options.heatshrinkLookaheadSz2=7] heatshrink only (< window)
 * @param {string} [options.dataFormat]   e.g. 'arm-cortex-m4' (needs options.dataSegment)
 * @param {object} [options.dataSegment]  code/data file-offset + address ranges (see data-format)
 * @returns {Buffer} the patch
 */
function createPatch(fromData, toData, options = {}) {
  const compression = options.compression || 'none';

  // Validate against the codecs actually implemented (throws a clear message
  // listing the supported set for unknown or out-of-scope names like lzma).
  const codec = getCodec(compression);

  const header = packHeader(PATCH_TYPE_SEQUENTIAL, COMPRESSION[compression]);
  const toSize = packSize(toData.length);

  // Per detools: when to_size == 0 the patch is just header + to_size.
  if (toData.length === 0) {
    return Buffer.concat([header, toSize]);
  }

  // Optional architecture data-format transform: normalise address fields in
  // both binaries (shrinking the bsdiff) and record how to restore them.
  let fromForDiff = fromData;
  let toForDiff = toData;
  let dfpatch;
  if (options.dataFormat) {
    if (!options.dataSegment) {
      throw new Error(`dataFormat '${options.dataFormat}' requires options.dataSegment.`);
    }
    const enc = dataFormat.encode(options.dataFormat, fromData, toData, options.dataSegment);
    fromForDiff = enc.ffrom;
    toForDiff = enc.fto;
    dfpatch = Buffer.concat([
      packSize(enc.patch.length),
      packSize(dataFormat.DATA_FORMATS[options.dataFormat]),
      enc.patch,
    ]);
  }

  const controls = createControl(fromForDiff, toForDiff);
  const payload = buildPayload(controls, dfpatch);
  const compressed = codec.compress(payload, {
    windowSz2: options.heatshrinkWindowSz2,
    lookaheadSz2: options.heatshrinkLookaheadSz2,
  });

  return Buffer.concat([header, toSize, compressed]);
}

module.exports = { createPatch, buildPayload };
