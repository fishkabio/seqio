import { parseAce } from '../../src/ace';

describe('parseAce — assembly consensus + reads', () => {
  it('reads each contig consensus and each read, in file order', () => {
    const ace = [
      'AS 1 2',
      '',
      'CO 1 12 2 3 U',
      'CCTC*TCCGTAG',
      '',
      'BQ',
      ' 20 20 20 20',
      '',
      'AF read1 U 1',
      'BS 1 6 read1',
      '',
      'RD read1 9 0 0',
      'AACC*CGGG',
      '',
      'QA 1 8 1 8',
      '',
      'RD read2 4 0 0',
      'TTGG',
      '',
      'QA 1 4 1 4',
    ].join('\n');
    expect(parseAce(ace)).toEqual([
      { id: 'Contig1', description: 'consensus', sequence: 'CCTC*TCCGTAG' },
      { id: 'read1', description: 'read', sequence: 'AACC*CGGG' },
      { id: 'read2', description: 'read', sequence: 'TTGG' },
    ]);
  });

  it('ends a sequence block at the next record tag even without a blank line', () => {
    const ace = ['CO c1 4 1 1 U', 'ACGT', 'BQ', ' 20 20', 'RD r1 4 0 0', 'TTTT', 'QA 1 4 1 4'].join('\n');
    expect(parseAce(ace)).toEqual([
      { id: 'Contigc1', description: 'consensus', sequence: 'ACGT' },
      { id: 'r1', description: 'read', sequence: 'TTTT' },
    ]);
  });

  it('keeps a truncated final read (never throws)', () => {
    expect(parseAce('CO 1 4 1 1 U\nACGT\nRD r 4 0 0\nGGG')).toEqual([
      { id: 'Contig1', description: 'consensus', sequence: 'ACGT' },
      { id: 'r', description: 'read', sequence: 'GGG' },
    ]);
  });
});
