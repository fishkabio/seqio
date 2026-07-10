import { parseScf } from '../../src/scf';

/** Build a minimal but spec-valid SCF file carrying `seq` as its called bases. */
function buildScf(seq: string, version: '2.00' | '3.00', name?: string): Uint8Array {
  const n = seq.length;
  const commentText = name === undefined ? '' : `NAME=${name}\n`;
  const comment = new TextEncoder().encode(commentText);
  const HEADER = 128;
  const basesOffset = HEADER;
  // v3 (SoA): peak(n*4) + probA/C/G/T(n each) + chars(n) + spare(n*3) = n*12
  // v2 (AoS): n records * 12 bytes = n*12  → same total size, different layout
  const basesSection = n * 12;
  const commentsOffset = HEADER + basesSection;
  const total = commentsOffset + comment.length;

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x2e736366, false); // ".scf"
  dv.setUint32(12, n, false); // bases
  dv.setUint32(24, basesOffset, false); // bases_offset
  dv.setUint32(28, comment.length, false); // comments_size
  dv.setUint32(32, commentsOffset, false); // comments_offset
  for (let i = 0; i < 4; i++) buf[36 + i] = version.charCodeAt(i);

  if (version === '3.00') {
    const charStart = basesOffset + n * 8; // after peak indices + 4 probability arrays
    for (let i = 0; i < n; i++) buf[charStart + i] = seq.charCodeAt(i);
  } else {
    for (let i = 0; i < n; i++) buf[basesOffset + i * 12 + 8] = seq.charCodeAt(i);
  }
  buf.set(comment, commentsOffset);
  return buf;
}

describe('parseScf — called bases from an SCF trace', () => {
  it('reads the base sequence from a v3.00 (column-layout) file', () => {
    expect(parseScf(buildScf('ACGTACGTN', '3.00'))).toEqual([{ id: 'scf', sequence: 'ACGTACGTN' }]);
  });

  it('reads the base sequence from a v2.00 (interleaved-layout) file', () => {
    expect(parseScf(buildScf('GATTACA', '2.00'))).toEqual([{ id: 'scf', sequence: 'GATTACA' }]);
  });

  it('uses NAME= from the comments section as the record id', () => {
    expect(parseScf(buildScf('ACGT', '3.00', 'read001'))).toEqual([{ id: 'read001', sequence: 'ACGT' }]);
  });

  it('returns [] for non-SCF bytes and never throws', () => {
    expect(parseScf(new Uint8Array([1, 2, 3]))).toEqual([]);
    expect(parseScf('not an scf file at all, just text')).toEqual([]);
  });

  it('is lenient with a file truncated mid-bases (returns the bases that fit)', () => {
    const seq = 'ACGTACGT'; // n=8; v3 char array starts at 128 + n*8 = 192
    const charStart = 128 + seq.length * 8;
    const truncated = buildScf(seq, '3.00').subarray(0, charStart + 6); // only 6 of 8 chars survive
    expect(parseScf(truncated)).toEqual([{ id: 'scf', sequence: 'ACGTAC' }]);
  });
});
