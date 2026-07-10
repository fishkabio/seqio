import * as fs from 'fs';
import * as path from 'path';
import { parseGff } from '../../src/gff';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

describe('parseGff', () => {
  it('returns the records of the embedded ##FASTA section (feature lines ignored)', () => {
    expect(parseGff(fixture('annot.gff3'))).toEqual([
      { id: 'chr1', description: 'test chromosome', sequence: 'ACGTACGTACGTACGTACGT' },
    ]);
  });

  it('returns [] for a GFF with no ##FASTA section (annotation only)', () => {
    expect(parseGff('##gff-version 3\nchr1\t.\tgene\t1\t9\t.\t+\t.\tID=g1\n')).toEqual([]);
  });
});
