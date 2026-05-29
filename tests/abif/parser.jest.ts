import * as fs from 'fs';
import * as path from 'path';
import { parseAbif, hasSignals, channelMaxLength } from '../../src/abif/parser';

const ABF = path.join(__dirname, '..', 'fixtures', 'A_forward.ab1');
const RAW = path.join(__dirname, '..', 'fixtures', 'Int_F_12_A7.ab1');

describe('parseAbif (high-level wrapper)', () => {
  it('parses A_forward.ab1 with basecalls, signals and metadata', () => {
    const p = parseAbif(fs.readFileSync(ABF), 'A_forward.ab1');
    expect(p.fileName).toBe('A_forward.ab1');
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

    // At least one of basecalled / raw channels has data.
    const hasAny =
      hasSignals(p.chromatogram.basecalled) || hasSignals(p.chromatogram.raw);
    expect(hasAny).toBe(true);
  });

  it('handles raw (no PBAS) file: baseCalls is undefined but signals are present', () => {
    const p = parseAbif(fs.readFileSync(RAW), 'Int_F_12_A7.ab1');
    expect(p.baseCalls).toBeUndefined();
    // DATA1..8 are present in this file.
    expect(p.chromatogram.dataChannels[1]).toBeDefined();
    expect(p.chromatogram.dataChannels[4]).toBeDefined();
    expect(p.chromatogram.dataChannels[9]).toBeUndefined();
    expect(channelMaxLength(p.chromatogram.raw)).toBeGreaterThan(0);
  });

  it('SPAC falls back to average peak spacing when missing or non-positive', () => {
    const p = parseAbif(fs.readFileSync(ABF));
    // A_forward has either a real SPAC or our fallback fills it from positions.
    expect(p.metadata.samplingRate).toBeDefined();
    expect(p.metadata.samplingRate!).toBeGreaterThan(0);
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
