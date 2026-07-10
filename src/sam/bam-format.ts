/**
 * BAM (`.bam`) reader — read-sequence extraction from the binary alignment format.
 *
 * BAM is the binary twin of SAM. On disk it is BGZF-compressed (a gzip stream of concatenated
 * blocks); this reader expects the INFLATED bytes — starting with the "BAM\1" magic. The caller
 * peels the gzip/BGZF wrapper first (a gzip decompressor decodes BGZF's concatenated members), so
 * this stays a synchronous, dependency-free binary parser.
 *
 * Semantics mirror the SAM reader exactly (see {@link parseSam}): one sequence per read (secondary
 * 0x100 / supplementary 0x800 skipped), reverse-strand sequence stored verbatim (reference-forward),
 * id = read name (+ /1,/2 for paired mates), description = "RNAME:POS (+/-)" or "unmapped". Records
 * without a stored sequence (l_seq = 0) are skipped. Lenient: on any truncation or garble it stops
 * and returns what it parsed cleanly, never throwing.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { isSecondaryOrSupplementary, locusHint, mateId } from './common';

/** 4-bit encoded base → IUPAC letter (BAM spec `seq_nt16_str`), indexed by nibble 0–15. */
const SEQ_NT16 = '=ACMGRSVTWYHKDBN';

/** Fixed-size prefix of an alignment record before the variable read_name/cigar/seq/qual/tags. */
const ALIGN_FIXED = 32;

export function parseBam(bytes: Uint8Array): SeqRecord[] {
  const records: SeqRecord[] = [];
  // "BAM\1" magic — absent unless the BGZF/gzip wrapper was already inflated by the caller.
  if (!(bytes[0] === 0x42 && bytes[1] === 0x41 && bytes[2] === 0x4d && bytes[3] === 0x01)) return records;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const cstr = (at: number, len: number): string => dec.decode(bytes.subarray(at, at + Math.max(0, len - 1)));

  try {
    // Header + reference table. Every length is bounds-checked BEFORE advancing: a malformed header
    // (e.g. a huge n_ref with a non-advancing negative l_name) must not loop/allocate unboundedly on
    // untrusted input — bail out with whatever was parsed (nothing, here) instead.
    const len = bytes.length;
    let p = 4;
    if (p + 4 > len) return records;
    const lText = dv.getInt32(p, true);
    p += 4;
    if (lText < 0 || p + lText + 4 > len) return records;
    p += lText; // skip the SAM header text
    const nRef = dv.getInt32(p, true);
    p += 4;
    if (nRef < 0) return records;
    const refs: string[] = [];
    for (let i = 0; i < nRef; i++) {
      if (p + 4 > len) return records;
      const lName = dv.getInt32(p, true);
      p += 4;
      if (lName <= 0 || p + lName + 4 > len) return records;
      refs.push(cstr(p, lName));
      p += lName + 4; // name + l_ref
    }

    while (p + 4 <= bytes.length) {
      const blockSize = dv.getInt32(p, true);
      p += 4;
      if (blockSize < ALIGN_FIXED || p + blockSize > bytes.length) break; // truncated → stop cleanly
      const end = p + blockSize;

      const refID = dv.getInt32(p, true);
      const pos = dv.getInt32(p + 4, true);
      const lReadName = dv.getUint8(p + 8);
      const nCigar = dv.getUint16(p + 12, true);
      const flag = dv.getUint16(p + 14, true);
      const lSeq = dv.getInt32(p + 16, true);

      let q = p + ALIGN_FIXED;
      const name = cstr(q, lReadName);
      q += lReadName + nCigar * 4; // skip read_name + CIGAR
      const seqBytes = (lSeq + 1) >> 1;
      if (lSeq > 0 && q + seqBytes <= end && !isSecondaryOrSupplementary(flag)) {
        const rname = refID >= 0 && refID < refs.length ? refs[refID] : '*';
        records.push(makeSeqRecord(mateId(name, flag), locusHint(rname, pos + 1, flag), decodeSeq(bytes, q, lSeq)));
      }
      p = end;
    }
  } catch {
    // Truncated/garbled binary — keep whatever parsed cleanly.
  }
  return records;
}

/** Decode `lSeq` 4-bit-packed bases (2 per byte, high nibble first) starting at byte offset `at`. */
function decodeSeq(bytes: Uint8Array, at: number, lSeq: number): string {
  let s = '';
  for (let i = 0; i < lSeq; i++) {
    const byte = bytes[at + (i >> 1)];
    s += SEQ_NT16[i & 1 ? byte & 0x0f : byte >> 4];
  }
  return s;
}
