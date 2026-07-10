/**
 * SAM (`.sam`) reader — read-sequence extraction.
 *
 * SAM is a read-alignment format: one record per alignment, tab-delimited, with 11 mandatory
 * fields (QNAME FLAG RNAME POS MAPQ CIGAR RNEXT PNEXT TLEN SEQ QUAL). This reader returns each
 * record's read sequence — field 10, `SEQ`. Records whose SEQ is `*` (sequence not stored, common
 * for secondary/supplementary alignments) are skipped: there's nothing to pick.
 *
 * The sequence is returned VERBATIM as written. For a reverse-strand alignment (FLAG bit 0x10) SAM
 * already stores the reverse complement (reference-forward orientation), so that reference-oriented
 * sequence is what you get — it is deliberately not un-flipped to the original read orientation.
 *
 * One sequence per read: secondary (FLAG 0x100) and supplementary (0x800) alignments are skipped —
 * they re-map the same read (a duplicate, or a hard-clipped split fragment), which would pollute a
 * "pick the sequences" list. What's kept is the read's SEQ from its primary (or unmapped) record —
 * i.e. the sequence as SAM stores it, which for a hard-clipped primary alignment omits the clipped
 * flanks rather than reconstructing the original full read.
 *
 * `@`-prefixed lines are skipped as headers — the SAM spec's QNAME charset `[!-?A-~]` excludes '@'
 * (0x40) precisely so a read name can never be confused with a header. Lenient: never throws; lines
 * with fewer than 11 fields are ignored rather than rejected.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { toLines } from '../text';

const FLAG_PAIRED = 0x1;
const FLAG_UNMAPPED = 0x4;
const FLAG_REVERSE = 0x10;
const FLAG_FIRST = 0x40;
const FLAG_LAST = 0x80;
const FLAG_SECONDARY = 0x100;
const FLAG_SUPPLEMENTARY = 0x800;

export function parseSam(input: string | Uint8Array): SeqRecord[] {
  const records: SeqRecord[] = [];
  for (const line of toLines(input)) {
    if (line.length === 0 || line.charCodeAt(0) === 0x40) continue; // '@' header / blank
    const f = line.split('\t');
    if (f.length < 11) continue;
    const seq = f[9];
    if (!seq || seq === '*') continue;
    if (int(f[1]) & (FLAG_SECONDARY | FLAG_SUPPLEMENTARY)) continue; // one sequence per read
    records.push(makeSeqRecord(readId(f), locus(f), seq));
  }
  return records;
}

/** QNAME, plus a /1 or /2 mate suffix for paired reads so both mates of a pair stay distinct. */
function readId(f: string[]): string {
  const qname = f[0];
  const flag = int(f[1]);
  if (flag & FLAG_PAIRED) {
    if (flag & FLAG_FIRST) return `${qname}/1`;
    if (flag & FLAG_LAST) return `${qname}/2`;
  }
  return qname;
}

/** Short mapping hint for the description: "RNAME:POS (+/-)" when mapped, else "unmapped". */
function locus(f: string[]): string {
  const flag = int(f[1]);
  const rname = f[2];
  if (flag & FLAG_UNMAPPED || rname === '*' || !rname) return 'unmapped';
  return `${rname}:${f[3]} (${flag & FLAG_REVERSE ? '-' : '+'})`;
}

function int(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
