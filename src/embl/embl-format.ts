/**
 * EMBL / Swiss-Prot (UniProtKB) flat-file reader — sequence extraction only.
 *
 * Both formats share one container: two-letter line-type codes in columns 0–1, an `SQ`
 * line that introduces the sequence, indented sequence lines (residues + trailing position
 * counters), and `//` between records. UniProtKB is historically derived from the EMBL
 * format, so a single scanner serves both; they differ only in which field is the id:
 *   - EMBL: the `ID` line's accession, suffixed with the sequence version (`SV n` → `.n`),
 *     falling back to `AC`.
 *   - Swiss-Prot: the primary `AC` accession (the `ID` line is the entry name), falling
 *     back to that entry name.
 * Description comes from the `DE` line(s), joined. Feature tables (`FT`) and all other codes
 * are skipped — this is the sequence-reading path only.
 *
 * Deliberately lenient (see AGENTS.md): never throws. No `SQ` block → empty sequence; a
 * missing `//` between records flushes the previous one when the next `ID` appears; a
 * truncated final record is flushed at EOF. Residue case is preserved as written.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { firstToken, stripWhitespace, toLines } from '../text';

type IdPolicy = 'embl' | 'swissprot';

/** Read EMBL flat files (`.embl`/`.dat`): id = accession.version from the ID line. */
export function parseEmbl(input: string | Uint8Array): SeqRecord[] {
  return parseEmblStyle(input, 'embl');
}

/** Read UniProtKB/Swiss-Prot flat files (`.dat`/`.txt`): id = primary AC accession. */
export function parseSwissprot(input: string | Uint8Array): SeqRecord[] {
  return parseEmblStyle(input, 'swissprot');
}

function parseEmblStyle(input: string | Uint8Array, policy: IdPolicy): SeqRecord[] {
  const lines = toLines(input);
  const records: SeqRecord[] = [];

  let started = false;
  let idLine = '';
  let ac = '';
  let de: string[] = [];
  let seq: string[] = [];
  let mode: 'header' | 'sequence' = 'header';

  const flush = (): void => {
    if (!started) return;
    records.push(makeSeqRecord(chooseId(policy, idLine, ac), de.join(' ').trim(), stripWhitespace(seq.join(''))));
    started = false;
    idLine = '';
    ac = '';
    de = [];
    seq = [];
    mode = 'header';
  };

  for (const line of lines) {
    if (line.startsWith('//')) {
      flush();
      continue;
    }
    if (mode === 'sequence') {
      // Indented (or blank) lines are sequence data; a code line ends the block, re-handled below.
      if (line.length === 0 || /^\s/.test(line)) {
        seq.push(line.replace(/[\s\d]/g, '')); // drop column spacing and the trailing position counter
        continue;
      }
      mode = 'header';
    }

    const code = line.slice(0, 2);
    if (code === 'ID') {
      if (started) flush(); // next record without a preceding '//'
      started = true;
      idLine = line.slice(2).trim();
    } else if (code === 'AC') {
      if (!ac) ac = line.slice(2).split(';')[0].trim(); // primary accession (first of a ';'-list)
      started = true;
    } else if (code === 'DE') {
      de.push(line.slice(2).trim());
      started = true;
    } else if (code === 'SQ') {
      mode = 'sequence';
      started = true;
    }
    // XX / FH / FT / OS / RN … — not needed for sequence extraction
  }
  flush();
  return records;
}

/** Pick the record id per format: EMBL accession.version from the ID line, or Swiss-Prot's AC. */
function chooseId(policy: IdPolicy, idLine: string, ac: string): string {
  if (policy === 'swissprot') return ac || firstToken(idLine);
  // EMBL ID line: "X56734; SV 1; linear; mRNA; STD; PLN; 1859 BP." (modern) or
  // "AB000263 standard; RNA; PRI; 368 BP." (old). Accession is the first token; SV is the
  // sequence version, appended as ".n" to match the accession.version convention.
  const parts = idLine.split(';');
  const acc = firstToken(parts[0]);
  let sv = '';
  for (const part of parts) {
    const m = /^\s*SV\s+(\d+)/.exec(part);
    if (m) sv = m[1];
  }
  return (sv ? `${acc}.${sv}` : acc) || ac;
}
