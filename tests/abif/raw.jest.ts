import * as fs from 'fs';
import * as path from 'path';
import { readAbif, writeAbif, findEntry } from '../../src/abif/raw';

const RAW = path.join(__dirname, '..', 'fixtures', 'Int_F_12_A7.ab1');
const ABF = path.join(__dirname, '..', 'fixtures', 'A_forward.ab1');

describe('abif-raw', () => {
  it('reads ABIF version and a non-empty directory', () => {
    const f = readAbif(fs.readFileSync(RAW));
    expect(f.version).toBeGreaterThan(0);
    expect(f.entries.length).toBeGreaterThan(0);
  });

  it('preserves entries on round-trip (write then read)', () => {
    const f = readAbif(fs.readFileSync(RAW));
    const out = writeAbif(f);
    const re = readAbif(out);

    expect(re.entries.length).toBe(f.entries.length);
    for (let i = 0; i < f.entries.length; i++) {
      expect(re.entries[i].tagName).toBe(f.entries[i].tagName);
      expect(re.entries[i].tagNumber).toBe(f.entries[i].tagNumber);
      expect(re.entries[i].elementType).toBe(f.entries[i].elementType);
      expect(re.entries[i].elementSize).toBe(f.entries[i].elementSize);
      expect(re.entries[i].elementCount).toBe(f.entries[i].elementCount);
      expect(re.entries[i].payload.byteLength).toBe(f.entries[i].payload.byteLength);
      // Byte-for-byte payload equality.
      for (let j = 0; j < f.entries[i].payload.byteLength; j++) {
        expect(re.entries[i].payload[j]).toBe(f.entries[i].payload[j]);
      }
    }
  });

  it('findEntry locates a tag by name+number', () => {
    const f = readAbif(fs.readFileSync(RAW));
    const fwo = findEntry(f, 'FWO_', 1);
    expect(fwo).toBeDefined();
    expect(fwo!.elementCount * fwo!.elementSize).toBe(4);
  });

  it('applies BioPython declared-vs-computed dataSize clamp on A_forward.ab1', () => {
    // A_forward.ab1 is the canonical BioPython fixture used to test the
    // declared/computed dataSize mismatch case. Parsing must succeed and
    // return entries with self-consistent payload lengths.
    const f = readAbif(fs.readFileSync(ABF));
    expect(f.entries.length).toBeGreaterThan(0);
    for (const e of f.entries) {
      expect(e.payload.byteLength).toBe(e.elementCount * e.elementSize);
    }
  });

  it('throws on missing ABIF magic', () => {
    const garbage = new Uint8Array(256);
    expect(() => readAbif(garbage)).toThrow(/Not an ABIF file/);
  });

  it('throws on a file shorter than the header', () => {
    expect(() => readAbif(new Uint8Array(10))).toThrow(/too small/);
  });
});
