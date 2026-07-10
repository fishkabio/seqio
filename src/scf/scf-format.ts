/**
 * SCF (`.scf`) reader — the called base sequence from a Staden chromatogram trace.
 *
 * SCF (Standard Chromatogram Format) is a binary trace file. Only the **called bases** are
 * extracted here (the trace samples/qualities are ignored — this library reads sequences):
 *
 *   Header (128 bytes, big-endian). The fields this reader uses:
 *     off  field
 *       0  magic ".scf"
 *      12  bases          (uint32 — number of called bases)
 *      24  bases_offset   (uint32 — start of the bases section)
 *      36  version[4]     (ASCII, e.g. "2.00" / "3.00")
 *      28  comments_size  (uint32)
 *      32  comments_offset(uint32)
 *
 *   Bases section — two layouts by version:
 *     • v3.x (column/SoA): peak indices (bases×uint32), then prob_A/C/G/T (bases bytes each),
 *       then the **base characters** (bases bytes), then spare (bases×3). So the characters begin
 *       at `bases_offset + bases*8`.
 *     • v2.x (interleaved/AoS): `bases` records of 12 bytes each — peak_index(uint32),
 *       prob_A/C/G/T(4), **base char(1)**, spare(3). The character of record i is at
 *       `bases_offset + i*12 + 8`.
 *
 * The record id comes from a `NAME=` field in the comments section when present, else `"scf"`.
 * Deliberately lenient (see AGENTS.md): never throws; returns `[]` for a truncated/unreadable
 * file, and best-effort (whatever bases fit) for one truncated mid-section.
 */

import { makeSeqRecord, SeqRecord } from '../seq-record';

const HEADER_SIZE = 128;

export function parseScf(input: string | Uint8Array): SeqRecord[] {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.length < HEADER_SIZE) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Magic ".scf" (0x2E736366) at offset 0.
  if (dv.getUint32(0, false) !== 0x2e736366) return [];

  const bases = dv.getUint32(12, false);
  const basesOffset = dv.getUint32(24, false);
  const version = String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39]);
  if (bases === 0 || basesOffset === 0) return [];

  const chars: number[] = [];
  if (Number.parseFloat(version) >= 3) {
    // v3.x SoA: base characters follow the peak-index and four probability arrays.
    const start = basesOffset + bases * 8;
    for (let i = 0; i < bases && start + i < bytes.length; i++) chars.push(bytes[start + i]);
  } else {
    // v2.x AoS: the base char is byte 8 of each 12-byte record.
    for (let i = 0; i < bases; i++) {
      const at = basesOffset + i * 12 + 8;
      if (at >= bytes.length) break;
      chars.push(bytes[at]);
    }
  }
  // Keep printable base symbols only; a padding NUL or stray control byte isn't a residue.
  const sequence = chars
    .filter(c => c > 0x20 && c < 0x7f)
    .map(c => String.fromCharCode(c))
    .join('');
  if (sequence.length === 0) return [];

  return [makeSeqRecord(readName(bytes, dv), '', sequence)];
}

/** The `NAME=` value from the SCF comments section, or `"scf"` when absent/unreadable. */
function readName(bytes: Uint8Array, dv: DataView): string {
  const size = dv.getUint32(28, false);
  const offset = dv.getUint32(32, false);
  if (size === 0 || offset === 0 || offset + size > bytes.length) return 'scf';
  let text = '';
  for (let i = offset; i < offset + size; i++) text += String.fromCharCode(bytes[i]);
  // Comments are newline-separated `KEY=value` lines; take NAME if present.
  const m = /^NAME=(.+)$/im.exec(text);
  return m ? m[1].trim() || 'scf' : 'scf';
}
