/**
 * Mutation helpers for AbifFile: write PBAS/PCON/PLOC/SPAC and ensure DATA9..12
 * are present. Used by basecallers to author ABIF output.
 */

import { asciiBytes, asDataView } from './bytes';
import { findEntry, upsertEntry } from './raw';
import { hasProcessedTraces } from './view';
import { AbifFile } from './types';

/** Set PBAS2 (replaces if present). */
export function setSequence(file: AbifFile, sequence: string): void {
  upsertEntry(file, 'PBAS', 2, asciiBytes(sequence), {
    elementType: 2, // char
    elementSize: 1,
    elementCount: sequence.length,
  });
}

/** Set PCON2 (replaces if present). Values clamped to [0, 255]. */
export function setConfidences(file: AbifFile, q: ArrayLike<number>): void {
  const buf = new Uint8Array(q.length);
  for (let i = 0; i < q.length; i++) {
    buf[i] = Math.max(0, Math.min(255, Math.round(q[i])));
  }
  upsertEntry(file, 'PCON', 2, buf, {
    elementType: 2,
    elementSize: 1,
    elementCount: q.length,
  });
}

/**
 * Set PLOC2 (replaces if present).
 *
 * Written as UNSIGNED int16 so positions up to 65535 are preserved on disk
 * (signed int16 would wrap on traces with > 32k scans).
 */
export function setPositions(file: AbifFile, positions: ArrayLike<number>): void {
  const buf = new Uint8Array(positions.length * 2);
  const view = asDataView(buf);
  for (let i = 0; i < positions.length; i++) {
    view.setUint16(i * 2, Math.max(0, Math.min(0xffff, positions[i])), false);
  }
  upsertEntry(file, 'PLOC', 2, buf, {
    elementType: 4,
    elementSize: 2,
    elementCount: positions.length,
  });
}

/**
 * Set SPAC/1, SPAC/2, SPAC/3 — the standard ABIF "average peak spacing" trio
 * that KB-basecaller writes and downstream tools (BioPython, Sequencher,
 * KB-aware viewers) expect:
 *
 *   - SPAC/1 (float32) — average peak spacing used in last analysis.
 *   - SPAC/2 (pString) — basecaller name / identifier.
 *   - SPAC/3 (float32) — average peak spacing computed by the basecaller.
 *
 * Both float fields are written with the same value.
 */
export function setAveragePeakSpacing(file: AbifFile, spacing: number, basecallerName: string): void {
  const f1 = new Uint8Array(4);
  asDataView(f1).setFloat32(0, spacing, false);
  upsertEntry(file, 'SPAC', 1, f1, { elementType: 7, elementSize: 4, elementCount: 1 });

  const nameBytes = asciiBytes(basecallerName);
  const len = Math.min(255, nameBytes.length);
  const p = new Uint8Array(1 + len);
  p[0] = len;
  p.set(nameBytes.subarray(0, len), 1);
  upsertEntry(file, 'SPAC', 2, p, { elementType: 18, elementSize: 1, elementCount: 1 + len });

  const f3 = new Uint8Array(4);
  asDataView(f3).setFloat32(0, spacing, false);
  upsertEntry(file, 'SPAC', 3, f3, { elementType: 7, elementSize: 4, elementCount: 1 });
}

/**
 * Mean consecutive peak-to-peak distance in scans, from a positions array.
 * Returns 0 when fewer than 2 positions are present.
 */
export function averagePeakSpacing(positions: ArrayLike<number>): number {
  if (positions.length < 2) return 0;
  return (positions[positions.length - 1] - positions[0]) / (positions.length - 1);
}

/**
 * Ensure DATA9..12 are present in the file. Many downstream consumers
 * (BioPython-style readers, viewers) read the chromatogram signal from
 * DATA9..12 by convention — these tags are the raw fluorescence on newer
 * instruments. Older files that only carry DATA1..8 break those consumers
 * with a "no signal" error after re-basecalling.
 *
 * We populate DATA9..12 by copying DATA1..4 (which on DATA1..8-only files IS
 * the raw signal). The DATA1..4 tags are left untouched so any tool that
 * reads them keeps working.
 *
 * No-op when DATA9..12 already exist.
 */
export function ensureRawDataChannels(file: AbifFile): void {
  if (hasProcessedTraces(file)) return;
  for (let i = 1; i <= 4; i++) {
    const src = findEntry(file, 'DATA', i);
    if (!src) continue;
    const target = 8 + i;
    if (findEntry(file, 'DATA', target)) continue;
    file.entries.push({
      tagName: 'DATA',
      tagNumber: target,
      elementType: src.elementType,
      elementSize: src.elementSize,
      elementCount: src.elementCount,
      payload: new Uint8Array(src.payload),
      dataHandle: 0,
    });
  }
}
