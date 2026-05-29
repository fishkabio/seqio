/**
 * Low-level ABIF file model: a flat list of directory entries with raw
 * payloads. Lossless round-trip is preserved: every entry (including unknown
 * vendor tags) is kept as a raw payload, so a subsequent writeAbif() reproduces
 * the same meaning.
 */
export interface AbifFile {
  /** ABIF version, e.g. 101 for v1.01. */
  version: number;
  /** Directory entries in the original on-disk order. */
  entries: AbifEntry[];
  /** MacBinary preamble offset (128 if present, 0 otherwise). Preserved for diagnostics. */
  macBinaryOffset: number;
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
  /** Number of elements. */
  elementCount: number;
  /** Raw payload bytes (length === elementCount * elementSize). */
  payload: Uint8Array;
  /** Opaque dataHandle field, usually 0. Preserved for round-trip. */
  dataHandle: number;
}

export interface ChannelSignals {
  A: number[];
  C: number[];
  G: number[];
  T: number[];
}

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

/** Basecalls extracted from PBAS/PCON/PLOC under the chosen version. */
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
  comments: string[];
}

/**
 * Full chromatogram bundle: all DATA channels, plus FWO_-aware A/C/G/T views.
 *
 * The two block views are named after their on-disk tag number ranges. Their
 * semantic content varies by instrument:
 *
 *   - DATA1..4  — on modern KB-basecaller-aware instruments (3130, 3500,
 *                  3730) these are POST-PROCESSED traces (mobility-corrected,
 *                  baseline-subtracted, color-separated). Basecallers operate
 *                  on these. On older simpler instruments DATA1..4 IS the raw
 *                  fluorescence.
 *   - DATA9..12 — RAW fluorescence on instruments that produce both blocks.
 *                  Absent on instruments that only write DATA1..8.
 *
 * Use {@link hasProcessedTraces} (data9To12 present) to detect whether
 * DATA1..4 has already been processed and bypass your own baseline/color
 * steps accordingly.
 */
export interface AbifChromatogramBundle {
  /** FWO_ value (e.g. "GATC"). */
  baseOrder: string;
  /** All DATA tags by tagNumber → trace. */
  dataChannels: Record<number, number[]>;
  /** DATA1..4 mapped to A/C/G/T by FWO_. Post-processed on newer instruments, raw on older. */
  data1To4: ChannelSignals;
  /** DATA9..12 mapped to A/C/G/T by FWO_. Raw fluorescence; absent on older instruments. */
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
  baseCalls?: AbifBaseCalls;
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
  elementCount: number;
  dataSize: number;
  dataOffset: number;
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
