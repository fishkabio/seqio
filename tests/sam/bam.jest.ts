import { parseBam } from '../../src/sam';

// Minimal BAM encoder (little-endian) — just enough to exercise parseBam without a fixture file.
const NT16 = '=ACMGRSVTWYHKDBN';

function packSeq(seq: string): Uint8Array {
  const out = new Uint8Array((seq.length + 1) >> 1);
  for (let i = 0; i < seq.length; i++) {
    const code = NT16.indexOf(seq[i].toUpperCase());
    out[i >> 1] |= i & 1 ? code : code << 4;
  }
  return out;
}

interface Rec {
  name: string;
  flag: number;
  refID: number;
  pos: number; // 0-based, as stored in BAM
  seq: string;
}

function encodeRecord(r: Rec): Uint8Array {
  const nameBytes = new TextEncoder().encode(r.name + '\0');
  const seqPacked = packSeq(r.seq);
  const qual = new Uint8Array(r.seq.length).fill(0xff);
  const blockSize = 32 + nameBytes.length + seqPacked.length + qual.length; // no CIGAR, no tags
  const buf = new ArrayBuffer(4 + blockSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setInt32(0, blockSize, true);
  dv.setInt32(4, r.refID, true);
  dv.setInt32(8, r.pos, true);
  dv.setUint8(12, nameBytes.length); // l_read_name
  dv.setUint8(13, 0); // mapq
  dv.setUint16(14, 0, true); // bin
  dv.setUint16(16, 0, true); // n_cigar_op
  dv.setUint16(18, r.flag, true); // flag
  dv.setInt32(20, r.seq.length, true); // l_seq
  dv.setInt32(24, -1, true); // next_refID
  dv.setInt32(28, -1, true); // next_pos
  dv.setInt32(32, 0, true); // tlen
  u8.set(nameBytes, 36);
  u8.set(seqPacked, 36 + nameBytes.length);
  u8.set(qual, 36 + nameBytes.length + seqPacked.length);
  return u8;
}

function buildBam(refs: string[], records: Rec[]): Uint8Array {
  const te = new TextEncoder();
  const head = new Uint8Array(12);
  head.set(te.encode('BAM\x01'), 0);
  new DataView(head.buffer).setInt32(4, 0, true); // l_text = 0
  new DataView(head.buffer).setInt32(8, refs.length, true); // n_ref
  const parts: Uint8Array[] = [head];
  for (const ref of refs) {
    const nameBytes = te.encode(ref + '\0');
    const rb = new Uint8Array(8 + nameBytes.length);
    const rdv = new DataView(rb.buffer);
    rdv.setInt32(0, nameBytes.length, true);
    rb.set(nameBytes, 4);
    rdv.setInt32(4 + nameBytes.length, 1000, true); // l_ref
    parts.push(rb);
  }
  for (const r of records) parts.push(encodeRecord(r));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('parseBam', () => {
  it('decodes 4-bit sequences, maps refID→RNAME, skips secondary, mirrors SAM semantics', () => {
    const bam = buildBam(
      ['chr1'],
      [
        { name: 'r1', flag: 0, refID: 0, pos: 99, seq: 'ACGT' }, // pos 99 (0-based) → 100 (1-based)
        { name: 'r2', flag: 0x10, refID: 0, pos: 199, seq: 'TTTT' }, // reverse strand
        { name: 'r3', flag: 0x100, refID: 0, pos: 299, seq: 'GGGG' }, // secondary → skipped
        { name: 'r4', flag: 0x4, refID: -1, pos: -1, seq: 'AACC' }, // unmapped
      ],
    );
    expect(parseBam(bam)).toEqual([
      { id: 'r1', description: 'chr1:100 (+)', sequence: 'ACGT' },
      { id: 'r2', description: 'chr1:200 (-)', sequence: 'TTTT' },
      { id: 'r4', description: 'unmapped', sequence: 'AACC' },
    ]);
  });

  it('adds /1 and /2 suffixes for paired mates', () => {
    const bam = buildBam(
      ['chr1'],
      [
        { name: 'pair', flag: 0x1 | 0x40, refID: 0, pos: 0, seq: 'AAAA' }, // paired, first
        { name: 'pair', flag: 0x1 | 0x80, refID: 0, pos: 10, seq: 'CCCC' }, // paired, last
      ],
    );
    expect(parseBam(bam).map(r => r.id)).toEqual(['pair/1', 'pair/2']);
  });

  it('returns [] when the "BAM\\1" magic is absent (e.g. still-compressed BGZF bytes)', () => {
    expect(parseBam(new Uint8Array([0x1f, 0x8b, 0x08, 0x04]))).toEqual([]);
    expect(parseBam(new Uint8Array(0))).toEqual([]);
  });

  it('bails out (no hang/OOM) on a malformed header: huge n_ref with a bad l_name', () => {
    // magic + l_text=0 + n_ref=2^30, then l_name=-4 (would never advance p without the guard).
    const buf = new Uint8Array(16);
    buf.set(new TextEncoder().encode('BAM\x01'), 0);
    const dv = new DataView(buf.buffer);
    dv.setInt32(4, 0, true); // l_text
    dv.setInt32(8, 1 << 30, true); // n_ref (absurd)
    dv.setInt32(12, -4, true); // l_name (invalid)
    expect(parseBam(buf)).toEqual([]);
  });
});
