import { parsePdb } from '../../src/pdb';

describe('parsePdb — SEQRES → one-letter sequence', () => {
  it('maps three-letter amino-acid codes to one letter, per chain, in order', () => {
    const pdb = [
      'HEADER    HYDROLASE                               17-FEB-98   1A5H',
      'SEQRES   1 A    5  SER GLU HIS GLU THR',
      'SEQRES   2 A    5  ARG',
      'ATOM      1  N   SER A   1      11.104  13.207  10.567  1.00  0.00           N',
    ].join('\n');
    expect(parsePdb(pdb)).toEqual([{ id: 'A', sequence: 'SEHETR' }]);
  });

  it('keeps chains separate and preserves chain order', () => {
    const pdb = ['SEQRES   1 A    3  ALA CYS GLY', 'SEQRES   1 B    2  TRP TYR', 'SEQRES   2 A    3  MET'].join('\n');
    expect(parsePdb(pdb)).toEqual([
      { id: 'A', sequence: 'ACGM' },
      { id: 'B', sequence: 'WY' },
    ]);
  });

  it('reads nucleotide residues (DA/DC/DG/DT and ribo A/C/G/U)', () => {
    const pdb = 'SEQRES   1 X    6   DA  DC  DG  DT   A   U';
    expect(parsePdb(pdb)).toEqual([{ id: 'X', sequence: 'ACGTAU' }]);
  });

  it('maps an unknown residue code to X and never throws', () => {
    expect(parsePdb('SEQRES   1 A    2  ALA XYZ')).toEqual([{ id: 'A', sequence: 'AX' }]);
  });

  it('derives the sequence from ATOM records when a chain has no SEQRES (one residue per number)', () => {
    const pdb = [
      'ATOM      1  N   SER A   1      11.1  13.2  10.5',
      'ATOM      2  CA  SER A   1      12.1  13.2  10.5',
      'ATOM      3  N   GLY A   2      13.1  13.2  10.5',
      'ATOM      4  N   ALA B   1      14.1  13.2  10.5',
    ].join('\n');
    expect(parsePdb(pdb)).toEqual([
      { id: 'A', sequence: 'SG' }, // both atoms of residue 1 collapse to one S; residue 2 → G
      { id: 'B', sequence: 'A' },
    ]);
  });

  it('prefers SEQRES over ATOM, and only takes the first model', () => {
    const pdb = [
      'SEQRES   1 A    2  ALA CYS',
      'MODEL        1',
      'ATOM      1  CA  ALA A   1      0.0  0.0  0.0',
      'ATOM      2  CA  CYS A   2      0.0  0.0  0.0',
      'ENDMDL',
      'MODEL        2',
      'ATOM      3  CA  GLY B   1      0.0  0.0  0.0',
      'ENDMDL',
    ].join('\n');
    // Chain A comes from SEQRES; chain B (model 2 only) is ignored.
    expect(parsePdb(pdb)).toEqual([{ id: 'A', sequence: 'AC' }]);
  });

  it('takes a modified polymer residue stored as HETATM (e.g. MSE) but skips ligands/solvent', () => {
    const pdb = [
      'ATOM      1  CA  GLY A   1      0.0  0.0  0.0',
      'HETATM    2  CA  MSE A   2      0.0  0.0  0.0', // selenomethionine — a real residue → M
      'HETATM    3  O   HOH A 101      0.0  0.0  0.0', // water — not a residue, skipped
      'HETATM    4  ZN   ZN A 102      0.0  0.0  0.0', // zinc ion — skipped
      'HETATM    5  I    I  A 103      0.0  0.0  0.0', // iodine ion — single-letter, skipped (not RNA)
    ].join('\n');
    expect(parsePdb(pdb)).toEqual([{ id: 'A', sequence: 'GM' }]);
  });

  it('returns nothing when there are neither SEQRES nor ATOM records', () => {
    expect(parsePdb('HEADER    X\nREMARK 1\nTITLE something')).toEqual([]);
  });
});
