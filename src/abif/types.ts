/**
 * Low-level ABIF file model: a flat list of directory entries with raw
 * payloads. Lossless round-trip is preserved: every entry (including unknown
 * vendor tags) is kept as a raw payload, so a subsequent writeAbif() reproduces
 * the same meaning.
 */
export interface AbifFile {
  /** ABIF version, e.g. 101 for v1.01. */
  version: number;
  /** The root directory (tdir) header, exactly as read — including any directory padding it declares. */
  tdir: AbifDirectory;
  /** Directory entries in the original on-disk order. */
  entries: AbifEntry[];
  /** MacBinary preamble offset (128 if present, 0 otherwise). Preserved for diagnostics. */
  macBinaryOffset: number;
  /**
   * The 128-byte MacBinary preamble, verbatim — present only when {@link macBinaryOffset} is 128.
   * Exposed so a raw reader can reproduce the wrapper, not just note that it existed.
   */
  macBinaryHeader?: Uint8Array;
  /**
   * Reserved header bytes [34..127] (94 bytes), verbatim. Usually zeros; exposed so a raw reader
   * keeps the entire 128-byte header, not just magic/version/tdir.
   */
  headerReserved: Uint8Array;
  /**
   * Physical byte ranges not covered by the header, directory, or any entry payload — orphaned
   * blocks left by editing tools, trailing padding, etc. Empty for a tightly-packed file. Exposed
   * so a raw reader accounts for every byte; the chromatogram never depends on these.
   */
  unreferencedRanges: AbifByteRange[];
}

/** A contiguous run of file bytes at an absolute offset — used for {@link AbifFile.unreferencedRanges}. */
export interface AbifByteRange {
  /** Absolute offset from the start of the file (includes any MacBinary preamble). */
  offset: number;
  /** The bytes in this range, verbatim. `bytes.length` is the range length. */
  bytes: Uint8Array;
}

export interface AbifEntry {
  /** 4-character tag name, e.g. "DATA", "PBAS". */
  tagName: string;
  /** Tag number, e.g. 1 or 2 for PBAS1 / PBAS2. */
  tagNumber: number;
  /** ABIF element type code (1=byte, 2=char, 3=word, 4=short, 5=long, 7=float,
   *  8=double, 10=date, 11=time, 13=bool, 18=pString, 19=cString,
   *  1023=tdir, ≥1024=user-defined). */
  elementType: number;
  /** Bytes per element. */
  elementSize: number;
  /** Number of elements (reconciled: clamped to what the payload holds). */
  elementCount: number;
  /**
   * Raw payload bytes. Length === the on-disk `dataSize` (the authoritative field), which for
   * user/opaque types may differ from `elementCount * elementSize`.
   */
  payload: Uint8Array;
  /** Opaque dataHandle field, usually 0. Preserved for round-trip. */
  dataHandle: number;
  /**
   * The directory fields exactly as they were on disk — present only when this entry was read from a
   * file (absent for entries synthesized by setters/writeAbif). Lets consumers inspect the real record
   * without our reconciliation.
   */
  raw?: AbifEntryRaw;
}

/** A directory entry's on-disk fields, verbatim, before any reconciliation applied by {@link readAbif}. */
export interface AbifEntryRaw {
  /** `elementCount` (numElements) as written on disk. */
  elementCount: number;
  /** `dataSize` field as written on disk, in bytes. */
  dataSize: number;
  /** External payload offset relative to the ABIF start, or -1 when the payload is inline. */
  dataOffset: number;
  /** Whether the payload was stored inline (declared dataSize ≤ 4). */
  inline: boolean;
  /**
   * The 4 raw bytes of the dataOffset/data slot, verbatim. For an external entry these are the
   * big-endian offset; for an inline entry they are the value bytes plus any padding/stale bytes
   * beyond `dataSize` — exposed so a raw reader loses no structure.
   */
  dataOffsetBytes: Uint8Array;
}

/**
 * The root directory (`tdir`) header — the header's own directory entry, describing the directory
 * block. Its fields are exposed like any other raw entry so a raw reader never loses them, even when
 * `rawEntryCount` desyncs from `dataSize`.
 */
export interface AbifDirectory {
  /** Effective number of entries actually read — equals `entries.length`. */
  entryCount: number;
  /** tdir `numElements` verbatim, before reconciliation; the authoritative on-disk entry count. */
  rawEntryCount: number;
  /** tdir `elementType` (1023). */
  elementType: number;
  /** tdir `tagNumber` (usually 1). */
  tagNumber: number;
  /** Bytes per directory entry (always 28). */
  entrySize: number;
  /**
   * Directory block size in bytes, from the tdir `dataSize` field. May exceed `entryCount * 28`
   * when the file carries directory padding / extra bytes.
   */
  dataSize: number;
  /** File offset (relative to the ABIF start) where the directory block begins. */
  dataOffset: number;
  /** The 4 raw bytes of the tdir's dataOffset field, verbatim. */
  dataOffsetBytes: Uint8Array;
  /** tdir `dataHandle` field, usually 0. */
  dataHandle: number;
  /**
   * The raw directory-padding bytes: everything from the end of the last entry to the end of the
   * directory block (`dataSize - entryCount*28`). Usually zeros; exposed so a raw reader keeps the
   * whole directory structure, not just the entries.
   */
  paddingBytes: Uint8Array;
}

export interface ChannelSignals {
  A: number[];
  C: number[];
  G: number[];
  T: number[];
}

/** Spec-defined role of a DATA<n> tag — see {@link dataChannelRole}. */
export type AbifDataChannelRole = 'trace' | 'telemetry' | 'other';

/** Per-base chromatogram view. */
export interface Chromatogram {
  /** Per-base peak position in sample points (from PLOC). */
  positions: number[];
  /** Four channels of signal values, aligned with sample points. */
  signals: ChannelSignals;
  /** Per-base Phred-like quality scores (0..100), from PCON. */
  confidences?: number[];
  /** Average peak spacing (samples per base), from SPAC. */
  samplingRate?: number;
}

/**
 * One basecall version exactly as the file stores it. ABIF numbers the
 * PBAS/PCON/PLOC tags by version, and the spec fixes what each number means:
 *
 *   - version 2 (`role: 'called'`) — the sequence as produced by the basecaller.
 *   - version 1 (`role: 'edited'`) — the sequence after user hand-editing.
 *   - any other version (`role: 'unknown'`) — the spec only defines 1 and 2, so
 *     a vendor/future PBAS3+ is surfaced without a claimed role.
 *
 * A file may carry either or both, and the two can differ in content and even in
 * length (edits insert/delete bases). {@link parseAbif} exposes every version it
 * finds via {@link ParsedAbif.baseCallVariants} — picking which one to show or
 * export is the consumer's call, not the parser's.
 */
export type AbifBaseCallRole = 'called' | 'edited' | 'unknown';

export interface AbifBaseCallVariant {
  /** Tag number of the PBAS/PCON/PLOC this variant came from (1, 2, or a vendor number). */
  version: number;
  /** Spec-defined role by tag number: 2 = basecaller-called, 1 = user-edited, else unknown. */
  role: AbifBaseCallRole;
  /** Bases from PBAS<version> as stored — case preserved, trailing NULs stripped, not normalized. */
  sequence: string;
  /** Per-base Q-scores from PCON<version>; `[]` when that version has no PCON. */
  confidences: number[];
  /** Per-base peak positions (sample indices) from PLOC<version>; `[]` when absent. */
  positions: number[];
}

/**
 * Convenience pointer to the preferred basecall version — the called one (PBAS2)
 * when present, else whatever single version the file has. This is a spec-role
 * choice (called over edited), not a quality judgement; see
 * {@link ParsedAbif.baseCallVariants} for every version the file actually carries.
 */
export interface AbifBaseCalls {
  /** Called bases (uppercase). */
  sequence: string;
  /** Per-base Q-score / confidence (PCON). */
  confidences: number[];
  /** Per-base peak positions in sample points (PLOC). */
  positions: number[];
  /** Which PBAS version was selected (1 or 2). */
  pbasVersion: number;
}

/** Optional metadata extracted from well-known tags. */
export interface AbifMetadata {
  sampleName?: string;
  laneNumber?: number;
  tube?: string;
  machineName?: string;
  machineModel?: string;
  runDate?: string;
  runTime?: string;
  samplingRate?: number;
  /**
   * Value of the RevC1 flag: whether the file declares its sequence already
   * reverse-complemented. undefined when the tag is absent. Reported as-is — the
   * consumer decides what to do with it.
   */
  reverseComplemented?: boolean;
  comments: string[];
}

/**
 * All DATA channels plus FWO_-aware A/C/G/T views of the two dye-trace blocks.
 *
 * The block views are named after their on-disk tag ranges — nothing more. Which
 * block is "raw" and which is "analyzed / processed" is an instrument-and-tool
 * convention that the ABIF file does NOT state, so this parser refuses to label
 * it. The consumer that needs to tell them apart has the primitives to decide:
 * the per-block sample counts (channel lengths) and the basecall peak positions
 * ({@link AbifBaseCalls.positions}); e.g. positions that overflow one block's
 * length can only belong to the other.
 *
 * Per the ABIF spec, DATA5..8 are instrument telemetry (voltage / current / power
 * / temperature), NOT dye traces — see {@link dataChannelRole}. They live in
 * {@link dataChannels} but are excluded from the A/C/G/T views.
 */
export interface AbifChromatogramBundle {
  /** FWO_ value (e.g. "GATC"). */
  baseOrder: string;
  /** All DATA tags by tagNumber → trace (dye traces AND telemetry). */
  dataChannels: Record<number, number[]>;
  /** DATA1..4 mapped to A/C/G/T by FWO_. */
  data1To4: ChannelSignals;
  /** DATA9..12 mapped to A/C/G/T by FWO_; empty when the file has no 9..12 block. */
  data9To12: ChannelSignals;
}

/** Rich result from {@link parseAbif} — everything the typical viewer needs. */
export interface ParsedAbif {
  fileName: string;
  fileSize: number;
  abifVersion: number;
  macBinaryOffset: number;
  dirEntryCount: number;
  metadata: AbifMetadata;
  chromatogram: AbifChromatogramBundle;
  /** Preferred basecall version (called over edited); convenience over {@link baseCallVariants}. */
  baseCalls?: AbifBaseCalls;
  /** Every basecall version the file carries (called and/or edited), in version order. */
  baseCallVariants: AbifBaseCallVariant[];
  /** All directory entries with their decoded payloads (best-effort by type). */
  entries: AbifDirEntry[];
}

/** A directory entry with a typed decoded value alongside the raw payload. */
export interface AbifDirEntry {
  /** 4-character tag name, e.g. "DATA". */
  tag: string;
  tagNumber: number;
  elementType: number;
  elementTypeName: string;
  elementSize: number;
  /** Reconciled element count (clamped to the declared dataSize when it was smaller). */
  elementCount: number;
  /** `numElements` exactly as written on disk, before reconciliation. */
  rawElementCount: number;
  /** `dataSize` as written on disk, in bytes (not recomputed). */
  dataSize: number;
  /** External payload offset relative to the ABIF start, or -1 when the payload is inline. */
  dataOffset: number;
  /** Whether the payload was stored inline (declared dataSize ≤ 4). */
  inline: boolean;
  decoded: AbifDecodedValue;
  preview: string;
}

export type AbifDecodedValue =
  | { kind: 'number'; value: number }
  | { kind: 'numbers'; value: number[] }
  | { kind: 'string'; value: string }
  | { kind: 'bools'; value: boolean[] }
  | { kind: 'date'; value: { year: number; month: number; day: number } }
  | { kind: 'time'; value: { hour: number; minute: number; second: number; hsec: number } }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'unknown'; value: Uint8Array };
