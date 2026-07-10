/**
 * GFA (Graphical Fragment Assembly, `.gfa`) reader — sequence extraction.
 *
 * Assembly / pangenome graphs. Only Segment (`S`) lines carry sequence; links, paths, jumps and
 * containments are graph topology and hold none. Both dialects are supported by field position:
 *
 *   GFA1:  S <name> <sequence> [tags…]
 *   GFA2:  S <sid>  <slen>     <sequence> [tags…]
 *
 * GFA2 inserts an integer segment length between the name and the sequence, so when the field after
 * the name is a bare integer AND another field follows, the sequence is that next field; otherwise
 * it's the field right after the name (GFA1). A `*` sequence (a segment declared without residues)
 * is skipped — there's nothing to pick. Lenient: never throws; malformed lines are ignored.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { toLines } from '../text';

export function parseGfa(input: string | Uint8Array): SeqRecord[] {
  const records: SeqRecord[] = [];
  for (const line of toLines(input)) {
    // Segment lines only: 'S' followed by a tab.
    if (line.charCodeAt(0) !== 0x53 || line.charCodeAt(1) !== 0x09) continue;
    const f = line.split('\t');
    const name = f[1];
    if (!name) continue;
    // GFA2 puts an integer length between name and sequence; GFA1 puts the sequence there.
    const seq = /^\d+$/.test(f[2] ?? '') && f[3] !== undefined ? f[3] : f[2];
    if (!seq || seq === '*') continue;
    records.push(makeSeqRecord(name, '', seq));
  }
  return records;
}
