/**
 * High-level typed view over an AbifFile.
 *
 * Reading helpers that interpret the raw payloads of well-known tags. For
 * mutation helpers (setSequence, setConfidences, ...) see ./setters.
 */

import { findEntry } from './abif-format';
import { asciiString, asDataView } from './bytes';
import { AbifDataChannelRole, AbifFile } from './types';

/** Get DATA<n> as a signed-int16 array, or undefined. */
export function getDataChannel(file: AbifFile, n: number): Int16Array | undefined {
  const e = findEntry(file, 'DATA', n);
  if (!e) return undefined;
  if (e.elementSize !== 2) {
    throw new Error(`DATA${n}: expected elementSize=2, got ${e.elementSize}`);
  }
  const arr = new Int16Array(e.elementCount);
  const view = asDataView(e.payload);
  for (let i = 0; i < e.elementCount; i++) {
    arr[i] = view.getInt16(i * 2, false);
  }
  return arr;
}

/**
 * Dye order, 4 ASCII chars (e.g. "GATC"). Defaults to "GATC" if FWO_ absent.
 *
 * GATC is the dye order produced by modern ABI 3730/3500 instruments and the
 * dominant default in the wild. Older "ACGT" defaults caused channel
 * mis-mapping on files where FWO_ is missing or malformed.
 */
export function getFwo(file: AbifFile): string {
  const e = findEntry(file, 'FWO_', 1);
  if (!e) return 'GATC';
  // Read only the declared elements — payload may carry trailing padding beyond elementCount.
  return asciiString(e.payload.subarray(0, e.elementCount));
}

/**
 * Whether an FWO_ string is a genuine dye order: a permutation of A/C/G/T with all
 * four bases distinct. `"GATC"` passes; `"AAAA"` (regex-valid but degenerate) does
 * not — mapping four channels through it would collapse them onto one base.
 */
export function isFwoPermutation(fwo: string): boolean {
  return /^[ACGT]{4}$/.test(fwo) && new Set(fwo).size === 4;
}

/**
 * Fact: the file carries a second dye-trace block, DATA9..12 (all four tags), in
 * addition to DATA1..4. Reports presence only — it does NOT say which block is
 * raw and which is analyzed/processed; that convention isn't stored in the file.
 */
export function hasData9To12Block(file: AbifFile): boolean {
  return !!(
    findEntry(file, 'DATA', 9) &&
    findEntry(file, 'DATA', 10) &&
    findEntry(file, 'DATA', 11) &&
    findEntry(file, 'DATA', 12)
  );
}

/**
 * Spec-defined role of a DATA<n> tag, limited to the numbers the ABIF spec names:
 *
 *   - `'trace'`     — dye-signal channels: DATA1..4 (raw dyes 1-4), DATA9..12
 *                     (analyzed dyes 1-4), and the two optional 5th-dye blocks
 *                     DATA105 (raw dye 5) and DATA205 (analyzed dye 5).
 *   - `'telemetry'` — DATA5..8: instrument run telemetry (voltage, current,
 *                     power, temperature), one value per scan — NOT dye signal.
 *   - `'other'`     — any other DATA number. The spec does not enumerate higher
 *                     extra-dye tags (106/206/…), so we don't claim a role for them.
 *
 * A fact from the ABIF specification, not an inference about content.
 */
export function dataChannelRole(n: number): AbifDataChannelRole {
  if (n >= 5 && n <= 8) return 'telemetry';
  if ((n >= 1 && n <= 4) || (n >= 9 && n <= 12) || n === 105 || n === 205) return 'trace';
  return 'other';
}

/**
 * Whether the file declares its sequence already reverse-complemented, from the
 * RevC1 flag (int16, non-zero = true). undefined when RevC1 is absent. Reported
 * as-is; the consumer decides how to act on it.
 */
export function getReverseComplemented(file: AbifFile): boolean | undefined {
  const e = findEntry(file, 'RevC', 1);
  if (!e) return undefined;
  const view = asDataView(e.payload);
  return e.payload.byteLength >= 2 ? view.getInt16(0, false) !== 0 : e.payload.some(b => b !== 0);
}

/**
 * Map from base letter ("A"|"C"|"G"|"T") to the DATA1..4 tag number that holds
 * its channel, using the dye order declared by FWO_. If FWO_="GATC" then
 * G→1, A→2, T→3, C→4.
 *
 * This follows the file's own FWO_ declaration for the DATA1..4 block; it makes
 * no claim about whether that block is raw or processed.
 */
export function getChannelMap(file: AbifFile): Record<'A' | 'C' | 'G' | 'T', number> {
  const fwo = getFwo(file);
  if (!isFwoPermutation(fwo)) {
    throw new Error(`FWO_ is not a permutation of A/C/G/T: "${fwo}"`);
  }
  return {
    [fwo[0]]: 1,
    [fwo[1]]: 2,
    [fwo[2]]: 3,
    [fwo[3]]: 4,
  } as Record<'A' | 'C' | 'G' | 'T', number>;
}

/** Get PBAS sequence (prefer PBAS2 over PBAS1). undefined if neither present. */
export function getSequence(file: AbifFile): string | undefined {
  return getSequenceForVersion(file, 2) ?? getSequenceForVersion(file, 1);
}

/**
 * Get PBAS<version> exactly as stored — no called/edited preference, unlike
 * {@link getSequence}. Used where each basecall version must be handled on its
 * own (e.g. cropping every version a file carries, not just the preferred one).
 */
export function getSequenceForVersion(file: AbifFile, version: number): string | undefined {
  const e = findEntry(file, 'PBAS', version);
  if (!e) return undefined;
  // Bound by elementCount (payload may be padded) and drop trailing NULs, matching parseAbif.
  return asciiString(e.payload.subarray(0, e.elementCount)).replace(/\0+$/g, '');
}

/**
 * Get per-base Phred-like quality scores (0..255 byte values, typically 0..60
 * for Sanger). Prefers PCON2 over PCON1.
 *
 * PCON is declared in the ABIF spec as elementType=2 (char) but the byte
 * values ARE the Q-scores — we read raw bytes regardless of declared type.
 */
export function getConfidences(file: AbifFile): number[] | undefined {
  return getConfidencesForVersion(file, 2) ?? getConfidencesForVersion(file, 1);
}

/**
 * Get PCON<version> exactly as stored — no called/edited preference, unlike
 * {@link getConfidences}. See {@link getSequenceForVersion} for why this exists.
 */
export function getConfidencesForVersion(file: AbifFile, version: number): number[] | undefined {
  const e = findEntry(file, 'PCON', version);
  if (!e) return undefined;
  const out: number[] = new Array(e.elementCount);
  for (let i = 0; i < e.elementCount; i++) out[i] = e.payload[i];
  return out;
}

/**
 * Get peak scan positions (one per base). Prefers PLOC2 over PLOC1.
 *
 * Read as UNSIGNED int16: PLOC indexes into the sample trace and is always
 * non-negative, but values > 32767 (long traces) would wrap to negative
 * if interpreted as signed.
 */
export function getPositions(file: AbifFile): number[] | undefined {
  return getPositionsForVersion(file, 2) ?? getPositionsForVersion(file, 1);
}

/**
 * Get PLOC<version> exactly as stored — no called/edited preference, unlike
 * {@link getPositions}. See {@link getSequenceForVersion} for why this exists.
 */
export function getPositionsForVersion(file: AbifFile, version: number): number[] | undefined {
  const e = findEntry(file, 'PLOC', version);
  if (!e) return undefined;
  if (e.elementSize !== 2) {
    throw new Error(`PLOC${version}: expected elementSize=2, got ${e.elementSize}`);
  }
  const view = asDataView(e.payload);
  const out: number[] = new Array(e.elementCount);
  for (let i = 0; i < e.elementCount; i++) out[i] = view.getUint16(i * 2, false);
  return out;
}

/**
 * Get average peak spacing (samples per base), from SPAC/1.
 *
 * ABIF spec defines SPAC as float32 (elementType=7); some legacy files
 * mislabel it as long (type=5). Both are 4 bytes and on disk the payload
 * is always a 32-bit float, so we read as float regardless of declared type.
 *
 * Returns undefined if SPAC is absent or non-positive.
 */
export function getSamplingRate(file: AbifFile): number | undefined {
  const e = findEntry(file, 'SPAC', 1);
  if (!e || e.elementSize !== 4 || e.payload.byteLength < 4) return undefined;
  const v = asDataView(e.payload).getFloat32(0, false);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}
