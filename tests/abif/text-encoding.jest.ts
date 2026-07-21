import * as fs from 'fs';
import * as path from 'path';
import { readAbif, upsertEntry, writeAbif } from '../../src/abif/abif-format';
import { asciiBytes, decodeAbifText, encodeAbifText } from '../../src/abif/bytes';
import { parseAbif } from '../../src/abif/parser';
import { AbifFile } from '../../src/abif/types';

const RAW = path.join(__dirname, '..', 'fixtures', 'raw-no-basecalls.ab1');

/** Build a file carrying one text tag with the given payload bytes, then parse it back. */
function roundTrip(tag: string, elementType: number, payload: Uint8Array): string {
  const file: AbifFile = readAbif(fs.readFileSync(RAW));
  upsertEntry(file, tag, 1, payload, { elementType, elementSize: 1, elementCount: payload.length });
  const parsed = parseAbif(writeAbif(file));
  const entry = parsed.entries.find(e => e.tag === tag && e.tagNumber === 1);
  if (entry?.decoded.kind !== 'string') throw new Error(`${tag} did not decode as a string`);
  return entry.decoded.value;
}

/** Wrap bytes as a pString payload: one length byte, then the text. */
function pString(bytes: Uint8Array): Uint8Array {
  const payload = new Uint8Array(bytes.length + 1);
  payload[0] = bytes.length;
  payload.set(bytes, 1);
  return payload;
}

describe('decodeAbifText', () => {
  it('decodes ASCII unchanged', () => {
    expect(decodeAbifText(encodeAbifText('KB_3130_POP7_BDTv3.mob'))).toBe('KB_3130_POP7_BDTv3.mob');
  });

  it('decodes UTF-8, which instruments do write (cyrillic, umlauts, CJK)', () => {
    for (const text of ['Нанофор 5', 'ПДМА-6', 'Grün', '日本語', 'µA — °C']) {
      expect(decodeAbifText(encodeAbifText(text))).toBe(text);
    }
  });

  it('falls back to byte-per-character for payloads that are not valid UTF-8', () => {
    // 0xE9 is "é" in Latin-1 but an incomplete sequence in UTF-8.
    expect(decodeAbifText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
    // A lone continuation byte cannot start a UTF-8 sequence either.
    expect(decodeAbifText(new Uint8Array([0x41, 0x80, 0x42]))).toBe('AB');
  });

  it('handles the empty payload', () => {
    expect(decodeAbifText(new Uint8Array(0))).toBe('');
  });

  it('round-trips through encodeAbifText for non-ASCII text', () => {
    const text = 'Нанофор 5 · ПДМА-6';
    expect(decodeAbifText(encodeAbifText(text))).toBe(text);
    // The old ASCII encoder would have mangled it — this is what the pair fixes.
    expect(decodeAbifText(asciiBytes(text))).not.toBe(text);
  });
});

describe('parseAbif text tags', () => {
  it('reads a UTF-8 cString (type 19) as text', () => {
    expect(roundTrip('RunN', 19, encodeAbifText('Seq_PDMA6_36_Standard'))).toBe('Seq_PDMA6_36_Standard');
    expect(roundTrip('CTOw', 19, encodeAbifText('ИАП РАН'))).toBe('ИАП РАН');
  });

  it('reads a UTF-8 char run (type 2) as text', () => {
    expect(roundTrip('SrdX', 2, encodeAbifText('<GelType>ПДМА-6</GelType>'))).toBe('<GelType>ПДМА-6</GelType>');
  });

  it('reads a UTF-8 pString (type 18) as text', () => {
    expect(roundTrip('MCHN', 18, pString(encodeAbifText('Нанофор 5')))).toBe('Нанофор 5');
  });

  it('still reads a Latin-1 pString the way it always did', () => {
    expect(roundTrip('MCHN', 18, pString(asciiBytes('café')))).toBe('café');
  });

  it('strips a trailing NUL terminator and padding from a cString', () => {
    const payload = new Uint8Array([...encodeAbifText('POP7'), 0, 0]);
    expect(roundTrip('GTyp', 19, payload)).toBe('POP7');
  });

  it('keeps interior spaces and does not trim the text', () => {
    expect(roundTrip('GTyp', 19, encodeAbifText(' POP6  '))).toBe(' POP6  ');
  });

  it('keeps a NUL inside the text, trimming only the trailing ones', () => {
    // A cString formally ends at its first NUL, but both the old and the new reader keep the tail —
    // pinned here so the behaviour is a decision, not an accident.
    const payload = new Uint8Array([...encodeAbifText('abc'), 0, ...encodeAbifText('junk'), 0]);
    expect(roundTrip('GTyp', 19, payload)).toBe('abc\0junk');
  });
});
