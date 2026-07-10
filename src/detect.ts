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
  | 'mega'
  | 'pir'
  | 'gff'
  | 'sam'
  | 'bam'
  | 'gfa'
  | 'pdb'
  | 'ace'
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
  if (line === undefined) return 'unknown';
  const detected = detectFromLine(line);
  // GCG/MSF permits free descriptive text (and GeneDoc `GDC` blocks) before its header, so the
  // signature isn't always on the first line — scan the window for the strong MSF signature. It wins
  // over an 'unknown' first line, and over a 'clustal' guess that came ONLY from the generic
  // "multiple sequence alignment" phrase (which an MSF preamble can carry) — but never over an
  // explicit CLUSTAL/MUSCLE/… banner or any other definite first-line format.
  const weakClustal = detected === 'clustal' && !CLUSTAL_BANNER.test(line.trimStart());
  if ((detected === 'unknown' || weakClustal) && hasMsfHeader(bytes)) return 'msf';
  // A PDB file's first line isn't always the classifiable one: a bare `MODEL` (no serial), an
  // I-TASSER-style `HEADER protein` (single space), or leading REMARK/METHOD prose all fall through
  // to 'unknown' on line 1. Scan the window for a definitive coordinate/SEQRES record instead.
  if (detected === 'unknown' && hasPdbSignal(bytes)) return 'pdb';
  // A GFF3 file exported without the leading `##gff-version` pragma still marks its embedded
  // sequence with a `##FASTA` directive followed by FASTA records. Requiring the `>` record after
  // the directive (not the bare `##FASTA` line, which a README/report could carry) keeps this safe
  // and aligns detection with parseability — the sequence lives only in that section.
  if (detected === 'unknown' && hasGffFastaSection(bytes)) return 'gff';
  return detected;
}

/** Whether the sniff window has a GFF3 `##FASTA` directive LINE followed by a `>` FASTA record. */
function hasGffFastaSection(bytes: Uint8Array): boolean {
  const head = bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes;
  // Anchor the directive to its own line (`$`) so a prose "##FASTA is an example" can't match; then
  // require an actual FASTA record (`^>`) somewhere after it.
  return /^##FASTA[ \t]*$[\s\S]*?^>/m.test(decodeText(head));
}

/** Whether the sniff window carries a definitive PDB coordinate/sequence record. */
function hasPdbSignal(bytes: Uint8Array): boolean {
  const head = bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes;
  const text = decodeText(head);
  // Match the *structure* PDB records carry, not just the keyword — so a prose/log line that merely
  // begins with "ATOM 1 …" or "CRYST1 …" can't trip detection (per review). Each pattern requires
  // fields that only a real record has:
  //   ATOM/HETATM — serial, then the x/y/z coordinate triplet (three `%8.3f` floats);
  //   SEQRES      — serNum, a single-char chain id, numRes, then a residue code;
  //   CRYST1      — the three unit-cell edge lengths (floats).
  // Inter-field spacing is `[ \t]` (never `\s`, which would let a match span a line boundary on
  // malformed input) so each signature stays strictly within one line.
  const coord = /-?\d+\.\d{3}/.source;
  const atom = new RegExp(`^(ATOM|HETATM)[ \\t]+\\d+[ \\t].*[ \\t]${coord}[ \\t]+${coord}[ \\t]+${coord}`, 'm');
  // SEQRES: serNum, an OPTIONAL single-char chain id (PDB allows a blank chain — don't require a
  // non-space token, or single-chain files are missed), numRes, then a residue code.
  const seqres = /^SEQRES[ \t]+\d+[ \t]+(?:\S[ \t]+)?\d+[ \t]+[A-Za-z]/m;
  const cryst1 = /^CRYST1[ \t]+\d+\.\d+[ \t]+\d+\.\d+[ \t]+\d+\.\d+/m;
  return atom.test(text) || seqres.test(text) || cryst1.test(text);
}

/** Whether the sniff window looks like a GCG/MSF file. */
function hasMsfHeader(bytes: Uint8Array): boolean {
  const head = bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes;
  const text = decodeText(head);
  // Canonical header line ("… MSF: <len> … Check: <n> ..") backed by a Name:/Len: declaration, OR —
  // for files whose "MSF:" line is missing/mangled — a full GCG name declaration
  // ("Name: <id> Len: <n> Check: <n> Weight:"), a pattern unique to MSF/GCG (so it's a safe
  // signature on its own; a garbage file with a bare "Name:HBB_HUMAN" won't match it).
  const headerLine = /\bMSF:\s*\d+\b[^\n]*\bCheck:\s*\d/.test(text) && /^\s*Name:\s+.*\bLen:\s*\d/im.test(text);
  const nameDecl = /^\s*Name:\s+\S+\s+Len:\s*\d+\s+Check:\s*\d+\s+Weight:/im.test(text);
  return headerLine || nameDecl;
}

/** Program banners that head a Clustal-format alignment (Clustal and the tools that emit its layout). */
const CLUSTAL_BANNER = /^(CLUSTAL|MUSCLE|MAFFT|T-?COFFEE|PROBCONS|KALIGN|MVIEW|PROMALS)\b/i;

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
  if (/^#mega\b/i.test(line)) return 'mega';
  // PDB: the HEADER record, or a coordinate file that opens on ATOM/HETATM/MODEL/CRYST1 (predicted
  // models & fragments often carry no HEADER/SEQRES — their sequence is read from the ATOM records).
  if (/^HEADER\s{2,}/.test(line)) return 'pdb';
  if (/^(ATOM|HETATM)\s+\d+\s/.test(line) || /^MODEL\s+\d/.test(line) || /^CRYST1\s/.test(line)) return 'pdb';
  // ACE assembly: the "AS <contigs> <reads>" header line.
  if (/^AS\s+\d+\s+\d+\s*$/.test(line)) return 'ace';
  // Clustal-format alignments carry a program banner: Clustal itself, or MUSCLE/MAFFT/… which
  // emit the same layout. The generic "multiple sequence alignment" phrase is guarded against a
  // '>'/'@' sequence header that merely mentions it.
  if (CLUSTAL_BANNER.test(line)) return 'clustal';
  // …but not the GeneDoc editor's own "Multiple Sequence Alignment Editor" banner, which heads GCG/MSF
  // files (they're detected as 'msf' via the header scan, not here).
  if (/multiple (sequence )?alignment/i.test(line) && !/^[>@#]/.test(line) && !/genedoc/i.test(line)) return 'clustal';
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
