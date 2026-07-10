import * as fs from 'fs';
import * as path from 'path';
import { parseGenbank } from '../../src/genbank';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

describe('parseGenbank', () => {
  it('reads the two-record fixture: version id, joined DEFINITION, ORIGIN sequence', () => {
    expect(parseGenbank(fixture('records.gb'))).toEqual([
      {
        id: 'TEST001.1',
        description: 'Synthetic test construct with a multi-line definition.',
        sequence: 'atgaaagttttacgtgatccggttgcaaccgatccggatc',
      },
      { id: 'TEST002.2', description: 'Second record.', sequence: 'acgtacgtacgt' },
    ]);
  });

  it('falls back to ACCESSION, then LOCUS name, when VERSION is absent', () => {
    expect(parseGenbank('LOCUS       XY   4 bp\nACCESSION   ACC9\nORIGIN\n        1 acgt\n//\n')).toEqual([
      { id: 'ACC9', sequence: 'acgt' },
    ]);
    expect(parseGenbank('LOCUS       ABC123   5 bp\nORIGIN\n        1 acgta\n//\n')).toEqual([
      { id: 'ABC123', sequence: 'acgta' },
    ]);
  });

  it('yields an empty sequence for a record with no ORIGIN rather than failing', () => {
    expect(parseGenbank('LOCUS       NOSEQ   0 bp\nDEFINITION  no sequence here.\n//\n')).toEqual([
      { id: 'NOSEQ', description: 'no sequence here.', sequence: '' },
    ]);
  });

  it('is lenient: recovers both records when the "//" between them is missing', () => {
    const text = 'LOCUS       A   2 bp\nORIGIN\n        1 ac\nLOCUS       B   2 bp\nORIGIN\n        1 gt\n//\n';
    expect(parseGenbank(text)).toEqual([
      { id: 'A', sequence: 'ac' },
      { id: 'B', sequence: 'gt' },
    ]);
  });

  it('accepts Uint8Array input and returns [] for empty input', () => {
    expect(parseGenbank(new TextEncoder().encode('LOCUS  Z   2 bp\nORIGIN\n        1 gg\n//\n'))).toEqual([
      { id: 'Z', sequence: 'gg' },
    ]);
    expect(parseGenbank('')).toEqual([]);
  });
});
