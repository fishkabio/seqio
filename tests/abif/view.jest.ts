import * as fs from 'fs';
import * as path from 'path';
import { readAbif } from '../../src/abif/raw';
import {
  getConfidences,
  getDataChannel,
  getFwo,
  getPositions,
  getRawChannelMap,
  getSamplingRate,
  getSequence,
  hasProcessedTraces,
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

const RAW = path.join(__dirname, '..', 'fixtures', 'Int_F_12_A7.ab1');
const ABF = path.join(__dirname, '..', 'fixtures', 'A_forward.ab1');

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
    const map = getRawChannelMap(f);
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
    expect(hasProcessedTraces(f)).toBe(false);

    ensureRawDataChannels(f);
    expect(hasProcessedTraces(f)).toBe(true);

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
