import * as fs from 'fs';
import * as path from 'path';
import { asciiBytes } from '../../src/abif/bytes';
import { channelMaxLength, hasSignals, parseAbif } from '../../src/abif/parser';
import { readAbif, upsertEntry, writeAbif } from '../../src/abif/raw';
import { AbifFile } from '../../src/abif/types';
import { getChannelMap } from '../../src/abif/view';

const ABF = path.join(__dirname, '..', 'fixtures', 'basecalled.ab1');
const RAW = path.join(__dirname, '..', 'fixtures', 'raw-no-basecalls.ab1');
const EDITED = path.join(__dirname, '..', 'fixtures', 'edited-differs-from-called.ab1');
const REVC = path.join(__dirname, '..', 'fixtures', 'revc-flag.ab1');

// Synthesize an ABIF byte buffer from the raw (no-basecall) fixture plus extra tags,
// so we can exercise basecall-version and RevC cases the real fixtures don't cover.
function u16be(vals: number[]): Uint8Array {
  const b = new Uint8Array(vals.length * 2);
  const v = new DataView(b.buffer);
  vals.forEach((n, i) => v.setUint16(i * 2, n, false));
  return b;
}
function withTags(mutate: (f: AbifFile) => void): Uint8Array {
  const f = readAbif(fs.readFileSync(RAW));
  mutate(f);
  return writeAbif(f);
}
function setPbas(f: AbifFile, num: number, seq: string): void {
  upsertEntry(f, 'PBAS', num, asciiBytes(seq), { elementType: 2, elementSize: 1, elementCount: seq.length });
}
function setPcon(f: AbifFile, num: number, qs: number[]): void {
  upsertEntry(f, 'PCON', num, new Uint8Array(qs), { elementType: 2, elementSize: 1, elementCount: qs.length });
}
function setPloc(f: AbifFile, num: number, ps: number[]): void {
  upsertEntry(f, 'PLOC', num, u16be(ps), { elementType: 4, elementSize: 2, elementCount: ps.length });
}
function setRevc(f: AbifFile, num: number, val: number): void {
  upsertEntry(f, 'RevC', num, u16be([val]), { elementType: 4, elementSize: 2, elementCount: 1 });
}

describe('parseAbif (high-level wrapper)', () => {
  it('parses basecalled.ab1 with basecalls, signals and metadata', () => {
    const p = parseAbif(fs.readFileSync(ABF), 'basecalled.ab1');
    expect(p.fileName).toBe('basecalled.ab1');
    expect(p.abifVersion).toBeGreaterThan(0);
    expect(p.dirEntryCount).toBeGreaterThan(0);
    expect(p.entries.length).toBe(p.dirEntryCount);

    // Basecalls present and self-consistent.
    expect(p.baseCalls).toBeDefined();
    expect(p.baseCalls!.sequence.length).toBeGreaterThan(0);
    expect(p.baseCalls!.confidences.length).toBe(p.baseCalls!.sequence.length);
    expect(p.baseCalls!.positions.length).toBe(p.baseCalls!.sequence.length);
    // PCON Q-scores are bytes in [0, 255]; for Sanger typically 0..60.
    for (const q of p.baseCalls!.confidences) {
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(255);
    }

    // FWO_ valid.
    expect(p.chromatogram.baseOrder).toMatch(/^[ACGT]{4}$/);

    // At least one of the DATA blocks has data.
    const hasAny = hasSignals(p.chromatogram.data1To4) || hasSignals(p.chromatogram.data9To12);
    expect(hasAny).toBe(true);
  });

  it('handles raw (no PBAS) file: baseCalls is undefined but signals are present', () => {
    const p = parseAbif(fs.readFileSync(RAW), 'raw-no-basecalls.ab1');
    expect(p.baseCalls).toBeUndefined();
    // DATA1..8 are present in this file.
    expect(p.chromatogram.dataChannels[1]).toBeDefined();
    expect(p.chromatogram.dataChannels[4]).toBeDefined();
    expect(p.chromatogram.dataChannels[9]).toBeUndefined();
    expect(channelMaxLength(p.chromatogram.data1To4)).toBeGreaterThan(0);
  });

  it('exposes real on-disk directory fields, not fabricated ones', () => {
    const p = parseAbif(fs.readFileSync(RAW));
    const external = p.entries.filter(e => !e.inline);
    expect(external.length).toBeGreaterThan(0);
    // External entries carry their real file offset (> 0), not a fabricated 0.
    for (const e of external) {
      expect(e.dataOffset).toBeGreaterThan(0);
      expect(e.rawElementCount).toBeGreaterThanOrEqual(0);
    }
    // Inline entries report -1 for the (non-existent) external offset.
    for (const e of p.entries.filter(e => e.inline)) expect(e.dataOffset).toBe(-1);
  });

  it('SPAC falls back to average peak spacing when missing or non-positive', () => {
    const p = parseAbif(fs.readFileSync(ABF));
    // basecalled.ab1 has either a real SPAC or our fallback fills it from positions.
    expect(p.metadata.samplingRate).toBeDefined();
    expect(p.metadata.samplingRate!).toBeGreaterThan(0);
  });

  it('exposes every basecall version, keeping edited and called distinct', () => {
    const p = parseAbif(fs.readFileSync(EDITED));
    // This file was hand-edited: PBAS1 (edited) and PBAS2 (called) differ in length.
    expect(p.baseCallVariants.map(v => v.role)).toEqual(['edited', 'called']);
    const edited = p.baseCallVariants.find(v => v.role === 'edited')!;
    const called = p.baseCallVariants.find(v => v.role === 'called')!;
    expect(edited.version).toBe(1);
    expect(called.version).toBe(2);
    expect(edited.sequence).not.toBe(called.sequence);
    expect(edited.sequence.length).not.toBe(called.sequence.length);
    // Each variant's PCON/PLOC match its own PBAS length (no cross-version borrowing).
    for (const v of p.baseCallVariants) {
      expect(v.confidences.length).toBe(v.sequence.length);
      expect(v.positions.length).toBe(v.sequence.length);
    }
    // The convenience pointer prefers the called version.
    expect(p.baseCalls!.pbasVersion).toBe(2);
    expect(p.baseCalls!.sequence).toBe(called.sequence);
  });

  it('baseCallVariants is empty on a raw (no PBAS) file', () => {
    const p = parseAbif(fs.readFileSync(RAW));
    expect(p.baseCallVariants).toEqual([]);
  });

  it('surfaces the RevC1 reverse-complement flag in metadata', () => {
    expect(parseAbif(fs.readFileSync(REVC)).metadata.reverseComplemented).toBe(false);
    expect(parseAbif(fs.readFileSync(RAW)).metadata.reverseComplemented).toBeUndefined();
  });

  describe('basecall versions and RevC edge cases (synthesized files)', () => {
    it('called-only file: single variant with role called, baseCalls prefers it', () => {
      const p = parseAbif(
        withTags(f => {
          setPbas(f, 2, 'ACGT');
          setPcon(f, 2, [30, 31, 32, 33]);
          setPloc(f, 2, [10, 20, 30, 40]);
        }),
      );
      expect(p.baseCallVariants).toHaveLength(1);
      expect(p.baseCallVariants[0]).toMatchObject({ version: 2, role: 'called', sequence: 'ACGT' });
      expect(p.baseCalls!.pbasVersion).toBe(2);
    });

    it('edited-only file: single variant with role edited, baseCalls falls back to it', () => {
      const p = parseAbif(
        withTags(f => {
          setPbas(f, 1, 'ACG');
          setPcon(f, 1, [10, 11, 12]);
          setPloc(f, 1, [5, 15, 25]);
        }),
      );
      expect(p.baseCallVariants).toHaveLength(1);
      expect(p.baseCallVariants[0]).toMatchObject({ version: 1, role: 'edited', sequence: 'ACG' });
      expect(p.baseCalls!.pbasVersion).toBe(1);
    });

    it('preserves PBAS case in variants; baseCalls upper-cases only as a convenience', () => {
      const p = parseAbif(
        withTags(f => {
          setPbas(f, 2, 'acgt');
          setPcon(f, 2, [30, 31, 32, 33]);
          setPloc(f, 2, [10, 20, 30, 40]);
        }),
      );
      expect(p.baseCallVariants[0].sequence).toBe('acgt'); // exactly as stored
      expect(p.baseCalls!.sequence).toBe('ACGT'); // convenience view is upper-cased
    });

    it('does not claim a role for a non-standard PBAS number (PBAS3 → unknown)', () => {
      const p = parseAbif(
        withTags(f => {
          setPbas(f, 3, 'AC');
          setPcon(f, 3, [20, 21]);
          setPloc(f, 3, [7, 17]);
        }),
      );
      expect(p.baseCallVariants[0]).toMatchObject({ version: 3, role: 'unknown' });
    });

    it('keeps single-element PBAS/PCON/PLOC (length-1 numeric not dropped)', () => {
      const p = parseAbif(
        withTags(f => {
          setPbas(f, 2, 'A');
          setPcon(f, 2, [42]);
          setPloc(f, 2, [13]);
        }),
      );
      expect(p.baseCalls!.sequence).toBe('A');
      expect(p.baseCalls!.confidences).toEqual([42]);
      expect(p.baseCalls!.positions).toEqual([13]); // PLOC (short) length 1 must not collapse away
      expect(p.baseCallVariants[0].positions).toEqual([13]);
    });

    it('keeps a single-element DATA channel', () => {
      const p = parseAbif(
        withTags(f => {
          const b = new Uint8Array(2);
          new DataView(b.buffer).setInt16(0, 777, false);
          upsertEntry(f, 'DATA', 20, b, { elementType: 4, elementSize: 2, elementCount: 1 });
        }),
      );
      expect(p.chromatogram.dataChannels[20]).toEqual([777]);
    });

    it('honors an existing-but-empty PBAS2 (key presence, not string truthiness)', () => {
      const p = parseAbif(withTags(f => setPbas(f, 2, '')));
      expect(p.baseCallVariants.map(v => v.version)).toContain(2);
      expect(p.baseCalls).toBeDefined();
      expect(p.baseCalls!.pbasVersion).toBe(2);
      expect(p.baseCalls!.sequence).toBe('');
    });

    it('preserves zero PCON Q-scores, including trailing ones (0 is a valid score)', () => {
      for (const qs of [
        [42, 0],
        [0, 42],
        [0, 0],
      ]) {
        const p = parseAbif(
          withTags(f => {
            setPbas(f, 2, 'AC');
            setPcon(f, 2, qs);
            setPloc(f, 2, [10, 20]);
          }),
        );
        expect(p.baseCalls!.confidences).toEqual(qs); // trailing NUL must not be stripped
        expect(p.baseCallVariants[0].confidences).toEqual(qs);
      }
    });

    it('entries[].decoded shows PCON as numbers, preserving a trailing zero score', () => {
      const p = parseAbif(
        withTags(f => {
          setPbas(f, 2, 'AC');
          setPcon(f, 2, [42, 0]);
          setPloc(f, 2, [10, 20]);
        }),
      );
      const pcon = p.entries.find(e => e.tag === 'PCON' && e.tagNumber === 2)!;
      expect(pcon.decoded).toEqual({ kind: 'numbers', value: [42, 0] }); // not the stripped string "*"
    });

    it('falls back to GATC when FWO_ is not a real permutation of A/C/G/T', () => {
      for (const bad of ['AAAA', 'GATT']) {
        const p = parseAbif(
          withTags(f =>
            upsertEntry(f, 'FWO_', 1, asciiBytes(bad), { elementType: 2, elementSize: 1, elementCount: bad.length }),
          ),
        );
        expect(p.chromatogram.baseOrder).toBe('GATC');
      }
    });

    it('getChannelMap throws on a non-permutation FWO_ but maps a valid one', () => {
      const withFwo = (s: string): AbifFile =>
        readAbif(
          withTags(f =>
            upsertEntry(f, 'FWO_', 1, asciiBytes(s), { elementType: 2, elementSize: 1, elementCount: s.length }),
          ),
        );
      expect(() => getChannelMap(withFwo('AAAA'))).toThrow(/permutation/i);
      expect(() => getChannelMap(withFwo('GATT'))).toThrow(/permutation/i);
      expect(getChannelMap(withFwo('GATC'))).toEqual({ G: 1, A: 2, T: 3, C: 4 });
    });

    it('baseCalls borrows a length-matched PCON/PLOC when the preferred version mismatches', () => {
      // PBAS2 = 3 bases, but PCON2/PLOC2 have 2 elems; PCON1/PLOC1 (3 elems) match the sequence.
      const p = parseAbif(
        withTags(f => {
          setPbas(f, 2, 'ACG');
          setPcon(f, 2, [9, 9]);
          setPloc(f, 2, [1, 2]);
          setPbas(f, 1, 'ACG');
          setPcon(f, 1, [10, 11, 12]);
          setPloc(f, 1, [5, 15, 25]);
        }),
      );
      expect(p.baseCalls!.pbasVersion).toBe(2);
      expect(p.baseCalls!.confidences).toEqual([10, 11, 12]); // borrowed from v1 (length matches), not the broken v2
      expect(p.baseCalls!.positions).toEqual([5, 15, 25]);
      // baseCallVariants stays strict — it reports v2's own (mismatched) arrays verbatim.
      expect(p.baseCallVariants.find(v => v.version === 2)!.confidences).toEqual([9, 9]);
    });

    it('baseCalls exposes empty confidences/positions when no version matches the PBAS length', () => {
      const p = parseAbif(
        withTags(f => {
          setPbas(f, 2, 'ACG');
          setPcon(f, 2, [9, 9]); // length 2 ≠ 3, and no other version to borrow from
          setPloc(f, 2, [1, 2]);
        }),
      );
      expect(p.baseCalls!.confidences).toEqual([]); // broken array not surfaced
      expect(p.baseCalls!.positions).toEqual([]);
    });

    it('reads RevC1 = 1 as reverseComplemented true', () => {
      expect(parseAbif(withTags(f => setRevc(f, 1, 1))).metadata.reverseComplemented).toBe(true);
    });

    it('ignores a stray RevC2 (spec defines only RevC1)', () => {
      expect(parseAbif(withTags(f => setRevc(f, 2, 1))).metadata.reverseComplemented).toBeUndefined();
    });
  });

  describe('exact fixture values (locked down, not smoke-style > 0)', () => {
    interface FixtureExpect {
      file: string;
      name: string;
      tdir: { entryCount: number; dataSize: number; dataOffset: number; paddingLen: number };
      data: number[];
      pbas: Record<number, number>;
      pconHead?: number[];
      fwo: string;
      revc: boolean | undefined;
    }
    const cases: FixtureExpect[] = [
      {
        file: ABF,
        name: 'basecalled',
        tdir: { entryCount: 171, dataSize: 4928, dataOffset: 204515, paddingLen: 140 },
        data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        pbas: { 1: 809, 2: 809 },
        pconHead: [7, 5, 5],
        fwo: 'GATC',
        revc: undefined,
      },
      {
        file: EDITED,
        name: 'edited-differs',
        tdir: { entryCount: 170, dataSize: 4928, dataOffset: 212662, paddingLen: 168 },
        data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        pbas: { 1: 376, 2: 413 },
        pconHead: [2, 1, 1],
        fwo: 'GATC',
        revc: false,
      },
      {
        file: REVC,
        name: 'revc-flag',
        tdir: { entryCount: 123, dataSize: 3584, dataOffset: 296403, paddingLen: 140 },
        data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        pbas: { 1: 1165, 2: 1165 },
        pconHead: [20, 3, 4],
        fwo: 'GATC',
        revc: false,
      },
      {
        file: RAW,
        name: 'raw-no-basecalls',
        tdir: { entryCount: 81, dataSize: 2268, dataOffset: 128, paddingLen: 0 },
        data: [1, 2, 3, 4, 5, 6, 7, 8],
        pbas: {},
        fwo: 'GATC',
        revc: undefined,
      },
    ];
    for (const c of cases) {
      it(`${c.name}: tdir / DATA ranges / PBAS-PCON-PLOC lengths / FWO / RevC`, () => {
        const bytes = new Uint8Array(fs.readFileSync(c.file));
        const f = readAbif(bytes);
        const p = parseAbif(bytes);
        expect(f.tdir).toMatchObject({
          entryCount: c.tdir.entryCount,
          rawEntryCount: c.tdir.entryCount,
          entrySize: 28,
          dataSize: c.tdir.dataSize,
          dataOffset: c.tdir.dataOffset,
        });
        expect(f.tdir.paddingBytes.length).toBe(c.tdir.paddingLen);
        // dataOffsetBytes is the tdir's 4-byte offset slot, big-endian → equals dataOffset.
        const off = f.tdir.dataOffsetBytes;
        expect(new DataView(off.buffer, off.byteOffset, 4).getInt32(0, false)).toBe(c.tdir.dataOffset);
        expect(f.entries.length).toBe(c.tdir.entryCount);
        expect(
          Object.keys(p.chromatogram.dataChannels)
            .map(Number)
            .sort((a, b) => a - b),
        ).toEqual(c.data);
        const pbasLens: Record<number, number> = {};
        for (const v of p.baseCallVariants) {
          pbasLens[v.version] = v.sequence.length;
          expect(v.confidences.length).toBe(v.sequence.length); // PCON length matches its PBAS
          expect(v.positions.length).toBe(v.sequence.length); // PLOC length matches its PBAS
        }
        expect(pbasLens).toEqual(c.pbas);
        if (c.pconHead) expect(p.baseCalls!.confidences.slice(0, 3)).toEqual(c.pconHead);
        expect(p.chromatogram.baseOrder).toBe(c.fwo);
        expect(p.metadata.reverseComplemented).toBe(c.revc);
      });
    }
  });

  it('accepts both ArrayBuffer and Uint8Array input', () => {
    const bytes = fs.readFileSync(ABF);
    const fromUint8 = parseAbif(bytes);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const fromAb = parseAbif(ab);
    expect(fromUint8.baseCalls!.sequence).toBe(fromAb.baseCalls!.sequence);
    expect(fromUint8.chromatogram.baseOrder).toBe(fromAb.chromatogram.baseOrder);
  });
});
