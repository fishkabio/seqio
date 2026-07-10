/**
 * GFF3 (`.gff`/`.gff3`) reader — sequence extraction.
 *
 * A GFF3 file is annotation (feature coordinates), which carries NO sequence — except when it
 * embeds a FASTA section after a `##FASTA` directive. This reader returns the records of that
 * embedded FASTA and nothing else; a GFF with no `##FASTA` section yields `[]` (there is no
 * sequence to pick). Feature lines are never turned into sequence.
 */

import { parseFasta } from '../fastx';
import { SeqRecord } from '../seq-record';
import { toLines } from '../text';

export function parseGff(input: string | Uint8Array): SeqRecord[] {
  const lines = toLines(input);
  const fastaAt = lines.findIndex(line => /^##FASTA\s*$/i.test(line.trim()));
  if (fastaAt < 0) return []; // annotation only — no embedded sequence
  return parseFasta(lines.slice(fastaAt + 1).join('\n'));
}
