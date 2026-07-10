/**
 * ACE (`.ace`) reader — assembly sequence extraction (Phrap/consed).
 *
 * An ACE file describes one or more contigs. Each contig is a `CO <name> <nBases> <nReads> …` line
 * followed by the consensus sequence (wrapped over several lines), then per-read records
 * `RD <readName> <nPaddedBases> …` each followed by that read's padded sequence. Other records
 * (`AS`, `BQ`, `QA`, `AF`, `BS`, `DS`, `WA`, `CT`, `RT`, …) carry qualities/metadata and are skipped.
 *
 * This reader returns every sequence it finds, in file order:
 *   - each contig consensus  → id `Contig<name>`, description `consensus`
 *   - each read              → id `<readName>`,   description `read`
 * The pad character `*` (an alignment gap in ACE) is kept verbatim — de-gapping is the caller's
 * choice.
 *
 * A `CO`/`RD` header declares the block's exact base count, so the sequence is accumulated until that
 * many residues are read (or a blank line ends it). This length-driven boundary — rather than
 * "stop at the next two-letter tag" — avoids swallowing a following record and avoids truncating at a
 * short residue line that merely looks like a tag (e.g. a line that is literally `BQ`/`CT`, both
 * valid residues). Deliberately lenient (see AGENTS.md): never throws; a truncated final block is kept.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { isBlank, stripWhitespace, toLines } from '../text';

export function parseAce(input: string | Uint8Array): SeqRecord[] {
  const records: SeqRecord[] = [];
  let kind: 'consensus' | 'read' | null = null;
  let id = '';
  let seq: string[] = [];
  let got = 0; // residues accumulated so far in the current block
  let expected = 0; // residue count the CO/RD header declared

  const flush = (): void => {
    // Skip an empty block (e.g. a declared count of 0) — nothing to record.
    if (kind && id && seq.length > 0) records.push(makeSeqRecord(id, kind, stripWhitespace(seq.join(''))));
    kind = null;
    id = '';
    seq = [];
    got = 0;
    expected = 0;
  };

  /** Start a new consensus/read block from a `CO`/`RD` header: `<tag> <name> <baseCount> …`. */
  const begin = (line: string, k: 'consensus' | 'read', label: (name: string) => string): void => {
    flush();
    const f = line.trim().split(/\s+/);
    kind = k;
    id = label(f[1] ?? '');
    // A full-integer base count bounds the block; anything else (missing/garbage) runs to a blank line.
    expected = /^\d+$/.test(f[2] ?? '') ? Number.parseInt(f[2], 10) : Number.POSITIVE_INFINITY;
  };

  for (const line of toLines(input)) {
    if (/^CO\s/.test(line)) {
      begin(line, 'consensus', name => `Contig${name}`); // CO <name> <nBases> <nReads> …
      continue;
    }
    if (/^RD\s/.test(line)) {
      begin(line, 'read', name => name); // RD <readName> <nPaddedBases> …
      continue;
    }
    if (kind === null) continue;
    if (isBlank(line) || got >= expected) {
      // A blank line ends the block early; `got >= expected` before consuming handles a 0-base block
      // (flush without swallowing the following metadata line).
      flush();
      continue;
    }
    const chunk = stripWhitespace(line); // residue line (may carry '*' pad gaps)
    seq.push(chunk);
    got += chunk.length;
    if (got >= expected) flush(); // reached the declared base count — block complete
  }
  flush();
  return records;
}
