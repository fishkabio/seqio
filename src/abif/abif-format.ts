/**
 * Raw layer: the ABIF byte<->struct codec. Every directory entry (including unknown
 * vendor tags) is preserved as a raw payload (Uint8Array), and writeAbif() reproduces
 * the original bytes exactly for an unmodified round-trip (see its own doc comment).
 * The domain layer (view.ts, setters.ts, parser.ts, abif-op-*.ts) provides typed,
 * format-aware access on top of this — this file knows nothing about what any tag
 * means.
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
import { AbifByteRange, AbifDirectory, AbifEntry, AbifEntryRaw, AbifFile } from './types';

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
 * Byte-exact on an unmodified round-trip for well-formed records and the tolerated
 * count/dataSize desyncs readAbif() accepts: readAbif() followed right back by
 * writeAbif(), with nothing touched in between, reproduces the original bytes
 * exactly (a MacBinary-wrapped input round-trips its ABIF payload byte-exact, but
 * the preamble itself is never re-added — see the AGENTS.md note on why). The one
 * exception is a genuinely invalid negative `dataSize`/`numElements` field (readAbif
 * tolerates these defensively, falling back to a computed size, but never treats them
 * as verbatim-eligible on write — see the byteLength check below) — such an entry
 * round-trips meaning-lossless (correct payload/content) but its declared dataSize
 * field gets normalized to the real payload length rather than reproducing the
 * original garbage value.
 *
 * This works by keeping every entry whose payload size hasn't changed since it was
 * read (`entry.raw` present — upsertEntry() clears it on any mutation — and
 * `payload.byteLength === raw.dataSize`) at its exact original directory slot and
 * file offset, writing the *original* on-disk numElements/dataSize/offset-or-inline-
 * padding instead of the reconciled/current ones. A new or resized entry is appended
 * past the highest byte offset still known to hold preserved content (every verbatim
 * entry's span, the directory, and any unreferenced range); only its own directory
 * record changes, so every other entry's bytes stay untouched. A resized/removed
 * entry's *old* span is not itself reserved — nothing points at it anymore, so it is
 * free to be reused by whatever gets appended next; the output is not padded out to
 * the original file's true end.
 *
 * The directory is kept at its original file offset as long as the entry count
 * didn't grow (removing entries just shortens it in place; the original directory
 * padding is only reused when the count is exactly unchanged, since a shorter
 * directory can't reuse padding sized for more entries). Only a growing entry count
 * relocates the whole directory to freshly appended space.
 */
export function writeAbif(file: AbifFile): Uint8Array {
  const base = file.macBinaryOffset;
  const numEntries = file.entries.length;
  const originalCount = file.tdir.entryCount;

  // An entry is verbatim-eligible when its payload is exactly the size it was read
  // at — the only case where its original directory record/offset can be reused.
  const verbatimRaw: Array<AbifEntryRaw | undefined> = file.entries.map(e =>
    e.raw && e.payload.byteLength === e.raw.dataSize ? e.raw : undefined,
  );

  // Anchor: the highest byte offset known to belong to the original (unwrapped)
  // file — header, directory span, every verbatim entry's external payload, and any
  // orphan byte range. Fresh content is appended after this, so an unmodified
  // round-trip never appends anything and the output ends exactly here.
  let anchor = HEADER_SIZE;
  // A malformed original can declare tdir.dataSize smaller than the entries actually occupy
  // (readAbif trusts numElements over dataSize — see the "desynced tdir.dataSize" test); the
  // *physical* directory span must still be protected even though the reused dataSize field
  // below intentionally reproduces the original (desynced) declared value byte-for-byte.
  anchor = Math.max(anchor, file.tdir.dataOffset + Math.max(file.tdir.dataSize, originalCount * ENTRY_SIZE));
  for (const raw of verbatimRaw) {
    if (raw && !raw.inline) anchor = Math.max(anchor, raw.dataOffset + raw.dataSize);
  }
  for (const r of file.unreferencedRanges) {
    anchor = Math.max(anchor, r.offset - base + r.bytes.length);
  }

  // Directory placement: reuse the original slot unless the entry count grew past it.
  const dirGrew = numEntries > originalCount;
  let cursor = anchor;
  const dirOffset = dirGrew ? cursor : file.tdir.dataOffset;
  const dirDataSize = numEntries === originalCount ? file.tdir.dataSize : numEntries * ENTRY_SIZE;
  if (dirGrew) cursor += dirDataSize;

  // Fresh (non-verbatim) external payloads are appended past the anchor, in entry order.
  const freshOffsets: number[] = new Array(numEntries);
  for (let i = 0; i < numEntries; i++) {
    const size = file.entries[i].payload.byteLength;
    if (verbatimRaw[i] || size <= 4) {
      freshOffsets[i] = -1; // reused verbatim placement, or inline — no fresh external slot
      continue;
    }
    freshOffsets[i] = cursor;
    cursor += size;
  }

  const out = new Uint8Array(cursor);
  const outView = asDataView(out);

  // Header: "ABIF" + version (int16 BE) + tdir entry (below) + reserved bytes verbatim.
  out.set(asciiBytes('ABIF'), 0);
  outView.setInt16(4, file.version, false);
  out.set(file.headerReserved, 6 + ENTRY_SIZE);
  writeDirRecord(out, outView, 6, {
    tagName: 'tdir',
    tagNumber: file.tdir.tagNumber,
    elementType: file.tdir.elementType,
    elementSize: file.tdir.entrySize,
    elementCount: numEntries,
    dataSize: dirDataSize,
    dataHandle: file.tdir.dataHandle,
    offsetSlot: { kind: 'external', value: dirOffset },
  });

  // Directory padding only carries over when the entry count is exactly unchanged.
  if (numEntries === originalCount && file.tdir.paddingBytes.length > 0) {
    out.set(file.tdir.paddingBytes, dirOffset + numEntries * ENTRY_SIZE);
  }

  for (let i = 0; i < numEntries; i++) {
    const e = file.entries[i];
    const raw = verbatimRaw[i];
    const off = dirOffset + i * ENTRY_SIZE;
    const dataSize = e.payload.byteLength;
    writeDirRecord(out, outView, off, {
      tagName: e.tagName,
      tagNumber: e.tagNumber,
      elementType: e.elementType,
      elementSize: e.elementSize,
      elementCount: raw ? raw.elementCount : e.elementCount,
      dataSize: raw ? raw.dataSize : dataSize,
      dataHandle: e.dataHandle,
      offsetSlot:
        dataSize <= 4
          ? { kind: 'inline', payload: e.payload, dataSize, staleTail: raw?.dataOffsetBytes }
          : { kind: 'external', value: raw ? raw.dataOffset : freshOffsets[i] },
    });
    if (dataSize > 4) {
      out.set(e.payload, raw ? raw.dataOffset : freshOffsets[i]);
    }
  }

  for (const r of file.unreferencedRanges) {
    out.set(r.bytes, r.offset - base);
  }

  return out;
}

type OffsetSlot =
  | { kind: 'external'; value: number }
  | { kind: 'inline'; payload: Uint8Array; dataSize: number; staleTail?: Uint8Array };

function writeDirRecord(
  out: Uint8Array,
  outView: DataView,
  off: number,
  rec: {
    tagName: string;
    tagNumber: number;
    elementType: number;
    elementSize: number;
    elementCount: number;
    dataSize: number;
    dataHandle: number;
    offsetSlot: OffsetSlot;
  },
): void {
  if (rec.tagName.length !== 4) {
    throw new Error(`tagName must be 4 chars: "${rec.tagName}"`);
  }
  out.set(asciiBytes(rec.tagName), off);
  outView.setInt32(off + 4, rec.tagNumber, false);
  outView.setInt16(off + 8, rec.elementType, false);
  outView.setInt16(off + 10, rec.elementSize, false);
  outView.setInt32(off + 12, rec.elementCount, false);
  outView.setInt32(off + 16, rec.dataSize, false);
  if (rec.offsetSlot.kind === 'external') {
    outView.setInt32(off + 20, rec.offsetSlot.value, false);
  } else {
    // Inline: clear 4 bytes, place the payload, then restore any stale tail byte(s)
    // beyond dataSize from the original slot — a byte-exact round-trip needs them,
    // since they're not derivable from any semantic field.
    const { payload, dataSize, staleTail } = rec.offsetSlot;
    out.fill(0, off + 20, off + 24);
    out.set(payload.subarray(0, dataSize), off + 20);
    if (staleTail && dataSize < 4) {
      out.set(staleTail.subarray(dataSize, 4), off + 20 + dataSize);
    }
  }
  outView.setInt32(off + 24, rec.dataHandle, false);
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
 *
 * This is the required way to mutate an entry read from a file — it clears `.raw`
 * on replacement so writeAbif() never reuses a now-stale on-disk shape. Setting
 * `entry.payload`/`elementType`/`elementSize`/`elementCount` directly instead
 * leaves `.raw` behind and can corrupt the written directory record.
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
    // `raw` describes the entry's shape as read from disk; once mutated it no longer applies —
    // clearing it forces writeAbif() to place this entry fresh rather than reuse a stale record
    // (e.g. a same-length content edit would otherwise silently keep the old elementCount/dataSize).
    existing.raw = undefined;
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
