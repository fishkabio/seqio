import * as fs from 'fs';
import * as path from 'path';
import { parseEmbl, parseSwissprot } from '../../src/embl';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

describe('parseEmbl', () => {
  it('reads the two-record fixture: accession.version id, joined DE, SQ sequence', () => {
    expect(parseEmbl(fixture('records.embl'))).toEqual([
      {
        id: 'X56734.1',
        description: 'Trifolium repens mRNA for non-cyanogenic beta-glucosidase',
        sequence: 'aaacaaaccaaatatggattttattgtagccatatttgct',
      },
      { id: 'AB000263.1', description: 'Homo sapiens test.', sequence: 'acgtacgtacgt' },
    ]);
  });

  it('falls back to AC and to the bare accession when SV is absent', () => {
    expect(parseEmbl('ID   AB000263 standard; RNA; PRI; 4 BP.\nSQ   Sequence 4 BP;\n     acgt        4\n//\n')).toEqual(
      [{ id: 'AB000263', sequence: 'acgt' }],
    );
  });

  it('is lenient: empty sequence with no SQ block, and [] for empty input', () => {
    expect(parseEmbl('ID   NOSEQ; SV 1; linear; mRNA; STD; PLN; 0 BP.\nDE   nothing.\n//\n')).toEqual([
      { id: 'NOSEQ.1', description: 'nothing.', sequence: '' },
    ]);
    expect(parseEmbl('')).toEqual([]);
  });
});

describe('parseSwissprot', () => {
  it('reads the two-record fixture: primary AC id, DE description, protein sequence', () => {
    expect(parseSwissprot(fixture('records.sp'))).toEqual([
      { id: 'P12345', description: 'RecName: Full=Test protein;', sequence: 'MKVLATTHGHIKLPQRSTVW' },
      { id: 'Q99999', description: 'RecName: Full=Other protein;', sequence: 'ACDEFGHIKL' },
    ]);
  });

  it('falls back to the entry name when AC is absent', () => {
    expect(parseSwissprot('ID   NAMEONLY   Reviewed;   3 AA.\nSQ   SEQUENCE 3 AA;\n     ACD\n//\n')).toEqual([
      { id: 'NAMEONLY', sequence: 'ACD' },
    ]);
  });
});
