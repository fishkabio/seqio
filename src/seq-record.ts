/**
 * The common "a sequence with a name" record produced by every reader that extracts
 * sequences for downstream picking/export (GenBank, EMBL, Swiss-Prot, the alignment
 * formats, …). Data only — same shape as {@link FastaRecord}, so all readers feed one
 * uniform list regardless of source format.
 */
export interface SeqRecord {
  /** Identifier (accession/version/locus/name, per the source format's convention). */
  id: string;
  /** Free-text description/definition when the format carries one. */
  description?: string;
  /**
   * Residues with line wrapping removed. Case is preserved as written; alignment gap
   * characters ('-', '.') are kept (an aligned row is stored verbatim, not de-gapped).
   */
  sequence: string;
}

/** Build a {@link SeqRecord}, dropping an empty description so records compare cleanly. */
export function makeSeqRecord(id: string, description: string, sequence: string): SeqRecord {
  return description ? { id, description, sequence } : { id, sequence };
}
