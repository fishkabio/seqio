/**
 * FASTA / FASTQ / .qual text serialization.
 *
 * Pure, format-level writers: they turn a sequence plus optional per-base Phred
 * quality into text. No coupling to any binary format — callers build records
 * from ABIF basecalls (PBAS/PCON), alignments, consensus, etc.
 *
 * Quality is encoded as Phred+33 (Sanger / Illumina 1.8+). Scores are clamped
 * to [0, {@link MAX_PHRED}]: the upper bound is the largest value representable
 * as Phred+33 ('~' = ASCII 126 = 93 + 33). Callers must NOT feed quality for
 * reads that lack it — gate on {@link hasUsableQuality} and emit FASTA only,
 * rather than letting the 255 "no quality" sentinel clamp to a perfect '~'.
 */

/** Largest Phred score representable as Phred+33 ('~' = ASCII 126 = 93 + 33). */
export const MAX_PHRED = 93;

const PHRED_OFFSET = 33;
const DEFAULT_LINE_WIDTH = 60;
const NO_QUALITY = 255;

/** A FASTA record: identifier, optional description, and residues. */
export interface FastaRecord {
  /** Identifier written after '>', up to the first space. */
  id: string;
  /** Optional free text after the id on the header line. */
  description?: string;
  /** Residues, written verbatim (case and gaps preserved). */
  sequence: string;
}

/** A FASTQ record: a {@link FastaRecord} plus one Phred score per residue. */
export interface FastqRecord extends FastaRecord {
  /** Per-base Phred scores; must be one per residue in {@link FastaRecord.sequence}. */
  qualities: readonly number[];
}

/** A .qual record: identifier, optional description, and per-base Phred scores. */
export interface QualRecord {
  id: string;
  description?: string;
  qualities: readonly number[];
}

/** Line-wrapping shared by the FASTA and .qual writers. */
export interface WrapOptions {
  /** Residues (FASTA) or scores (.qual) per line; <= 0 writes one line. Default 60. */
  lineWidth?: number;
}

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
