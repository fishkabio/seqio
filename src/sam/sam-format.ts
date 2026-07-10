/**
 * SAM (`.sam`) reader — read-sequence extraction.
 *
 * SAM is a read-alignment format: one record per alignment, tab-delimited, with 11 mandatory
 * fields (QNAME FLAG RNAME POS MAPQ CIGAR RNEXT PNEXT TLEN SEQ QUAL). This reader returns each
 * record's read sequence — field 10, `SEQ`. Records whose SEQ is `*` (sequence not stored) are
 * skipped: there's nothing to pick.
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
import { isSecondaryOrSupplementary, locusHint, mateId } from './common';

export function parseSam(input: string | Uint8Array): SeqRecord[] {
  const records: SeqRecord[] = [];
  for (const line of toLines(input)) {
    if (line.length === 0 || line.charCodeAt(0) === 0x40) continue; // '@' header / blank
    const f = line.split('\t');
    if (f.length < 11) continue;
    const seq = f[9];
    if (!seq || seq === '*') continue;
    const flag = int(f[1]);
    if (isSecondaryOrSupplementary(flag)) continue; // one sequence per read
    records.push(makeSeqRecord(mateId(f[0], flag), locusHint(f[2], int(f[3]), flag), seq));
  }
  return records;
}

function int(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
