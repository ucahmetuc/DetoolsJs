# detools-js

Pure Node.js, zero-dependency implementation of [detools](https://github.com/eerimoq/detools)
**sequential bsdiff** binary delta encoding — with an **arm-cortex-m4** data-format
transform for firmware. It creates patches the real `detools` (Python/C) can apply,
and applies detools-produced patches. Verified **both directions** against
detools 0.53.0, byte-for-byte where detools owns the format.

Built for firmware OTA: small patches, `heatshrink` compression whose window is
read from the patch, and no runtime dependencies so it drops into any build
pipeline.

- [Install](#install)
- [Quick start](#quick-start)
- [CLI](#cli)
- [API](#api)
- [Compression](#compression)
- [ARM data-format](#arm-cortex-m4-data-format)
- [Patch format](#patch-format-sequential-bsdiff)
- [Not implemented](#not-implemented-out-of-scope)
- [Limitations](#limitations)
- [Tests](#tests)
- [Feedback](#feedback)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Install

Requires Node.js 18+. No dependencies.

```bash
npm install detools-js
```

The CLI is exposed as `detools-js` (via `npx detools-js`) or run directly with
`node bin/detools-js.js` from a checkout.

## Quick start

```bash
# create a heatshrink-compressed patch (device reads window/lookahead from it)
node bin/detools-js.js create_patch -c heatshrink \
  --heatshrink-window-sz2 12 --heatshrink-lookahead-sz2 9 \
  old.bin new.bin firmware.patch

# apply it back
node bin/detools-js.js apply_patch old.bin firmware.patch reconstructed.bin
```

```js
const { createPatch, applyPatch } = require('detools-js'); // or require('./src')

const patch = createPatch(oldBuf, newBuf, {
  compression: 'heatshrink',      // 'none' | 'crle' | 'heatshrink'
  heatshrinkWindowSz2: 12,        // <= 13, lookahead < window
  heatshrinkLookaheadSz2: 9,
});
const rebuilt = applyPatch(oldBuf, patch); // Buffer equal to newBuf
```

## CLI

```
detools-js create_patch [options] <fromfile> <tofile> <patchfile>
detools-js apply_patch            <fromfile> <patchfile> <tofile>

create_patch options:
  -c, --compression <c>              none (default) | crle | heatshrink
  --heatshrink-window-sz2 <n>        default 8 (<= 13)
  --heatshrink-lookahead-sz2 <n>     default 7 (< window)
  --data-format arm-cortex-m4        enable the ARM transform (see below)
  --from-code-addresses B-E          e.g. 0x8000000-0x8001abc
  --to-code-addresses   B-E
  --from-data-offsets B-E            optional (data-pointer tables)
  --to-data-offsets   B-E
  --from-data-addresses B-E          optional (RAM range for pointer classification)
  --to-data-addresses   B-E
```

## API

### `createPatch(fromData, toData, options?) → Buffer`

- `fromData`, `toData`: `Buffer`s (old and new images).
- `options.compression`: `'none'` | `'crle'` | `'heatshrink'` (default `'none'`).
- `options.heatshrinkWindowSz2` / `heatshrinkLookaheadSz2`: heatshrink params.
- `options.dataFormat`: `'arm-cortex-m4'` (requires `options.dataSegment`).
- `options.dataSegment`: `{ fromCodeBegin, fromCodeEnd, toCodeBegin, toCodeEnd,
  fromDataOffsetBegin, fromDataOffsetEnd, fromDataBegin, fromDataEnd,
  toDataOffsetBegin, toDataOffsetEnd, toDataBegin, toDataEnd }` — file-offset and
  address ranges, mirroring detools' `--from/--to-*` flags. Unused ranges are `0`.

### `applyPatch(fromData, patch) → Buffer`

Reconstructs and returns the new image. **Validates** the patch: throws on a
corrupt/foreign patch or a mismatched `from` image rather than emitting wrong
bytes. Handles the data-format transform automatically when the patch carries one.

## Compression

| Codec | Status |
|---|---|
| `none` | identity — byte-identical to detools |
| `crle` | detools' conditional RLE — byte-identical to detools |
| `heatshrink` | LZSS; a faithful port of upstream `heatshrink_encoder.c` — byte-identical to the `heatshrink2` C library |

`lzma`, `bz2`, `zstd`, `lz4` are **out of scope**: in detools those are thin
wrappers over external C libraries (liblzma/libbz2/libzstd/liblz4) with no pure-JS
equivalent, so reproducing detools' exact output isn't possible without shipping
those libraries. This project deliberately keeps only what detools implements
itself (`none`/`crle`, the bsdiff core, the format) plus `heatshrink`, whose
bitstream is small and fully documented.

Because of that, `detools-js` output is **byte-identical** to `detools` for all
three codecs (verified with `cmp`).

## arm-cortex-m4 data-format

ARM Cortex-M firmware is full of absolute/relative addresses (branch targets,
PC-relative literal loads, pointer tables). When code shifts, they all move and a
tiny logical change explodes into thousands of byte differences. The
`arm-cortex-m4` data-format normalises those fields (`b.w`/`bl`/`ldr`/`ldr.w` +
data/code pointers) to zero in both images before diffing and records how to
restore the real values, so the diff stays small.

```bash
node bin/detools-js.js create_patch -c heatshrink \
  --heatshrink-window-sz2 12 --heatshrink-lookahead-sz2 9 \
  --data-format arm-cortex-m4 \
  --from-code-addresses 0x8000000-0x8001abc \
  --to-code-addresses   0x8000000-0x8001b40 \
  old.bin new.bin firmware.patch
```

```js
createPatch(oldBuf, newBuf, {
  compression: 'heatshrink', heatshrinkWindowSz2: 12, heatshrinkLookaheadSz2: 9,
  dataFormat: 'arm-cortex-m4',
  dataSegment: {
    fromCodeBegin: 0x8000000, fromCodeEnd: 0x8000000 + oldBuf.length,
    toCodeBegin:   0x8000000, toCodeEnd:   0x8000000 + newBuf.length,
    fromDataOffsetBegin: 0, fromDataOffsetEnd: 0, fromDataBegin: 0, fromDataEnd: 0,
    toDataOffsetBegin: 0, toDataOffsetEnd: 0, toDataBegin: 0, toDataEnd: 0,
  },
});
```

Measured on real ~180 KB STM32 firmware (heatshrink 12/9, data-format on vs off):
**3–44 % smaller** depending on how localised the change is (biggest wins on small
incremental updates; ~11 % averaged over a chain of releases). Verified byte-for-
byte against real detools on compiled Cortex-M4 firmware, both directions.

> The reference detools **C** decoder does not implement the data-format transform,
> so a device applying these patches must implement it too.

## Patch format (sequential bsdiff)

```
[1 byte header]   bitstruct p1u3u4: 1 pad bit + 3-bit patch type + 4-bit compression
[to_size]         signed pack_size varint (uncompressed) — size of the new image
[payload]         compressed; after decompression:
                    dfpatch                       pack_size(0) when no data-format
                    repeat until to_size produced:
                      pack_size(diff_len)  + diff bytes
                      pack_size(extra_len) + extra bytes
                      pack_size(adjustment)         signed seek in old image
```

Apply: `out = (diff[i] + old[from+i]) & 0xff` for `diff_len` bytes, then copy
`extra` literally, then advance the old pointer by `adjustment`.

`pack_size` is a variable-length signed int: the first byte holds the sign in bit
6 and 6 magnitude bits with bit 7 as the continuation flag; following bytes hold 7
magnitude bits each. (`crle` internally uses its own unsigned varint.)

## Not implemented (out of scope)

detools has more surface than this port. The following are **not implemented**
and raise a clear error if requested (they are not silent no-ops):

- **Compression** `lzma`, `bz2`, `zstd`, `lz4` — thin wrappers over external C
  libraries in detools, with no pure-JS equivalent. `createPatch`/`applyPatch`
  throw for these. Implemented: `none`, `crle`, `heatshrink`.
- **Patch types** `in-place`, `hdiffpatch`, `match-blocks`, and the standalone
  `BSDIFF40` format. Only `sequential` + `bsdiff` is implemented; `applyPatch`
  rejects other patch types.
- **Data formats** `aarch64`, `xtensa-lx106` — declared but not implemented
  (`create`/`apply` throw). Implemented: `arm-cortex-m4`.

## Limitations

- **Degenerate inputs are slow.** bsdiff has a known worst case when the input is
  almost entirely one repeated byte (the suffix-array search does O(n) work per
  position). detools' C build hits the same wall with a far smaller constant.
  Realistic firmware — including large 0xFF erased-flash regions — is handled in
  well under a second (~140 ms for 512 KB), because those regions collapse into a
  single long match. No mitigation is applied so output stays identical to detools.

## Tests

```bash
node test/run.js               # self round-trip (create -> apply), all codecs + arm
node test/cross-detools.js     # cross-check vs real detools (needs python + detools)
node test/oracle-heatshrink.js # byte-identity of heatshrink vs the heatshrink2 C lib
node test/fuzz.js              # randomized create->apply + garbage-patch robustness
```

`cross-detools.js` / `oracle-heatshrink.js` require Python with `detools` and
`heatshrink2` installed; they skip cleanly if unavailable. Env knobs:
`COMPRESSIONS`, `HS_WINDOW`, `HS_LOOKAHEAD`, `PYTHON`.

## Feedback

Bug reports, questions and feature suggestions are welcome on the
[issue tracker](https://github.com/ucahmetuc/DetoolsJs/issues). For a bug, please
include the detools-js version, Node.js version and, if possible, a minimal
`from`/`to` image pair that reproduces it.

## Acknowledgements

detools-js is an independent re-implementation and is not affiliated with these
projects:

- [detools](https://github.com/eerimoq/detools) by Erik Moqvist: the patch format,
  the `none`/`crle` codecs and the `arm-cortex-m4` data-format this package follows
  (BSD-2-Clause).
- [bsdiff](https://www.daemonology.net/bsdiff/) by Colin Percival: the diff
  algorithm (BSD-2-Clause).
- [heatshrink](https://github.com/atomicobject/heatshrink) by Scott Vokes: the
  `heatshrink` codec (ISC).

Their license texts are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## License

MIT, see [LICENSE](LICENSE). Third-party notices: see
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
