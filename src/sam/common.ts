/**
 * Shared SAM/BAM alignment-flag helpers — the two readers (text SAM, binary BAM) apply identical
 * record semantics, so the FLAG bits and the id/description conventions live here once.
 */

export const FLAG_PAIRED = 0x1;
export const FLAG_UNMAPPED = 0x4;
export const FLAG_REVERSE = 0x10;
export const FLAG_FIRST = 0x40;
export const FLAG_LAST = 0x80;
export const FLAG_SECONDARY = 0x100;
export const FLAG_SUPPLEMENTARY = 0x800;

/** Skip records that re-map an already-seen read, so each read yields one sequence. */
export function isSecondaryOrSupplementary(flag: number): boolean {
  return (flag & (FLAG_SECONDARY | FLAG_SUPPLEMENTARY)) !== 0;
}

/** QNAME, plus a /1 or /2 mate suffix for paired reads so both mates of a pair stay distinct. */
export function mateId(qname: string, flag: number): string {
  if (flag & FLAG_PAIRED) {
    if (flag & FLAG_FIRST) return `${qname}/1`;
    if (flag & FLAG_LAST) return `${qname}/2`;
  }
  return qname;
}

/** Short mapping hint: "RNAME:POS (+/-)" when mapped, else "unmapped". `pos` is 1-based here. */
export function locusHint(rname: string | undefined, pos: number, flag: number): string {
  if (flag & FLAG_UNMAPPED || !rname || rname === '*') return 'unmapped';
  return `${rname}:${pos} (${flag & FLAG_REVERSE ? '-' : '+'})`;
}
