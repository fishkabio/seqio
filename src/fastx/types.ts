/**
 * Record + option types for the FASTA / FASTQ / .qual family.
 *
 * These carry the sequence's data only — the residues and (FASTQ) the per-base
 * Phred scores. A file's line wrapping and newline style are cosmetic: the readers
 * discard them and the writers re-impose a chosen width. The same record shape is
 * used symmetrically for reading and writing, so parse → edit → write round-trips
 * the data (not the exact bytes).
 */

/** A FASTA record: identifier, optional description, and residues. */
export interface FastaRecord {
  /** Identifier: the header text up to the first whitespace (the '>' is not included). */
  id: string;
  /** Free text after the id on the header line; absent when the header is just an id. */
  description?: string;
  /** Residues with all line breaks/whitespace removed; case and gap chars ('-', '.') preserved. */
  sequence: string;
}

/** A FASTQ record: a {@link FastaRecord} plus one Phred score per residue. */
export interface FastqRecord extends FastaRecord {
  /** Per-base Phred scores decoded from the quality line (Phred+33), one per residue. */
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
