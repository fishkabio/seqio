import * as fs from 'fs';
import * as path from 'path';
import { formatFasta, formatFastq, parseFasta, parseFastq } from '../../src/fastx';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

// The canonical Sanger FASTQ example (Cock et al. 2010 / Wikipedia), stored in
// tests/fixtures/reads.fastq. Kept here as literals so the parse is checked against an
// authored golden, not against re-derived values.
const WIKI_SEQ = 'GATTTGGGGTTCAAAGCAGTATCGATCAAATAGTAAATCCATTTGTTCAACTCACAGTTT';
const WIKI_QUAL_LINE = "!''*((((***+))%%%++)(%%%%).1***-+*''))**55CCF>>>>>>CCCCCCC65";

describe('parseFasta', () => {
  it('splits id and description and joins wrapped residues', () => {
    expect(parseFasta('>seq1 my read\nACGT\nACGT\n')).toEqual([
      { id: 'seq1', description: 'my read', sequence: 'ACGTACGT' },
    ]);
  });

  it('omits description when the header is only an id', () => {
    expect(parseFasta('>seq1\nACGT\n')).toEqual([{ id: 'seq1', sequence: 'ACGT' }]);
  });

  it('preserves case and gap characters, strips inner spaces', () => {
    expect(parseFasta('>x\naCg t-N.\n')).toEqual([{ id: 'x', sequence: 'aCgt-N.' }]);
  });

  it('accepts a header with no sequence body (empty sequence)', () => {
    expect(parseFasta('>empty\n')).toEqual([{ id: 'empty', sequence: '' }]);
  });

  it('accepts Uint8Array input', () => {
    expect(parseFasta(new TextEncoder().encode('>a\nACGT\n'))).toEqual([{ id: 'a', sequence: 'ACGT' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseFasta('')).toEqual([]);
  });

  it('is lenient: skips stray text before the first ">" header rather than refusing', () => {
    expect(parseFasta('junk line\nACGT\n>a\nGG\n')).toEqual([{ id: 'a', sequence: 'GG' }]);
  });

  it('is lenient: strips a leading UTF-8 BOM before the first header', () => {
    expect(parseFasta('\uFEFF>a\nACGT\n')).toEqual([{ id: 'a', sequence: 'ACGT' }]);
  });

  it('parses the multi-read fixture (";" comment, blank line, wrapping, gaps, case)', () => {
    expect(parseFasta(fixture('reads.fasta'))).toEqual([
      { id: 'read1', description: 'sample alpha', sequence: 'ACGTACGTACGTACGTACGTACGTACGTAC' },
      { id: 'read2', description: 'sample beta | len=12', sequence: 'acgtACGT--NN' },
    ]);
  });
});

describe('parseFastq', () => {
  it('parses one record and decodes Phred+33 quality', () => {
    // 'I' = 0x49 = 73 -> Phred 40; '#' = 0x23 = 35 -> Phred 2.
    expect(parseFastq('@r1 desc\nACGT\n+\nII#I\n')).toEqual([
      { id: 'r1', description: 'desc', sequence: 'ACGT', qualities: [40, 40, 2, 40] },
    ]);
  });

  it('parses the canonical Sanger example fixture', () => {
    const records = parseFastq(fixture('reads.fastq'));
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('SEQ_ID');
    expect(records[0].sequence).toBe(WIKI_SEQ);
    expect(records[0].qualities).toHaveLength(WIKI_SEQ.length);
    // First quality char '!' (ASCII 33) is Phred 0; last two "65" are '6'(21) and '5'(20).
    expect(records[0].qualities[0]).toBe(0);
    expect(records[0].qualities.slice(-2)).toEqual([21, 20]);
  });

  it('handles wrapped sequence/quality and a quality line starting with "@" (fixture)', () => {
    // readA: seq wrapped over 2 lines; quality '@@@@' ('@'=64 -> Phred 31) then 'IIII' (40).
    // The '@@@@' line must NOT be read as a new record — length terminates the block.
    expect(parseFastq(fixture('wrapped.fastq'))).toEqual([
      { id: 'readA', description: 'multi-line', sequence: 'ACGTACGT', qualities: [31, 31, 31, 31, 40, 40, 40, 40] },
      { id: 'readB', sequence: 'TT', qualities: [0, 0] },
    ]);
  });

  it('is lenient: a truncated final record keeps its sequence (quality unknown -> 0)', () => {
    expect(parseFastq('@r1\nACGT\n')).toEqual([{ id: 'r1', sequence: 'ACGT', qualities: [0, 0, 0, 0] }]);
  });

  it('is lenient: short quality is padded to the residue count with Phred 0', () => {
    expect(parseFastq('@r1\nACGT\n+\nII\n')).toEqual([{ id: 'r1', sequence: 'ACGT', qualities: [40, 40, 0, 0] }]);
  });

  it('is lenient: extra quality beyond the residue count is dropped', () => {
    expect(parseFastq('@r1\nAC\n+\nIIII\n')).toEqual([{ id: 'r1', sequence: 'AC', qualities: [40, 40] }]);
  });

  it('is lenient: an out-of-range quality byte is clamped into [0, 93]', () => {
    // 0x7f (DEL, 127) is one past '~' (126, the Phred 93 max) -> clamped to 93.
    expect(parseFastq('@r1\nA\n+\n\x7f\n')).toEqual([{ id: 'r1', sequence: 'A', qualities: [93] }]);
  });

  it('reads a valid record whose single quality line starts with "@" (Phred 31)', () => {
    expect(parseFastq('@r1\nACGT\n+\n@@@@\n')).toEqual([{ id: 'r1', sequence: 'ACGT', qualities: [31, 31, 31, 31] }]);
  });

  it('does not swallow the next record when a quality run is short', () => {
    // r1 quality "II" is short (2 of 4); the following "@r2" must start a new record,
    // not be consumed as r1 quality.
    expect(parseFastq('@r1\nACGT\n+\nII\n@r2\nGG\n+\n##\n')).toEqual([
      { id: 'r1', sequence: 'ACGT', qualities: [40, 40, 0, 0] },
      { id: 'r2', sequence: 'GG', qualities: [2, 2] },
    ]);
  });

  it('keeps the next record even when the residue gap exceeds the next header length', () => {
    // r1 needs 8 quality chars but has 2; "@r2" (len 3) fits inside the gap, so a
    // length/overshoot-only guard would swallow it. Recognized as a header structurally.
    expect(parseFastq('@r1\nACGTACGT\n+\nII\n@r2\nGG\n+\n##\n')).toEqual([
      { id: 'r1', sequence: 'ACGTACGT', qualities: [40, 40, 0, 0, 0, 0, 0, 0] },
      { id: 'r2', sequence: 'GG', qualities: [2, 2] },
    ]);
  });

  it('consumes a full "@@@@" quality line even when another record follows', () => {
    // "@@@@" is r1's real quality (followed by "@r2", not a "+"), so it must NOT be
    // mistaken for the next header; r2 still parses.
    expect(parseFastq('@r1\nACGT\n+\n@@@@\n@r2\nCC\n+\nDD\n')).toEqual([
      { id: 'r1', sequence: 'ACGT', qualities: [31, 31, 31, 31] },
      { id: 'r2', sequence: 'CC', qualities: [35, 35] },
    ]);
  });

  it('recovers a record with a missing "+" separator mid-file without merging sequences', () => {
    expect(parseFastq('@r1\nACGT\n@r2\nGG\n+\nII\n')).toEqual([
      { id: 'r1', sequence: 'ACGT', qualities: [0, 0, 0, 0] },
      { id: 'r2', sequence: 'GG', qualities: [40, 40] },
    ]);
  });
});

describe('reader/writer round-trip', () => {
  it('parseFasta(formatFasta(x)) recovers the data', () => {
    const records = [
      { id: 'a', description: 'first', sequence: 'ACGTACGTACGT' },
      { id: 'b', sequence: 'TTGGCC' },
    ];
    expect(parseFasta(formatFasta(records, { lineWidth: 4 }))).toEqual(records);
  });

  it('formatFastq(parseFastq(x)) reproduces the canonical fixture byte-for-byte', () => {
    // The fixture is already 4-line/unwrapped with a bare '+', which is exactly what the
    // writer emits, so decode -> encode is the identity on it.
    const text = fixture('reads.fastq');
    expect(formatFastq(parseFastq(text))).toBe(text);
    expect(text).toBe(`@SEQ_ID\n${WIKI_SEQ}\n+\n${WIKI_QUAL_LINE}\n`);
  });
});
