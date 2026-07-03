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
 *    16   4    dataSize       (int32; total payload bytes — authoritative; for
 *                              well-formed entries equals count*size, but user/
 *                              opaque types may differ, so we read by dataSize)
 *    20   4    dataOffset     (int32) OR inline data if dataSize <= 4
 *    24   4    dataHandle     (int32; usually 0)
 *
 * Inline rule (per ABIF spec): when the declared dataSize <= 4 the payload bytes
 * are stored directly in the dataOffset field (left-aligned, padded to 4 bytes).
 *
 * MacBinary preamble: some ABIF files (older Mac-origin) start with a 128-byte
 * MacBinary header before the actual ABIF magic. We detect and skip it.
 */

import { asciiBytes, asciiString, asDataView, subview, tagNameFromInt32 } from './bytes';
import { AbifByteRange, AbifDirectory, AbifEntry, AbifFile } from './types';

export const HEADER_SIZE = 128;
export const ENTRY_SIZE = 28;

/**
 * Parse an ABIF file from raw bytes into its verbatim directory structure.
 *
 * This is the RAW source of truth: it reads the tdir header and every entry as
 * stored — real dataSize, dataOffset, numElements (see `entry.raw`), the 4 inline
 * bytes, and the tdir/directory metadata — and interprets nothing. For a
 * high-level, opinionated view (typed channels, basecalls, metadata) layer
 * {@link parseAbif} on top.
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
  // After skipping any MacBinary wrap, the ABIF part itself must still hold a full 128-byte header;
  // otherwise reading version/tdir below would run past the DataView (a raw RangeError, not ours).
  if (bytes.byteLength - base < HEADER_SIZE) {
    throw new Error(`ABIF too small: ${bytes.byteLength - base} bytes after offset ${base}`);
  }
  const view = asDataView(bytes);

  const version = view.getInt16(base + 4, false);

  // Header bytes [base+6 .. base+34) are a TdirEntry describing the directory itself.
  const dirEntry = decodeEntry(bytes, view, base + 6, base);
  if (dirEntry.tagName !== 'tdir') {
    throw new Error(`Expected "tdir" header entry, got "${dirEntry.tagName}"`);
  }
  if (dirEntry.elementSize !== ENTRY_SIZE) {
    throw new Error(`Expected dir element size ${ENTRY_SIZE}, got ${dirEntry.elementSize}`);
  }

  // The directory's numElements (raw) is the authoritative entry count — like BioPython, we trust
  // it rather than clamp against tdir.dataSize, which is a redundant byte-count that some writers
  // desync. Physical bounds are enforced below; a negative/garbage count just yields 0 entries.
  const rawDirCount = dirEntry.raw?.elementCount ?? dirEntry.elementCount;
  const numEntries = Math.max(0, rawDirCount);
  // tdir.dataSize is always > 4 (28*N), so the dataOffset field is an external offset.
  const dirOffset = view.getInt32(base + 6 + 20, false);
  if (dirOffset < 0 || dirOffset + numEntries * ENTRY_SIZE > bytes.byteLength - base) {
    throw new Error(
      `Directory out of bounds: offset=${dirOffset}, entries=${numEntries}, file=${bytes.byteLength - base}`,
    );
  }

  const entries: AbifEntry[] = [];
  for (let i = 0; i < numEntries; i++) {
    entries.push(decodeEntry(bytes, view, base + dirOffset + i * ENTRY_SIZE, base));
  }

  // Root directory (tdir) header, as read — its dataSize may exceed numEntries*28 (directory padding).
  const dirDataSize = dirEntry.raw?.dataSize ?? numEntries * ENTRY_SIZE;
  const entriesEnd = base + dirOffset + numEntries * ENTRY_SIZE;
  const padLen = Math.min(
    Math.max(0, dirDataSize - numEntries * ENTRY_SIZE),
    Math.max(0, bytes.byteLength - entriesEnd),
  );
  const tdir: AbifDirectory = {
    entryCount: numEntries, // effective count actually read (== entries.length)
    rawEntryCount: rawDirCount, // tdir numElements verbatim, before any reconciliation
    elementType: dirEntry.elementType, // 1023 (tdir)
    tagNumber: dirEntry.tagNumber, // usually 1
    entrySize: dirEntry.elementSize,
    dataSize: dirDataSize,
    dataOffset: dirOffset,
    dataOffsetBytes: dirEntry.raw?.dataOffsetBytes ?? new Uint8Array(4),
    dataHandle: dirEntry.dataHandle,
    paddingBytes: new Uint8Array(subview(bytes, entriesEnd, padLen)),
  };

  // Reserved header bytes [base+34 .. base+128) — verbatim, so a raw reader keeps the whole header.
  const headerReserved = new Uint8Array(subview(bytes, base + 6 + ENTRY_SIZE, HEADER_SIZE - 6 - ENTRY_SIZE));

  // The MacBinary preamble bytes themselves, when present — verbatim, so the wrapper is reproducible.
  const macBinaryHeader = macBinaryOffset === 128 ? new Uint8Array(subview(bytes, 0, 128)) : undefined;

  const unreferencedRanges = computeUnreferencedRanges(bytes, base, dirOffset, dirDataSize, entries, macBinaryOffset);

  return { version, tdir, entries, macBinaryOffset, macBinaryHeader, headerReserved, unreferencedRanges };
}

/**
 * Find the file's physical byte ranges that no header/directory/entry payload covers — orphaned
 * blocks, trailing padding, etc. Computes the complement of every referenced interval so a raw
 * reader can account for all bytes without the writer having to be byte-exact.
 */
function computeUnreferencedRanges(
  bytes: Uint8Array,
  base: number,
  dirOffset: number,
  dirDataSize: number,
  entries: AbifEntry[],
  macBinaryOffset: number,
): AbifByteRange[] {
  const total = bytes.byteLength;
  const covered: Array<[number, number]> = [];
  if (macBinaryOffset === 128) covered.push([0, 128]); // preamble
  covered.push([base, base + HEADER_SIZE]); // 128-byte header (magic/version/tdir/reserved)
  // Directory spans the bytes actually read (numElements entries) OR the declared dataSize when it is
  // larger (padding) — whichever is bigger, so a desynced dataSize < numElements*28 doesn't mislabel
  // already-read entries as orphan bytes. A negative dataSize collapses to the physical entry span.
  const dirCovered = Math.max(entries.length * ENTRY_SIZE, Math.max(0, dirDataSize));
  covered.push([base + dirOffset, base + dirOffset + dirCovered]);
  for (const e of entries) {
    if (e.raw && !e.raw.inline) {
      const start = base + e.raw.dataOffset;
      covered.push([start, start + e.payload.byteLength]); // external payload
    }
  }

  const norm = covered
    .map(([s, en]): [number, number] => [Math.max(0, Math.min(s, total)), Math.max(0, Math.min(en, total))])
    .filter(([s, en]) => en > s)
    .sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const [s, en] of norm) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], en);
    else merged.push([s, en]);
  }

  const gaps: AbifByteRange[] = [];
  let cursor = 0;
  for (const [s, en] of merged) {
    if (s > cursor) gaps.push({ offset: cursor, bytes: new Uint8Array(subview(bytes, cursor, s - cursor)) });
    cursor = Math.max(cursor, en);
  }
  if (cursor < total) gaps.push({ offset: cursor, bytes: new Uint8Array(subview(bytes, cursor, total - cursor)) });
  return gaps;
}

/**
 * Decode a 28-byte TdirEntry at the given absolute byte offset.
 *
 * Two robustness measures applied here that BioPython also uses and that real
 * ABIF files in the wild require:
 *
 *   1. The payload is exactly `dataSize` bytes — the authoritative directory field.
 *      ABIF allows `numElements * elementSize != dataSize` for user/opaque types,
 *      so we never derive the payload length from count*size (that both truncates
 *      a larger declared payload and over-reads a smaller one).
 *
 *   2. Inline vs external follows the spec: inline iff `dataSize <= 4` (the payload
 *      fits in the 4-byte dataOffset field). Data > 4 bytes is always external,
 *      even when count*size <= 4. We fall back to count*size only when the declared
 *      field is negative/garbage.
 *
 *   3. `elementCount` is reconciled down to what the payload can hold, so a desynced
 *      (over-large) count can't drive readers past the real bytes.
 *
 *   4. External payload offsets are relative to the ABIF start, so we add `base`
 *      (the MacBinary preamble length) when reading them.
 */
function decodeEntry(bytes: Uint8Array, view: DataView, off: number, base: number): AbifEntry {
  const tagName = asciiString(subview(bytes, off, 4));
  const tagNumber = view.getInt32(off + 4, false);
  const elementType = view.getInt16(off + 8, false);
  const elementSize = view.getInt16(off + 10, false);
  const rawElementCount = view.getInt32(off + 12, false);
  const declaredDataSize = view.getInt32(off + 16, false);
  const dataHandle = view.getInt32(off + 24, false);

  const computedDataSize = Math.max(0, rawElementCount * Math.max(0, elementSize));
  // Payload length is the declared dataSize; a negative/garbage declared field falls back to the
  // computed count*size (consistent with the inline decision below).
  const payloadSize = declaredDataSize >= 0 ? declaredDataSize : computedDataSize;
  // Inline iff dataSize <= 4; fall back to computed size only for an invalid declared field.
  const inline = declaredDataSize >= 0 ? declaredDataSize <= 4 : computedDataSize <= 4;
  // Reconcile the element count down to what the payload holds, and never expose a negative count
  // (a malformed numElements would otherwise crash Array/TypedArray helpers downstream). When
  // elementSize <= 0 the per-element stride is unknown, so cap by payloadSize (≤ 1 byte/element)
  // rather than trusting the raw count — otherwise a typed getter reads past a 0-byte payload.
  const elementCount = Math.max(
    0,
    elementSize > 0
      ? Math.min(rawElementCount, Math.floor(payloadSize / elementSize))
      : Math.min(rawElementCount, payloadSize),
  );

  let payload: Uint8Array;
  let dataOffset: number;
  if (inline) {
    dataOffset = -1;
    payload = new Uint8Array(subview(bytes, off + 20, Math.min(4, payloadSize)));
  } else {
    dataOffset = view.getInt32(off + 20, false);
    const at = base + dataOffset;
    if (dataOffset < 0 || at + payloadSize > bytes.byteLength) {
      throw new Error(
        `Entry ${tagName}${tagNumber}: payload out of bounds (offset=${dataOffset}, size=${payloadSize})`,
      );
    }
    payload = new Uint8Array(subview(bytes, at, payloadSize));
  }

  // The raw 4 bytes of the data/offset slot, verbatim (payload+padding when inline, offset when external).
  const dataOffsetBytes = new Uint8Array(subview(bytes, off + 20, 4));

  return {
    tagName,
    tagNumber,
    elementType,
    elementSize,
    elementCount,
    payload,
    dataHandle,
    raw: { elementCount: rawElementCount, dataSize: declaredDataSize, dataOffset, inline, dataOffsetBytes },
  };
}

/**
 * Serialize an AbifFile back to a Uint8Array.
 *
 * Layout produced: header (128 B) + directory (N*28 B) + payload block.
 * External payloads are packed tightly in entry order. Payloads <= 4 bytes are
 * stored inline inside their directory entry.
 *
 * Meaning-lossless, not byte-exact: the payload bytes, tag fields and dataSize
 * (= payload length) round-trip, but physical layout does not — payloads are
 * repacked, directory/header padding and any MacBinary preamble are dropped. A
 * byte-exact layout-preserving mode is a possible future opt-in.
 */
export function writeAbif(file: AbifFile): Uint8Array {
  const numEntries = file.entries.length;
  const dirOffset = HEADER_SIZE;
  const dirSize = numEntries * ENTRY_SIZE;

  // Compute external payload offsets. The payload bytes are authoritative: dataSize
  // written = payload.byteLength (may differ from count*size for user/opaque types).
  let payloadCursor = dirOffset + dirSize;
  const externalOffsets: number[] = new Array(numEntries);
  for (let i = 0; i < numEntries; i++) {
    const dataSize = file.entries[i].payload.byteLength;
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
  const dataSize = externalDataSize ?? e.payload.byteLength;
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
    throw new Error(`upsertEntry ${name}${number}: payload length ${payload.byteLength} != count*size`);
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
