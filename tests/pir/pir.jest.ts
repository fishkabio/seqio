import * as fs from 'fs';
import * as path from 'path';
import { parsePir } from '../../src/pir';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

describe('parsePir', () => {
  it('reads the two-record fixture: id after ";", title, residues without the "*" terminator', () => {
    expect(parsePir(fixture('records.pir'))).toEqual([
      { id: 'CRAB_ANAPL', description: 'ALPHA CRYSTALLIN B CHAIN.', sequence: 'MDITIHNPLIRRPLFSWLAPSRIF' },
      { id: 'TEST_DNA', description: 'test dna sequence.', sequence: 'ACGTACGTACGT' },
    ]);
  });

  it('is lenient: keeps residues of a truncated record with no "*" and returns [] for empty input', () => {
    expect(parsePir('>P1;X\ntitle\n  ACDEF\n')).toEqual([{ id: 'X', description: 'title', sequence: 'ACDEF' }]);
    expect(parsePir('')).toEqual([]);
  });
});
