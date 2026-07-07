/**
 * Domain-layer operation: crop an ABIF file to a sample range.
 *
 * `{ start, end }` is a half-open sample range in the DATA9..12 (processed/analyzed)
 * domain — the only domain PLOC maps into (see AGENTS.md's "raw vs processed" note).
 * DATA9..12 are sliced exactly by that range. DATA1..4/5..8 (raw dye trace and
 * instrument telemetry) have no honest sample-for-sample correspondence to the
 * processed domain (the mapping is non-linear mobility correction, not stored in the
 * file), so they are never approximated: `rawTrace` keeps them whole and untouched,
 * or omits them, never a proportional slice.
 *
 * Every basecall version the file carries (PBAS1/PCON1/PLOC1 "edited",
 * PBAS2/PCON2/PLOC2 "called", or any vendor version) is cropped independently by its
 * OWN PLOC — two versions are not guaranteed to share base positions or even length
 * (edits insert/delete bases), so there is no shared coordinate to crop them together
 * by. A version with no PLOC of its own cannot be cropped and is rejected rather than
 * silently dropped or left un-cropped.
 *
 * Everything else (metadata, FWO_, SPAC, ...) is carried over untouched — this is a
 * structural crop, not a re-derivation of run metadata for the new region.
 *
 * Reverse-complement is out of scope here; this function has no RC option.
 *
 * Returns a new, independently mutable AbifFile — the input is not mutated, and
 * neither is the output if the input is later touched. Untouched entries are
 * shallow-copied (a new AbifEntry object; the underlying payload bytes are shared,
 * which is safe since nothing ever mutates payload bytes in place — only replaces
 * them wholesale), so a later upsertEntry() on either file's copy of a shared tag
 * can't reach into the other file's entries.
 */

import { findEntry } from './abif-format';
import { asciiBytes, asDataView } from './bytes';
import { AbifEntry, AbifFile } from './types';
import { getConfidencesForVersion, getPositionsForVersion, getSequenceForVersion, hasData9To12Block } from './view';

export interface CropAbifRange {
  /** Inclusive start sample index into DATA9..12. */
  start: number;
  /** Exclusive end sample index into DATA9..12. */
  end: number;
}

export interface CropAbifOptions {
  /**
   * DATA1..4 (raw dye trace) and DATA5..8 (telemetry): 'full' keeps them whole and
   * untouched (the exported file's raw trace no longer lines up sample-for-sample
   * with the cropped DATA9..12/PLOC, by design — see the module doc comment);
   * 'omit' drops them from the output entirely. Default 'omit'.
   */
  rawTrace?: 'full' | 'omit';
}

/** Crop an AbifFile to a DATA9..12 sample range. See the module doc comment for the model. */
export function cropAbif(file: AbifFile, range: CropAbifRange, options: CropAbifOptions = {}): AbifFile {
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new Error(`cropAbif: invalid range [${start}, ${end})`);
  }
  if (!hasData9To12Block(file)) {
    throw new Error('cropAbif: no DATA9..12 block to crop — the range has nothing to apply to');
  }
  // The range's meaning is bounded by the processed trace itself: clamping a too-large `end`
  // instead of rejecting it would let a kept base's PLOC point past the (now shorter) cropped
  // DATA9..12 — a structurally inconsistent result. Bound by the shortest of the four channels,
  // in case a malformed file's DATA9..12 lengths ever disagree.
  const processedLength = Math.min(
    entryElementCount(file, 9),
    entryElementCount(file, 10),
    entryElementCount(file, 11),
    entryElementCount(file, 12),
  );
  if (end > processedLength) {
    throw new Error(`cropAbif: range end ${end} exceeds the processed trace length ${processedLength}`);
  }
  const rawTrace = options.rawTrace ?? 'omit';

  const entries: AbifEntry[] = [];
  for (const e of file.entries) {
    if (e.tagName === 'DATA' && e.tagNumber >= 9 && e.tagNumber <= 12) {
      entries.push(cropDataEntry(e, start, end));
    } else if (e.tagName === 'DATA' && e.tagNumber >= 1 && e.tagNumber <= 8) {
      // Shallow-copy so a later upsertEntry() on the cropped file's copy (mutates in place)
      // can never reach back and corrupt the input file's own entry object.
      if (rawTrace === 'full') entries.push({ ...e });
    } else if (e.tagName === 'PBAS' || e.tagName === 'PCON' || e.tagName === 'PLOC') {
      // Handled per-version below, once per version rather than once per tag.
    } else {
      entries.push({ ...e });
    }
  }

  for (const version of basecallVersionsIn(file)) {
    entries.push(...cropBasecallVersion(file, version, start, end));
  }

  return {
    version: file.version,
    tdir: file.tdir,
    entries,
    macBinaryOffset: 0,
    macBinaryHeader: undefined,
    headerReserved: file.headerReserved,
    // Orphan byte ranges belong to the pre-crop file's specific byte layout; carrying
    // them into a structurally different (smaller) file would preserve meaningless bytes.
    unreferencedRanges: [],
  };
}

/** DATA<n>'s elementCount, or 0 if absent — used to bound the requested range up front. */
function entryElementCount(file: AbifFile, n: number): number {
  return findEntry(file, 'DATA', n)?.elementCount ?? 0;
}

function cropDataEntry(e: AbifEntry, start: number, end: number): AbifEntry {
  if (e.elementSize !== 2) {
    throw new Error(`cropAbif: DATA${e.tagNumber} expected elementSize=2, got ${e.elementSize}`);
  }
  // Callers only reach here once cropAbif has already validated end <= the processed trace length.
  const payload = new Uint8Array(e.payload.subarray(start * 2, end * 2));
  return {
    tagName: 'DATA',
    tagNumber: e.tagNumber,
    elementType: e.elementType,
    elementSize: 2,
    elementCount: end - start,
    payload,
    dataHandle: e.dataHandle,
  };
}

/** Every PBAS tag number present, ascending (1 = edited, 2 = called, other = vendor). */
function basecallVersionsIn(file: AbifFile): number[] {
  const versions = new Set<number>();
  for (const e of file.entries) {
    if (e.tagName === 'PBAS') versions.add(e.tagNumber);
  }
  return Array.from(versions).sort((a, b) => a - b);
}

/** Crop one basecall version's PBAS/PCON/PLOC by its own PLOC, independent of any other version. */
function cropBasecallVersion(file: AbifFile, version: number, start: number, end: number): AbifEntry[] {
  const sequence = getSequenceForVersion(file, version);
  if (sequence === undefined) return [];
  const positions = getPositionsForVersion(file, version);
  if (positions === undefined) {
    throw new Error(`cropAbif: PBAS${version} has no PLOC${version} to crop by`);
  }
  if (positions.length !== sequence.length) {
    throw new Error(
      `cropAbif: PBAS${version}/PLOC${version} length mismatch (${sequence.length} vs ${positions.length})`,
    );
  }
  const confidences = getConfidencesForVersion(file, version);
  if (confidences !== undefined && confidences.length !== sequence.length) {
    throw new Error(`cropAbif: PBAS${version}/PCON${version} length mismatch`);
  }

  const kept: number[] = [];
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] >= start && positions[i] < end) kept.push(i);
  }

  const croppedSequence = kept.map(i => sequence[i]).join('');
  const croppedPositions = kept.map(i => positions[i] - start);

  const out: AbifEntry[] = [
    {
      tagName: 'PBAS',
      tagNumber: version,
      elementType: 2, // char
      elementSize: 1,
      elementCount: croppedSequence.length,
      payload: asciiBytes(croppedSequence),
      dataHandle: 0,
    },
    {
      tagName: 'PLOC',
      tagNumber: version,
      elementType: 4, // short, but PLOC values are unsigned (see setPositions)
      elementSize: 2,
      elementCount: croppedPositions.length,
      payload: encodeUnsignedShorts(croppedPositions),
      dataHandle: 0,
    },
  ];
  if (confidences !== undefined) {
    const croppedConfidences = kept.map(i => confidences[i]);
    out.push({
      tagName: 'PCON',
      tagNumber: version,
      elementType: 2, // declared char; bytes ARE Q-scores, see getConfidencesForVersion
      elementSize: 1,
      elementCount: croppedConfidences.length,
      payload: Uint8Array.from(croppedConfidences),
      dataHandle: 0,
    });
  }
  return out;
}

function encodeUnsignedShorts(values: readonly number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 2);
  const view = asDataView(buf);
  for (let i = 0; i < values.length; i++) {
    view.setUint16(i * 2, Math.max(0, Math.min(0xffff, values[i])), false);
  }
  return buf;
}
