import * as fs from 'fs';
import * as path from 'path';
import { parseClustal, parseMsf, parseNexus, parsePhylip, parseStockholm } from '../../src/msa';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

describe('MSA readers (aligned row = record, gaps preserved)', () => {
  it('parseClustal accumulates interleaved blocks by name', () => {
    expect(parseClustal(fixture('align.aln'))).toEqual([
      { id: 'seq1', sequence: 'ACGT-ACGTACGTACGT' },
      { id: 'seq2', sequence: 'ACGTAACGTACGTACGT' },
    ]);
  });

  it('parseStockholm ignores #=GC markup and the header', () => {
    expect(parseStockholm(fixture('align.sto'))).toEqual([
      { id: 'seq1', sequence: 'ACGT-ACGT' },
      { id: 'seq2', sequence: 'ACGTAACGT' },
    ]);
  });

  it('parsePhylip reads relaxed interleaved layout', () => {
    expect(parsePhylip(fixture('align.phy'))).toEqual([
      { id: 'seq1', sequence: 'ACGT-ACGTACGTACGT' },
      { id: 'seq2', sequence: 'ACGTAACGTACGTACGT' },
    ]);
  });

  it('parseNexus reads the MATRIX block', () => {
    expect(parseNexus(fixture('align.nex'))).toEqual([
      { id: 'seq1', sequence: 'ACGT-ACGT' },
      { id: 'seq2', sequence: 'ACGTAACGT' },
    ]);
  });

  it('parseMsf reads sequence blocks after the header "//" (gaps "." preserved)', () => {
    expect(parseMsf(fixture('align.msf'))).toEqual([
      { id: 'seq1', sequence: 'ACGT.ACGT' },
      { id: 'seq2', sequence: 'ACGTAACGT' },
    ]);
  });

  it('parseNexus keeps space-grouped residues in a row (does not drop after the first token)', () => {
    expect(parseNexus('#NEXUS\nMATRIX\nseq1  ACGT ACGT\nseq2  ACGT AACG\n;\n')).toEqual([
      { id: 'seq1', sequence: 'ACGTACGT' },
      { id: 'seq2', sequence: 'ACGTAACG' },
    ]);
  });

  it('parseClustal skips a non-CLUSTAL program banner (MUSCLE) instead of making a bogus row', () => {
    expect(parseClustal('MUSCLE (3.8) multiple sequence alignment\n\nseq1  ACGT\nseq2  ACGT\n')).toEqual([
      { id: 'seq1', sequence: 'ACGT' },
      { id: 'seq2', sequence: 'ACGT' },
    ]);
  });

  it('parseStockholm returns rows from every //-separated alignment (multi-record)', () => {
    const two = '# STOCKHOLM 1.0\na AC\nb GT\n//\n# STOCKHOLM 1.0\nc TT\n//\n';
    expect(parseStockholm(two)).toEqual([
      { id: 'a', sequence: 'AC' },
      { id: 'b', sequence: 'GT' },
      { id: 'c', sequence: 'TT' },
    ]);
  });
});
