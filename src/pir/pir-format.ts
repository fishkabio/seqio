/**
 * PIR / NBRF (`.pir`) reader — sequence extraction.
 *
 * A PIR record is: a header `>XX;identifier` (the two-letter code XX is the sequence type —
 * P1/F1 protein, DL/DC DNA, RL/RC RNA, N1/N3 nucleotide, XX other), a free-text title line,
 * then the residues, terminated by `*`. One file may hold many records.
 *   - id: the identifier after the `;` (or the whole header when there is no `;`).
 *   - description: the title line.
 *   - sequence: the residues with spacing removed and the single trailing `*` terminator dropped.
 *
 * Deliberately lenient (see AGENTS.md): never throws; a truncated record (no `*`) keeps its
 * residues; the first line after a header is taken as the title.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { stripWhitespace, toLines } from '../text';

export function parsePir(input: string | Uint8Array): SeqRecord[] {
  const records: SeqRecord[] = [];
  let id: string | undefined;
  let description = '';
  let seq: string[] = [];
  let awaitingTitle = false;

  const flush = (): void => {
    if (id === undefined) return;
    let sequence = stripWhitespace(seq.join(''));
    if (sequence.endsWith('*')) sequence = sequence.slice(0, -1); // drop the PIR terminator
    records.push(makeSeqRecord(id, description, sequence));
    id = undefined;
    description = '';
    seq = [];
    awaitingTitle = false;
  };

  for (const line of toLines(input)) {
    if (line.startsWith('>')) {
      flush();
      const header = line.slice(1);
      const semi = header.indexOf(';');
      id = (semi >= 0 ? header.slice(semi + 1) : header).trim();
      awaitingTitle = true;
    } else if (id === undefined) {
      continue; // stray text before the first header
    } else if (awaitingTitle) {
      description = line.trim(); // the line right after the header is the title
      awaitingTitle = false;
    } else {
      seq.push(line);
    }
  }
  flush();
  return records;
}
