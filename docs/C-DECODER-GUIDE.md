# detools sequential patch — C decoder implementation guide (for MCU)

This document specifies **everything the on-device C decoder must do** to apply a
patch produced by `detools-js` (and by upstream `detools`). It is self-contained:
an implementer needs only this file.

Target: apply `patch` to the current firmware image (`from`, in flash) to produce
the new image (`to`, written to another flash slot / staging area), on a
RAM-constrained MCU (the reference device has **48 KiB** total RAM).

The patch type is **sequential bsdiff**. Compression is **heatshrink** (also
`none` / `crle`). An optional **arm-cortex-m4 data-format** transform may be
present. detools' own reference C decoder handles sequential + heatshrink but
**does NOT implement the data-format transform** — Section 7 is the new work.

Everything here is byte-exact and verified: `detools-js` output is byte-identical
to `detools` for `none`/`crle`/`heatshrink`, and its data-format patches apply
correctly under real `detools` on real Cortex-M4 firmware (both directions).

---

## 1. Pipeline overview

```
patch bytes
  ├─ [1] header byte            (patch type + compression)
  ├─ [varint] to_size           (size of the reconstructed image, UNCOMPRESSED)
  └─ compressed payload         (heatshrink / crle / none)
        │  (decompress)
        ▼
     payload bytes
        ├─ dfpatch               (data-format prefix; pack_size(0) if none)
        └─ control stream        (repeated: diff, extra, adjustment)

apply:  to = bsdiff_apply(from, control stream)
        if data-format:  to = restore_addresses(to, from, dfpatch)
```

All multi-byte integers in the container/control stream use the **signed varint**
("pack_size") in Section 3 — NOT plain little-endian. (The arm-cortex-m4 literal
values embedded in the *reconstructed image* are ordinary little-endian; see §7.)

---

## 2. Container format

| Field | Encoding | Notes |
|---|---|---|
| header | 1 byte | bitfield `p1 u3 u4`: 1 pad bit, 3-bit patch type, 4-bit compression. Byte = `(patch_type << 4) | compression`. |
| to_size | signed varint (§3) | number of bytes in the reconstructed image |
| payload | compression-specific | everything after `to_size` to end of file |

**Patch type** must be `0` (sequential). Reject others.
**Compression**: `0`=none, `1`=lzma, `2`=crle, `3`=bz2, `4`=heatshrink, `5`=zstd,
`6`=lz4. The device only needs `none`, `crle`, `heatshrink`.

Special case: if `to_size == 0`, the patch is just `header + to_size` (empty
output); stop.

Example (verified): header `0x00` → sequential + none. `0x04` → sequential +
heatshrink. `0x02` → sequential + crle.

---

## 3. Signed varint ("pack_size")

Used for `to_size` and for every size/adjustment in the control stream and inside
the dfpatch block headers.

Decode:
```c
// Reads one varint from *p (advancing it). Returns a signed 32-bit value.
// Layout: first byte  bit6 = sign, bits0-5 = low 6 magnitude bits,
//                      bit7 = "more bytes follow".
//         next bytes  bits0-6 = 7 more magnitude bits, bit7 = continuation.
static int32_t unpack_size(const uint8_t **p) {
    uint8_t b = *(*p)++;
    int      is_neg = b & 0x40;
    uint32_t value  = b & 0x3f;
    unsigned offset = 6;
    while (b & 0x80) {
        b = *(*p)++;
        value |= (uint32_t)(b & 0x7f) << offset;
        offset += 7;
    }
    return is_neg ? -(int32_t)value : (int32_t)value;
}
```
Values fit in 32 bits for any real firmware (< 2 GiB). Magnitudes here are
non-negative except the bsdiff `adjustment` and the data-format diffs/values,
which are signed.

There is also a **second, different varint** used *only inside* the crle
compressed stream (§4.2) — do not confuse them.

---

## 4. Decompression

The payload is decompressed to recover the raw payload bytes. Decompress the
whole payload (or stream it — see §8 for RAM). The decompressed length is not
stored explicitly; you decode until the control loop has produced `to_size`
bytes and the payload is exhausted.

### 4.1 none
Identity. Payload bytes are the raw payload.

### 4.2 crle (Conditional RLE)
Segment stream. Each segment: `[kind:1][size:varint2][data]`.
- `kind==0` SCATTERED: `size` literal bytes follow, copy verbatim.
- `kind==1` REPEATED: `size` is a repeat count; the **single** next byte is
  repeated `size` times.

`varint2` (crle-only, UNSIGNED): each byte holds 7 bits (bits0-6); bit7 = "more".
```c
static uint32_t crle_size(const uint8_t **p) {
    uint32_t value = 0; unsigned shift = 0; uint8_t b;
    do { b = *(*p)++; value |= (uint32_t)(b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return value;
}
```

### 4.3 heatshrink (primary)
LZSS bitstream, **MSB-first**. detools prepends a **1-byte header** before the
heatshrink stream:
```
header = ((window_sz2 - 4) << 4) | (lookahead_sz2 - 3)
```
So window/lookahead are read FROM THE PATCH (do not hard-code them):
`window_sz2 = (header >> 4) + 4`, `lookahead_sz2 = (header & 0x0f) + 3`.
Example: the project default window 12 / lookahead 9 → header byte
`((12-4)<<4) | (9-3)` = `0x86`.

After the header byte, read bits MSB-first:
- tag bit `1` → **literal**: read next 8 bits → output one byte.
- tag bit `0` → **backref**: read `window_sz2` bits = `index`, then
  `lookahead_sz2` bits = `count`. Copy `count + 1` bytes from `output_len -
  (index + 1)` (i.e. distance = index+1, length = count+1) to the output. The
  decoder window is **zero-initialised**: a backref that reaches before the start
  of produced output reads zero bytes (do not treat as error).

Stop when the input bits are exhausted (the final byte is zero-padded; a partial
trailing symbol that cannot be completed is padding — stop cleanly).

> This is the standard heatshrink format (atomicobject/heatshrink, ISC). If the
> device already links the heatshrink C library, use its decoder; feed it the
> stream **after** the 1-byte header, configured with the header's window/lookahead.

`lzma`/`bz2`/`zstd`/`lz4` are out of scope for the device.

---

## 5. Payload structure (after decompression)

```
payload:
  dfpatch:
    df_len   : signed varint          (length of the data-format patch; 0 = none)
    if df_len > 0:
      df_fmt : signed varint          (0 = arm-cortex-m4, 1 = aarch64, 2 = xtensa)
      df_bytes[df_len]                (the data-format patch; see §7)
  control stream (repeat until to_pos == to_size):
    diff_len   : signed varint
    diff_bytes[diff_len]
    extra_len  : signed varint
    extra_bytes[extra_len]
    adjustment : signed varint        (signed seek in the from image)
```

---

## 6. Sequential bsdiff apply (no data-format)

State: `to_pos = 0`, `from_pos = 0`. Reconstruct byte-wise. `add` is mod-256.

```
read df_len (must be 0 for this section); (df_fmt/df_bytes absent)
while to_pos < to_size:
    diff_len = unpack_size()
    # bounds: 0 <= diff_len, to_pos+diff_len <= to_size,
    #         from_pos+diff_len <= from_size, payload has diff_len bytes left
    for i in 0..diff_len-1:
        out[to_pos+i] = (payload_next_byte() + from[from_pos+i]) & 0xff
    to_pos  += diff_len
    from_pos+= diff_len

    extra_len = unpack_size()
    for i in 0..extra_len-1:
        out[to_pos+i] = payload_next_byte()
    to_pos += extra_len

    adjustment = unpack_size()      # signed
    from_pos += adjustment
# require: payload fully consumed (else corrupt)
```

Key facts:
- The **diff** region overlays patch bytes onto `from` bytes by **byte-wise
  addition mod 256** (this is bsdiff's "add_bytes"): `to = (patch + from) & 0xff`.
- The **extra** region is literal new bytes (copied straight through).
- `from_pos` advances by `diff_len` during the diff, then by the signed
  `adjustment`. It does NOT advance during extra.
- `out` can be written straight to the destination flash slot sequentially;
  `from` is read random-access from the source slot.

Validate aggressively (a wrong `from` image or corrupt patch must be detected,
not silently mis-applied): bounds-check every read, and require the payload to be
exactly consumed when `to_pos == to_size`.

If `df_len == 0`, you are done. Otherwise apply §7 **on top of** this output.

---

## 7. Data-format transform: arm-cortex-m4

### 7.1 Concept

Absolute/relative addresses (branch targets, PC-relative literal loads, pointer
tables) all shift when code moves, turning a tiny logical change into thousands of
byte differences. The data-format **normalises** these fields to zero in *both*
images before diffing, so the bsdiff sees them as unchanged, and records how to
**restore** the real `to` values afterwards.

Therefore, decode is a post-pass on the §6 output:

```
to_final[i] = ( to_bsdiff[i] + dfdiff[i] ) & 0xff        # dfdiff is 0 except at restored fields
```
…where `to_bsdiff` was itself produced using a **zeroed view of `from`**:
```
from_view[p] = is_zeroed(p) ? 0 : from[p]
```
Both `is_zeroed(p)` (a set of 4-byte from-regions) and `dfdiff` (a set of 4-byte
to-regions holding the restored little-endian values / re-encoded instructions)
come from the dfpatch + a disassembly of `from`.

> IMPORTANT: the zeroing of `from` and the restoring into the output are two
> halves of the SAME operation. You must do BOTH, or the result is wrong.

### 7.2 dfpatch binary layout (df_bytes, exactly)

All integers below are the signed varint (§3) unless noted. Parse in this order:

```
1. data-pointers presence: 1 byte (0x00 = absent, 0x01 = present)
   if present: from_data_offset : varint
               from_data_begin  : varint
               from_data_end    : varint
2. code-pointers presence: 1 byte (0x00 / 0x01)
   if present: from_code_begin  : varint
               from_code_end    : varint
3. if data-pointers present: data-pointers BLOCK HEADER   (block-header, §7.3)
4. if code-pointers present: code-pointers BLOCK HEADER
5. bw    block header
6. bl    block header
7. ldr   block header
8. ldr_w block header
9. if data-pointers present: data-pointers BLOCK VALUES    (block-values, §7.5)
10.if code-pointers present: code-pointers BLOCK VALUES
11.bw    block values
12.bl    block values
13.ldr   block values
14.ldr_w block values
```

Note the **headers all come first, then all the value arrays** (in the same
order). A "block header" and its "block values" are two separate spans.

**Verified example** (arm patch of a 6781→6841-byte firmware, code-only config):
```
df_len = 151, df_fmt = 0
df_bytes[0..] = 00 01 80 80 80 80 01  bd e9 ...
  byte 0  = 0x00  -> data-pointers ABSENT
  byte 1  = 0x01  -> code-pointers PRESENT
  varint  = 80 80 80 80 01 -> from_code_begin = 0x08000000
  varint  = ...            -> from_code_end   = 0x08001a7d  (0x08000000 + 6781)
  (data-pointers block header skipped: absent)
  code-pointers block header: 0 blocks
  bw header: 0 blocks
  bl header: 1 block  -> {from_offset=123, to_address=0x960(2400), n_values=41}
  ldr header: 1 block
  ldr_w header: 0 blocks
  ...values follow...
```

### 7.3 Block header / block values

A **block header** is:
```
n_blocks : varint
repeat n_blocks:
    from_offset  : varint     # INDEX into the address-sorted from-instruction list
    to_address   : varint     # file offset in `to` of the first field in the block
    n_values     : varint     # number of fields in the block
```
The matching **block values** span is, for each block in order, `n_values`
signed varints — the `diff` values.

Semantics of one block (category C, e.g. bl):
- Let `FROM_C` = the list of `(address, value)` pairs found by disassembling
  `from` for category C, **sorted by address ascending**.
- `from_offset` indexes into `FROM_C`. The block covers
  `FROM_C[from_offset .. from_offset + n_values - 1]`.
- Let `base = FROM_C[from_offset].address`.
- For `i` in `0 .. n_values-1`:
  - `(from_addr, from_val) = FROM_C[from_offset + i]`
  - `to_val   = from_val - diff[i]`            (diff[i] = the i-th block value)
  - `to_pos   = to_address + (from_addr - base)`   (file offset in `to`)
  - **Zero** 4 bytes of the from-view at `from_addr`.
  - **Restore**: write `encode_C(to_val)` (4 bytes) into `dfdiff` at `to_pos`.

`encode_C`:
- `ldr`, `ldr_w`, `data_pointers`, `code_pointers`: little-endian **int32** of
  `to_val` (`store32le`).
- `bl`: `pack_bl(to_val)` (§7.5). `bw`: `pack_bw(to_val)` (§7.5).

The `(from_addr - base) == (to_pos - to_address)` spacing invariant always holds
(the encoder only groups fields with identical from/to spacing), so `to_pos` is
well-defined and the restored fields never overlap.

### 7.4 Disassembly of `from` (must be byte-exact)

Reconstruct `FROM_C` for each category by a **single linear Thumb sweep** of the
`from` image. This must exactly match the encoder (below is the exact algorithm).
Use the offsets from the dfpatch header:
`data_offset_begin = from_data_offset`,
`data_offset_end   = from_data_offset + (from_data_end - from_data_begin)`,
`data_begin/end    = from_data_begin/end`, `code_begin/end = from_code_begin/end`.
(When data-pointers are absent, `data_offset_begin==data_offset_end==0` → the data
branch never runs; the whole image is swept as code.)

Maps produced: `bw{addr→imm}`, `bl{addr→imm}`, `ldr{addr→s32}`, `ldr_w{addr→s32}`,
`data_pointers{addr→u32}`, `code_pointers{addr→u32}`. `addr` is the **file offset**
in `from` (0-based), not the load address.

Sweep (`pos` from 0 to size, stepping as shown):
```
while pos < size:
    if data_offset_begin <= pos < data_offset_end:     # 4-byte pointer table region
        v = u32le(from, pos)
        if data_begin <= v < data_end:  data_pointers[pos] = v
        elif code_begin <= v < code_end: code_pointers[pos] = v
        pos += 4
    elif pos in ldr or pos in ldr_w:                   # a known literal-pool word
        pos += 4                                       # skip; don't disassemble as code
    else:
        u = u16le(from, pos)                            # upper halfword
        if (u & 0xf800) == 0xf000:                      # 32-bit branch (b.w / bl)
            l = u16le(from, pos+2)                       # lower halfword
            if   (l & 0xd000) == 0xd000: bl[pos] = unpack_bl(u, l)
            elif (l & 0xc000) == 0x8000: bw[pos] = unpack_bw(u, l)
            pos += 4
        elif (u & 0xf800) == 0x4800:                    # ldr Rt,[pc,#imm8*4]
            imm = 4*(u & 0xff) + 4
            ldr_common(&ldr, pos, imm)                  # see below
            pos += 2
        elif u == 0xf8df:                               # ldr.w Rt,[pc,#imm12]
            l = u16le(from, pos+2)
            imm = (l & 0xfff) + 4
            ldr_common(&ldr_w, pos, imm)
            pos += 4
        elif (u & 0xfff0) in {0xfbb0,0xfb90,0xf8d0,0xf850}: pos += 4  # other 32-bit ops
        elif (u & 0xffe0) == 0xfa00:                    pos += 4
        elif (u & 0xffc0) == 0xe900:                    pos += 4
        else:                                            pos += 2      # 16-bit instr
```
`ldr_common(map, address, imm)` — records the **literal-pool word**, keyed by its
address, valued by the signed 32-bit word stored there:
```
a = address
if (a % 4) == 2: a -= 2          # align the PC base to 4
a += imm                         # a = literal-pool address (file offset)
map[a] = s32le(from, a)          # the literal value stored there
```
Notes:
- Bounds: if any read runs past the end of `from`, skip that item (the encoder
  does the same — it just logs and continues).
- Because literal pools sit after their `ldr` (positive `imm`), the pool address
  is registered in `ldr`/`ldr_w` before the sweep reaches it, so the
  `elif pos in ldr…` branch skips it. Preserve this ordering.
- The maps must end up **sorted by address** for §7.3 indexing. A linear sweep
  yields ascending addresses naturally (for `bw/bl`), but `ldr` targets can be
  inserted out of order relative to the sweep position — sort each map by address
  before indexing.

### 7.5 Instruction decode/encode (bit-exact)

`unpack_*` turn the two 16-bit halfwords into a signed immediate; `pack_*` turn a
signed immediate back into the 4 in-memory bytes (two little-endian halfwords).
The device needs `unpack_*` (to build `FROM_C` values) and `pack_*` (to build the
restored `to` instruction bytes).

```c
// ---- b.w (conditional 32-bit branch) ----
static int32_t unpack_bw(uint16_t u, uint16_t l) {
    uint32_t s    = (u >> 10) & 1;
    uint32_t cond = (u >>  6) & 0xf;
    uint32_t imm6 =  u        & 0x3f;
    uint32_t imm11=  l        & 0x7ff;
    uint32_t j1   = (l >> 13) & 1;
    uint32_t t    = (l >> 12) & 1;
    uint32_t j2   = (l >> 11) & 1;
    uint32_t v = (s<<24)|(j2<<23)|(j1<<22)|(imm6<<16)|(imm11<<5)|(cond<<1)|t;
    int32_t value = (int32_t)v;
    if (s) value -= (1 << 25);
    return value;
}
static void pack_bw(int32_t value, uint8_t out[4]) {
    if (value < 0) value += (1 << 25);
    uint32_t t    =  value        & 1;
    uint32_t cond = (value >> 1)  & 0xf;
    uint32_t imm32= (uint32_t)value >> 5;
    uint32_t s    =  imm32 >> 19;
    uint32_t j2   = (imm32 >> 18) & 1;
    uint32_t j1   = (imm32 >> 17) & 1;
    uint32_t imm6 = (imm32 >> 11) & 0x3f;
    uint32_t imm11=  imm32        & 0x7ff;
    uint32_t V = (0x1Eu<<27)|(s<<26)|(cond<<22)|(imm6<<16)|(0x2u<<14)|(j1<<13)|(t<<12)|(j2<<11)|imm11;
    uint8_t b0=(V>>24)&0xff,b1=(V>>16)&0xff,b2=(V>>8)&0xff,b3=V&0xff;
    out[0]=b1; out[1]=b0; out[2]=b3; out[3]=b2;      // byteswap('22')
}

// ---- bl (unconditional 32-bit call) ----
static int32_t unpack_bl(uint16_t u, uint16_t l) {
    uint32_t s    = (u >> 10) & 1;
    uint32_t imm10=  u        & 0x3ff;
    uint32_t imm11=  l        & 0x7ff;
    uint32_t j1   = (l >> 13) & 1;
    uint32_t j2   = (l >> 11) & 1;
    uint32_t i1 = 1u - (j1 ^ s);      // = -((j1^s)-1)
    uint32_t i2 = 1u - (j2 ^ s);
    uint32_t v = (s<<23)|(i1<<22)|(i2<<21)|(imm10<<11)|imm11;
    int32_t value = (int32_t)v;
    if (s) value -= (1 << 24);
    return value;
}
static void pack_bl(int32_t imm32, uint8_t out[4]) {
    if (imm32 < 0) imm32 += (1 << 24);
    uint32_t s    = (uint32_t)imm32 >> 23;
    uint32_t i1   = ((uint32_t)imm32 >> 22) & 1;
    uint32_t i2   = ((uint32_t)imm32 >> 21) & 1;
    uint32_t j1   = 1u - (i1 ^ s);
    uint32_t j2   = 1u - (i2 ^ s);
    uint32_t imm10= ((uint32_t)imm32 >> 11) & 0x3ff;
    uint32_t imm11=  (uint32_t)imm32        & 0x7ff;
    uint32_t V = (0x1Eu<<27)|(s<<26)|(imm10<<16)|(0x3u<<14)|(j1<<13)|(1u<<12)|(j2<<11)|imm11;
    uint8_t b0=(V>>24)&0xff,b1=(V>>16)&0xff,b2=(V>>8)&0xff,b3=V&0xff;
    out[0]=b1; out[1]=b0; out[2]=b3; out[3]=b2;
}
```
`i1/i2/j1/j2` note: `-((x^s)-1)` with `x,s ∈ {0,1}` equals `1-(x^s)`, always 0/1.

**Verified vectors** (from the example patch, bl block 0, `base=0x930`):
```
i=0: from_addr=0x930 from_val=-1154 diff=-1122 -> to_val=-32   to_pos=2400  pack_bl=ff f7 e0 ff
i=1: from_addr=0x93e from_val=-1135 diff=  50  -> to_val=-1185 to_pos=2414  pack_bl=ff f7 5f fb
i=2: from_addr=0x94c from_val=-1114 diff=  52  -> to_val=-1166 to_pos=2428  pack_bl=ff f7 72 fb
```
(`from_val` here is `unpack_bl` of the bytes at that `from` address; `to_val =
from_val - diff`; the 4 bytes go into `dfdiff` at `to_pos`, and 4 bytes at
`from_addr` are zeroed in the from-view.)

### 7.6 Restore-write order

Build `dfdiff` by writing (into a zero background) in this order: `ldr`, `ldr_w`,
`bl`, `bw`, then (if present) `data_pointers`, `code_pointers`. Zero the from-view
for the same categories. Order does not affect correctness (fields never overlap)
but matches the reference.

---

## 8. Low-RAM strategy (the important part for 48 KiB)

Do **not** materialise full `dfdiff` (that's `to_size` bytes) or store the entire
disassembly. Both are sparse/derivable. Recommended flow:

1. **Decompress-and-apply streaming.** Feed the heatshrink decoder in small
   chunks; run the §6 control loop consuming decompressed bytes as they appear;
   write `to` straight to destination flash. `from` is read random-access from
   flash (cheap, no RAM).

2. **Parse the dfpatch once** into a compact block table (small: a few blocks,
   each = 3 varints + `n_values` diffs). If even the diffs are large, you can
   re-read them from flash-resident patch on a second pass.

3. **One linear disassembly pass** over `from` (from flash). The block
   `from_offset` indexes the **address-sorted** category list, and a linear sweep
   visits `bw`/`bl` in ascending address already; maintain a per-category running
   counter. When the counter matches a needed index (from the block table), emit a
   **restore entry**: `{ from_addr, to_pos, kind, to_val }` (compute `to_val =
   unpack/​read(from) - diff`). For `ldr`/`ldr_w`, sort is needed — either buffer
   just the `ldr` addresses (usually far fewer than `bl`) or do a dedicated sorted
   pass. Store only the **needed** entries: `≈ 12 bytes each`; a few hundred–
   thousand entries → low tens of KiB. This is the only real RAM cost.

4. **Apply the two overlays** while producing `to`:
   - *from-view zeroing*: keep the restore entries sorted by `from_addr`; as the
     §6 loop reads `from[from_pos+i]`, if `from_pos+i` falls in any `[from_addr,
     from_addr+4)`, substitute 0. A moving cursor + the fact that diffs read
     `from` largely forward makes this cheap; adjustments can seek, so binary
     search or a small window is safest.
   - *restore add*: keep entries sorted by `to_pos`; as you finalise output byte
     `to[k]`, if `k` is in a restore region, add the corresponding
     `encode_C(to_val)` byte: `to[k] = (to[k] + restore_byte(k)) & 0xff`.

   You can apply the restore either inline (during the write, using a `to_pos`
   cursor) or as a cheap second pass over the destination slot (re-read/rewrite
   only the restored words) — whichever suits your flash write granularity.

5. If RAM is still tight, note the restore entries can be **regenerated** by
   re-running the disassembly pass a second time (from flash is re-readable), so
   you can process them in `to_pos` order without holding them all — trading flash
   reads for RAM.

Absolute upper bound on entries = total `n_values` across all blocks (in the patch
header) — you can compute it up front and refuse/adapt if it exceeds a budget.

---

## 9. Constants reference

```
patch types:   sequential=0, in-place=1, hdiffpatch=2   (device supports 0 only)
compression:   none=0, lzma=1, crle=2, bz2=3, heatshrink=4, zstd=5, lz4=6
data formats:  arm-cortex-m4=0, aarch64=1, xtensa-lx106=2
heatshrink:    header byte = ((window_sz2-4)<<4) | (lookahead_sz2-3)
               tag 1=literal(+8 bits), tag 0=backref(window_sz2 index bits + lookahead_sz2 count bits)
               distance=index+1, length=count+1, MSB-first, zero-initialised window
crle:          kind 0=scattered (size literal bytes), 1=repeated (size copies of 1 byte)
add_bytes:     out = (a + b) & 0xff  (byte-wise, mod 256)
```

---

## 10. Edge cases & validation

- **Validate everything** on the device: reject non-sequential patch type,
  unknown compression, sizes that exceed `to_size`/`from_size`/remaining payload,
  and a payload that isn't fully consumed at `to_pos == to_size`. A wrong `from`
  image (e.g. incomplete/rolled-back firmware) must fail loudly, not silently
  produce garbage. (The firmware carries its own CRC too, but failing early is
  better.)
- `to_size == 0` → empty output, no payload.
- heatshrink: the window/lookahead come from the stream header — never hard-code.
- data-format: you MUST do both the from-view zeroing and the dfdiff restore; each
  alone yields wrong output. Fields are 4 bytes; `bl`/`bw` restores use
  `pack_bl`/`pack_bw`, all pointer/`ldr` restores use plain little-endian int32.
- Signedness: `adjustment`, block `diff` values, and `unpack/pack` immediates are
  signed. Use signed 32-bit arithmetic.

### How to generate test vectors

Use `detools-js` (pure Node, this repo) or upstream `detools` to produce patches
and intermediate values for any `from`/`to` pair:

```bash
# reference patch your decoder must reproduce the OUTPUT of:
node bin/detools-js.js create_patch -c heatshrink \
  --heatshrink-window-sz2 12 --heatshrink-lookahead-sz2 9 \
  --data-format arm-cortex-m4 \
  --from-code-addresses 0x8000000-<hexEnd(old)> \
  --to-code-addresses   0x8000000-<hexEnd(new)> \
  old.bin new.bin out.patch

# apply with the reference (must equal new.bin) — compare against your C output:
python -m detools apply_patch old.bin out.patch check.bin && cmp check.bin new.bin
```

For byte-level intermediates (disassembly maps, block contents, resolved
`to_val`/`to_pos`/`pack_bl`), instrument `src/data-format/arm-cortex-m4.js`
(`disassemble`, `createReaders`) — it mirrors this document exactly and is the
easiest oracle to diff your C implementation against.
