/**
 * High-level typed view over an AbifFile.
 *
 * Reading helpers that interpret the raw payloads of well-known tags. For
 * mutation helpers (setSequence, setConfidences, ...) see ./setters.
 */

import { asciiString, asDataView } from './bytes';
import { findEntry } from './raw';
import { AbifFile } from './types';

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
  return asciiString(e.payload);
}

/**
 * True when the file carries BOTH DATA1..4 and DATA9..12. Newer ABI-style
 * instruments produce both: DATA1..4 is post-processed (mobility-corrected,
 * baseline-subtracted, color-separated) and DATA9..12 is raw fluorescence.
 * Older instruments produce only DATA1..4 (which IS the raw signal).
 *
 * Callers that re-process traces (basecallers) should detect this and bypass
 * their own baseline-subtraction / color-matrix steps when DATA1..4 is
 * already cleaned.
 */
export function hasProcessedTraces(file: AbifFile): boolean {
  return !!(
    findEntry(file, 'DATA', 9) &&
    findEntry(file, 'DATA', 10) &&
    findEntry(file, 'DATA', 11) &&
    findEntry(file, 'DATA', 12)
  );
}

/**
 * Map from base letter ("A"|"C"|"G"|"T") to the DATA tag number that holds
 * its RAW fluorescence channel.
 *
 * ABIF stores up to 12 DATA tags. KB-basecaller-aware instruments (3130, 3500,
 * ...) use DATA1..4 for processed traces and DATA9..12 for raw. Older / simpler
 * instruments produce only DATA1..8 where DATA1..4 ARE the raw traces.
 *
 * This helper always returns the DATA1..4 mapping (the convention used by
 * basecallers operating on raw signal). Use {@link hasProcessedTraces} to
 * detect whether DATA1..4 has been pre-processed and bypass baseline/color
 * steps accordingly.
 *
 * The dye-to-channel order within each block is given by FWO_. If
 * FWO_="GATC" then G→1, A→2, T→3, C→4.
 */
export function getRawChannelMap(file: AbifFile): Record<'A' | 'C' | 'G' | 'T', number> {
  const fwo = getFwo(file);
  if (!/^[ACGT]{4}$/.test(fwo)) {
    throw new Error(`FWO_ malformed: "${fwo}"`);
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
  const e2 = findEntry(file, 'PBAS', 2);
  if (e2) return asciiString(e2.payload);
  const e1 = findEntry(file, 'PBAS', 1);
  if (e1) return asciiString(e1.payload);
  return undefined;
}

/**
 * Get per-base Phred-like quality scores (0..255 byte values, typically 0..60
 * for Sanger). Prefers PCON2 over PCON1.
 *
 * PCON is declared in the ABIF spec as elementType=2 (char) but the byte
 * values ARE the Q-scores — we read raw bytes regardless of declared type.
 */
export function getConfidences(file: AbifFile): number[] | undefined {
  const e = findEntry(file, 'PCON', 2) ?? findEntry(file, 'PCON', 1);
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
  const e = findEntry(file, 'PLOC', 2) ?? findEntry(file, 'PLOC', 1);
  if (!e) return undefined;
  if (e.elementSize !== 2) {
    throw new Error(`PLOC: expected elementSize=2, got ${e.elementSize}`);
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
