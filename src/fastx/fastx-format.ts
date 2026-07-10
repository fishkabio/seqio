/**
 * FASTA / FASTQ / .qual text codec: readers (parseFasta / parseFastq) and writers
 * (formatFasta / formatFastq / formatQual).
 *
 * Text formats have no on-disk container, so there is no separate raw layer — this
 * one file is the codec (the `<family>-format.ts` analog of `abif-format.ts`).
 *
 * Data only: the readers keep residues and per-base Phred scores and drop cosmetic
 * formatting (line wrapping, blank lines, `\r\n` vs `\n`); the writers re-impose a
 * chosen wrap width. Quality is Phred+33 (Sanger / Illumina 1.8+); scores are clamped
 * to [0, {@link MAX_PHRED}] on write ('~' = ASCII 126 = 93 + 33).
 */

import { isBlank, stripWhitespace, toLines } from '../text';
import { FastaRecord, FastqRecord, QualRecord, WrapOptions } from './types';

/** Largest Phred score representable as Phred+33 ('~' = ASCII 126 = 93 + 33). */
export const MAX_PHRED = 93;

const PHRED_OFFSET = 33;
const DEFAULT_LINE_WIDTH = 60;
const NO_QUALITY = 255;

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * Parse FASTA text (or bytes) into records. Deliberately lenient — it never refuses a
 * file: blank lines and legacy ';' comment lines are ignored, residue lines are
 * concatenated with inner whitespace stripped (case and gaps preserved), and any stray
 * text before the first '>' header is skipped. id = the header up to the first
 * whitespace, description = the remainder.
 */
export function parseFasta(input: string | Uint8Array): FastaRecord[] {
  const lines = toLines(input);
  const records: FastaRecord[] = [];
  let header: string | undefined;
  let residues: string[] = [];
  const flush = (): void => {
    if (header !== undefined) records.push(makeFasta(header, residues.join('')));
  };
  for (const line of lines) {
    if (line[0] === '>') {
      flush();
      header = line.slice(1);
      residues = [];
    } else if (isBlank(line) || line[0] === ';') {
      // Blank separators and old-style ';' comment lines carry no residues.
      continue;
    } else if (header === undefined) {
      // Stray text before the first '>' header (BOM, junk): skip it, don't refuse the file.
      continue;
    } else {
      residues.push(line);
    }
  }
  flush();
  return records;
}

/**
 * Parse FASTQ text (or bytes) into records with decoded Phred+33 qualities.
 *
 * Handles multi-line records: the sequence runs to the '+' separator, then the quality
 * runs until it has as many chars as the sequence has residues. Length — not "the next
 * line starting with @" — terminates the quality block, because a quality character can
 * itself be '@' (Phred 31) or '+' (Phred 10); this is the one subtlety the spec calls
 * out (Cock et al. 2010).
 *
 * Deliberately lenient — it never refuses a file, and never lets one malformed record
 * cost a *following* one. A stray line where a '@' header is expected is skipped (resync
 * at the next '@'); a record with no '+' separator (truncated, or the next record starts)
 * keeps its sequence with unknown quality; a short/over-long or out-of-range quality is
 * reconciled to the residue count in {@link makeFastq}. The sequence — what callers
 * actually pick — is always preserved intact, for every record.
 *
 * Cross-record safety comes from recognizing a real next-record header structurally: a
 * line beginning '@' is the next header (not this record's quality) when a '+' separator
 * follows its sequence before any other '@' — see {@link startsRecord}. This is exact for
 * strict 4-line FASTQ (the real-world norm, where a quality line is followed only by the
 * next '@' header or EOF) and preserves every following record even when a quality block is
 * badly truncated. The one accepted blind spot is a deliberate trade-off: '@' and '+' are
 * both valid Phred+33 characters, so in *wrapped* multi-line quality a continuation line
 * that begins '@' and is later followed (before the next header) by one beginning '+' is
 * misread as a header. That pattern is vanishingly rare, and favoring "never drop the next
 * record's sequence on truncated input" over it is the right call for this parser's use.
 */
export function parseFastq(input: string | Uint8Array): FastqRecord[] {
  const lines = toLines(input);
  const records: FastqRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i]) || lines[i][0] !== '@') {
      // Blank line, or a stray/garbled line where a header is expected: skip and resync.
      i++;
      continue;
    }
    const header = lines[i].slice(1);
    i++;
    // Sequence: up to the '+' separator (may span multiple lines). Stop early at a '@'
    // too: residue lines never begin '@', so it means the '+' is missing and the next
    // record has started — don't swallow it.
    const seqParts: string[] = [];
    while (i < lines.length && lines[i][0] !== '+' && lines[i][0] !== '@') {
      seqParts.push(lines[i]);
      i++;
    }
    const sequence = stripWhitespace(seqParts.join(''));
    if (i >= lines.length || lines[i][0] === '@') {
      // No '+' separator: truncated final record, or the next record begins here. Keep
      // this sequence (quality unknown); the '@', if any, is re-read as the next header.
      records.push(makeFastq(header, sequence, ''));
      continue;
    }
    i++; // skip the '+' line (it may repeat the id; we do not require or check that)
    // Quality: accumulate until it matches the residue count. Whitespace-only wrap is
    // stripped (a real Phred+33 char is never a space/tab), so it never inflates the count.
    // A line beginning '@' that opens a well-formed record is the NEXT header even while
    // this quality is still short — hand it back rather than swallowing that record.
    let quality = '';
    while (i < lines.length && quality.length < sequence.length) {
      if (lines[i][0] === '@' && startsRecord(lines, i)) break;
      quality += stripWhitespace(lines[i]);
      i++;
    }
    records.push(makeFastq(header, sequence, quality));
  }
  return records;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/** Serialize one or more records to FASTA text (trailing newline included). */
export function formatFasta(records: FastaRecord | readonly FastaRecord[], options?: WrapOptions): string {
  const width = options?.lineWidth ?? DEFAULT_LINE_WIDTH;
  return toArray(records)
    .map(r => `${headerLine('>', r.id, r.description)}\n${wrapResidues(r.sequence, width)}`)
    .join('');
}

/** Serialize one or more records to FASTQ text, Phred+33 (trailing newline included). */
export function formatFastq(records: FastqRecord | readonly FastqRecord[]): string {
  return toArray(records).map(formatFastqRecord).join('');
}

/** Serialize one or more records to .qual text: space-separated Phred ints, wrapped. */
export function formatQual(records: QualRecord | readonly QualRecord[], options?: WrapOptions): string {
  const width = options?.lineWidth ?? DEFAULT_LINE_WIDTH;
  return toArray(records)
    .map(r => `${headerLine('>', r.id, r.description)}\n${wrapScores(r.qualities, width)}`)
    .join('');
}

/**
 * Report whether quality scores are present and usable. False for missing or
 * empty scores and for the all-255 sentinel (ABIF PCON uses 255 for "no
 * quality"), so a caller can offer FASTA only instead of inventing perfect Q.
 */
export function hasUsableQuality(qualities?: readonly number[]): boolean {
  return !!qualities && qualities.length > 0 && !qualities.every(q => q === NO_QUALITY);
}

// ---------------------------------------------------------------------------
// Internals — readers
// ---------------------------------------------------------------------------

/** Build a FASTA record from a raw header (sans '>') and joined residue text. */
function makeFasta(header: string, residues: string): FastaRecord {
  const { id, description } = splitHeader(header);
  const sequence = stripWhitespace(residues);
  return description === undefined ? { id, sequence } : { id, description, sequence };
}

/**
 * Build a FASTQ record, decoding quality to Phred scores reconciled to the residue
 * count: missing trailing quality (short / truncated line) reads as Phred 0, extra
 * quality chars are dropped, and bytes outside the printable Phred+33 range are clamped
 * into [0, MAX_PHRED]. Never throws — a malformed quality never costs the caller the
 * sequence.
 */
function makeFastq(header: string, sequence: string, quality: string): FastqRecord {
  const { id, description } = splitHeader(header);
  const qualities = new Array<number>(sequence.length);
  for (let k = 0; k < sequence.length; k++) {
    const code = k < quality.length ? quality.charCodeAt(k) : PHRED_OFFSET;
    qualities[k] = clampPhred(code - PHRED_OFFSET);
  }
  return description === undefined ? { id, sequence, qualities } : { id, description, sequence, qualities };
}

/** Split a header line (already stripped of its '>'/'@') into id and optional description. */
function splitHeader(header: string): { id: string; description?: string } {
  const trimmed = header.trim();
  const space = trimmed.search(/\s/);
  if (space < 0) return { id: trimmed };
  return { id: trimmed.slice(0, space), description: trimmed.slice(space + 1).trim() || undefined };
}

/**
 * Whether line `i` (already known to begin '@') opens a FASTQ record rather than being a
 * quality line that merely starts with '@'. True when a '+' separator follows its sequence
 * lines before the next '@' or EOF. Exact for strict 4-line FASTQ; for the rare wrapped-
 * quality blind spot this shares, see {@link parseFastq}.
 */
function startsRecord(lines: string[], i: number): boolean {
  let j = i + 1;
  while (j < lines.length && lines[j][0] !== '+' && lines[j][0] !== '@') j++;
  return lines[j]?.[0] === '+';
}

// ---------------------------------------------------------------------------
// Internals — writers
// ---------------------------------------------------------------------------

/** Build one FASTQ record; the '+' separator is left bare (no id repeat). */
function formatFastqRecord(record: FastqRecord): string {
  const { id, description, sequence, qualities } = record;
  if (qualities.length !== sequence.length) {
    throw new Error(`FASTQ ${id}: ${qualities.length} quality scores for ${sequence.length} bases`);
  }
  const quality = qualities.map(phredToChar).join('');
  return `${headerLine('@', id, description)}\n${sequence}\n+\n${quality}\n`;
}

/** Join id + optional description into a header line; reject embedded newlines. */
function headerLine(prefix: '>' | '@', id: string, description?: string): string {
  const name = description ? `${id} ${description}` : id;
  if (name.includes('\n')) {
    throw new Error('FASTX header must not contain a newline');
  }
  return prefix + name;
}

/** Wrap residues to `width` per line; an empty sequence yields no body line. */
function wrapResidues(sequence: string, width: number): string {
  if (sequence.length === 0) return '';
  if (width <= 0 || sequence.length <= width) return `${sequence}\n`;
  let out = '';
  for (let i = 0; i < sequence.length; i += width) {
    out += `${sequence.slice(i, i + width)}\n`;
  }
  return out;
}

/** Wrap clamped Phred ints to `width` per line, space-separated. */
function wrapScores(qualities: readonly number[], width: number): string {
  if (qualities.length === 0) return '';
  const values = qualities.map(clampPhred);
  const perLine = width <= 0 ? values.length : width;
  let out = '';
  for (let i = 0; i < values.length; i += perLine) {
    out += `${values.slice(i, i + perLine).join(' ')}\n`;
  }
  return out;
}

/** Round and clamp a score to the Phred+33 range [0, MAX_PHRED]. */
function clampPhred(q: number): number {
  const r = Math.round(q);
  return r < 0 ? 0 : r > MAX_PHRED ? MAX_PHRED : r;
}

/** Encode one Phred score as a Phred+33 ASCII character. */
function phredToChar(q: number): string {
  return String.fromCharCode(clampPhred(q) + PHRED_OFFSET);
}

/** Normalize a single record or array into a readonly array. */
function toArray<T>(value: T | readonly T[]): readonly T[] {
  // Array.isArray does not narrow readonly arrays, so cast the single-value branch.
  return Array.isArray(value) ? value : [value as T];
}
