import { parseGenbankLocation } from '../../src/genbank/location';
import { ResolvedLocation, resolveGenbankLocation } from '../../src/genbank/resolve-location';
import { GenbankTopology } from '../../src/genbank/types';

/** Parse a GenBank location expression and resolve it against a molecule of the given length/topology. */
function resolve(expression: string, length: number, topology: GenbankTopology = 'linear'): ResolvedLocation {
  const { location } = parseGenbankLocation(expression);
  return resolveGenbankLocation(location, { length, topology });
}

describe('resolveGenbankLocation', () => {
  it('resolves a plus-strand range to a single 0-based half-open interval', () => {
    const result = resolve('1..20', 540);
    expect(result.kind).toBe('interval');
    expect(result.strand).toBe(1);
    expect(result.segments).toEqual([
      { start: 0, end: 20, strand: 1, fuzzyStart: false, fuzzyEnd: false, wrapped: false },
    ]);
    expect([result.min, result.max]).toEqual([0, 20]);
    expect(result.unresolved).toBe(false);
  });

  it('resolves a single-base point', () => {
    const result = resolve('81', 540);
    expect(result.kind).toBe('point');
    expect(result.segments).toEqual([
      { start: 80, end: 81, strand: 1, fuzzyStart: false, fuzzyEnd: false, wrapped: false },
    ]);
  });

  it('flips strand for complement without moving coordinates', () => {
    const result = resolve('complement(505..538)', 540);
    expect(result.kind).toBe('interval');
    expect(result.strand).toBe(-1);
    expect(result.segments).toEqual([
      { start: 504, end: 538, strand: -1, fuzzyStart: false, fuzzyEnd: false, wrapped: false },
    ]);
  });

  it('keeps join parts in ascending reading order on the plus strand', () => {
    const result = resolve('join(1..100,200..300)', 540);
    expect(result.kind).toBe('set');
    expect(result.strand).toBe(1);
    expect(result.segments.map(s => [s.start, s.end])).toEqual([
      [0, 100],
      [199, 300],
    ]);
    expect([result.min, result.max]).toEqual([0, 300]);
  });

  it('reverses reading order and flips strand for complement(join(...))', () => {
    const result = resolve('complement(join(1..100,200..300))', 540);
    expect(result.kind).toBe('set');
    expect(result.strand).toBe(-1);
    // Reading 3'->5': the higher segment comes first, each on the minus strand.
    expect(result.segments.map(s => [s.start, s.end, s.strand])).toEqual([
      [199, 300, -1],
      [0, 100, -1],
    ]);
    expect([result.min, result.max]).toEqual([0, 300]);
  });

  it('places a between location as a zero-length boundary after the left base', () => {
    const result = resolve('2^3', 540);
    expect(result.kind).toBe('boundary');
    expect(result.segments).toEqual([
      { start: 2, end: 2, strand: 1, fuzzyStart: false, fuzzyEnd: false, wrapped: false },
    ]);
  });

  it('rejects a between location whose bases are not adjacent', () => {
    const result = resolve('2^9', 540);
    expect(result.kind).toBe('unresolved');
    expect(result.segments).toEqual([]);
  });

  it('rejects a between location with a sub-1 base position', () => {
    expect(resolve('0^1', 540).kind).toBe('unresolved');
  });

  it('canonicalises a circular origin-wrap boundary (length^1) to offset 0', () => {
    const result = resolve('540^1', 540, 'circular');
    expect(result.kind).toBe('boundary');
    expect(result.segments).toEqual([
      { start: 0, end: 0, strand: 1, fuzzyStart: false, fuzzyEnd: false, wrapped: true },
    ]);
    expect(result.clamped).toBe(false);
  });

  it('reverses nested complement composition', () => {
    // complement(join(complement(1..100),200..300)): inner complement(1..100) is plus again.
    const result = resolve('complement(join(complement(1..100),200..300))', 540);
    expect(result.strand).toBe(0); // mixes strands: 1..100 stays plus, 200..300 becomes minus
    expect(result.segments.map(s => [s.start, s.end, s.strand])).toEqual([
      [199, 300, -1],
      [0, 100, 1],
    ]);
  });

  it("keeps fuzzy flags on genomic bounds under complement (no 5'/3' swap)", () => {
    const result = resolve('complement(<1..>20)', 540);
    expect(result.segments).toEqual([
      { start: 0, end: 20, strand: -1, fuzzyStart: true, fuzzyEnd: true, wrapped: false },
    ]);
  });

  it('drops an unknown operator rather than trusting its child geometry', () => {
    const result = resolve('bond(1..100,200..300)', 540);
    expect(result.kind).toBe('unresolved');
    expect(result.segments).toEqual([]);
    expect(result.unresolved).toBe(true);
  });

  it('marks fuzzy bounds from < and >', () => {
    const result = resolve('<1..>20', 540);
    expect(result.segments).toEqual([
      { start: 0, end: 20, strand: 1, fuzzyStart: true, fuzzyEnd: true, wrapped: false },
    ]);
  });

  it('widens a within-range position toward its role (start->min, end->max)', () => {
    const result = resolve('10.20..90.100', 540);
    expect(result.segments[0].start).toBe(9); // min of 10..20, 0-based
    expect(result.segments[0].end).toBe(100); // max of 90..100
    expect(result.segments[0].fuzzyStart).toBe(true);
    expect(result.segments[0].fuzzyEnd).toBe(true);
  });

  it('splits an origin-spanning range into two wrapped segments on a circular molecule', () => {
    const result = resolve('2686..100', 2686, 'circular');
    expect(result.kind).toBe('set');
    expect(result.segments).toEqual([
      { start: 2685, end: 2686, strand: 1, fuzzyStart: false, fuzzyEnd: false, wrapped: true },
      { start: 0, end: 100, strand: 1, fuzzyStart: false, fuzzyEnd: false, wrapped: true },
    ]);
    expect([result.min, result.max]).toEqual([0, 2686]);
  });

  it('treats a start>end range on a linear molecule as unresolved', () => {
    const result = resolve('2686..100', 2686, 'linear');
    expect(result.kind).toBe('unresolved');
    expect(result.segments).toEqual([]);
    expect(result.unresolved).toBe(true);
  });

  it('clamps out-of-bounds positions and flags them as clamped', () => {
    const range = resolve('1..5000', 540);
    expect(range.segments[0].end).toBe(540);
    expect(range.clamped).toBe(true);
    const point = resolve('600', 540);
    expect(point.segments[0]).toMatchObject({ start: 539, end: 540 });
    expect(point.clamped).toBe(true);
    const inBounds = resolve('1..20', 540);
    expect(inBounds.clamped).toBe(false);
  });

  it('reports remote references as unresolved', () => {
    const result = resolve('J00194.1:1..100', 540);
    expect(result.kind).toBe('unresolved');
    expect(result.unresolved).toBe(true);
    expect(result.segments).toEqual([]);
  });

  it('reports an unparsed/garbled location as unresolved', () => {
    const result = resolve('not-a-location', 540);
    expect(result.unresolved).toBe(true);
    expect(result.segments).toEqual([]);
  });
});
