import * as fs from 'fs';
import * as path from 'path';
import { findEntry, readAbif, upsertEntry, writeAbif } from '../../src/abif/abif-format';
import { cropAbif } from '../../src/abif/abif-op-crop';
import { getConfidences, getPositions, getSequence } from '../../src/abif/view';

const ABF = path.join(__dirname, '..', 'fixtures', 'basecalled.ab1');
const RAW = path.join(__dirname, '..', 'fixtures', 'raw-no-basecalls.ab1');
const EDITED = path.join(__dirname, '..', 'fixtures', 'edited-differs-from-called.ab1');

describe('cropAbif', () => {
  it('crops DATA9..12 and both basecall versions to a sample range (identical called/edited)', () => {
    const original = readAbif(fs.readFileSync(ABF));
    const data9Before = findEntry(original, 'DATA', 9);
    if (!data9Before) throw new Error('fixture must carry DATA9');

    const cropped = cropAbif(original, { start: 16, end: 125 });

    // DATA9..12: exact byte slice of the original, half-open [16, 125).
    const data9After = findEntry(cropped, 'DATA', 9);
    expect(data9After?.elementCount).toBe(125 - 16);
    expect(Array.from(data9After?.payload ?? [])).toEqual(Array.from(data9Before.payload.subarray(16 * 2, 125 * 2)));

    // PLOC2 real values in this fixture: ...,16,43,61,86,99,125,... -- 16 included, 125 excluded.
    expect(findEntry(cropped, 'PBAS', 2)?.elementCount).toBe(5);
    expect(getSequence(cropped)).toHaveLength(5);
    expect(getPositions(cropped)).toEqual([0, 27, 45, 70, 83]);

    // Called and edited are identical in this fixture, so PBAS1/PLOC1 crop the same way.
    expect(findEntry(cropped, 'PBAS', 1)?.elementCount).toBe(5);
    const bc1 = { seq: findEntry(cropped, 'PBAS', 1), pos: findEntry(cropped, 'PLOC', 1) };
    expect(bc1.seq?.payload).toEqual(findEntry(cropped, 'PBAS', 2)?.payload);
    expect(bc1.pos?.payload).toEqual(findEntry(cropped, 'PLOC', 2)?.payload);

    // PCON cropped to the same 5 bases.
    expect(findEntry(cropped, 'PCON', 2)?.elementCount).toBe(5);
    expect(getConfidences(cropped)).toHaveLength(5);

    // Default rawTrace is 'omit': DATA1..8 dropped entirely.
    for (let n = 1; n <= 8; n++) expect(findEntry(cropped, 'DATA', n)).toBeUndefined();

    // Unrelated metadata carried over untouched.
    const smplBefore = findEntry(original, 'SMPL', 1);
    const smplAfter = findEntry(cropped, 'SMPL', 1);
    expect(smplAfter?.payload).toEqual(smplBefore?.payload);

    // No orphan bytes from the pre-crop file's layout carried into the derived file.
    expect(cropped.unreferencedRanges).toEqual([]);

    // The input AbifFile is not mutated.
    expect(original.entries.length).toBe(readAbif(fs.readFileSync(ABF)).entries.length);
    expect(findEntry(original, 'DATA', 9)?.elementCount).toBe(data9Before.elementCount);
  });

  it('keeps DATA1..4 whole and untouched when rawTrace is "full"', () => {
    const original = readAbif(fs.readFileSync(ABF));
    const data1Before = findEntry(original, 'DATA', 1);
    if (!data1Before) throw new Error('fixture must carry DATA1');

    const cropped = cropAbif(original, { start: 16, end: 125 }, { rawTrace: 'full' });
    const data1After = findEntry(cropped, 'DATA', 1);
    expect(data1After?.elementCount).toBe(data1Before.elementCount); // whole, not sliced
    expect(data1After?.payload).toEqual(data1Before.payload);
  });

  it('crops two basecall versions independently by their own PLOC (different length/content)', () => {
    // Golden values computed directly from the real fixture for range [0, 400):
    // PLOC1 (edited, 376 bases) keeps 5; PLOC2 (called, 413 bases) keeps 24 -- proving the crop
    // does not assume a shared coordinate space between basecall versions.
    const original = readAbif(fs.readFileSync(EDITED));
    const cropped = cropAbif(original, { start: 0, end: 400 });

    const edited = findEntry(cropped, 'PBAS', 1);
    expect(edited?.elementCount).toBe(5);
    expect(Buffer.from(edited?.payload ?? []).toString('ascii')).toBe('TTCTC');
    expect(findEntry(cropped, 'PLOC', 1)?.elementCount).toBe(5);

    const called = findEntry(cropped, 'PBAS', 2);
    expect(called?.elementCount).toBe(24);
    expect(Buffer.from(called?.payload ?? []).toString('ascii')).toBe('AGATAGATCTGATTTACTATTCTC');
    expect(findEntry(cropped, 'PLOC', 2)?.elementCount).toBe(24);
  });

  it('shifts PLOC to zero relative to the crop start', () => {
    const original = readAbif(fs.readFileSync(EDITED));
    const cropped = cropAbif(original, { start: 0, end: 400 });
    const positions1 = decodeUint16(findEntry(cropped, 'PLOC', 1));
    expect(positions1).toEqual([329, 348, 365, 379, 395]); // start=0 -> no shift

    const shifted = cropAbif(original, { start: 300, end: 400 });
    const positions1Shifted = decodeUint16(findEntry(shifted, 'PLOC', 1));
    expect(positions1Shifted).toEqual([29, 48, 65, 79, 95]); // shifted by -300
  });

  it('produces a file that writeAbif()/readAbif() round-trips consistently', () => {
    const original = readAbif(fs.readFileSync(ABF));
    const cropped = cropAbif(original, { start: 16, end: 125 });
    const reread = readAbif(writeAbif(cropped));

    expect(getSequence(reread)).toHaveLength(5);
    expect(getPositions(reread)).toEqual([0, 27, 45, 70, 83]);
    expect(findEntry(reread, 'DATA', 9)?.elementCount).toBe(125 - 16);
    for (const e of reread.entries) {
      expect(e.payload.byteLength).toBe(e.elementCount * e.elementSize);
    }
  });

  it('rejects an invalid range', () => {
    const original = readAbif(fs.readFileSync(ABF));
    expect(() => cropAbif(original, { start: 10, end: 10 })).toThrow(/invalid range/);
    expect(() => cropAbif(original, { start: 10, end: 5 })).toThrow(/invalid range/);
    expect(() => cropAbif(original, { start: -1, end: 5 })).toThrow(/invalid range/);
    expect(() => cropAbif(original, { start: 1.5, end: 5 })).toThrow(/invalid range/);
  });

  it('rejects a file with no DATA9..12 block', () => {
    const original = readAbif(fs.readFileSync(RAW));
    expect(() => cropAbif(original, { start: 0, end: 10 })).toThrow(/DATA9\.\.12/);
  });

  it('rejects a PBAS version that has no PLOC of its own, rather than silently dropping it', () => {
    const file = readAbif(fs.readFileSync(ABF));
    // Strip PLOC2 while leaving PBAS2 in place -- an incomplete/malformed basecall version.
    file.entries = file.entries.filter(e => !(e.tagName === 'PLOC' && e.tagNumber === 2));
    expect(() => cropAbif(file, { start: 0, end: 100 })).toThrow(/PBAS2 has no PLOC2/);
  });

  it('rejects mismatched PBAS/PLOC lengths for the same version', () => {
    const file = readAbif(fs.readFileSync(RAW));
    upsertEntry(file, 'PBAS', 2, Buffer.from('ACGT'), { elementType: 2, elementSize: 1, elementCount: 4 });
    upsertEntry(file, 'PLOC', 2, Buffer.alloc(2), { elementType: 4, elementSize: 2, elementCount: 1 });
    setSquareData9To12(file, 10);
    expect(() => cropAbif(file, { start: 0, end: 10 })).toThrow(/length mismatch/);
  });

  it('rejects mismatched PBAS/PCON lengths for the same version', () => {
    const file = readAbif(fs.readFileSync(RAW));
    upsertEntry(file, 'PBAS', 2, Buffer.from('ACGT'), { elementType: 2, elementSize: 1, elementCount: 4 });
    upsertEntry(file, 'PLOC', 2, encode16([0, 1, 2, 3]), { elementType: 4, elementSize: 2, elementCount: 4 });
    upsertEntry(file, 'PCON', 2, Buffer.from([30]), { elementType: 2, elementSize: 1, elementCount: 1 });
    setSquareData9To12(file, 10);
    expect(() => cropAbif(file, { start: 0, end: 10 })).toThrow(/PBAS2\/PCON2 length mismatch/);
  });

  it('rejects a range whose end exceeds the processed trace length, rather than silently clamping it', () => {
    // A silently clamped DATA9..12 could leave a kept base's shifted PLOC pointing past the
    // cropped trace -- this must be a hard error, not a shorter-than-requested crop.
    const original = readAbif(fs.readFileSync(ABF));
    const length = findEntry(original, 'DATA', 9)?.elementCount ?? 0;
    expect(() => cropAbif(original, { start: 0, end: length + 1 })).toThrow(/exceeds the processed trace length/);
    // Exactly at the boundary is fine.
    expect(() => cropAbif(original, { start: 0, end: length })).not.toThrow();
  });

  it('bounds the range by the shortest DATA9..12 channel when their lengths disagree', () => {
    const file = readAbif(fs.readFileSync(RAW));
    upsertEntry(file, 'DATA', 9, Buffer.alloc(20), { elementType: 4, elementSize: 2, elementCount: 10 });
    upsertEntry(file, 'DATA', 10, Buffer.alloc(16), { elementType: 4, elementSize: 2, elementCount: 8 }); // shorter
    upsertEntry(file, 'DATA', 11, Buffer.alloc(20), { elementType: 4, elementSize: 2, elementCount: 10 });
    upsertEntry(file, 'DATA', 12, Buffer.alloc(20), { elementType: 4, elementSize: 2, elementCount: 10 });
    expect(() => cropAbif(file, { start: 0, end: 9 })).toThrow(/exceeds the processed trace length 8/);
    expect(() => cropAbif(file, { start: 0, end: 8 })).not.toThrow();
  });

  it('does not let a mutation on the cropped file reach back into the original', () => {
    const original = readAbif(fs.readFileSync(ABF));
    const smplBefore = Array.from(findEntry(original, 'SMPL', 1)?.payload ?? []);

    const cropped = cropAbif(original, { start: 16, end: 125 });
    upsertEntry(cropped, 'SMPL', 1, Buffer.from('mutated!'), {
      elementType: 18,
      elementSize: 1,
      elementCount: 8,
    });

    expect(Array.from(findEntry(original, 'SMPL', 1)?.payload ?? [])).toEqual(smplBefore);
  });
});

function setSquareData9To12(file: ReturnType<typeof readAbif>, elementCount: number): void {
  for (const n of [9, 10, 11, 12]) {
    upsertEntry(file, 'DATA', n, Buffer.alloc(elementCount * 2), {
      elementType: 4,
      elementSize: 2,
      elementCount,
    });
  }
}

function encode16(values: number[]): Uint8Array {
  const buf = new Uint8Array(values.length * 2);
  const view = new DataView(buf.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, false));
  return buf;
}

function decodeUint16(e: ReturnType<typeof findEntry>): number[] {
  if (!e) throw new Error('entry not found');
  const view = new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength);
  const out: number[] = [];
  for (let i = 0; i < e.elementCount; i++) out.push(view.getUint16(i * 2, false));
  return out;
}
