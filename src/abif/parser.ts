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

import { asciiString, asDataView, subview } from './bytes';
import { readAbif } from './raw';
import { getFwo } from './view';
import {
  AbifBaseCalls,
  AbifChromatogramBundle,
  AbifDecodedValue,
  AbifDirEntry,
  AbifEntry,
  AbifMetadata,
  ChannelSignals,
  ParsedAbif,
} from './types';

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
      const s = asciiString(payload.subarray(0, elementCount)).replace(/\0+$/g, '');
      return { kind: 'string', value: s };
    }
    case 3: {
      const arr: number[] = [];
      for (let i = 0; i < elementCount; i++) arr.push(view.getUint16(i * 2, false));
      return arr.length === 1 ? { kind: 'number', value: arr[0] } : { kind: 'numbers', value: arr };
    }
    case 4: {
      const arr: number[] = [];
      for (let i = 0; i < elementCount; i++) arr.push(view.getInt16(i * 2, false));
      return arr.length === 1 ? { kind: 'number', value: arr[0] } : { kind: 'numbers', value: arr };
    }
    case 5: {
      const arr: number[] = [];
      for (let i = 0; i < elementCount; i++) arr.push(view.getInt32(i * 4, false));
      return arr.length === 1 ? { kind: 'number', value: arr[0] } : { kind: 'numbers', value: arr };
    }
    case 7: {
      const arr: number[] = [];
      for (let i = 0; i < elementCount; i++) arr.push(view.getFloat32(i * 4, false));
      return arr.length === 1 ? { kind: 'number', value: arr[0] } : { kind: 'numbers', value: arr };
    }
    case 8: {
      const arr: number[] = [];
      for (let i = 0; i < elementCount; i++) arr.push(view.getFloat64(i * 8, false));
      return arr.length === 1 ? { kind: 'number', value: arr[0] } : { kind: 'numbers', value: arr };
    }
    case 10: {
      const year = view.getInt16(0, false);
      const month = view.getUint8(2);
      const day = view.getUint8(3);
      return { kind: 'date', value: { year, month, day } };
    }
    case 11: {
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
      for (let i = 0; i < elementCount; i++) arr.push(view.getUint8(i) !== 0);
      return { kind: 'bools', value: arr };
    }
    case 18: {
      const len = view.getUint8(0);
      const s = asciiString(subview(payload, 1, Math.min(len, Math.max(0, elementCount - 1))));
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
 * Accepts ArrayBuffer or Uint8Array (Buffer in Node works too — it extends
 * Uint8Array). The `fileName` argument is informational only; it's preserved
 * in the result.
 */
export function parseAbif(input: ArrayBuffer | Uint8Array, fileName = ''): ParsedAbif {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const file = readAbif(bytes);

  const entries: AbifDirEntry[] = file.entries.map(e => {
    const decoded = decodePayload(e.elementType, e.elementCount, e.payload);
    return {
      tag: e.tagName,
      tagNumber: e.tagNumber,
      elementType: e.elementType,
      elementTypeName: typeName(e.elementType),
      elementSize: e.elementSize,
      elementCount: e.elementCount,
      dataSize: e.elementCount * e.elementSize,
      // Effective offset within the file is not tracked here (we already
      // resolved it during read); inline detection uses the structural rule.
      dataOffset: 0,
      inline: e.elementCount * e.elementSize <= 4,
      decoded,
      preview: previewDecoded(decoded, e.elementType),
    };
  });

  // FWO_ → base order.
  let baseOrder = getFwo(file);
  if (!/^[ACGT]{4}$/.test(baseOrder)) baseOrder = 'GATC';

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

    if (e.tagName === 'DATA' && decoded.kind === 'numbers') {
      dataChannels[e.tagNumber] = decoded.value;
      if (e.tagNumber >= 1 && e.tagNumber <= 4) data1To4[channelKey(e.tagNumber - 1)] = decoded.value;
      else if (e.tagNumber >= 9 && e.tagNumber <= 12) data9To12[channelKey(e.tagNumber - 9)] = decoded.value;
    } else if (e.tagName === 'PBAS' && decoded.kind === 'string') {
      pbas[e.tagNumber] = decoded.value;
    } else if (e.tagName === 'PCON') {
      // PCON Q-scores are stored as elementType=2 (char) — char codes ARE the values.
      if (decoded.kind === 'numbers') pcon[e.tagNumber] = decoded.value;
      else if (decoded.kind === 'string') {
        pcon[e.tagNumber] = Array.from(decoded.value, c => c.charCodeAt(0));
      }
    } else if (e.tagName === 'PLOC' && decoded.kind === 'numbers') {
      // PLOC sample indices are always non-negative — reinterpret int16 as uint16.
      ploc[e.tagNumber] = decoded.value.map(v => (v < 0 ? v + 0x10000 : v));
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
    }
  }

  // Basecalls: prefer PBAS2 (BioPython convention).
  let baseCalls: AbifBaseCalls | undefined;
  const pbasVersion = pbas[2] ? 2 : pbas[1] ? 1 : Object.keys(pbas).map(Number)[0];
  if (pbasVersion !== undefined && pbas[pbasVersion]) {
    // Don't .trim(): keep length aligned with PCON/PLOC (trailing nulls already stripped).
    const seq = pbas[pbasVersion].toUpperCase();
    // Fall back to whichever PCON has a length matching the chosen PBAS — some
    // files ship PCON only under one tagNumber even when PBAS exists under both.
    let confidences = pcon[pbasVersion] ?? [];
    if (confidences.length === 0) {
      for (const v of Object.keys(pcon).map(Number)) {
        if (pcon[v].length === seq.length) {
          confidences = pcon[v];
          break;
        }
      }
    }
    let positions = ploc[pbasVersion] ?? [];
    if (positions.length === 0) {
      for (const v of Object.keys(ploc).map(Number)) {
        if (ploc[v].length === seq.length) {
          positions = ploc[v];
          break;
        }
      }
    }
    baseCalls = { sequence: seq, confidences, positions, pbasVersion };
  }

  // SPAC fallback: derive from PLOC positions or DATA9 length when missing.
  if (!Number.isFinite(metadata.samplingRate) || (metadata.samplingRate ?? 0) <= 0) {
    const pos = baseCalls?.positions;
    const data9Len = Math.max(
      data9To12.A.length,
      data9To12.C.length,
      data9To12.G.length,
      data9To12.T.length,
    );
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
