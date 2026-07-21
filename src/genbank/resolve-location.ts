import { GenbankLocation, GenbankPosition, GenbankTopology } from './types';

/** Reading strand of a resolved segment: 1 for the top strand, -1 for the complement. */
export type Strand = 1 | -1;

/**
 * A contiguous genomic span in internal coordinates: 0-based, half-open `[start, end)`.
 * GenBank's 1-based inclusive positions are converted here so the rest of the app never re-derives them.
 */
export interface LocationSegment {
  /** 0-based inclusive start offset (the lower genomic coordinate). */
  start: number;
  /** 0-based exclusive end offset (the higher genomic coordinate). */
  end: number;
  /** Reading strand of this segment. */
  strand: Strand;
  /** The genomic start (`start`) bound was fuzzy (`<`, `within`, `one-of`); annotates the coordinate, not a 5' end. */
  fuzzyStart: boolean;
  /** The genomic end (`end`) bound was fuzzy (`>`, `within`, `one-of`); annotates the coordinate, not a 3' end. */
  fuzzyEnd: boolean;
  /** The segment came from splitting an origin-spanning (circular) span. */
  wrapped: boolean;
}

/** Overall geometry class of a resolved location. */
export type ResolvedLocationKind = 'interval' | 'point' | 'boundary' | 'set' | 'unresolved';

/** A GenBank location expression resolved to concrete genomic coordinates. */
export interface ResolvedLocation {
  /** Segments in 5'->3' reading order (complement already reverses order and flips strand). */
  segments: LocationSegment[];
  /** Geometry class derived from the resolved segments. */
  kind: ResolvedLocationKind;
  /** Overall strand; 0 when segments mix strands (e.g. trans-splicing). */
  strand: Strand | 0;
  /** Minimum 0-based start across segments, or -1 when nothing resolved. */
  min: number;
  /** Maximum 0-based exclusive end across segments, or -1 when nothing resolved. */
  max: number;
  /** The expression contained remote/unparsed/unknown parts that could not be placed. */
  unresolved: boolean;
  /** A position fell outside `[1, length]` and was clamped; the geometry is shown but should not be trusted as-is. */
  clamped: boolean;
}

/** Context needed to place a location: the record length and topology. */
export interface ResolveLocationContext {
  /** Sequence length in bases; used for clamping and circular wrap. 0 disables clamping. */
  length: number;
  /** Molecule topology; only `circular` allows origin-spanning (start > end) ranges. */
  topology?: GenbankTopology;
}

interface PositionValue {
  value?: number;
  fuzzy: boolean;
}

interface Collected {
  segments: LocationSegment[];
  unresolved: boolean;
  clamped: boolean;
}

const EMPTY: Collected = { segments: [], unresolved: true, clamped: false };

/** Pick a representative numeric value for a position, widening fuzzy positions toward the given role. */
function positionValue(position: GenbankPosition, role: 'start' | 'end'): PositionValue {
  switch (position.kind) {
    case 'exact':
      return { value: position.value, fuzzy: false };
    case 'before':
    case 'after':
      return { value: position.value, fuzzy: true };
    case 'within':
    case 'one-of': {
      const values = position.values ?? [];
      if (values.length === 0) return { fuzzy: true };
      return { value: role === 'end' ? Math.max(...values) : Math.min(...values), fuzzy: true };
    }
    default:
      return { fuzzy: true };
  }
}

function flip(strand: Strand): Strand {
  return strand === 1 ? -1 : 1;
}

/** Clamp a 0-based inclusive index into the sequence; a falsy length only pins the negative floor. */
function clampIndex(index: number, length: number): number {
  const nonNegative = Math.max(0, index);
  return length > 0 ? Math.min(nonNegative, length - 1) : nonNegative;
}

/** Clamp a 0-based exclusive end into the sequence; a boundary may sit at `length`. */
function clampEnd(end: number, length: number): number {
  const nonNegative = Math.max(0, end);
  return length > 0 ? Math.min(nonNegative, length) : nonNegative;
}

function collectPoint(position: GenbankPosition, strand: Strand, context: ResolveLocationContext): Collected {
  const { value, fuzzy } = positionValue(position, 'start');
  if (value === undefined) return EMPTY;
  const rawStart = value - 1;
  const start = clampIndex(rawStart, context.length);
  return {
    segments: [{ start, end: start + 1, strand, fuzzyStart: fuzzy, fuzzyEnd: fuzzy, wrapped: false }],
    unresolved: false,
    clamped: start !== rawStart,
  };
}

function collectBetween(
  left: GenbankPosition,
  right: GenbankPosition,
  strand: Strand,
  context: ResolveLocationContext,
): Collected {
  const leftValue = positionValue(left, 'start');
  const rightValue = positionValue(right, 'end');
  if (leftValue.value === undefined || rightValue.value === undefined) return EMPTY;
  // Between positions reference real 1-based bases; a left position below 1 is malformed.
  if (leftValue.value < 1) return EMPTY;
  // `a^b` is only meaningful when b immediately follows a, or wraps the origin on a circular molecule.
  const originWrap = context.topology === 'circular' && leftValue.value === context.length && rightValue.value === 1;
  const adjacent = rightValue.value === leftValue.value + 1;
  if (!adjacent && !originWrap) return EMPTY;
  // The boundary just after 1-based base a sits at 0-based offset a; the circular origin wrap canonicalises to 0.
  const at = originWrap ? 0 : clampEnd(leftValue.value, context.length);
  return {
    segments: [
      { start: at, end: at, strand, fuzzyStart: leftValue.fuzzy, fuzzyEnd: rightValue.fuzzy, wrapped: originWrap },
    ],
    unresolved: false,
    clamped: !originWrap && at !== leftValue.value,
  };
}

function collectRange(
  startPos: GenbankPosition,
  endPos: GenbankPosition,
  strand: Strand,
  context: ResolveLocationContext,
): Collected {
  const startValue = positionValue(startPos, 'start');
  const endValue = positionValue(endPos, 'end');
  if (startValue.value === undefined || endValue.value === undefined) return EMPTY;
  const { length } = context;

  // Normal range: start <= end.
  if (startValue.value <= endValue.value) {
    const rawStart = startValue.value - 1;
    const rawEnd = endValue.value;
    const start = clampIndex(rawStart, length);
    const end = clampEnd(rawEnd, length);
    return {
      segments: [{ start, end, strand, fuzzyStart: startValue.fuzzy, fuzzyEnd: endValue.fuzzy, wrapped: false }],
      unresolved: false,
      clamped: start !== rawStart || end !== rawEnd,
    };
  }

  // start > end is only valid for circular molecules: the span wraps across the origin.
  if (context.topology !== 'circular' || length <= 0) return EMPTY;
  const rawStart = startValue.value - 1;
  const rawEnd = endValue.value;
  const start = clampIndex(rawStart, length);
  const end = clampEnd(rawEnd, length);
  return {
    segments: [
      { start, end: length, strand, fuzzyStart: startValue.fuzzy, fuzzyEnd: false, wrapped: true },
      { start: 0, end, strand, fuzzyStart: false, fuzzyEnd: endValue.fuzzy, wrapped: true },
    ],
    unresolved: false,
    clamped: start !== rawStart || end !== rawEnd,
  };
}

function collectOperator(location: GenbankLocation, strand: Strand, context: ResolveLocationContext): Collected {
  if (location.kind !== 'operator') return EMPTY;
  const operator = location.operator.toLowerCase();
  const complement = operator === 'complement';
  const known = complement || operator === 'join' || operator === 'order';
  // An operator we don't understand may reorder or reinterpret its parts; its child geometry can't be trusted.
  if (!known || location.parts.length === 0) return EMPTY;

  const childStrand = complement ? flip(strand) : strand;
  const segments: LocationSegment[] = [];
  let unresolved = false;
  let clamped = false;
  for (const part of location.parts) {
    const collected = collect(part, childStrand, context);
    segments.push(...collected.segments);
    unresolved = unresolved || collected.unresolved;
    clamped = clamped || collected.clamped;
  }
  // complement reads its child 3'->5', so the concatenated reading order reverses.
  if (complement) segments.reverse();
  return { segments, unresolved, clamped };
}

function collect(location: GenbankLocation, strand: Strand, context: ResolveLocationContext): Collected {
  switch (location.kind) {
    case 'point':
      return collectPoint(location.position, strand, context);
    case 'range':
      return collectRange(location.start, location.end, strand, context);
    case 'between':
      return collectBetween(location.left, location.right, strand, context);
    case 'operator':
      return collectOperator(location, strand, context);
    default:
      // remote / unparsed cannot be placed on this molecule.
      return EMPTY;
  }
}

/**
 * Resolve a parsed GenBank location AST into concrete 0-based half-open segments.
 * Segments come back in reading order; use `min`/`max` for a bounding box and `strand`/`kind` for display.
 */
export function resolveGenbankLocation(location: GenbankLocation, context: ResolveLocationContext): ResolvedLocation {
  const { segments, unresolved, clamped } = collect(location, 1, context);
  if (segments.length === 0) {
    return { segments: [], kind: 'unresolved', strand: 0, min: -1, max: -1, unresolved: true, clamped };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let hasPlus = false;
  let hasMinus = false;
  for (const segment of segments) {
    if (segment.start < min) min = segment.start;
    if (segment.end > max) max = segment.end;
    if (segment.strand === 1) hasPlus = true;
    else hasMinus = true;
  }

  const strand: Strand | 0 = hasPlus && hasMinus ? 0 : hasPlus ? 1 : -1;
  let kind: ResolvedLocationKind;
  if (segments.length > 1) {
    kind = 'set';
  } else {
    const span = segments[0].end - segments[0].start;
    kind = span === 0 ? 'boundary' : span === 1 ? 'point' : 'interval';
  }

  return { segments, kind, strand, min, max, unresolved, clamped };
}
