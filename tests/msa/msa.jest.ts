import * as fs from 'fs';
import * as path from 'path';
import { parseClustal, parseMega, parseMsf, parseNexus, parsePhylip, parseStockholm } from '../../src/msa';

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

  it('parseMega reads interleaved #Name rows, skipping the #mega header and !directives', () => {
    const meg = [
      '#mega',
      '!Title Example;',
      '!Format DataType=DNA;',
      '#taxonA ACGT ACGT',
      '#taxonB ACGA A.GT',
      '',
      '#taxonA GGGG',
      '#taxonB GG-G',
    ].join('\n');
    expect(parseMega(meg)).toEqual([
      { id: 'taxonA', sequence: 'ACGTACGTGGGG' },
      { id: 'taxonB', sequence: 'ACGAA.GTGG-G' },
    ]);
  });

  it('parseMega handles a multi-line !directive and residues wrapped onto following lines', () => {
    const meg = ['#mega', '!Title a title that', 'wraps across lines;', '#s1', 'ACGT', 'ACGT', '#s2', 'TTTTGGGG'].join(
      '\n',
    );
    expect(parseMega(meg)).toEqual([
      { id: 's1', sequence: 'ACGTACGT' },
      { id: 's2', sequence: 'TTTTGGGG' },
    ]);
  });

  it('parseMsf reads sequence blocks after the header "//" (gaps "." preserved)', () => {
    expect(parseMsf(fixture('align.msf'))).toEqual([
      { id: 'seq1', sequence: 'ACGT.ACGT' },
      { id: 'seq2', sequence: 'ACGTAACGT' },
    ]);
  });

  it('parseMsf skips the numeric position rulers interleaved between blocks (digit guard)', () => {
    // GCG & GeneDoc interleave position rulers ("        1        9") between sequence blocks; these
    // must not become bogus "1"/"9" records. Residue runs never carry digits, so the digit guard
    // drops the rulers while every real row is kept and accumulated across blocks.
    const msf = [
      '  demo.msf  MSF: 9  Type: P  Check: 0  ..',
      ' Name: seq1  Len: 9  Check: 0  Weight: 1.00',
      ' Name: seq2  Len: 9  Check: 0  Weight: 1.00',
      '//',
      '           1         9',
      'seq1  ACGT. ACGT',
      'seq2  ACGTA ACGT',
      '          10        18',
      'seq1  ACGT. ACGT',
      'seq2  ACGTA ACGT',
    ].join('\n');
    expect(parseMsf(msf)).toEqual([
      { id: 'seq1', sequence: 'ACGT.ACGTACGT.ACGT' },
      { id: 'seq2', sequence: 'ACGTAACGTACGTAACGT' },
    ]);
  });

  it('parseMsf keeps a row even when the header did not declare its name (stays lenient)', () => {
    // The reader must not drop a genuine (digit-free) row just because the exporter renamed/omitted
    // its Name: label — only numeric rulers are filtered.
    const msf = '  x.msf  MSF: 4  Check: 0  ..\n Name: a  Len: 4  Check: 0  Weight: 1.00\n//\na  ACGT\nb  TTTT\n';
    expect(parseMsf(msf)).toEqual([
      { id: 'a', sequence: 'ACGT' },
      { id: 'b', sequence: 'TTTT' },
    ]);
  });

  it('parseMsf accepts a numeric sequence name (only the residue field is digit-guarded)', () => {
    expect(parseMsf('//\n     1        5\n1  ACGTA\n2  TTTTT\n')).toEqual([
      { id: '1', sequence: 'ACGTA' },
      { id: '2', sequence: 'TTTTT' },
    ]);
  });

  it('parseMsf merges rows that share a name (interleaved-block accumulation) — so a file that DUPLICATES a sequence yields one over-long row; documented limitation for malformed input', () => {
    // A well-formed interleaved MSF repeats each name once per block and accumulates it. A file that
    // declares/embeds the SAME name twice is ambiguous; by-name accumulation concatenates them.
    const msf = '//\ndup  ACGT\nother  TTTT\ndup  GGGG\nother  CCCC\n';
    expect(parseMsf(msf)).toEqual([
      { id: 'dup', sequence: 'ACGTGGGG' },
      { id: 'other', sequence: 'TTTTCCCC' },
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
