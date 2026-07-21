/**
 * High-level "parse everything" wrapper around the raw + view layers.
 *
 * Returns a single ParsedAbif object with metadata, the FWO_-aware
 * DATA1..4 / DATA9..12 channel split, basecalls, and decoded directory entries
 * for diagnostics. Mirrors what typical viewers (chromatogram UIs, sample
 * inspectors) need from a single file.
 *
 * For round-trip authoring (basecallers), prefer {@link readAbif} +
 * setters from ./setters which operate directly on the raw AbifFile.
 */

import { readAbif } from './abif-format';
import { asDataView, decodeAbifText, subview } from './bytes';
import {
  AbifBaseCalls,
  AbifBaseCallVariant,
  AbifChromatogramBundle,
  AbifDecodedValue,
  AbifDirEntry,
  AbifEntry,
  AbifMetadata,
  ChannelSignals,
  ParsedAbif,
} from './types';
import { getFwo, isFwoPermutation } from './view';

const TYPE_NAMES: Record<number, string> = {
  1: 'byte',
  2: 'char',
  3: 'word',
  4: 'short',
  5: 'long',
  7: 'float',
  8: 'double',
  10: 'date',
  11: 'time',
  12: 'thumb',
  13: 'bool',
  18: 'pString',
  19: 'cString',
  1023: 'tdir',
};

function typeName(t: number): string {
  return TYPE_NAMES[t] ?? (t >= 1024 ? `user${t}` : `type${t}`);
}

function previewNumbers(arr: number[], max = 10): string {
  if (arr.length <= max) return `[${arr.join(', ')}]`;
  return `[${arr.slice(0, max).join(', ')}, … +${arr.length - max}] (n=${arr.length})`;
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function previewBytes(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, 16);
  const hex = Array.from(slice, b => b.toString(16).padStart(2, '0')).join(' ');
  return `${bytes.byteLength}B [${hex}${bytes.byteLength > 16 ? ' …' : ''}]`;
}

/** Coerce a decoded value to a number array, treating a single scalar as a one-element array. */
function asNumbers(d: AbifDecodedValue): number[] | undefined {
  if (d.kind === 'numbers') return d.value;
  if (d.kind === 'number') return [d.value];
  return undefined;
}

/**
 * Decode a run of fixed-width numbers, bounded by BOTH the element count and the
 * actual payload length — so a malformed entry whose declared elementSize/dataSize
 * disagrees with the type's real width can never drive a read past the buffer.
 */
function decodeNumeric(
  byteLength: number,
  elementCount: number,
  size: number,
  read: (offset: number) => number,
): AbifDecodedValue {
  const n = Math.max(0, Math.min(elementCount, Math.floor(byteLength / size)));
  const arr: number[] = [];
  for (let i = 0; i < n; i++) arr.push(read(i * size));
  return arr.length === 1 ? { kind: 'number', value: arr[0] } : { kind: 'numbers', value: arr };
}

/**
 * Decode a payload best-effort by ABIF element type.
 *
 * Strings have trailing NULs stripped (cString/pString convention).
 * pString (type 18) is decoded as `length-prefix + chars`.
 */
function decodePayload(elementType: number, elementCount: number, payload: Uint8Array): AbifDecodedValue {
  const view = asDataView(payload);
  switch (elementType) {
    case 1: {
      const arr = Array.from(payload.subarray(0, elementCount));
      return { kind: 'numbers', value: arr };
    }
    case 2:
    case 19: {
      // Trim the NUL terminator/padding before decoding — a stray NUL is not part of the text.
      const raw = payload.subarray(0, elementCount);
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      return { kind: 'string', value: decodeAbifText(raw.subarray(0, end)) };
    }
    case 3:
      return decodeNumeric(payload.byteLength, elementCount, 2, o => view.getUint16(o, false));
    case 4:
      return decodeNumeric(payload.byteLength, elementCount, 2, o => view.getInt16(o, false));
    case 5:
      return decodeNumeric(payload.byteLength, elementCount, 4, o => view.getInt32(o, false));
    case 7:
      return decodeNumeric(payload.byteLength, elementCount, 4, o => view.getFloat32(o, false));
    case 8:
      return decodeNumeric(payload.byteLength, elementCount, 8, o => view.getFloat64(o, false));
    case 10: {
      // A date needs 4 bytes; a short/truncated payload falls back to raw bytes rather than throwing.
      if (payload.byteLength < 4) return { kind: 'unknown', value: payload };
      const year = view.getInt16(0, false);
      const month = view.getUint8(2);
      const day = view.getUint8(3);
      return { kind: 'date', value: { year, month, day } };
    }
    case 11: {
      // A time needs 4 bytes; short payload → raw bytes, not a RangeError.
      if (payload.byteLength < 4) return { kind: 'unknown', value: payload };
      return {
        kind: 'time',
        value: {
          hour: view.getUint8(0),
          minute: view.getUint8(1),
          second: view.getUint8(2),
          hsec: view.getUint8(3),
        },
      };
    }
    case 13: {
      const arr: boolean[] = [];
      for (let i = 0; i < Math.min(elementCount, payload.byteLength); i++) arr.push(view.getUint8(i) !== 0);
      return { kind: 'bools', value: arr };
    }
    case 18: {
      // pString = length prefix + chars; an empty payload is just the empty string.
      if (payload.byteLength < 1) return { kind: 'string', value: '' };
      const len = view.getUint8(0);
      const s = decodeAbifText(subview(payload, 1, Math.min(len, Math.max(0, elementCount - 1))));
      return { kind: 'string', value: s };
    }
    default:
      return { kind: 'unknown', value: payload };
  }
}

function previewDecoded(d: AbifDecodedValue, elementType: number): string {
  switch (d.kind) {
    case 'number':
      return String(d.value);
    case 'numbers':
      return previewNumbers(d.value);
    case 'string':
      return truncate(JSON.stringify(d.value));
    case 'bools':
      return d.value.length === 1 ? String(d.value[0]) : `[${d.value.join(', ')}]`;
    case 'date': {
      const { year, month, day } = d.value;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    case 'time': {
      const { hour, minute, second } = d.value;
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    }
    case 'bytes':
      return `${typeName(elementType)} ${previewBytes(d.value)}`;
    case 'unknown':
      return `${typeName(elementType)} ${previewBytes(d.value)}`;
  }
}

/**
 * Parse an ABIF file into a high-level view: metadata, channels, basecalls,
 * and decoded directory entries.
 *
 * This is the INTERPRETING layer — it makes convenience choices (FWO_ → "GATC"
 * fallback, derived samplingRate, preferred/upper-cased PBAS2 baseCalls). It is
 * not the raw structural truth: for that use {@link readAbif}, which reads the
 * directory verbatim (raw dataSize/offset/counts, tdir, inline bytes) and makes
 * no interpretation. `parseAbif` builds on top of it.
 *
 * Accepts ArrayBuffer or Uint8Array (Buffer in Node works too — it extends
 * Uint8Array). The `fileName` argument is informational only; it's preserved
 * in the result.
 */
export function parseAbif(input: ArrayBuffer | Uint8Array, fileName = ''): ParsedAbif {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const file = readAbif(bytes);

  const entries: AbifDirEntry[] = file.entries.map(e => {
    // PCON is declared char (type 2) but its bytes ARE Q-scores; decode it as numbers so the
    // diagnostic view keeps zeros the char decoder would strip (matches baseCalls.confidences).
    const decoded =
      e.tagName === 'PCON' && e.elementSize === 1
        ? decodePayload(1, e.elementCount, e.payload) // type 1 = byte → { kind: 'numbers' }
        : decodePayload(e.elementType, e.elementCount, e.payload);
    // Prefer the real on-disk directory fields (present when read from a file) over
    // reconciled/computed values, so the diagnostic view reflects the actual record.
    return {
      tag: e.tagName,
      tagNumber: e.tagNumber,
      elementType: e.elementType,
      elementTypeName: typeName(e.elementType),
      elementSize: e.elementSize,
      elementCount: e.elementCount,
      rawElementCount: e.raw?.elementCount ?? e.elementCount,
      dataSize: e.raw?.dataSize ?? e.elementCount * e.elementSize,
      dataOffset: e.raw?.dataOffset ?? -1,
      inline: e.raw?.inline ?? e.elementCount * e.elementSize <= 4,
      decoded,
      preview: previewDecoded(decoded, e.elementType),
    };
  });

  // FWO_ → base order. Fall back to GATC unless FWO_ is a real permutation of A/C/G/T
  // (a degenerate value like "AAAA" is regex-valid but would collapse channels).
  let baseOrder = getFwo(file);
  if (!isFwoPermutation(baseOrder)) baseOrder = 'GATC';

  const dataChannels: Record<number, number[]> = {};
  const data1To4: ChannelSignals = { A: [], C: [], G: [], T: [] };
  const data9To12: ChannelSignals = { A: [], C: [], G: [], T: [] };
  const metadata: AbifMetadata = { comments: [] };
  const pbas: Record<number, string> = {};
  const pcon: Record<number, number[]> = {};
  const ploc: Record<number, number[]> = {};

  const channelKey = (i: number): keyof ChannelSignals => baseOrder[i] as keyof ChannelSignals;

  for (let idx = 0; idx < file.entries.length; idx++) {
    const e = file.entries[idx];
    const decoded = entries[idx].decoded;

    if (e.tagName === 'DATA') {
      // Accept single-element channels too (decodePayload collapses length-1 to a scalar).
      const nums = asNumbers(decoded);
      if (nums) {
        dataChannels[e.tagNumber] = nums;
        if (e.tagNumber >= 1 && e.tagNumber <= 4) data1To4[channelKey(e.tagNumber - 1)] = nums;
        else if (e.tagNumber >= 9 && e.tagNumber <= 12) data9To12[channelKey(e.tagNumber - 9)] = nums;
      }
    } else if (e.tagName === 'PBAS' && decoded.kind === 'string') {
      pbas[e.tagNumber] = decoded.value;
    } else if (e.tagName === 'PCON') {
      // PCON Q-scores are 1 byte each (elementType=2/char). Read them straight from the payload —
      // a trailing zero is a valid score, but the char decoder strips trailing NULs and would drop it.
      const nums = e.elementSize === 1 ? Array.from(e.payload.subarray(0, e.elementCount)) : asNumbers(decoded);
      if (nums) pcon[e.tagNumber] = nums;
    } else if (e.tagName === 'PLOC') {
      // PLOC sample indices are always non-negative — reinterpret int16 as uint16.
      const nums = asNumbers(decoded);
      if (nums) ploc[e.tagNumber] = nums.map(v => (v < 0 ? v + 0x10000 : v));
    } else if (e.tagName === 'SPAC') {
      // ABIF spec defines SPAC as float (elementType=7). Some legacy files mislabel
      // it as long (type=5); both are 4 bytes and the payload is always a float.
      if (e.elementSize === 4 && e.payload.byteLength >= 4) {
        const v = asDataView(e.payload).getFloat32(0, false);
        if (Number.isFinite(v) && v > 0) metadata.samplingRate = v;
      } else if (decoded.kind === 'number') {
        metadata.samplingRate = decoded.value;
      }
    } else if (e.tagName === 'SMPL' && decoded.kind === 'string') {
      metadata.sampleName = decoded.value;
    } else if (e.tagName === 'LANE' && decoded.kind === 'number') {
      metadata.laneNumber = decoded.value;
    } else if (e.tagName === 'TUBE' && decoded.kind === 'string') {
      metadata.tube = decoded.value;
    } else if (e.tagName === 'MCHN' && decoded.kind === 'string') {
      metadata.machineName = decoded.value;
    } else if (e.tagName === 'MODL' && decoded.kind === 'string') {
      metadata.machineModel = decoded.value;
    } else if (e.tagName === 'RUND' && decoded.kind === 'date') {
      const d = decoded.value;
      metadata.runDate = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    } else if (e.tagName === 'RUNT' && decoded.kind === 'time') {
      const t = decoded.value;
      metadata.runTime = `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}:${String(t.second).padStart(2, '0')}`;
    } else if (e.tagName === 'CMNT' && decoded.kind === 'string') {
      metadata.comments.push(decoded.value);
    } else if (e.tagName === 'RevC' && e.tagNumber === 1) {
      // RevC1 (int16): file's own flag for whether the sequence is already
      // reverse-complemented. Only tagNumber 1 is defined by the spec. Reported
      // as-is; we draw no conclusion from it.
      if (decoded.kind === 'number') metadata.reverseComplemented = decoded.value !== 0;
      else if (decoded.kind === 'numbers') metadata.reverseComplemented = decoded.value.some(v => v !== 0);
    }
  }

  // Every basecall version the file carries, exactly as stored — the source of
  // truth. Per-version PCON/PLOC are kept strictly (no cross-version borrowing):
  // a variant reports only what its own tag number holds.
  const baseCallVariants: AbifBaseCallVariant[] = Object.keys(pbas)
    .map(Number)
    .sort((a, b) => a - b)
    .map(
      (v): AbifBaseCallVariant => ({
        version: v,
        role: v === 1 ? 'edited' : v === 2 ? 'called' : 'unknown',
        // As stored: case is preserved (lower-case can encode masking/edits). The
        // uppercased convenience view lives on `baseCalls`, not here.
        sequence: pbas[v],
        confidences: pcon[v] ?? [],
        positions: ploc[v] ?? [],
      }),
    );

  // Basecalls: prefer PBAS2 (called) over PBAS1 (edited) — a spec-role choice. Test key
  // presence, not string truthiness, so an existing-but-empty PBAS2 is still honored.
  let baseCalls: AbifBaseCalls | undefined;
  const pbasVersion = 2 in pbas ? 2 : 1 in pbas ? 1 : Object.keys(pbas).map(Number)[0];
  if (pbasVersion !== undefined && pbas[pbasVersion] !== undefined) {
    // Don't .trim(): keep length aligned with PCON/PLOC (trailing nulls already stripped).
    const seq = pbas[pbasVersion].toUpperCase();
    // Fall back to whichever PCON has a length matching the chosen PBAS — some
    // files ship PCON only under one tagNumber even when PBAS exists under both.
    // Fall back to whichever version's PCON/PLOC matches the chosen PBAS length — triggered when the
    // preferred version's array is missing OR present-but-length-mismatched. Expose none rather than a
    // broken array when nothing matches, so baseCalls stays self-consistent (baseCallVariants stays strict).
    let confidences = pcon[pbasVersion] ?? [];
    if (confidences.length !== seq.length) {
      confidences =
        Object.keys(pcon)
          .map(Number)
          .map(v => pcon[v])
          .find(c => c.length === seq.length) ?? [];
    }
    let positions = ploc[pbasVersion] ?? [];
    if (positions.length !== seq.length) {
      positions =
        Object.keys(ploc)
          .map(Number)
          .map(v => ploc[v])
          .find(pp => pp.length === seq.length) ?? [];
    }
    baseCalls = { sequence: seq, confidences, positions, pbasVersion };
  }

  // SPAC fallback: derive from PLOC positions or DATA9 length when missing.
  if (!Number.isFinite(metadata.samplingRate) || (metadata.samplingRate ?? 0) <= 0) {
    const pos = baseCalls?.positions;
    const data9Len = Math.max(data9To12.A.length, data9To12.C.length, data9To12.G.length, data9To12.T.length);
    if (pos && pos.length > 1) {
      metadata.samplingRate = (pos[pos.length - 1] - pos[0]) / (pos.length - 1);
    } else if (baseCalls && baseCalls.sequence.length > 0 && data9Len > 0) {
      metadata.samplingRate = data9Len / baseCalls.sequence.length;
    }
  }

  const chromatogram: AbifChromatogramBundle = { baseOrder, dataChannels, data1To4, data9To12 };

  return {
    fileName,
    fileSize: bytes.byteLength,
    abifVersion: file.version,
    macBinaryOffset: file.macBinaryOffset,
    dirEntryCount: file.entries.length,
    metadata,
    chromatogram,
    baseCalls,
    baseCallVariants,
    entries,
  };
}

/** True when any channel has at least one signal value. */
export function hasSignals(s: ChannelSignals): boolean {
  return s.A.length > 0 || s.C.length > 0 || s.G.length > 0 || s.T.length > 0;
}

/** Length of the longest channel in a ChannelSignals bundle. */
export function channelMaxLength(s: ChannelSignals): number {
  return Math.max(s.A.length, s.C.length, s.G.length, s.T.length);
}

// Quiet unused-import for the AbifEntry type if it isn't reachable elsewhere.
export type { AbifEntry };
