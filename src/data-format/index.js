'use strict';

// Data-format dispatch.

const armCortexM4 = require('./arm-cortex-m4');

// Numbers as they appear in the dfpatch. Only arm-cortex-m4 is implemented;
// aarch64 and xtensa-lx106 are NOT implemented (getImpl throws) — they would
// follow the same shape as detools/data_format/{aarch64,xtensa_lx106}.py.
const DATA_FORMATS = {
  'arm-cortex-m4': 0,
  aarch64: 1,
  'xtensa-lx106': 2,
};

const DATA_FORMAT_NAME = Object.fromEntries(
  Object.entries(DATA_FORMATS).map(([name, num]) => [num, name])
);

const IMPL = {
  'arm-cortex-m4': armCortexM4,
};

function getImpl(name) {
  const impl = IMPL[name];
  if (!impl) {
    throw new Error(
      `Data format '${name}' is not implemented. Available: ${Object.keys(IMPL).join(', ')}.`
    );
  }
  return impl;
}

function encode(name, fromData, toData, segment) {
  return getImpl(name).encode(fromData, toData, segment);
}

function createReaders(name, fromData, patch, toSize) {
  return getImpl(name).createReaders(fromData, patch, toSize);
}

module.exports = { DATA_FORMATS, DATA_FORMAT_NAME, encode, createReaders, getImpl };
