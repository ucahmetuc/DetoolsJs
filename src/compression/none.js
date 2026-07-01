'use strict';

// "none" compression: identity. Mirrors detools/compression/none.py.

// Identity: the buffer is returned as-is. Callers (createPatch's Buffer.concat
// and applyPatch's read-only parse) never mutate it, so no defensive copy is
// needed.
function compress(buffer) {
  return buffer;
}

function decompress(buffer) {
  return buffer;
}

module.exports = { compress, decompress };
