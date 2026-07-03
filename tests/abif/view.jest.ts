import * as fs from 'fs';
import * as path from 'path';
import { readAbif, upsertEntry } from '../../src/abif/raw';
import {
  dataChannelRole,
  getChannelMap,
  getConfidences,
  getDataChannel,
  getFwo,
  getPositions,
  getReverseComplemented,
  getSamplingRate,
  getSequence,
  hasData9To12Block,
} from '../../src/abif/view';
import {
  averagePeakSpacing,
  ensureRawDataChannels,
  setAveragePeakSpacing,
  setConfidences,
  setPositions,
  setSequence,
} from '../../src/abif/setters';
import { writeAbif } from '../../src/abif/raw';

const RAW = path.join(__dirname, '..', 'fixtures', 'raw-no-basecalls.ab1');
const ABF = path.join(__dirname, '..', 'fixtures', 'basecalled.ab1');
const REVC = path.join(__dirname, '..', 'fixtures', 'revc-flag.ab1');

describe('abif-view', () => {
  it('reads DATA1..8 as int16 arrays on a raw file', () => {
    const f = readAbif(fs.readFileSync(RAW));
    for (let n = 1; n <= 8; n++) {
      const arr = getDataChannel(f, n);
      expect(arr).toBeDefined();
      expect(arr!.length).toBeGreaterThan(0);
    }
    // Raw fixture has no DATA9..12.
    expect(getDataChannel(f, 9)).toBeUndefined();
  });

  it('reads FWO_ and computes channel map', () => {
    const f = readAbif(fs.readFileSync(RAW));
    const fwo = getFwo(f);
    expect(fwo).toMatch(/^[ACGT]{4}$/);
    const map = getChannelMap(f);
    const channels = Object.values(map).sort();
    expect(channels).toEqual([1, 2, 3, 4]);
    expect(map[fwo[0] as 'A']).toBe(1);
    expect(map[fwo[3] as 'A']).toBe(4);
  });

  it('returns undefined for sequence/confidences/positions on raw (no PBAS) file', () => {
    const f = readAbif(fs.readFileSync(RAW));
    expect(getSequence(f)).toBeUndefined();
    expect(getConfidences(f)).toBeUndefined();
    expect(getPositions(f)).toBeUndefined();
  });

  it('reads sequence/confidences/positions on a basecalled file', () => {
    const f = readAbif(fs.readFileSync(ABF));
    const seq = getSequence(f);
    const conf = getConfidences(f);
    const pos = getPositions(f);
    expect(seq).toBeDefined();
    expect(seq!.length).toBeGreaterThan(0);
    expect(conf).toBeDefined();
    expect(conf!.length).toBe(seq!.length);
    expect(pos).toBeDefined();
    expect(pos!.length).toBe(seq!.length);
    // PLOC values are monotonically non-decreasing and non-negative.
    let prev = -1;
    for (const p of pos!) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('round-trips PBAS2/PCON2/PLOC2 via setters and preserves other entries', () => {
    const buf = fs.readFileSync(RAW);
    const f = readAbif(buf);
    const originalEntryCount = f.entries.length;

    const seq = 'ACGTNRYSWKM';
    const q = [10, 20, 30, 40, 50, 15, 25, 35, 45, 55, 5];
    const pos = [100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300];

    setSequence(f, seq);
    setConfidences(f, q);
    setPositions(f, pos);

    expect(f.entries.length).toBe(originalEntryCount + 3);

    const re = readAbif(writeAbif(f));
    expect(getSequence(re)).toBe(seq);
    expect(getConfidences(re)).toEqual(q);
    expect(getPositions(re)).toEqual(pos);

    // Every original entry still present and intact.
    const orig = readAbif(buf);
    for (const oe of orig.entries) {
      const m = re.entries.find(e => e.tagName === oe.tagName && e.tagNumber === oe.tagNumber);
      expect(m).toBeDefined();
      expect(m!.payload.byteLength).toBe(oe.payload.byteLength);
      for (let j = 0; j < oe.payload.byteLength; j++) {
        expect(m!.payload[j]).toBe(oe.payload[j]);
      }
    }
  });

  it('setters replace existing tags rather than duplicate them', () => {
    const f = readAbif(fs.readFileSync(RAW));
    const beforeCount = f.entries.length;
    setSequence(f, 'AAAA');
    setSequence(f, 'CCCC');
    setSequence(f, 'GGGG');
    expect(f.entries.length).toBe(beforeCount + 1);
    const re = readAbif(writeAbif(f));
    expect(getSequence(re)).toBe('GGGG');
  });

  it('ensureRawDataChannels duplicates DATA1..4 into DATA9..12 when absent', () => {
    const f = readAbif(fs.readFileSync(RAW));
    expect(hasData9To12Block(f)).toBe(false);

    ensureRawDataChannels(f);
    expect(hasData9To12Block(f)).toBe(true);

    for (let i = 1; i <= 4; i++) {
      const src = getDataChannel(f, i);
      const tgt = getDataChannel(f, 8 + i);
      expect(src).toBeDefined();
      expect(tgt).toBeDefined();
      expect(tgt!.length).toBe(src!.length);
      for (let j = 0; j < src!.length; j++) expect(tgt![j]).toBe(src![j]);
    }
  });

  it('ensureRawDataChannels is a no-op when DATA9..12 already present', () => {
    const f = readAbif(fs.readFileSync(RAW));
    ensureRawDataChannels(f);
    const after1 = f.entries.length;
    ensureRawDataChannels(f);
    expect(f.entries.length).toBe(after1);
  });

  describe('facts, not verdicts', () => {
    it('dataChannelRole labels only the DATA numbers the spec names', () => {
      // Standard four dyes (raw + analyzed) plus the two named 5th-dye blocks 105/205.
      for (const n of [1, 2, 3, 4, 9, 10, 11, 12, 105, 205]) expect(dataChannelRole(n)).toBe('trace');
      for (const n of [5, 6, 7, 8]) expect(dataChannelRole(n)).toBe('telemetry');
      // The spec does not enumerate 106/206/…, so we don't claim a role for them.
      for (const n of [0, 13, 100, 104, 106, 206, 999]) expect(dataChannelRole(n)).toBe('other');
    });

    it('getReverseComplemented reads RevC1 (true/false), ignoring other tag numbers', () => {
      // revc-flag.ab1 carries RevC1 = 0; raw-no-basecalls has no RevC tag.
      expect(getReverseComplemented(readAbif(fs.readFileSync(REVC)))).toBe(false);
      expect(getReverseComplemented(readAbif(fs.readFileSync(RAW)))).toBeUndefined();
      // Synthesize RevC1 = 1 (true) and a stray RevC2 (must be ignored — spec defines only RevC1).
      const int16 = (v: number): Uint8Array => {
        const b = new Uint8Array(2);
        new DataView(b.buffer).setInt16(0, v, false);
        return b;
      };
      const trueFile = readAbif(fs.readFileSync(RAW));
      upsertEntry(trueFile, 'RevC', 1, int16(1), { elementType: 4, elementSize: 2, elementCount: 1 });
      expect(getReverseComplemented(trueFile)).toBe(true);

      const revc2Only = readAbif(fs.readFileSync(RAW));
      upsertEntry(revc2Only, 'RevC', 2, int16(1), { elementType: 4, elementSize: 2, elementCount: 1 });
      expect(getReverseComplemented(revc2Only)).toBeUndefined();
    });
  });

  describe('average peak spacing (SPAC)', () => {
    it('averagePeakSpacing returns mean consecutive diff', () => {
      expect(averagePeakSpacing([10, 20, 30, 40])).toBeCloseTo(10);
      expect(averagePeakSpacing([0, 100])).toBeCloseTo(100);
    });

    it('averagePeakSpacing returns 0 when fewer than 2 positions', () => {
      expect(averagePeakSpacing([])).toBe(0);
      expect(averagePeakSpacing([42])).toBe(0);
    });

    it('setAveragePeakSpacing writes SPAC/1, SPAC/2, SPAC/3 in standard ABIF format', () => {
      const f = readAbif(fs.readFileSync(RAW));
      setAveragePeakSpacing(f, 12.345, 'fishka-test');
      const re = readAbif(writeAbif(f));
      expect(getSamplingRate(re)).toBeCloseTo(12.345, 3);
    });

    it('setAveragePeakSpacing replaces existing SPAC tags rather than duplicating', () => {
      const f = readAbif(fs.readFileSync(RAW));
      setAveragePeakSpacing(f, 10, 'first');
      const after1 = f.entries.length;
      setAveragePeakSpacing(f, 11, 'second');
      expect(f.entries.length).toBe(after1);
      const re = readAbif(writeAbif(f));
      expect(getSamplingRate(re)).toBeCloseTo(11, 3);
    });
  });
});
