/**
 * Content-based file-format detection.
 *
 * Sniffs the bytes, never the file extension: binary magic first (ABIF at offset 0, or at
 * 128 behind a MacBinary preamble; SCF's ".scf" magic), then the first non-blank line for
 * the text formats. Text signatures are matched on the leading line's content (a keyword
 * like `LOCUS`, or the first character `>` / `;` / `@`), so a mislabeled or extension-less
 * file still resolves.
 */

import { decodeText } from './text';

/** A format {@link detectFormat} can recognize. Some are detected before their reader ships. */
export type SeqFileFormat =
  | 'abif'
  | 'scf'
  | 'fasta'
  | 'fastq'
  | 'genbank'
  | 'embl'
  | 'swissprot'
  | 'clustal'
  | 'stockholm'
  | 'phylip'
  | 'nexus'
  | 'msf'
  | 'pir'
  | 'gff'
  | 'sam'
  | 'bam'
  | 'gfa'
  | 'unknown';

/** MacBinary preamble length: an ABIF may sit 128 bytes into the file behind one. */
const MACBINARY_OFFSET = 128;

/** Only the file's start matters for detection; decode at most this many bytes. */
const SNIFF_BYTES = 8192;

/**
 * Detect the sequencing file format from its content. Returns 'unknown' when no signature
 * matches (empty input, or a leading line that is neither a known magic nor a recognized
 * text marker).
 */
export function detectFormat(bytes: Uint8Array): SeqFileFormat {
  if (hasAscii(bytes, 0, 'ABIF') || hasAscii(bytes, MACBINARY_OFFSET, 'ABIF')) return 'abif';
  if (hasAscii(bytes, 0, '.scf')) return 'scf';
  // BAM's magic is "BAM\1". On disk a BAM is BGZF-compressed (starts with the gzip magic 1f 8b), so
  // this matches only once that wrapper has been inflated — the caller peels gzip before detecting.
  if (hasAscii(bytes, 0, 'BAM\x01')) return 'bam';
  const line = firstNonBlankLine(bytes);
  return line === undefined ? 'unknown' : detectFromLine(line);
}

/** Classify a text file from its first non-blank line (leading whitespace ignored). */
function detectFromLine(raw: string): SeqFileFormat {
  const line = raw.trimStart();
  if (/^LOCUS\s/.test(line)) return 'genbank';
  // EMBL and Swiss-Prot both open with an "ID" line; Swiss-Prot's ends in "… NN AA." and
  // carries the Reviewed/Unreviewed status, whereas EMBL's ends in "… NN BP."
  if (/^ID\s/.test(line)) return /(Reviewed|Unreviewed);| AA\.\s*$/.test(line) ? 'swissprot' : 'embl';
  // Alignment formats — each names itself on the first line, except PHYLIP (a "<ntax> <nchar>" line).
  if (/^#\s*STOCKHOLM/i.test(line)) return 'stockholm';
  if (/^#NEXUS/i.test(line)) return 'nexus';
  // Clustal-format alignments carry a program banner: Clustal itself, or MUSCLE/MAFFT/… which
  // emit the same layout. The generic "multiple sequence alignment" phrase is guarded against a
  // '>'/'@' sequence header that merely mentions it.
  if (/^(CLUSTAL|MUSCLE|MAFFT|T-?COFFEE|PROBCONS|KALIGN|MVIEW|PROMALS)\b/i.test(line)) return 'clustal';
  if (/multiple (sequence )?alignment/i.test(line) && !/^[>@#]/.test(line)) return 'clustal';
  if (/^!!(NA|AA)_MULTIPLE_ALIGNMENT/i.test(line) || /\bMSF:\s*\d/.test(line)) return 'msf';
  if (/^\d+\s+\d+\s*$/.test(line)) return 'phylip';
  if (/^##gff-version/i.test(line)) return 'gff';
  // GFA (assembly graph): the version header (an `H` line carrying `VN:Z:1.x`/`2.x`, in any tag
  // position), or a headerless file that opens on a Segment line `S\t<name>\t…` (see below).
  if (/^H\t(?:[^\t]*\t)*VN:Z:[12]\./.test(line)) return 'gfa';
  // SAM: `@`-prefixed header whose tag is a known two-letter record type + TAB — distinct from a
  // FASTQ read id (which also starts with '@'), so this must precede the '@' → fastq rule below.
  if (/^@(HD|SQ|RG|PG|CO)\t/.test(line)) return 'sam';
  // PIR/NBRF headers are '>XX;id' with a specific two-letter type code — matched before the
  // bare '>' → FASTA rule so a PIR file isn't taken for FASTA.
  if (/^>(P1|F1|DL|DC|RL|RC|N1|N3|XX);/i.test(line)) return 'pir';
  switch (line.charCodeAt(0)) {
    case 0x3e: // '>'
    case 0x3b: // ';' — legacy Pearson FASTA comment line
      return 'fasta';
    case 0x40: // '@'
      return 'fastq';
  }
  // Headerless variants, checked last (their signatures are structural, not a leading marker). SAM
  // first: it's the stricter check (11 mandatory fields), so a SAM record whose QNAME happens to be
  // "S" isn't misread as a GFA segment line (which is only 3 fields).
  if (isSamRecord(line)) return 'sam';
  if (/^S\t[!-~]+\t/.test(line)) return 'gfa'; // GFA segment line
  return 'unknown';
}

/**
 * Whether a line is a headerless SAM alignment record: at least the 11 mandatory tab fields, with
 * FLAG/POS/MAPQ integer and a valid CIGAR (`*` or runs of <len><op>). This structural check keeps a
 * generic TSV from being mistaken for SAM.
 */
function isSamRecord(line: string): boolean {
  const f = line.split('\t');
  if (f.length < 11) return false;
  const [, flag, , pos, mapq, cigar] = f;
  return /^\d+$/.test(flag) && /^\d+$/.test(pos) && /^\d+$/.test(mapq) && /^(\*|(\d+[MIDNSHPX=])+)$/.test(cigar);
}

/** The first non-blank line within the sniff window, or undefined if there is none. */
function firstNonBlankLine(bytes: Uint8Array): string | undefined {
  const head = bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes;
  for (const line of decodeText(head).split(/\r\n|\r|\n/)) {
    if (line.trim().length > 0) return line;
  }
  return undefined;
}

/** Whether `magic` (ASCII) appears verbatim at `offset`. */
function hasAscii(bytes: Uint8Array, offset: number, magic: string): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}
