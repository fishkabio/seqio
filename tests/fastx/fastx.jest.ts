import * as fs from 'fs';
import * as path from 'path';
import { readAbif } from '../../src/abif/raw';
import { getConfidences, getSequence } from '../../src/abif/view';
import { formatFasta, formatFastq, formatQual, hasUsableQuality, MAX_PHRED } from '../../src/fastx';

const BASECALLED = path.join(__dirname, '..', 'fixtures', 'A_forward.ab1');

describe('formatFasta', () => {
  it('writes a header with description and wraps the sequence at 60 by default', () => {
    const sequence = 'A'.repeat(60) + 'C'.repeat(60) + 'G'.repeat(10);
    const text = formatFasta({ id: 'seq1', description: 'my read', sequence });
    expect(text).toBe(`>seq1 my read\n${'A'.repeat(60)}\n${'C'.repeat(60)}\n${'G'.repeat(10)}\n`);
  });

  it('omits the description and writes a short sequence on one line', () => {
    expect(formatFasta({ id: 'seq1', sequence: 'ACGT' })).toBe('>seq1\nACGT\n');
  });

  it('honors a custom line width', () => {
    expect(formatFasta({ id: 'x', sequence: 'ACGTACGTAC' }, { lineWidth: 4 })).toBe('>x\nACGT\nACGT\nAC\n');
  });

  it('writes one line when lineWidth <= 0', () => {
    const sequence = 'A'.repeat(70);
    expect(formatFasta({ id: 'x', sequence }, { lineWidth: 0 })).toBe(`>x\n${sequence}\n`);
  });

  it('writes header only for an empty sequence', () => {
    expect(formatFasta({ id: 'empty', sequence: '' })).toBe('>empty\n');
  });

  it('concatenates multiple records', () => {
    const text = formatFasta([
      { id: 'a', sequence: 'AC' },
      { id: 'b', sequence: 'GT' },
    ]);
    expect(text).toBe('>a\nAC\n>b\nGT\n');
  });

  it('rejects a newline in the header', () => {
    expect(() => formatFasta({ id: 'a\nb', sequence: 'AC' })).toThrow();
  });
});

describe('formatFastq', () => {
  it('encodes quality as Phred+33 and clamps to [0, 93]', () => {
    // 0->'!'(33), 2->'#'(35), 40->'I'(73), 93->'~'(126); 94 and 255 clamp to 93->'~'; -5 clamps to 0->'!'.
    const text = formatFastq({
      id: 'r1',
      description: 'd',
      sequence: 'ACGTNNN',
      qualities: [0, 2, 40, 93, 94, 255, -5],
    });
    expect(text).toBe('@r1 d\nACGTNNN\n+\n!#I~~~!\n');
  });

  it('omits the description and leaves the + separator bare', () => {
    expect(formatFastq({ id: 'r1', sequence: 'AC', qualities: [10, 20] })).toBe('@r1\nAC\n+\n+5\n');
  });

  it('throws when the quality count does not match the sequence length', () => {
    expect(() => formatFastq({ id: 'r', sequence: 'ACG', qualities: [10, 20] })).toThrow();
  });

  it('concatenates multiple records', () => {
    const text = formatFastq([
      { id: 'a', sequence: 'A', qualities: [0] },
      { id: 'b', sequence: 'C', qualities: [93] },
    ]);
    expect(text).toBe('@a\nA\n+\n!\n@b\nC\n+\n~\n');
  });

  it('caps at the Phred+33 ceiling', () => {
    expect(MAX_PHRED).toBe(93);
  });
});

describe('formatQual', () => {
  it('writes space-separated clamped scores on one line when lineWidth <= 0', () => {
    const text = formatQual({ id: 'q1', qualities: [0, 2, 40, 93, 94, 255, -5] }, { lineWidth: 0 });
    expect(text).toBe('>q1\n0 2 40 93 93 93 0\n');
  });

  it('wraps scores at the given width', () => {
    expect(formatQual({ id: 'q1', qualities: [1, 2, 3, 4, 5, 6] }, { lineWidth: 4 })).toBe('>q1\n1 2 3 4\n5 6\n');
  });

  it('wraps at 60 scores per line by default', () => {
    const qualities = new Array(61).fill(30);
    const text = formatQual({ id: 'q', qualities });
    expect(text).toBe(`>q\n${new Array(60).fill(30).join(' ')}\n30\n`);
  });

  it('writes header only for empty scores', () => {
    expect(formatQual({ id: 'q', qualities: [] })).toBe('>q\n');
  });
});

describe('hasUsableQuality', () => {
  it('is false for missing, empty, or all-255 scores', () => {
    expect(hasUsableQuality(undefined)).toBe(false);
    expect(hasUsableQuality([])).toBe(false);
    expect(hasUsableQuality([255])).toBe(false);
    expect(hasUsableQuality([255, 255, 255])).toBe(false);
  });

  it('is true when at least one real score is present (0 is a real score)', () => {
    expect(hasUsableQuality([0])).toBe(true);
    expect(hasUsableQuality([30, 30, 30])).toBe(true);
    expect(hasUsableQuality([255, 10])).toBe(true);
  });
});

describe('fastx on a basecalled fixture (A_forward.ab1)', () => {
  const file = readAbif(fs.readFileSync(BASECALLED));
  const sequence = getSequence(file);
  const confidences = getConfidences(file);
  if (sequence === undefined || confidences === undefined) {
    throw new Error('fixture A_forward.ab1 is expected to carry PBAS + PCON');
  }
  // Real Sanger Q-scores sit well under the ceiling, so clamping is a round, not a cap.
  const clamped = confidences.map(q => Math.min(MAX_PHRED, Math.max(0, q)));

  it('has one quality score per base', () => {
    expect(confidences.length).toBe(sequence.length);
    expect(hasUsableQuality(confidences)).toBe(true);
  });

  it('produces a 4-line FASTQ whose quality line decodes back to the scores', () => {
    const lines = formatFastq({ id: 'A_forward', sequence, qualities: confidences }).split('\n');
    expect(lines[0]).toBe('@A_forward');
    expect(lines[1]).toBe(sequence);
    expect(lines[2]).toBe('+');
    expect(lines[3].length).toBe(sequence.length);
    const decoded = Array.from(lines[3], c => c.charCodeAt(0) - 33);
    expect(decoded).toEqual(clamped);
    expect(lines[4]).toBe('');
    expect(lines.length).toBe(5);
  });

  it('wraps FASTA at 60 and the residues round-trip', () => {
    const lines = formatFasta({ id: 'A_forward', sequence }).split('\n');
    expect(lines[0]).toBe('>A_forward');
    const body = lines.slice(1).filter(l => l.length > 0);
    expect(body.join('')).toBe(sequence);
    const nonLast = body.slice(0, -1);
    expect(nonLast.every(l => l.length === 60)).toBe(true);
  });

  it('writes .qual that parses back to the same scores', () => {
    const lines = formatQual({ id: 'A_forward', qualities: confidences }).split('\n');
    expect(lines[0]).toBe('>A_forward');
    const nums = lines
      .slice(1)
      .filter(l => l.length > 0)
      .join(' ')
      .split(' ')
      .map(Number);
    expect(nums).toEqual(clamped);
  });
});
