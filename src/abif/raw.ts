/**
 * Low-level ABIF reader/writer.
 *
 * Round-trip without loss: every directory entry (including unknown vendor
 * tags) is preserved as a raw payload (Uint8Array). The high-level layer
 * (view.ts, parser.ts) provides typed access on top of this.
 *
 * ABIF file layout:
 *   [0..3]      "ABIF" magic
 *   [4..5]      version (int16 BE; 101 = v1.01)
 *   [6..33]     TdirEntry describing the directory itself
 *   [34..127]   reserved (94 bytes, zero-filled)
 *   [...]       directory block (N * 28-byte entries) and payload blocks
 *
 * TdirEntry (28 bytes, big-endian):
 *   off  size  field
 *     0   4    tagName        (ASCII)
 *     4   4    tagNumber      (int32)
 *     8   2    elementType    (int16)
 *    10   2    elementSize    (int16)
 *    12   4    elementCount   (int32)
 *    16   4    dataSize       (int32; total payload bytes; spec says count*size)
 *    20   4    dataOffset     (int32) OR inline data if dataSize <= 4
 *    24   4    dataHandle     (int32; usually 0)
 *
 * Inline rule (per ABIF spec): when count*size <= 4 the payload bytes are
 * stored directly in the dataOffset field (left-aligned, padded to 4 bytes).
 *
 * MacBinary preamble: some ABIF files (older Mac-origin) start with a 128-byte
 * MacBinary header before the actual ABIF magic. We detect and skip it.
 */

import { asciiBytes, asciiString, asDataView, subview, tagNameFromInt32 } from './bytes';
import { AbifEntry, AbifFile } from './types';

export const HEADER_SIZE = 128;
export const ENTRY_SIZE = 28;

/**
 * Parse an ABIF file from raw bytes.
 *
 * Accepts Uint8Array (works in Node and the browser). Node's Buffer extends
 * Uint8Array, so `readAbif(buffer)` and `readAbif(new Uint8Array(arrayBuffer))`
 * both work.
 *
 * Throws if the magic header is missing. Does NOT require any specific tags
 * (PBAS, DATA, ...) to be present — raw pre-basecalled files are supported.
 */
export function readAbif(bytes: Uint8Array): AbifFile {
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(`ABIF too small: ${bytes.byteLength} bytes`);
  }

  // MacBinary wrap support: skip 128 bytes if magic is at offset 128.
  let macBinaryOffset = 0;
  if (asciiString(subview(bytes, 0, 4)) !== 'ABIF') {
    if (bytes.byteLength >= 128 + 4 && asciiString(subview(bytes, 128, 4)) === 'ABIF') {
      macBinaryOffset = 128;
    } else {
      throw new Error('Not an ABIF file: missing "ABIF" magic.');
    }
  }
  const base = macBinaryOffset;
  const view = asDataView(bytes);

  const version = view.getInt16(base + 4, false);

  // Header bytes [base+6 .. base+34) are a TdirEntry describing the directory itself.
  const dirEntry = decodeEntry(bytes, view, base + 6);
  if (dirEntry.tagName !== 'tdir') {
    throw new Error(`Expected "tdir" header entry, got "${dirEntry.tagName}"`);
  }
  if (dirEntry.elementSize !== ENTRY_SIZE) {
    throw new Error(`Expected dir element size ${ENTRY_SIZE}, got ${dirEntry.elementSize}`);
  }

  const numEntries = dirEntry.elementCount;
  // tdir.dataSize is always > 4 (28*N), so the dataOffset field is an external offset.
  const dirOffset = view.getInt32(base + 6 + 20, false);
  if (dirOffset < 0 || dirOffset + numEntries * ENTRY_SIZE > bytes.byteLength - base) {
    throw new Error(
      `Directory out of bounds: offset=${dirOffset}, entries=${numEntries}, file=${bytes.byteLength - base}`,
    );
  }

  const entries: AbifEntry[] = [];
  for (let i = 0; i < numEntries; i++) {
    entries.push(decodeEntry(bytes, view, base + dirOffset + i * ENTRY_SIZE));
  }

  return { version, entries, macBinaryOffset };
}

/**
 * Decode a 28-byte TdirEntry at the given absolute byte offset.
 *
 * Two robustness measures applied here that BioPython also uses and that real
 * ABIF files in the wild require:
 *
 *   1. The inline rule uses `elementCount * elementSize` (the structural size),
 *      not the declared `dataSize` field — they should agree, but the writer
 *      sometimes desynced them.
 *
 *   2. When the declared `dataSize` is smaller than `count*size`, trust the
 *      smaller value for payload reading. Some older instruments and edited
 *      files (e.g. BioPython A_forward.ab1) have `dataSize` set to the actual
 *      written size while `elementCount` was left at the original (larger)
 *      value, so reading the full count*size range would land in adjacent data.
 */
function decodeEntry(bytes: Uint8Array, view: DataView, off: number): AbifEntry {
  const tagName = asciiString(subview(bytes, off, 4));
  const tagNumber = view.getInt32(off + 4, false);
  const elementType = view.getInt16(off + 8, false);
  const elementSize = view.getInt16(off + 10, false);
  const rawElementCount = view.getInt32(off + 12, false);
  const declaredDataSize = view.getInt32(off + 16, false);
  const dataHandle = view.getInt32(off + 24, false);

  const computedDataSize = Math.max(0, rawElementCount * Math.max(0, elementSize));
  const effectiveDataSize = Math.min(computedDataSize, Math.max(0, declaredDataSize));
  // Inline is a structural property of the on-disk record: based on RAW count*size.
  const inline = computedDataSize <= 4;
  // For iteration we use the smaller of declared and computed, clamped to size
  // boundaries, so we don't over-read past the real payload.
  const elementCount =
    elementSize > 0 && declaredDataSize >= 0 && declaredDataSize < computedDataSize
      ? Math.floor(declaredDataSize / elementSize)
      : rawElementCount;

  let payload: Uint8Array;
  if (inline) {
    payload = new Uint8Array(subview(bytes, off + 20, effectiveDataSize));
  } else {
    const dataOffset = view.getInt32(off + 20, false);
    if (dataOffset < 0 || dataOffset + effectiveDataSize > bytes.byteLength) {
      throw new Error(
        `Entry ${tagName}${tagNumber}: payload out of bounds (offset=${dataOffset}, size=${effectiveDataSize})`,
      );
    }
    payload = new Uint8Array(subview(bytes, dataOffset, effectiveDataSize));
  }

  return { tagName, tagNumber, elementType, elementSize, elementCount, payload, dataHandle };
}

/**
 * Serialize an AbifFile back to a Uint8Array.
 *
 * Layout produced: header (128 B) + directory (N*28 B) + payload block.
 * External payloads are packed tightly in entry order. Inline payloads
 * (count*size <= 4) live entirely inside their directory entry.
 *
 * The output is not bit-identical to the input if the original had a different
 * physical layout (e.g. payloads before directory), but the *meaning*
 * round-trips: readAbif(writeAbif(f)) reproduces the same entries structurally.
 *
 * MacBinary preamble is not preserved by writeAbif.
 */
export function writeAbif(file: AbifFile): Uint8Array {
  const numEntries = file.entries.length;
  const dirOffset = HEADER_SIZE;
  const dirSize = numEntries * ENTRY_SIZE;

  // Compute external payload offsets.
  let payloadCursor = dirOffset + dirSize;
  const externalOffsets: number[] = new Array(numEntries);
  for (let i = 0; i < numEntries; i++) {
    const e = file.entries[i];
    const dataSize = e.elementCount * e.elementSize;
    if (e.payload.byteLength !== dataSize) {
      throw new Error(
        `Entry ${e.tagName}${e.tagNumber}: payload length ${e.payload.byteLength} != dataSize ${dataSize}`,
      );
    }
    if (dataSize > 4) {
      externalOffsets[i] = payloadCursor;
      payloadCursor += dataSize;
    } else {
      externalOffsets[i] = -1; // inline
    }
  }

  const totalSize = payloadCursor;
  const out = new Uint8Array(totalSize);
  const outView = asDataView(out);

  // Header: "ABIF" + version (int16 BE) + tdir entry + zeros.
  out.set(asciiBytes('ABIF'), 0);
  outView.setInt16(4, file.version, false);
  // The tdir entry's dataOffset is the directory offset (explicit, not from
  // the AbifEntry payload — the tdir is structural).
  writeEntry(
    {
      tagName: 'tdir',
      tagNumber: 1,
      elementType: 1023,
      elementSize: ENTRY_SIZE,
      elementCount: numEntries,
      payload: new Uint8Array(0),
      dataHandle: 0,
    },
    out,
    outView,
    6,
    /* externalOffset */ -1,
    /* externalDataSize */ dirSize,
    /* explicitDirOffset */ dirOffset,
  );

  // Directory entries.
  for (let i = 0; i < numEntries; i++) {
    const e = file.entries[i];
    writeEntry(e, out, outView, dirOffset + i * ENTRY_SIZE, externalOffsets[i]);
  }

  // Payload block.
  for (let i = 0; i < numEntries; i++) {
    const off = externalOffsets[i];
    if (off >= 0) {
      out.set(file.entries[i].payload, off);
    }
  }

  return out;
}

function writeEntry(
  e: AbifEntry,
  out: Uint8Array,
  outView: DataView,
  off: number,
  externalOffset: number,
  externalDataSize?: number,
  explicitDirOffset?: number,
): void {
  if (e.tagName.length !== 4) {
    throw new Error(`tagName must be 4 chars: "${e.tagName}"`);
  }
  out.set(asciiBytes(e.tagName), off);
  outView.setInt32(off + 4, e.tagNumber, false);
  outView.setInt16(off + 8, e.elementType, false);
  outView.setInt16(off + 10, e.elementSize, false);
  outView.setInt32(off + 12, e.elementCount, false);
  const dataSize = externalDataSize ?? e.elementCount * e.elementSize;
  outView.setInt32(off + 16, dataSize, false);

  if (explicitDirOffset !== undefined) {
    outView.setInt32(off + 20, explicitDirOffset, false);
  } else if (dataSize <= 4) {
    // Inline: clear 4 bytes then place payload at off+20.
    out.fill(0, off + 20, off + 24);
    out.set(e.payload.subarray(0, dataSize), off + 20);
  } else {
    if (externalOffset < 0) {
      throw new Error(`External payload requires offset for ${e.tagName}${e.tagNumber}`);
    }
    outView.setInt32(off + 20, externalOffset, false);
  }
  outView.setInt32(off + 24, e.dataHandle, false);
}

// =====================================================================
// Lookup / mutation helpers
// =====================================================================

/** Find an entry by name+number, or undefined. */
export function findEntry(file: AbifFile, name: string, number: number): AbifEntry | undefined {
  return file.entries.find(e => e.tagName === name && e.tagNumber === number);
}

/** Find all entries with the given tag name. */
export function findEntries(file: AbifFile, name: string): AbifEntry[] {
  return file.entries.filter(e => e.tagName === name);
}

/**
 * Replace the payload of an existing entry, or append a new one.
 * elementType/elementSize/elementCount must be supplied for new entries.
 */
export function upsertEntry(
  file: AbifFile,
  name: string,
  number: number,
  payload: Uint8Array,
  defaults: { elementType: number; elementSize: number; elementCount: number },
): void {
  if (payload.byteLength !== defaults.elementCount * defaults.elementSize) {
    throw new Error(
      `upsertEntry ${name}${number}: payload length ${payload.byteLength} != count*size`,
    );
  }
  const existing = findEntry(file, name, number);
  if (existing) {
    existing.elementType = defaults.elementType;
    existing.elementSize = defaults.elementSize;
    existing.elementCount = defaults.elementCount;
    existing.payload = payload;
  } else {
    file.entries.push({
      tagName: name,
      tagNumber: number,
      elementType: defaults.elementType,
      elementSize: defaults.elementSize,
      elementCount: defaults.elementCount,
      payload,
      dataHandle: 0,
    });
  }
}

/** Re-export for users who want to interpret raw tag bytes themselves. */
export { tagNameFromInt32 };
