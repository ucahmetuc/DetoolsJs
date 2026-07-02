'use strict';

// Port of detools/data_format/arm_cortex_m4.py. Disassembles Thumb-2 enough to
// find the address-bearing fields (b.w / bl branch targets, ldr / ldr.w
// literal-pool values, and 32-bit data/code pointers), so those fields can be
// normalised (zeroed) in both binaries before bsdiff and restored on apply.

const {
  Blocks,
  createPatchBlock,
  createDataPointersPatchBlock,
  createCodePointersPatchBlock,
  unpackPointersHeader,
  unpackPointersBlocks,
} = require('./utils');
const { ByteReader } = require('../pack-size');

// A minimal seekable cursor over a Buffer, matching the read/tell/seek usage.
class Reader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
  }
  get size() {
    return this.buf.length;
  }
  tell() {
    return this.pos;
  }
  seek(p) {
    this.pos = p;
  }
  read(n) {
    const end = Math.min(this.pos + n, this.buf.length);
    const out = this.buf.subarray(this.pos, end);
    this.pos = end;
    return out;
  }
}

function readU16LE(reader) {
  const d = reader.read(2);
  if (d.length !== 2) return null;
  return d[0] | (d[1] << 8);
}

function unpackBw(upper16, lower16) {
  const s = (upper16 & 0x400) >> 10;
  const cond = (upper16 & 0x3c0) >> 6;
  const imm6 = upper16 & 0x3f;
  const imm11 = lower16 & 0x7ff;
  const j1 = (lower16 & 0x2000) >> 13;
  const t = (lower16 & 0x1000) >> 12;
  const j2 = (lower16 & 0x800) >> 11;
  let value = (s << 24) | (j2 << 23) | (j1 << 22) | (imm6 << 16) | (imm11 << 5) | (cond << 1) | t;
  if (s === 1) value -= 1 << 25;
  return value;
}

function unpackBl(upper16, lower16) {
  const s = (upper16 & 0x400) >> 10;
  const imm10 = upper16 & 0x3ff;
  const imm11 = lower16 & 0x7ff;
  const j1 = (lower16 & 0x2000) >> 13;
  const j2 = (lower16 & 0x800) >> 11;
  const i1 = -((j1 ^ s) - 1);
  const i2 = -((j2 ^ s) - 1);
  let value = (s << 23) | (i1 << 22) | (i2 << 21) | (imm10 << 11) | imm11;
  if (s === 1) value -= 1 << 24;
  return value;
}

// Re-encode a b.w / bl instruction from its decoded immediate. Produces the
// 4 in-memory bytes (two little-endian halfwords), matching detools'
// bitstruct pack + byteswap('22').
function packBw(value) {
  if (value < 0) value += 1 << 25;
  const t = value & 0x1;
  const cond = (value >> 1) & 0xf;
  const imm32 = value >> 5;
  const s = imm32 >> 19;
  const j2 = (imm32 >> 18) & 0x1;
  const j1 = (imm32 >> 17) & 0x1;
  const imm6 = (imm32 >> 11) & 0x3f;
  const imm11 = imm32 & 0x7ff;
  // fields u5 u1 u4 u6 u2 u1 u1 u1 u11, MSB-first into 32 bits
  const v =
    (0b11110 * 0x8000000) + // << 27
    (s << 26) + (cond << 22) + (imm6 << 16) + (0b10 << 14) +
    (j1 << 13) + (t << 12) + (j2 << 11) + imm11;
  const b0 = (v >>> 24) & 0xff;
  const b1 = (v >>> 16) & 0xff;
  const b2 = (v >>> 8) & 0xff;
  const b3 = v & 0xff;
  return Buffer.from([b1, b0, b3, b2]); // byteswap '22'
}

function packBl(imm32) {
  if (imm32 < 0) imm32 += 1 << 24;
  const s = imm32 >> 23;
  const i1 = (imm32 >> 22) & 0x1;
  const i2 = (imm32 >> 21) & 0x1;
  const j1 = -((i1 ^ s) - 1);
  const j2 = -((i2 ^ s) - 1);
  const imm10 = (imm32 >> 11) & 0x3ff;
  const imm11 = imm32 & 0x7ff;
  // fields u5 u1 u10 u2 u1 u1 u1 u11
  const v =
    (0b11110 * 0x8000000) + // << 27
    (s << 26) + (imm10 << 16) + (0b11 << 14) +
    (j1 << 13) + (1 << 12) + (j2 << 11) + imm11;
  const b0 = (v >>> 24) & 0xff;
  const b1 = (v >>> 16) & 0xff;
  const b2 = (v >>> 8) & 0xff;
  const b3 = v & 0xff;
  return Buffer.from([b1, b0, b3, b2]);
}

function readS32(buf, addr) {
  if (addr < 0 || addr + 4 > buf.length) return null;
  return buf.readInt32LE(addr);
}

function disassembleData(reader, address, dataBegin, dataEnd, codeBegin, codeEnd, dataPointers, codePointers) {
  const data = reader.read(4);
  if (data.length !== 4) return;
  const value = data.readUInt32LE(0);
  if (dataBegin <= value && value < dataEnd) dataPointers.set(address, value);
  else if (codeBegin <= value && value < codeEnd) codePointers.set(address, value);
}

function disassembleLdrCommon(reader, address, ldr, imm) {
  if (address % 4 === 2) address -= 2;
  address += imm;
  const position = reader.tell();
  reader.seek(address);
  const data = reader.read(4);
  reader.seek(position);
  if (data.length !== 4) return;
  ldr.set(address, data.readInt32LE(0));
}

function disassemble(reader, dataOffsetBegin, dataOffsetEnd, dataBegin, dataEnd, codeBegin, codeEnd) {
  const length = reader.size;
  const bw = new Map();
  const bl = new Map();
  const ldr = new Map();
  const ldrW = new Map();
  const dataPointers = new Map();
  const codePointers = new Map();

  while (reader.tell() < length) {
    const address = reader.tell();

    if (dataOffsetBegin <= address && address < dataOffsetEnd) {
      disassembleData(reader, address, dataBegin, dataEnd, codeBegin, codeEnd, dataPointers, codePointers);
    } else if (ldr.has(address) || ldrW.has(address)) {
      reader.read(4); // skip a known literal pool word
    } else {
      const upper16 = readU16LE(reader);
      if (upper16 === null) continue;

      if ((upper16 & 0xf800) === 0xf000) {
        // 32-bit branch (b.w / bl): read lower halfword.
        const lower16 = readU16LE(reader);
        if (lower16 === null) continue;
        if ((lower16 & 0xd000) === 0xd000) bl.set(address, unpackBl(upper16, lower16));
        else if ((lower16 & 0xc000) === 0x8000) bw.set(address, unpackBw(upper16, lower16));
      } else if ((upper16 & 0xf800) === 0x4800) {
        // ldr Rt, [pc, #imm8*4]
        const imm8 = 4 * (upper16 & 0xff) + 4;
        disassembleLdrCommon(reader, address, ldr, imm8);
      } else if ((upper16 & 0xffff) === 0xf8df) {
        // ldr.w Rt, [pc, #imm12]
        const lower16 = readU16LE(reader);
        if (lower16 === null) continue;
        const imm12 = (lower16 & 0xfff) + 4;
        disassembleLdrCommon(reader, address, ldrW, imm12);
      } else if ([0xfbb0, 0xfb90, 0xf8d0, 0xf850].includes(upper16 & 0xfff0)) {
        reader.read(2); // other 32-bit instruction, skip lower halfword
      } else if ((upper16 & 0xffe0) === 0xfa00) {
        reader.read(2);
      } else if ((upper16 & 0xffc0) === 0xe900) {
        reader.read(2);
      }
    }
  }

  return { bw, bl, ldr, ldrW, dataPointers, codePointers };
}

// ---- encode (create side) ------------------------------------------------
function encode(fromData, toData, seg) {
  const ffrom = Buffer.from(fromData); // mutable copies (get zeroed)
  const fto = Buffer.from(toData);

  const from = disassemble(new Reader(ffrom),
    seg.fromDataOffsetBegin, seg.fromDataOffsetEnd,
    seg.fromDataBegin, seg.fromDataEnd, seg.fromCodeBegin, seg.fromCodeEnd);
  const to = disassemble(new Reader(fto),
    seg.toDataOffsetBegin, seg.toDataOffsetEnd,
    seg.toDataBegin, seg.toDataEnd, seg.toCodeBegin, seg.toCodeEnd);

  const dataPointers = createDataPointersPatchBlock(ffrom, fto,
    seg.fromDataOffsetBegin, seg.fromDataBegin, seg.fromDataEnd,
    from.dataPointers, to.dataPointers);
  const codePointers = createCodePointersPatchBlock(ffrom, fto,
    seg.fromCodeBegin, seg.fromCodeEnd, from.codePointers, to.codePointers);
  const bw = createPatchBlock(ffrom, fto, from.bw, to.bw);
  const bl = createPatchBlock(ffrom, fto, from.bl, to.bl);
  const ldr = createPatchBlock(ffrom, fto, from.ldr, to.ldr);
  const ldrW = createPatchBlock(ffrom, fto, from.ldrW, to.ldrW);

  const patch = Buffer.concat([
    dataPointers.header,
    codePointers.header,
    // headers
    dataPointers.data.header, codePointers.data.header,
    bw.header, bl.header, ldr.header, ldrW.header,
    // datas
    dataPointers.data.data, codePointers.data.data,
    bw.data, bl.data, ldr.data, ldrW.data,
  ]);

  return { ffrom, fto, patch };
}

// ---- create readers (apply side) -----------------------------------------
function entryAt(sorted, index) {
  const entry = sorted[index];
  if (!entry) {
    throw new Error('Corrupt data-format patch: block index out of range.');
  }
  return entry;
}

function writeZerosToFrom(fromZeroed, blocks, dict) {
  const sorted = [...dict.entries()].sort((x, y) => x[0] - y[0]);
  for (const { fromOffset, values } of blocks) {
    for (let i = 0; i < values.length; i++) {
      const fromAddress = entryAt(sorted, fromOffset + i)[0];
      fromZeroed.fill(0, fromAddress, fromAddress + 4);
    }
  }
}

function writeValuesToDiff(fdiff, blocks, dict, packCallback) {
  const sorted = [...dict.entries()].sort((x, y) => x[0] - y[0]);
  for (const { fromOffset, toAddress, values } of blocks) {
    const fromAddressBase = entryAt(sorted, fromOffset)[0];
    for (let i = 0; i < values.length; i++) {
      const [fromAddress, fromValue] = entryAt(sorted, fromOffset + i);
      const pos = toAddress + fromAddress - fromAddressBase;
      const bytes = packCallback(fromValue - values[i]); // = packCallback(toValue)
      if (pos < 0 || pos + bytes.length > fdiff.length) {
        throw new Error('Corrupt data-format patch: restore position out of range.');
      }
      bytes.copy(fdiff, pos);
    }
  }
}

function packS32(value) {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32LE(value | 0, 0);
  return b;
}

/**
 * Given the original from-data, the data-format patch bytes and to_size,
 * return { fromZeroed, dfdiff } used by applyPatch.
 */
function createReaders(fromData, patch, toSize) {
  const reader = new ByteReader(patch, 0);
  const ph = unpackPointersHeader(reader);
  const bwHeader = Blocks.unpackHeader(reader);
  const blHeader = Blocks.unpackHeader(reader);
  const ldrHeader = Blocks.unpackHeader(reader);
  const ldrWHeader = Blocks.unpackHeader(reader);

  const { dataBlocks, codeBlocks } = unpackPointersBlocks(
    reader, ph.dataPresent, ph.codePresent, ph.dataPointersHeader, ph.codePointersHeader);
  const bwBlocks = Blocks.fromReader(bwHeader, reader);
  const blBlocks = Blocks.fromReader(blHeader, reader);
  const ldrBlocks = Blocks.fromReader(ldrHeader, reader);
  const ldrWBlocks = Blocks.fromReader(ldrWHeader, reader);

  const dis = disassemble(new Reader(Buffer.from(fromData)),
    ph.fromDataOffset,
    ph.fromDataOffset + ph.fromDataEnd - ph.fromDataBegin,
    ph.fromDataBegin, ph.fromDataEnd, ph.fromCodeBegin, ph.fromCodeEnd);

  // Diff reader: to_size buffer of zeros with reconstructed to-values written.
  const dfdiff = Buffer.alloc(toSize);
  writeValuesToDiff(dfdiff, ldrBlocks, dis.ldr, packS32);
  writeValuesToDiff(dfdiff, ldrWBlocks, dis.ldrW, packS32);
  writeValuesToDiff(dfdiff, blBlocks, dis.bl, packBl);
  writeValuesToDiff(dfdiff, bwBlocks, dis.bw, packBw);
  if (ph.dataPresent) writeValuesToDiff(dfdiff, dataBlocks, dis.dataPointers, packS32);
  if (ph.codePresent) writeValuesToDiff(dfdiff, codeBlocks, dis.codePointers, packS32);

  // From reader: from-data copy with matched value locations zeroed.
  const fromZeroed = Buffer.from(fromData);
  writeZerosToFrom(fromZeroed, bwBlocks, dis.bw);
  writeZerosToFrom(fromZeroed, blBlocks, dis.bl);
  writeZerosToFrom(fromZeroed, ldrBlocks, dis.ldr);
  writeZerosToFrom(fromZeroed, ldrWBlocks, dis.ldrW);
  if (ph.dataPresent) writeZerosToFrom(fromZeroed, dataBlocks, dis.dataPointers);
  if (ph.codePresent) writeZerosToFrom(fromZeroed, codeBlocks, dis.codePointers);

  return { fromZeroed, dfdiff };
}

module.exports = { encode, createReaders, disassemble, packBw, packBl, unpackBw, unpackBl, Reader };
