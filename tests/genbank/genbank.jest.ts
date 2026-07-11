import * as fs from 'fs';
import * as path from 'path';
import { parseGenbank, parseGenbankDocument, parseGenbankLocation } from '../../src/genbank';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

describe('parseGenbank', () => {
  it('reads the two-record fixture: version id, joined DEFINITION, ORIGIN sequence', () => {
    expect(parseGenbank(fixture('records.gb'))).toEqual([
      {
        id: 'TEST001.1',
        description: 'Synthetic test construct with a multi-line definition.',
        sequence: 'atgaaagttttacgtgatccggttgcaaccgatccggatc',
      },
      { id: 'TEST002.2', description: 'Second record.', sequence: 'acgtacgtacgt' },
    ]);
  });

  it('falls back to ACCESSION, then LOCUS name, when VERSION is absent', () => {
    expect(parseGenbank('LOCUS       XY   4 bp\nACCESSION   ACC9\nORIGIN\n        1 acgt\n//\n')).toEqual([
      { id: 'ACC9', sequence: 'acgt' },
    ]);
    expect(parseGenbank('LOCUS       ABC123   5 bp\nORIGIN\n        1 acgta\n//\n')).toEqual([
      { id: 'ABC123', sequence: 'acgta' },
    ]);
  });

  it('yields an empty sequence for a record with no ORIGIN rather than failing', () => {
    expect(parseGenbank('LOCUS       NOSEQ   0 bp\nDEFINITION  no sequence here.\n//\n')).toEqual([
      { id: 'NOSEQ', description: 'no sequence here.', sequence: '' },
    ]);
  });

  it('is lenient: recovers both records when the "//" between them is missing', () => {
    const text = 'LOCUS       A   2 bp\nORIGIN\n        1 ac\nLOCUS       B   2 bp\nORIGIN\n        1 gt\n//\n';
    expect(parseGenbank(text)).toEqual([
      { id: 'A', sequence: 'ac' },
      { id: 'B', sequence: 'gt' },
    ]);
  });

  it('accepts Uint8Array input and returns [] for empty input', () => {
    expect(parseGenbank(new TextEncoder().encode('LOCUS  Z   2 bp\nORIGIN\n        1 gg\n//\n'))).toEqual([
      { id: 'Z', sequence: 'gg' },
    ]);
    expect(parseGenbank('')).toEqual([]);
  });
});

describe('parseGenbankDocument', () => {
  it('parses metadata, source, features, qualifiers, sequence, and exact source spans', () => {
    const text = fixture('records.gb');
    const document = parseGenbankDocument(text);
    const record = document[0];
    const sourceFeature = record?.features[0];
    const cds = record?.features[1];

    expect(document.flatMap(item => item.diagnostics)).toEqual([]);
    expect(document).toHaveLength(2);
    expect(record?.locus).toEqual({
      name: 'TEST001',
      length: 40,
      unit: 'bp',
      moleculeType: 'DNA',
      topology: 'linear',
      division: 'SYN',
      date: '01-JAN-2020',
      strandedness: undefined,
      tokens: ['TEST001', '40', 'bp', 'DNA', 'linear', 'SYN', '01-JAN-2020'],
      span: { start: 0, end: 76, startLine: 1, startColumn: 1, endLine: 1, endColumn: 77 },
    });
    expect(record?.sourceInfo).toEqual({
      description: 'synthetic construct',
      organism: 'synthetic construct',
      taxonomy: [],
      span: { start: 212, end: 243, startLine: 7, startColumn: 1, endLine: 7, endColumn: 32 },
    });
    expect(sourceFeature?.location).toEqual({
      kind: 'range',
      start: { kind: 'exact', value: 1, raw: '1' },
      end: { kind: 'exact', value: 40, raw: '40' },
      raw: '1..40',
    });
    expect(sourceFeature?.qualifiers).toEqual([
      {
        name: 'organism',
        value: 'synthetic construct',
        rawValue: '"synthetic construct"',
        quoted: true,
        terminated: true,
        span: { start: 365, end: 396, startLine: 11, startColumn: 22, endLine: 11, endColumn: 53 },
      },
    ]);
    expect(cds?.qualifiers[0]?.value).toBe('MKV');
    expect(text.slice(cds?.span.start, cds?.span.end)).toBe(
      'CDS             1..30\n                     /translation="MKV"',
    );
    expect(record?.sequence).toBe('atgaaagttttacgtgatccggttgcaaccgatccggatc');
    expect(record?.terminated).toBe(true);
    expect(record?.originalText).toBe(text.slice(record?.span.start, record?.span.end));
    expect(record?.originalText).not.toContain('TEST002');
    expect(document[1]?.originalText).toContain('LOCUS       TEST002');
    expect(document[1]?.originalText).not.toContain('LOCUS       TEST001');
  });

  it('parses references, taxonomy, repeated and multiline qualifiers, db links, and base counts', () => {
    const text = `LOCUS       COMPLEX1       30 bp ds-DNA circular SYN 02-FEB-2024
DEFINITION  Complex test record.
ACCESSION   COMPLEX1 ALT0001
VERSION     COMPLEX1.3  GI:12345
KEYWORDS    plasmid; test construct.
DBLINK      BioProject: PRJNA1
            BioSample: SAMN1
SOURCE      synthetic DNA construct
  ORGANISM  synthetic DNA construct
            other sequences; artificial sequences.
REFERENCE   1  (bases 1 to 30)
  AUTHORS   Doe,J. and Roe,R.
  TITLE     Direct Submission
  JOURNAL   Submitted (02-FEB-2024) Example Lab
   PUBMED   123456
FEATURES             Location/Qualifiers
     source          1..30
                     /organism="synthetic DNA construct"
                     /mol_type="other DNA"
     CDS             complement(join(<1..9,
                     J00194.1:20..>30))
                     /gene="foo"
                     /gene="foo_alias"
                     /note="a note that wraps
                     onto another line"
                     /pseudo
                     /translation="M A
                     BC"
BASE COUNT       8 a 7 c 7 g 8 t
ORIGIN
        1 acgtacgtac gtacgtacgt acgtacgtac
//
`;
    const document = parseGenbankDocument(text);
    const record = document[0];
    const cds = record?.features[1];

    expect(document.flatMap(item => item.diagnostics)).toEqual([]);
    expect(record?.locus).toMatchObject({
      name: 'COMPLEX1',
      length: 30,
      unit: 'bp',
      strandedness: 'ds-',
      moleculeType: 'DNA',
      topology: 'circular',
      division: 'SYN',
      date: '02-FEB-2024',
    });
    expect(record?.accessions).toEqual(['COMPLEX1', 'ALT0001']);
    expect(record?.version).toBe('COMPLEX1.3');
    expect(record?.gi).toBe('12345');
    expect(record?.keywords).toEqual(['plasmid', 'test construct']);
    expect(record?.dbLinks).toEqual(['BioProject: PRJNA1', 'BioSample: SAMN1']);
    expect(record?.sourceInfo).toMatchObject({
      description: 'synthetic DNA construct',
      organism: 'synthetic DNA construct',
      taxonomy: ['other sequences', 'artificial sequences'],
    });
    expect(record?.references).toEqual([
      expect.objectContaining({
        number: 1,
        range: 'bases 1 to 30',
        authors: 'Doe,J. and Roe,R.',
        title: 'Direct Submission',
        journal: 'Submitted (02-FEB-2024) Example Lab',
        pubmed: '123456',
      }),
    ]);
    expect(cds?.location).toEqual({
      kind: 'operator',
      operator: 'complement',
      parts: [
        {
          kind: 'operator',
          operator: 'join',
          parts: [
            {
              kind: 'range',
              start: { kind: 'before', value: 1, raw: '<1' },
              end: { kind: 'exact', value: 9, raw: '9' },
              raw: '<1..9',
            },
            {
              kind: 'remote',
              accession: 'J00194.1',
              location: {
                kind: 'range',
                start: { kind: 'exact', value: 20, raw: '20' },
                end: { kind: 'after', value: 30, raw: '>30' },
                raw: '20..>30',
              },
              raw: 'J00194.1:20..>30',
            },
          ],
          raw: 'join(<1..9,J00194.1:20..>30)',
        },
      ],
      raw: 'complement(join(<1..9,J00194.1:20..>30))',
    });
    expect(cds?.qualifiers.map(qualifier => [qualifier.name, qualifier.value])).toEqual([
      ['gene', 'foo'],
      ['gene', 'foo_alias'],
      ['note', 'a note that wraps onto another line'],
      ['pseudo', undefined],
      ['translation', 'MABC'],
    ]);
    expect(record?.baseCount).toEqual({ a: 8, c: 7, g: 7, t: 8 });
  });

  it('supports GenPept LOCUS lines and records without ORIGIN', () => {
    const document = parseGenbankDocument(
      'LOCUS       PROT1             12 aa            linear   PRI 03-MAR-2025\nDEFINITION  Protein record.\n//\n',
    );
    expect(document[0]).toMatchObject({
      id: 'PROT1',
      sequence: '',
      locus: { name: 'PROT1', length: 12, unit: 'aa', topology: 'linear', division: 'PRI' },
      terminated: true,
    });
  });

  it('keeps unknown sections and recovers a malformed location and missing terminator', () => {
    const text = `LOCUS       ODD1 4 bp DNA linear SYN 01-JAN-2020
WGS         AAAA01000001-AAAA01000009
FEATURES             Location/Qualifiers
     misc_feature    join(1..2,broken
                     /note="still readable"
ORIGIN
        1 acgt
`;
    const document = parseGenbankDocument(text);
    expect(document[0]?.sections.find(section => section.key === 'WGS')?.value).toBe('AAAA01000001-AAAA01000009');
    expect(document[0]?.features[0]?.location).toEqual({ kind: 'unparsed', raw: 'join(1..2,broken' });
    expect(document[0]?.features[0]?.qualifiers[0]?.value).toBe('still readable');
    expect(document.flatMap(item => item.diagnostics.map(diagnostic => diagnostic.code))).toEqual([
      'truncated-record',
      'unparsed-feature-location',
    ]);
  });

  it('recovers the next qualifier after an unterminated quoted value and reports it', () => {
    const text = `LOCUS       Q1 4 bp DNA linear SYN 01-JAN-2020
FEATURES             Location/Qualifiers
     source          1..4
                     /note="unfinished
                     /organism="synthetic construct"
ORIGIN
        1 acgt
//
`;
    const document = parseGenbankDocument(text);
    expect(
      document[0]?.features[0]?.qualifiers.map(qualifier => [qualifier.name, qualifier.value, qualifier.terminated]),
    ).toEqual([
      ['note', 'unfinished', false],
      ['organism', 'synthetic construct', true],
    ]);
    expect(document.flatMap(item => item.diagnostics.map(diagnostic => diagnostic.code))).toEqual([
      'unterminated-qualifier',
    ]);
  });

  it('reports and preserves both records when // is missing between records', () => {
    const text =
      'LOCUS       A 2 bp DNA linear SYN 01-JAN-2020\nORIGIN\n  1 ac\nLOCUS       B 2 bp DNA linear SYN 01-JAN-2020\nORIGIN\n  1 gt\n//\n';
    const document = parseGenbankDocument(text);
    expect(document.map(record => [record.id, record.sequence, record.terminated])).toEqual([
      ['A', 'ac', false],
      ['B', 'gt', true],
    ]);
    expect(document.flatMap(item => item.diagnostics.map(diagnostic => diagnostic.code))).toEqual([
      'missing-record-terminator',
    ]);
  });

  it('does not absorb a COMMENT that follows the final REFERENCE into the reference block', () => {
    const text = `LOCUS       AB000001 30 bp DNA linear SYN 01-JAN-2020
DEFINITION  Test.
VERSION     AB000001.1
REFERENCE   1  (bases 1 to 30)
  AUTHORS   Doe,J.
  TITLE     A title
  JOURNAL   Journal
COMMENT     This is a comment line
            with a second line.
FEATURES             Location/Qualifiers
     source          1..30
                     /organism="synthetic construct"
ORIGIN
        1 acgtacgtac gtacgtacgt acgtacgtac
//
`;
    const record = parseGenbankDocument(text)[0];
    expect(Object.keys(record?.references[0]?.fields ?? {})).toEqual(['AUTHORS', 'TITLE', 'JOURNAL']);
    expect(record?.references[0]?.journal).toBe('Journal');
    expect(record?.references[0]?.span.endLine).toBe(7);
    expect(record?.comments).toEqual(['This is a comment line with a second line.']);
  });

  it('attributes a missing-record-terminator diagnostic to the unterminated record', () => {
    const text =
      'LOCUS       A 2 bp DNA linear SYN 01-JAN-2020\nORIGIN\n  1 ac\nLOCUS       B 2 bp DNA linear SYN 01-JAN-2020\nORIGIN\n  1 gt\n//\n';
    const document = parseGenbankDocument(text);
    expect(document[0]?.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['missing-record-terminator']);
    expect(document[1]?.diagnostics).toEqual([]);
  });

  it('skips optional parsers requested by the caller while retaining all concatenated records', () => {
    const document = parseGenbankDocument(fixture('records.gb'), {
      features: false,
      references: false,
      sequence: false,
      sections: false,
    });
    expect(document.map(record => record.id)).toEqual(['TEST001.1', 'TEST002.2']);
    expect(document.map(record => [record.features, record.references, record.sequence, record.sections])).toEqual([
      [[], [], '', []],
      [[], [], '', []],
    ]);
    expect(document[0]).toMatchObject({
      definition: 'Synthetic test construct with a multi-line definition.',
      sourceInfo: { organism: 'synthetic construct' },
    });
  });
});

describe('parseGenbankLocation', () => {
  it.each([
    ['123', { kind: 'point', position: { kind: 'exact', value: 123, raw: '123' }, raw: '123' }],
    [
      '123^124',
      {
        kind: 'between',
        left: { kind: 'exact', value: 123, raw: '123' },
        right: { kind: 'exact', value: 124, raw: '124' },
        raw: '123^124',
      },
    ],
    ['3.9', { kind: 'point', position: { kind: 'within', values: [3, 9], raw: '3.9' }, raw: '3.9' }],
    [
      'one-of(6,9)',
      { kind: 'point', position: { kind: 'one-of', values: [6, 9], raw: 'one-of(6,9)' }, raw: 'one-of(6,9)' },
    ],
    [
      's00194.1: 20..30',
      {
        kind: 'remote',
        accession: 's00194.1',
        location: {
          kind: 'range',
          start: { kind: 'exact', value: 20, raw: '20' },
          end: { kind: 'exact', value: 30, raw: '30' },
          raw: '20..30',
        },
        raw: 's00194.1: 20..30',
      },
    ],
    ['order(1..2,8..9)', expect.objectContaining({ kind: 'operator', operator: 'order' })],
  ])('parses %s', (source, expected) => {
    expect(parseGenbankLocation(source)).toEqual({ location: expected, complete: true });
  });

  it('retains unsupported syntax instead of throwing', () => {
    expect(parseGenbankLocation('join(1..2,?bad)')).toEqual({
      location: { kind: 'unparsed', raw: 'join(1..2,?bad)' },
      complete: false,
    });
  });

  it('accepts signed nonstandard positions seen in legacy GenBank fixtures', () => {
    expect(parseGenbankLocation('-1..20')).toEqual({
      location: {
        kind: 'range',
        start: { kind: 'exact', value: -1, raw: '-1' },
        end: { kind: 'exact', value: 20, raw: '20' },
        raw: '-1..20',
      },
      complete: true,
    });
  });
});
