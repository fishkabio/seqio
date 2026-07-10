/**
 * GenBank / GenPept flat-file reader — sequence extraction only.
 *
 * Reads the sequence(s) and their identity out of GenBank flat files (`.gb`/`.gbk`/`.gbff`,
 * and the protein `.gp` variant). One file may hold many records, each ending in `//`. We
 * take what a "pick a sequence" caller needs and skip the rest:
 *   - id: VERSION (accession.version) if present, else ACCESSION, else the LOCUS name.
 *   - description: DEFINITION (its continuation lines joined).
 *   - sequence: the ORIGIN block, with the leading base counters and spacing stripped.
 * Feature-table parsing (locations, /translation, join/complement) is intentionally out of
 * scope here — this is the sequence-reading path, not a full annotation model.
 *
 * Deliberately lenient (see AGENTS.md): never throws. A record with no ORIGIN yields an
 * empty sequence rather than an error; a missing `//` between records (or a truncated final
 * record) still yields every record whose LOCUS was seen. Sequence case is preserved as
 * written (GenBank ORIGIN is conventionally lowercase).
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { firstToken, stripWhitespace, toLines } from '../text';

/** A top-level GenBank keyword: starts in column 0 (letters/digits), unlike indented lines. */
const KEYWORD = /^([A-Za-z][A-Za-z0-9_]*)/;

export function parseGenbank(input: string | Uint8Array): SeqRecord[] {
  const lines = toLines(input);
  const records: SeqRecord[] = [];

  let started = false;
  let locus = '';
  let accession = '';
  let version = '';
  let definition: string[] = [];
  let seq: string[] = [];
  let mode: 'header' | 'definition' | 'origin' = 'header';

  const flush = (): void => {
    if (!started) return;
    const id = version || accession || locus;
    records.push(makeSeqRecord(id, definition.join(' ').trim(), stripWhitespace(seq.join(''))));
    started = false;
    locus = accession = version = '';
    definition = [];
    seq = [];
    mode = 'header';
  };

  for (const line of lines) {
    if (line.startsWith('//')) {
      flush();
      continue;
    }
    const isKeyword = line.length > 0 && !/^\s/.test(line);

    if (mode === 'origin') {
      if (isKeyword)
        mode = 'header'; // a keyword ends the ORIGIN block; handle it below
      else {
        seq.push(line.replace(/[\s\d]/g, '')); // drop the position counter and column spacing
        continue;
      }
    }
    if (mode === 'definition' && !isKeyword) {
      definition.push(line.trim()); // DEFINITION continues onto indented lines
      continue;
    }
    if (!isKeyword) continue; // an indented line we don't collect (feature qualifiers, etc.)

    const key = (KEYWORD.exec(line)?.[1] ?? '').toUpperCase();
    const value = line.slice(key.length).trim();
    if (key === 'LOCUS' && started) flush(); // next record without a preceding '//'
    started = true;
    mode = 'header';
    if (key === 'LOCUS') locus = firstToken(value);
    else if (key === 'ACCESSION') accession = firstToken(value);
    else if (key === 'VERSION') version = firstToken(value);
    else if (key === 'DEFINITION') {
      definition = [value];
      mode = 'definition';
    } else if (key === 'ORIGIN') mode = 'origin';
  }
  flush();
  return records;
}
