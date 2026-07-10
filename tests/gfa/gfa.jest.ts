import { parseGfa } from '../../src/gfa';

describe('parseGfa', () => {
  it('extracts GFA1 segment sequences (S <name> <seq>), skipping non-S lines and * segments', () => {
    const gfa = [
      'H\tVN:Z:1.0',
      'S\ts1\tACGTACGT\tLN:i:8',
      'S\ts2\tTTTTGGGG',
      'S\ts3\t*\tLN:i:100', // segment declared without residues — nothing to pick
      'L\ts1\t+\ts2\t+\t4M',
      'P\tpath1\ts1+,s2+\t*',
    ].join('\n');
    expect(parseGfa(gfa)).toEqual([
      { id: 's1', sequence: 'ACGTACGT' },
      { id: 's2', sequence: 'TTTTGGGG' },
    ]);
  });

  it('reads GFA2 segments, where an integer length sits between the name and the sequence', () => {
    const gfa = ['H\tVN:Z:2.0', 'S\ts1\t8\tACGTACGT', 'S\ts2\t8\tTTTTGGGG\txx:Z:tag'].join('\n');
    expect(parseGfa(gfa)).toEqual([
      { id: 's1', sequence: 'ACGTACGT' },
      { id: 's2', sequence: 'TTTTGGGG' },
    ]);
  });

  it('is lenient: no segment lines / empty input → []', () => {
    expect(parseGfa('H\tVN:Z:1.0\nL\ts1\t+\ts2\t+\t0M')).toEqual([]);
    expect(parseGfa('')).toEqual([]);
  });
});
