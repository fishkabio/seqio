/**
 * PDB (`.pdb`) reader — sequence extraction from `SEQRES` records.
 *
 * A PDB file lists each macromolecular chain's primary sequence in `SEQRES` records:
 *   `SEQRES  <serNum> <chainID> <numRes>  <res1> <res2> … <res13>`
 * with the residues as three-letter codes (13 per line, continued across records). This reader
 * collects the SEQRES residues per chain, in file order, and maps the three-letter codes to the
 * one-letter sequence: the 20 standard amino acids (+ SEC→U, PYL→O, the ambiguity codes B/Z/X),
 * and nucleotides (DA/DC/DG/DT/DU and A/C/G/U/T/I/N). Anything unrecognized becomes `X`.
 *   - id: the chain identifier (e.g. `A`).
 *   - sequence: the chain's residues, one letter each (no gaps — SEQRES is the primary sequence).
 *
 * SEQRES is the declared sequence and is preferred. For a chain with no SEQRES record (common in
 * coordinate-only files — predicted models, fragments), the sequence is reconstructed from the
 * first model's `ATOM` records instead (one residue per chain + residue number), plus any `HETATM`
 * whose residue is a recognized polymer/modified code (e.g. MSE selenomethionine) — solvent, ions
 * and ligands are left out. Deliberately lenient (see AGENTS.md): never throws.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { toLines } from '../text';

/** Three-letter → one-letter residue codes: standard amino acids, common variants, and nucleotides. */
const THREE_TO_ONE: Record<string, string> = {
  ALA: 'A',
  ARG: 'R',
  ASN: 'N',
  ASP: 'D',
  CYS: 'C',
  GLN: 'Q',
  GLU: 'E',
  GLY: 'G',
  HIS: 'H',
  ILE: 'I',
  LEU: 'L',
  LYS: 'K',
  MET: 'M',
  PHE: 'F',
  PRO: 'P',
  SER: 'S',
  THR: 'T',
  TRP: 'W',
  TYR: 'Y',
  VAL: 'V',
  MSE: 'M', // selenomethionine — very common in crystal structures, reads as Met
  SEC: 'U', // selenocysteine
  PYL: 'O', // pyrrolysine
  ASX: 'B',
  GLX: 'Z',
  UNK: 'X',
  // Nucleotides (deoxy- and ribo-, both the modern " DA"/"A" spellings).
  DA: 'A',
  DC: 'C',
  DG: 'G',
  DT: 'T',
  DU: 'U',
  DI: 'I',
  A: 'A',
  C: 'C',
  G: 'G',
  U: 'U',
  T: 'T',
  I: 'I',
  N: 'N',
};

/** Map one three-letter residue code to its one-letter symbol (unknown → `X`). */
function residueToOne(code: string): string {
  return THREE_TO_ONE[code.toUpperCase()] ?? 'X';
}

/**
 * Whether a HETATM's residue should count as polymer: a recognized code that is **not** a
 * single-letter nucleotide code. Genuine nucleotide/amino-acid residues always arrive as ATOM, so
 * a single-letter code on a HETATM is far more likely a ligand/ion collision (e.g. `I` = iodine)
 * than an RNA residue — excluding them keeps the whitelist to real modified residues (MSE, the
 * three-letter amino acids, DA/DC/…).
 */
function isHetatmResidue(code: string): boolean {
  return code.length >= 2 && Object.prototype.hasOwnProperty.call(THREE_TO_ONE, code.toUpperCase());
}

/**
 * One SEQRES record → its chain id + three-letter residue codes. Read by the fixed PDB columns
 * (chainID at column 12, residues from column 20) so a **blank** chain id — valid in PDB — isn't
 * mistaken for a residue by a naive whitespace split; falls back to whitespace splitting only for a
 * short/malformed line.
 */
function parseSeqres(line: string): { chain: string; codes: string[] } | null {
  // Trust the fixed columns only when the numeric fields land where the spec puts them (serNum in
  // cols 8-10, numRes in 14-17). This distinguishes a real fixed-column record — including one with
  // a blank chain id — from a loosely-spaced line, which must go through the whitespace fallback.
  const fixedColumns =
    line.length >= 20 && /^\d+$/.test(line.slice(7, 10).trim()) && /^\d+$/.test(line.slice(13, 17).trim());
  if (fixedColumns) {
    const codes = line.slice(19).trim().split(/\s+/).filter(Boolean);
    if (codes.length > 0) return { chain: line[11], codes }; // col 12 chain id (may be a space)
  }
  // Loosely-spaced / malformed line: SEQRES serNum chainID numRes res…
  const f = line.trim().split(/\s+/);
  return f.length >= 5 ? { chain: f[2], codes: f.slice(4) } : null;
}

/** A per-chain code collector that preserves first-seen chain order. */
interface Chains {
  readonly order: string[];
  readonly map: Map<string, string[]>;
}

function push(chains: Chains, chain: string, code: string): void {
  let codes = chains.map.get(chain);
  if (!codes) {
    chains.map.set(chain, (codes = []));
    chains.order.push(chain);
  }
  codes.push(code);
}

export function parsePdb(input: string | Uint8Array): SeqRecord[] {
  const lines = toLines(input);
  const seqres: Chains = { order: [], map: new Map() };
  const atom: Chains = { order: [], map: new Map() };
  const seen = new Set<string>(); // chain+residue-number, to take each ATOM residue once
  let pastFirstModel = false;

  for (const line of lines) {
    if (line.startsWith('SEQRES')) {
      const rec = parseSeqres(line);
      if (rec) for (const code of rec.codes) push(seqres, rec.chain, code);
    } else if (line.startsWith('ENDMDL')) {
      pastFirstModel = true; // only the first model contributes an ATOM-derived sequence
    } else if (!pastFirstModel && line.length >= 27 && (line.startsWith('ATOM') || line.startsWith('HETATM'))) {
      // Fixed PDB columns: resName 18-20, chainID 22, resSeq+iCode 23-27.
      const resName = line.slice(17, 20).trim();
      // ATOM is always a polymer residue. HETATM also covers ligands/solvent/ions, so take it only
      // when its residue is a recognized polymer/modified code (e.g. MSE) — this keeps the modified
      // residues that coordinate-only files store as HETATM without pulling in waters or ligands.
      if (line.startsWith('ATOM') || isHetatmResidue(resName)) {
        const chain = line[21];
        const key = `${chain}|${line.slice(22, 27)}`;
        if (!seen.has(key)) {
          seen.add(key);
          push(atom, chain, resName);
        }
      }
    }
  }

  // Prefer SEQRES; fall back to the ATOM-derived sequence for any chain SEQRES didn't declare.
  const order = [...seqres.order, ...atom.order.filter(c => !seqres.map.has(c))];
  return order.map(chain => {
    const codes = seqres.map.get(chain) ?? atom.map.get(chain) ?? [];
    return makeSeqRecord(chain.trim(), '', codes.map(residueToOne).join(''));
  });
}
