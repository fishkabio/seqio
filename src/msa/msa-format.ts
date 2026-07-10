/**
 * Multiple-sequence-alignment readers — one aligned row = one record.
 *
 * Covers the common alignment formats: Clustal (`.aln`), Stockholm (`.sto`/`.stk`),
 * PHYLIP (`.phy`), NEXUS (`.nex`) and GCG/MSF (`.msf`). Each returns the alignment's rows
 * as {@link SeqRecord}s: `id` = the taxon/sequence name, `sequence` = that row **with its
 * gap characters preserved** (an aligned row is data; de-gapping is a caller's choice).
 * Only line spacing and wrap are removed. No description field — these formats don't carry
 * a per-row one.
 *
 * Deliberately lenient (see AGENTS.md): never throws, best-effort on malformed input, and
 * always returns every row it can. Interleaved blocks are accumulated by name.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { decodeText, isBlank, stripWhitespace, toLines } from '../text';

/** Accumulates aligned blocks by row name, preserving first-seen order (handles interleaving). */
class Alignment {
  private readonly order: string[] = [];
  private readonly blocks = new Map<string, string[]>();

  add(name: string, block: string): void {
    const parts = this.blocks.get(name);
    if (parts) parts.push(block);
    else {
      this.blocks.set(name, [block]);
      this.order.push(name);
    }
  }

  toRecords(): SeqRecord[] {
    return this.order.map(name => makeSeqRecord(name, '', stripWhitespace((this.blocks.get(name) ?? []).join(''))));
  }
}

/** Alignment-column characters: residues (any letter/digit), gaps and match/missing symbols. */
const ALIGN_BLOCK = /^[A-Za-z0-9.*?~-]+$/;

/** Read a Clustal (`.aln`) alignment. Also handles the Clustal-format output of MUSCLE, MAFFT, etc. */
export function parseClustal(input: string | Uint8Array): SeqRecord[] {
  const aln = new Alignment();
  let seenFirst = false;
  for (const line of toLines(input)) {
    // Blank lines separate blocks; a conservation line is indented (no name in column 0).
    if (isBlank(line) || /^\s/.test(line)) continue;
    if (!seenFirst) {
      seenFirst = true;
      // The program banner is the first line; every aligner emits its own. Skip it — the
      // block guard below also rejects a banner's prose token, so this is belt-and-braces.
      if (
        /multiple (sequence )?alignment/i.test(line) ||
        /^(CLUSTAL|MUSCLE|MAFFT|T-?COFFEE|PROBCONS|KALIGN|MVIEW|PROMALS)/i.test(line)
      ) {
        continue;
      }
    }
    const m = /^(\S+)\s+(\S+)/.exec(line); // name + one block (trailing coordinate columns ignored)
    if (m && ALIGN_BLOCK.test(m[2])) aln.add(m[1], m[2]);
  }
  return aln.toRecords();
}

/** Read a Stockholm (`.sto`/`.stk`) alignment; multiple `//`-separated alignments are all returned. */
export function parseStockholm(input: string | Uint8Array): SeqRecord[] {
  const records: SeqRecord[] = [];
  let aln = new Alignment();
  for (const line of toLines(input)) {
    if (line.startsWith('//')) {
      records.push(...aln.toRecords());
      aln = new Alignment();
      continue;
    }
    // '#' lines are the header and #=GF/#=GC/#=GR/#=GS markup — not sequence rows.
    if (isBlank(line) || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(\S+)/.exec(line);
    if (m) aln.add(m[1], m[2]);
  }
  records.push(...aln.toRecords());
  return records;
}

/**
 * Read a PHYLIP (`.phy`) alignment. Supports relaxed (whitespace-delimited names) interleaved
 * and single-block layouts — the common modern output (RAxML/PhyML/aligners). The first line is
 * `<ntax> <nchar>`; the next `ntax` non-blank lines carry names + the first block; any further
 * non-blank lines are interleaved continuation, appended round-robin and clipped at `nchar` so a
 * stray line can't overrun residues into another taxon.
 *
 * Limitation: multi-line *sequential* PHYLIP (each taxon's whole sequence spanning consecutive
 * lines before the next taxon) is read as interleaved and would be misassigned; it is rare next to
 * interleaved output. Single-line sequential (one line per taxon) reads correctly.
 */
export function parsePhylip(input: string | Uint8Array): SeqRecord[] {
  const lines = toLines(input);
  let i = 0;
  while (i < lines.length && isBlank(lines[i])) i++;
  const header = (lines[i] ?? '').trim().split(/\s+/);
  const ntax = Number.parseInt(header[0] ?? '', 10);
  const nchar = Number.parseInt(header[1] ?? '', 10);
  if (!Number.isFinite(ntax) || ntax <= 0) return []; // no "<ntax> <nchar>" header — not PHYLIP
  i++;

  const names: string[] = [];
  const rows: string[] = [];
  for (; i < lines.length && names.length < ntax; i++) {
    if (isBlank(lines[i])) continue;
    const m = /^(\S+)\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    names.push(m[1]);
    rows.push(m[2].replace(/\s+/g, ''));
  }
  const nt = names.length;
  if (nt === 0) return [];

  // Remaining non-blank lines: interleaved continuation, appended round-robin. Bound each row
  // at nchar (when known) so a stray/sequential line can't overrun residues into another taxon.
  const cap = Number.isFinite(nchar) && nchar > 0 ? nchar : Number.POSITIVE_INFINITY;
  for (let k = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    const idx = k % nt;
    if (rows[idx].length < cap) rows[idx] += lines[i].replace(/\s+/g, '');
    k++;
  }
  return names.map((name, idx) =>
    makeSeqRecord(name, '', cap === Number.POSITIVE_INFINITY ? rows[idx] : rows[idx].slice(0, cap)),
  );
}

/**
 * Read a NEXUS (`.nex`) DATA/CHARACTERS block's MATRIX. Handles interleaved matrices (names
 * repeat across blocks), space-grouped rows, and a final row that closes the matrix with `;`.
 *
 * Not resolved (kept verbatim / unsupported): `FORMAT MATCHCHAR=.` — a `.` meaning "same residue
 * as the first taxon here" is left literal rather than substituted; and label-less matrices
 * (`FORMAT LABELS=NO`, relying on TAXLABELS order) whose rows carry no name are skipped.
 */
export function parseNexus(input: string | Uint8Array): SeqRecord[] {
  const text = decodeText(input).replace(/\[[^\]]*\]/g, ''); // drop [ … ] comments (may be inline)
  const aln = new Alignment();
  let inMatrix = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!inMatrix) {
      if (/^\s*matrix\b/i.test(line)) inMatrix = true; // the MATRIX keyword opens the data
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === ';') break; // MATRIX ends at a ';'
    if (isBlank(trimmed)) continue;
    const endsMatrix = trimmed.endsWith(';');
    const data = endsMatrix ? trimmed.slice(0, -1).trim() : trimmed;
    // name + the REST of the row (residues may be space-grouped), unquoting a 'quoted name'.
    const m = /^("[^"]+"|'[^']+'|\S+)\s+(.+)$/.exec(data);
    if (m) aln.add(m[1].replace(/^['"]|['"]$/g, ''), m[2].replace(/\s+/g, ''));
    if (endsMatrix) break;
  }
  return aln.toRecords();
}

/** Read a GCG/MSF (`.msf`) alignment (the sequence blocks after the header's `//`). */
export function parseMsf(input: string | Uint8Array): SeqRecord[] {
  const aln = new Alignment();
  let inSeq = false;
  for (const line of toLines(input)) {
    if (!inSeq) {
      if (line.trimStart().startsWith('//')) inSeq = true; // '//' separates header from sequence
      continue;
    }
    if (isBlank(line)) continue;
    const m = /^\s*(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const residues = m[2].replace(/\s+/g, ''); // space-grouped residues (gaps '.'/'~' kept)
    // Skip the position rulers / coordinate lines GCG & GeneDoc interleave between blocks
    // ("        1        50"): they carry digits, which real residue runs never do. This stays
    // lenient (every genuine row is kept, even if the header's Name: labels were truncated) while
    // dropping the only systematic noise. (A row's name IS allowed to contain digits — only the
    // residue field is guarded.)
    if (/\d/.test(residues)) continue;
    aln.add(m[1], residues);
  }
  return aln.toRecords();
}
