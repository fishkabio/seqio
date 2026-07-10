import { parseSam } from '../../src/sam';

// A small SAM: header lines, a forward and a reverse mapped read, an unmapped read, a proper pair
// (first + last mate), and a secondary alignment whose SEQ is '*'. Tabs are real (\t).
const SAM = [
  '@HD\tVN:1.6\tSO:coordinate',
  '@SQ\tSN:chr1\tLN:248956422',
  '@PG\tID:bwa\tPN:bwa',
  'read1\t0\tchr1\t1000\t60\t8M\t*\t0\t0\tACGTACGT\tIIIIIIII',
  'read2\t16\tchr1\t2000\t60\t8M\t*\t0\t0\tTTTTGGGG\tIIIIIIII',
  'read3\t4\t*\t0\t0\t*\t*\t0\t0\tAACCGGTT\tIIIIIIII',
  'read4\t83\tchr1\t3000\t60\t4M\t=\t3100\t100\tAACC\tIIII',
  'read4\t163\tchr1\t3100\t60\t4M\t=\t3000\t-100\tGGTT\tIIII',
  'secondary\t256\tchr1\t5000\t0\t8M\t*\t0\t0\t*\t*',
].join('\n');

describe('parseSam', () => {
  it('extracts each stored read sequence, skipping headers and SEQ=* records', () => {
    expect(parseSam(SAM)).toEqual([
      { id: 'read1', description: 'chr1:1000 (+)', sequence: 'ACGTACGT' },
      { id: 'read2', description: 'chr1:2000 (-)', sequence: 'TTTTGGGG' },
      { id: 'read3', description: 'unmapped', sequence: 'AACCGGTT' },
      { id: 'read4/1', description: 'chr1:3000 (-)', sequence: 'AACC' },
      { id: 'read4/2', description: 'chr1:3100 (+)', sequence: 'GGTT' },
    ]);
  });

  it('stores the reverse-strand sequence verbatim (reference-forward, not un-flipped)', () => {
    const rec = parseSam('r\t16\tchr1\t1\t60\t4M\t*\t0\t0\tACGT\tIIII')[0];
    expect(rec.sequence).toBe('ACGT');
  });

  it('skips secondary (0x100) and supplementary (0x800) alignments even when they carry SEQ', () => {
    const sam = [
      'r\t0\tchr1\t100\t60\t4M\t*\t0\t0\tACGT\tIIII', // primary — kept
      'r\t256\tchr2\t200\t0\t4M\t*\t0\t0\tACGT\tIIII', // secondary — same read, dropped
      'r\t2048\tchr3\t300\t60\t2H2M\t*\t0\t0\tGT\tII', // supplementary split — dropped
    ].join('\n');
    expect(parseSam(sam)).toEqual([{ id: 'r', description: 'chr1:100 (+)', sequence: 'ACGT' }]);
  });

  it('is lenient: ignores short/garbled lines and returns [] for none', () => {
    expect(parseSam('not\ta\tsam\tline')).toEqual([]);
    expect(parseSam('')).toEqual([]);
  });
});
