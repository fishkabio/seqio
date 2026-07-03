import * as fs from 'fs';
import * as path from 'path';
import { readAbif, writeAbif, findEntry } from '../../src/abif/raw';
import { getConfidences, getDataChannel, getFwo, getSequence } from '../../src/abif/view';
import { parseAbif } from '../../src/abif/parser';

const RAW = path.join(__dirname, '..', 'fixtures', 'raw-no-basecalls.ab1');
const ABF = path.join(__dirname, '..', 'fixtures', 'basecalled.ab1');
const EDITED = path.join(__dirname, '..', 'fixtures', 'edited-differs-from-called.ab1');
const REVC = path.join(__dirname, '..', 'fixtures', 'revc-flag.ab1');

describe('abif-raw', () => {
  it('reads ABIF version and a non-empty directory', () => {
    const f = readAbif(fs.readFileSync(RAW));
    expect(f.version).toBeGreaterThan(0);
    expect(f.entries.length).toBeGreaterThan(0);
  });

  it('preserves entries on round-trip (write then read)', () => {
    const f = readAbif(fs.readFileSync(RAW));
    const out = writeAbif(f);
    const re = readAbif(out);

    expect(re.entries.length).toBe(f.entries.length);
    for (let i = 0; i < f.entries.length; i++) {
      expect(re.entries[i].tagName).toBe(f.entries[i].tagName);
      expect(re.entries[i].tagNumber).toBe(f.entries[i].tagNumber);
      expect(re.entries[i].elementType).toBe(f.entries[i].elementType);
      expect(re.entries[i].elementSize).toBe(f.entries[i].elementSize);
      expect(re.entries[i].elementCount).toBe(f.entries[i].elementCount);
      expect(re.entries[i].payload.byteLength).toBe(f.entries[i].payload.byteLength);
      // Byte-for-byte payload equality.
      for (let j = 0; j < f.entries[i].payload.byteLength; j++) {
        expect(re.entries[i].payload[j]).toBe(f.entries[i].payload[j]);
      }
    }
  });

  it('findEntry locates a tag by name+number', () => {
    const f = readAbif(fs.readFileSync(RAW));
    const fwo = findEntry(f, 'FWO_', 1);
    expect(fwo).toBeDefined();
    expect(fwo!.elementCount * fwo!.elementSize).toBe(4);
  });

  it('applies BioPython declared-vs-computed dataSize clamp on basecalled.ab1', () => {
    // basecalled.ab1 is BioPython's A_forward fixture — the canonical case for the
    // declared/computed dataSize mismatch. Parsing must succeed and return entries
    // with self-consistent payload lengths.
    const f = readAbif(fs.readFileSync(ABF));
    expect(f.entries.length).toBeGreaterThan(0);
    for (const e of f.entries) {
      expect(e.payload.byteLength).toBe(e.elementCount * e.elementSize);
    }
  });

  it('exposes the root tdir directory metadata and the padding bytes', () => {
    const f = readAbif(fs.readFileSync(ABF));
    expect(f.tdir.entrySize).toBe(28);
    expect(f.tdir.entryCount).toBe(f.entries.length);
    expect(f.tdir.dataOffset).toBeGreaterThan(0);
    // basecalled.ab1 carries 140 bytes of directory padding after the entries.
    const pad = f.tdir.dataSize - f.tdir.entryCount * 28;
    expect(pad).toBe(140);
    expect(f.tdir.paddingBytes.length).toBe(pad);
    expect(f.tdir.paddingBytes.every(b => b === 0)).toBe(true);
  });

  it('reads a directory by its raw numElements, not clamped by a desynced tdir.dataSize', () => {
    // tdir claims 2 entries (numElements) but sets dataSize=28 (room for 1). numElements wins.
    const N = 2;
    const dirAt = 128;
    const buf = new Uint8Array(dirAt + N * 28);
    const dv = new DataView(buf.buffer);
    buf.set([0x41, 0x42, 0x49, 0x46], 0); // "ABIF"
    dv.setInt16(4, 101, false);
    buf.set([0x74, 0x64, 0x69, 0x72], 6); // "tdir"
    dv.setInt32(10, 1, false); // tdir tagNumber
    dv.setInt16(14, 1023, false); // elementType
    dv.setInt16(16, 28, false); // elementSize
    dv.setInt32(18, N, false); // numElements = 2 (authoritative)
    dv.setInt32(22, 28, false); // dataSize = 28 (desynced: only room for 1)
    dv.setInt32(26, dirAt, false); // dataOffset
    for (let i = 0; i < N; i++) {
      const at = dirAt + i * 28;
      buf.set(Array.from('USER', c => c.charCodeAt(0)), at);
      dv.setInt32(at + 4, i + 1, false); // tagNumber 1, 2
      dv.setInt16(at + 8, 1024, false); // user elementType
      dv.setInt16(at + 10, 1, false); // elementSize
      dv.setInt32(at + 12, 1, false); // elementCount
      dv.setInt32(at + 16, 1, false); // dataSize (inline)
      buf[at + 20] = 0x41; // inline 'A'
    }
    const f = readAbif(buf);
    expect(f.tdir.rawEntryCount).toBe(2); // raw header field preserved
    expect(f.tdir.dataSize).toBe(28); // verbatim, not recomputed
    expect(f.entries.length).toBe(2); // iterated by numElements, not clamped to floor(28/28)=1
    expect(f.entries.map(e => e.tagNumber)).toEqual([1, 2]);
    // The 2nd entry is read AND covered — a desynced dataSize must not flag it as an orphan range.
    expect(f.unreferencedRanges).toEqual([]);
  });

  it('exposes the MacBinary preamble bytes verbatim when present', () => {
    const abif = new Uint8Array(fs.readFileSync(ABF));
    const wrapped = new Uint8Array(128 + abif.length);
    wrapped.fill(0xcd, 0, 128); // non-zero preamble
    wrapped.set(abif, 128);
    const f = readAbif(wrapped);
    expect(f.macBinaryOffset).toBe(128);
    expect(f.macBinaryHeader).toBeDefined();
    expect(f.macBinaryHeader!.length).toBe(128);
    expect(f.macBinaryHeader!.every(b => b === 0xcd)).toBe(true);
    expect(readAbif(abif).macBinaryHeader).toBeUndefined(); // absent when not wrapped
  });

  it('rejects a MacBinary-wrapped file whose ABIF header is truncated (controlled error, not RangeError)', () => {
    const buf = new Uint8Array(140); // 128 preamble + only 12 ABIF bytes — no room for a 128B header
    buf.set([0x41, 0x42, 0x49, 0x46], 128); // "ABIF" magic at offset 128
    expect(() => readAbif(buf)).toThrow(/too small/i);
  });

  it('exposes reserved header bytes [34..127] verbatim, including non-zero values', () => {
    const bytes = new Uint8Array(fs.readFileSync(ABF));
    bytes[50] = 0xab; // a byte in the reserved region
    const f = readAbif(bytes);
    expect(f.headerReserved.length).toBe(94);
    expect(f.headerReserved[50 - 34]).toBe(0xab);
  });

  it('exposes unreferenced physical byte ranges (orphaned blocks / trailing padding)', () => {
    const bc = readAbif(fs.readFileSync(ABF)).unreferencedRanges;
    expect(bc.map(r => r.offset)).toEqual([19675, 194552, 199562]);
    expect(bc.map(r => r.bytes.length)).toEqual([25, 4928, 4928]);
    expect(bc.reduce((s, r) => s + r.bytes.length, 0)).toBe(9881);
    const ed = readAbif(fs.readFileSync(EDITED)).unreferencedRanges;
    expect(ed.length).toBe(1);
    expect(ed[0].bytes.length).toBe(28); // trailing zero block
    // Tightly-packed fixtures have no gaps.
    expect(readAbif(fs.readFileSync(REVC)).unreferencedRanges).toEqual([]);
    expect(readAbif(fs.readFileSync(RAW)).unreferencedRanges).toEqual([]);
  });

  it('readAbif is the raw structure; parseAbif is the interpreting layer', () => {
    const bytes = fs.readFileSync(ABF);
    const raw = readAbif(bytes);
    // Raw: tdir + verbatim entry fields, no derived channel/basecall concepts.
    expect(raw.tdir.entrySize).toBe(28);
    expect(raw.entries.every(e => e.raw !== undefined)).toBe(true);
    expect('baseOrder' in raw).toBe(false);
    // Interpreted: parseAbif derives baseOrder, basecall variants, etc.
    const p = parseAbif(bytes);
    expect(p.chromatogram.baseOrder).toMatch(/^[ACGT]{4}$/);
    expect(Array.isArray(p.baseCallVariants)).toBe(true);
  });

  it('reads external payloads through a MacBinary preamble (base offset applied, full payload)', () => {
    const plain = fs.readFileSync(RAW);
    const wrapped = new Uint8Array(128 + plain.byteLength);
    wrapped.set(plain, 128); // 128-byte MacBinary preamble; ABIF magic now at offset 128
    const a = readAbif(plain);
    const b = readAbif(wrapped);
    expect(b.macBinaryOffset).toBe(128);
    expect(b.entries.length).toBe(a.entries.length);
    // Every payload — full bytes, not a prefix — must match the unwrapped parse.
    for (let i = 0; i < a.entries.length; i++) {
      expect(Array.from(b.entries[i].payload)).toEqual(Array.from(a.entries[i].payload));
    }
  });

  describe('payload sizing / inline rule on user (opaque) entries', () => {
    // Build a minimal ABIF holding a single directory entry with the given fields.
    function oneEntry(o: {
      tag?: string;
      tagNumber?: number;
      elementType: number;
      elementSize: number;
      elementCount: number;
      dataSize: number;
      inline?: number[];
      external?: number[];
    }): Uint8Array {
      const dirAt = 128;
      const payloadAt = dirAt + 28;
      const buf = new Uint8Array(payloadAt + (o.external?.length ?? 0));
      const dv = new DataView(buf.buffer);
      buf.set([0x41, 0x42, 0x49, 0x46], 0); // "ABIF"
      dv.setInt16(4, 101, false);
      buf.set([0x74, 0x64, 0x69, 0x72], 6); // tdir
      dv.setInt32(10, 1, false);
      dv.setInt16(14, 1023, false);
      dv.setInt16(16, 28, false);
      dv.setInt32(18, 1, false); // one entry
      dv.setInt32(22, 28, false);
      dv.setInt32(26, dirAt, false);
      const tag = o.tag ?? 'USER';
      buf.set(Array.from(tag, c => c.charCodeAt(0)), dirAt);
      dv.setInt32(dirAt + 4, o.tagNumber ?? 1, false);
      dv.setInt16(dirAt + 8, o.elementType, false);
      dv.setInt16(dirAt + 10, o.elementSize, false);
      dv.setInt32(dirAt + 12, o.elementCount, false);
      dv.setInt32(dirAt + 16, o.dataSize, false);
      if (o.inline) buf.set(o.inline, dirAt + 20);
      else dv.setInt32(dirAt + 20, payloadAt, false);
      if (o.external) buf.set(o.external, payloadAt);
      return buf;
    }
    const oneUserEntry = oneEntry;

    it('reads the full inline payload when dataSize > count*size (finding: no truncation)', () => {
      // elementSize=1, elementCount=1 → count*size=1, but dataSize=4 → payload is 4 bytes.
      const f = readAbif(oneUserEntry({ elementType: 1024, elementSize: 1, elementCount: 1, dataSize: 4, inline: [65, 66, 67, 68] }));
      const e = findEntry(f, 'USER', 1)!;
      expect(Array.from(e.payload)).toEqual([65, 66, 67, 68]);
      expect(e.raw).toMatchObject({ inline: true, dataSize: 4, dataOffset: -1, elementCount: 1 });
    });

    it('exposes the full 4-byte inline slot, including stale bytes beyond dataSize', () => {
      // dataSize=2 → 2 meaningful bytes, but the inline slot carries 2 more (stale) bytes.
      const f = readAbif(oneUserEntry({ elementType: 1024, elementSize: 1, elementCount: 1, dataSize: 2, inline: [65, 66, 0x99, 0xff] }));
      const e = findEntry(f, 'USER', 1)!;
      expect(Array.from(e.payload)).toEqual([65, 66]); // meaningful bytes = dataSize
      expect(Array.from(e.raw!.dataOffsetBytes)).toEqual([65, 66, 0x99, 0xff]); // full slot, stale visible
      expect(e.raw!.dataSize).not.toBe(e.elementCount * e.elementSize); // declared dataSize kept separate
    });

    it('reconciles an external entry whose dataSize is smaller than elementCount*elementSize', () => {
      // elementType 4 (short, 2B) × 4 elems would be 8 bytes, but dataSize says 6 (external, >4).
      const f = readAbif(oneUserEntry({ elementType: 4, elementSize: 2, elementCount: 4, dataSize: 6, external: [0, 1, 0, 2, 0, 3] }));
      const e = findEntry(f, 'USER', 1)!;
      expect(e.raw!.inline).toBe(false); // dataSize 6 > 4 → external
      expect(e.raw!.dataSize).toBe(6); // declared, verbatim
      expect(e.raw!.elementCount).toBe(4); // on-disk numElements
      expect(e.raw!.dataSize).toBeLessThan(e.raw!.elementCount * e.elementSize); // genuine 6 < 8 mismatch
      expect(e.payload.byteLength).toBe(6); // payload sized by dataSize, not count*size
      expect(e.elementCount).toBe(3); // reconciled down to what 6 bytes hold
    });

    it('reads external when dataSize > 4 even though count*size <= 4 (finding: not inline)', () => {
      // count*size = 1 (would look inline) but dataSize=6 → the payload is external.
      const f = readAbif(oneUserEntry({ elementType: 1024, elementSize: 1, elementCount: 1, dataSize: 6, external: [1, 2, 3, 4, 5, 6] }));
      const e = findEntry(f, 'USER', 1)!;
      expect(Array.from(e.payload)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(e.raw).toMatchObject({ inline: false, dataSize: 6, dataOffset: 156, elementCount: 1 });
    });

    it('treats declared dataSize<=4 as inline even when count*size>4, clamping element count', () => {
      const f = readAbif(oneUserEntry({ elementType: 1024, elementSize: 2, elementCount: 4, dataSize: 4, inline: [65, 66, 67, 68] }));
      const e = findEntry(f, 'USER', 1)!;
      expect(e.raw?.inline).toBe(true);
      expect(Array.from(e.payload)).toEqual([65, 66, 67, 68]);
      expect(e.elementCount).toBe(2); // reconciled: 4 bytes / elementSize 2
      expect(e.raw?.elementCount).toBe(4); // raw numElements preserved
    });

    it('round-trips such an opaque entry meaning-losslessly (writeAbif uses payload length)', () => {
      const f = readAbif(oneUserEntry({ elementType: 1024, elementSize: 1, elementCount: 1, dataSize: 6, external: [1, 2, 3, 4, 5, 6] }));
      const e = findEntry(readAbif(writeAbif(f)), 'USER', 1)!;
      expect(Array.from(e.payload)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(e.raw?.dataSize).toBe(6);
    });
  });

  describe('best-effort decoding of malformed entries', () => {
    // Reuse the single-entry builder from the block above via a local copy.
    function oneEntry(o: {
      tag?: string;
      tagNumber?: number;
      elementType: number;
      elementSize: number;
      elementCount: number;
      dataSize: number;
      inline?: number[];
      external?: number[];
    }): Uint8Array {
      const dirAt = 128;
      const payloadAt = dirAt + 28;
      const buf = new Uint8Array(payloadAt + (o.external?.length ?? 0));
      const dv = new DataView(buf.buffer);
      buf.set([0x41, 0x42, 0x49, 0x46], 0);
      dv.setInt16(4, 101, false);
      buf.set([0x74, 0x64, 0x69, 0x72], 6);
      dv.setInt32(10, 1, false);
      dv.setInt16(14, 1023, false);
      dv.setInt16(16, 28, false);
      dv.setInt32(18, 1, false);
      dv.setInt32(22, 28, false);
      dv.setInt32(26, dirAt, false);
      buf.set(Array.from(o.tag ?? 'USER', c => c.charCodeAt(0)), dirAt);
      dv.setInt32(dirAt + 4, o.tagNumber ?? 1, false);
      dv.setInt16(dirAt + 8, o.elementType, false);
      dv.setInt16(dirAt + 10, o.elementSize, false);
      dv.setInt32(dirAt + 12, o.elementCount, false);
      dv.setInt32(dirAt + 16, o.dataSize, false);
      if (o.inline) buf.set(o.inline, dirAt + 20);
      else dv.setInt32(dirAt + 20, payloadAt, false);
      if (o.external) buf.set(o.external, payloadAt);
      return buf;
    }

    it('does not throw on a short date payload (falls back to raw bytes)', () => {
      const bytes = oneEntry({ tag: 'RUND', elementType: 10, elementSize: 1, elementCount: 2, dataSize: 2, inline: [7, 0xe8] });
      expect(() => parseAbif(bytes)).not.toThrow();
      const p = parseAbif(bytes);
      expect(p.entries.find(x => x.tag === 'RUND')!.decoded.kind).toBe('unknown');
      expect(p.metadata.runDate).toBeUndefined();
    });

    it('does not throw on an empty pString payload', () => {
      const bytes = oneEntry({ tag: 'CMNT', elementType: 18, elementSize: 1, elementCount: 0, dataSize: 0 });
      expect(() => parseAbif(bytes)).not.toThrow();
      expect(parseAbif(bytes).entries.find(x => x.tag === 'CMNT')!.decoded).toEqual({ kind: 'string', value: '' });
    });

    it('handles a negative dataSize without dropping the payload (falls back to count*size)', () => {
      const f = readAbif(oneEntry({ tag: 'USER', elementType: 2, elementSize: 1, elementCount: 1, dataSize: -5, inline: [65] }));
      const e = findEntry(f, 'USER', 1)!;
      expect(e.elementCount).toBe(1);
      expect(Array.from(e.payload)).toEqual([65]);
      expect(e.raw?.dataSize).toBe(-5); // raw field preserved verbatim
    });

    it('does not throw on numeric types whose payload is shorter than the element width', () => {
      // type 5/7 (4 bytes/elem) and 8 (8 bytes) with only 2 payload bytes → no RangeError.
      for (const elementType of [3, 4, 5, 7, 8]) {
        const bytes = oneEntry({ tag: 'USER', elementType, elementSize: 2, elementCount: 1, dataSize: 2, inline: [0, 1] });
        expect(() => parseAbif(bytes)).not.toThrow();
      }
    });

    it('getFwo/getSequence read only elementCount, ignoring trailing padding', () => {
      // FWO_: 4 declared chars but dataSize 5 ("ACGT\0").
      const fwoBytes = oneEntry({ tag: 'FWO_', elementType: 2, elementSize: 1, elementCount: 4, dataSize: 5, external: [65, 67, 71, 84, 0] });
      expect(getFwo(readAbif(fwoBytes))).toBe('ACGT'); // not "ACGT\0"
      expect(parseAbif(fwoBytes).chromatogram.baseOrder).toBe('ACGT'); // real order, not the GATC fallback
      // PBAS2: 2 declared bases but dataSize 3 (inline slot "AC\0", padded).
      const pbasFile = readAbif(oneEntry({ tag: 'PBAS', tagNumber: 2, elementType: 2, elementSize: 1, elementCount: 2, dataSize: 3, inline: [65, 67, 0, 0] }));
      expect(getSequence(pbasFile)).toBe('AC');
    });

    it('clamps elementCount to the payload when elementSize <= 0 (typed getters stay well-formed)', () => {
      // PCON2 claims 5 elements at elementSize=0, but dataSize=0 → nothing to read.
      const f = readAbif(oneEntry({ tag: 'PCON', tagNumber: 2, elementType: 2, elementSize: 0, elementCount: 5, dataSize: 0 }));
      expect(findEntry(f, 'PCON', 2)!.elementCount).toBe(0); // not the disk's 5
      expect(getConfidences(f)).toEqual([]); // number[], never [undefined, undefined, ...]
      // Negative elementSize is bounded the same way — by the payload byte count.
      const g = readAbif(oneEntry({ tag: 'PCON', tagNumber: 2, elementType: 2, elementSize: -1, elementCount: 9, dataSize: 3, inline: [7, 8, 9, 0] }));
      expect(getConfidences(g)).toEqual([7, 8, 9]);
    });

    it('clamps a negative numElements so downstream helpers do not crash', () => {
      const f = readAbif(oneEntry({ tag: 'DATA', tagNumber: 1, elementType: 4, elementSize: 2, elementCount: -3, dataSize: 4, inline: [0, 1, 0, 2] }));
      const e = findEntry(f, 'DATA', 1)!;
      expect(e.elementCount).toBe(0); // reconciled to a safe non-negative count
      expect(e.raw?.elementCount).toBe(-3); // raw numElements preserved verbatim
      expect(() => getDataChannel(f, 1)).not.toThrow(); // would be new Int16Array(-3) without the clamp
      expect(getDataChannel(f, 1)!.length).toBe(0);
    });
  });

  it('throws on missing ABIF magic', () => {
    const garbage = new Uint8Array(256);
    expect(() => readAbif(garbage)).toThrow(/Not an ABIF file/);
  });

  it('throws on a file shorter than the header', () => {
    expect(() => readAbif(new Uint8Array(10))).toThrow(/too small/);
  });
});
