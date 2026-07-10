import * as fs from 'fs';
import * as path from 'path';
import { detectFormat } from '../src/detect';

const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('detectFormat', () => {
  it('detects ABIF from the .ab1 fixture magic', () => {
    expect(detectFormat(fixtureBytes('basecalled.ab1'))).toBe('abif');
  });

  it('detects ABIF behind a 128-byte MacBinary preamble', () => {
    const bytes = new Uint8Array(132);
    bytes.set(ascii('ABIF'), 128);
    expect(detectFormat(bytes)).toBe('abif');
  });

  it('detects SCF from its ".scf" magic (recognized even though it has no parser yet)', () => {
    expect(detectFormat(ascii('.scf'))).toBe('scf');
  });

  it('detects FASTA from the fixture', () => {
    expect(detectFormat(fixtureBytes('reads.fasta'))).toBe('fasta');
  });

  it('detects FASTQ from the fixture', () => {
    expect(detectFormat(fixtureBytes('reads.fastq'))).toBe('fastq');
  });

  it('detects GenBank from the LOCUS line', () => {
    expect(detectFormat(fixtureBytes('records.gb'))).toBe('genbank');
  });

  it('detects EMBL vs Swiss-Prot by the ID line (BP. vs AA./Reviewed)', () => {
    expect(detectFormat(fixtureBytes('records.embl'))).toBe('embl');
    expect(detectFormat(fixtureBytes('records.sp'))).toBe('swissprot');
  });

  it('detects the alignment formats from their fixtures', () => {
    expect(detectFormat(fixtureBytes('align.aln'))).toBe('clustal');
    expect(detectFormat(fixtureBytes('align.sto'))).toBe('stockholm');
    expect(detectFormat(fixtureBytes('align.phy'))).toBe('phylip');
    expect(detectFormat(fixtureBytes('align.nex'))).toBe('nexus');
    expect(detectFormat(fixtureBytes('align.msf'))).toBe('msf');
  });

  it('detects MSF when a free-text / GeneDoc preamble precedes the header (not on line 1)', () => {
    // GCG/MSF allows descriptive text (and GeneDoc GDC blocks) before the "MSF: … Check:" header, so
    // the signature isn't on the first line — and the GeneDoc banner must not be mistaken for Clustal.
    const msf = [
      'GCG MSF file of project DEMO — free descriptive text',
      'GDC ****** GeneDoc Multiple Sequence Alignment Editor ******',
      '',
      '  demo.msf  MSF: 9  Type: P  Check: 0  ..',
      ' Name: seq1  Len: 9  Check: 0  Weight: 1.00',
      ' Name: seq2  Len: 9  Check: 0  Weight: 1.00',
      '//',
      'seq1  ACGT.ACGT',
      'seq2  ACGTAACGT',
    ].join('\n');
    expect(detectFormat(ascii(msf))).toBe('msf');
  });

  it('detects a GCG/MSF whose "MSF:" header line is missing via the Name:/Len:/Check:/Weight: block', () => {
    // Some MSF exports mangle/omit the "MSF:" line but keep the GCG name declarations — an
    // MSF-specific signature we can key on so a real alignment still loads.
    const msf = ['//.. stray text', '..', ' Name: seq1  Len: 8  Check: 10  Weight: 1.00', '//', 'seq1  ACGTACGT'].join(
      '\n',
    );
    expect(detectFormat(ascii(msf))).toBe('msf');
  });

  it('does NOT take a garbage file with a bare "Name:x" (no Len:/Check:/Weight:) for MSF', () => {
    expect(detectFormat(ascii('..\nName:HBB_HUMAN\n//\nfgtggtrghtrfg gerg rg\n'))).toBe('unknown');
  });

  it('detects MEGA (#mega), PDB (HEADER) and ACE (AS <n> <m>) from their leading line', () => {
    expect(detectFormat(ascii('#mega\n!Title x;\n#s1 ACGT\n'))).toBe('mega');
    expect(detectFormat(ascii('HEADER    HYDROLASE                               17-FEB-98   1A5H\n'))).toBe('pdb');
    expect(detectFormat(ascii('AS 2 4\nCO 1 50 2 50 U\nACGT\n'))).toBe('ace');
  });

  it('detects PDB by a coordinate/SEQRES record when line 1 is not classifiable', () => {
    // Bare `MODEL` (no serial) then an ATOM coordinate line — 1MOT-style ptools output.
    expect(detectFormat(ascii('MODEL \nATOM      1  N   ALA A 249       3.679 -15.582   2.213\n'))).toBe('pdb');
    // I-TASSER `HEADER protein` (single space) then REMARK prose, then an ATOM line.
    expect(
      detectFormat(ascii('HEADER protein\nMETHOD\nATOM      1  N   VAL A   1      37.640   0.000   0.000\n')),
    ).toBe('pdb');
    // A SEQRES-led file with no HEADER at all — including one with a BLANK chain id (valid PDB).
    expect(detectFormat(ascii('REMARK something\nSEQRES   1 A    3  SER GLU HIS\n'))).toBe('pdb');
    expect(detectFormat(ascii('REMARK x\nSEQRES   1      3  ALA GLY SER\n'))).toBe('pdb');
  });

  it('does not mistake prose that merely mentions ATOM/CRYST1 for PDB', () => {
    // No coordinate triplet / structured fields → stays unknown (hardened signatures).
    expect(detectFormat(ascii('Some report\nATOM 1 is an example record\nCRYST1 notes here\n'))).toBe('unknown');
  });

  it('detects a headerless GFF (no ##gff-version) by its ##FASTA directive + FASTA record', () => {
    const gff = 'chr1\tsrc\tgene\t1\t9\t.\t+\t.\tID=g1\n##FASTA\n>chr1\nACGTACGTA\n';
    expect(detectFormat(ascii(gff))).toBe('gff');
    // A bare "##FASTA" line with no following FASTA record is not enough (e.g. prose/README).
    expect(detectFormat(ascii('notes about ##FASTA sections\n##FASTA\nnothing follows\n'))).toBe('unknown');
    // "##FASTA" appearing only mid-sentence (not as a directive line) must not match, even with a
    // later ">" FASTA example.
    expect(detectFormat(ascii('##FASTA is an example directive\n>example\nACGT\n'))).toBe('unknown');
  });

  it('keeps an explicit CLUSTAL/MUSCLE banner as clustal even if an MSF-like Name: line follows', () => {
    // The MSF override applies only to the generic "multiple sequence alignment" phrase, never to a
    // real program banner (which is the stronger, definite signal).
    const banner = 'MUSCLE (3.8) multiple sequence alignment\n Name: x  Len: 5  Check: 1  Weight: 1.0\n//\nx  ACGTA\n';
    expect(detectFormat(ascii(banner))).toBe('clustal');
  });

  it('detects PIR (by the >XX; type code) and GFF3 (##gff-version), not as FASTA', () => {
    expect(detectFormat(fixtureBytes('records.pir'))).toBe('pir');
    expect(detectFormat(fixtureBytes('annot.gff3'))).toBe('gff');
  });

  it('detects a MUSCLE-banner alignment as clustal (same layout as CLUSTAL)', () => {
    expect(detectFormat(ascii('MUSCLE (3.8) multiple sequence alignment\n\nseq1  ACGT\nseq2  ACGT\n'))).toBe('clustal');
  });

  it('skips leading whitespace before the "@"/">" sniff', () => {
    expect(detectFormat(ascii('  \n\t>x\nACGT'))).toBe('fasta');
    expect(detectFormat(ascii('\r\n@r\nAC\n+\nII'))).toBe('fastq');
  });

  it('skips a leading UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...ascii('>x\nACGT')]);
    expect(detectFormat(withBom)).toBe('fasta');
  });

  it('detects SAM from a header line, and not as FASTQ despite the leading "@"', () => {
    expect(detectFormat(ascii('@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:100\n'))).toBe('sam');
    // A FASTQ read id also starts with '@' but is not a two-letter SAM tag + TAB.
    expect(detectFormat(ascii('@read1\nACGT\n+\nIIII\n'))).toBe('fastq');
  });

  it('detects headerless SAM from the mandatory-field structure', () => {
    expect(detectFormat(ascii('read1\t0\tchr1\t1000\t60\t8M\t*\t0\t0\tACGTACGT\tIIIIIIII\n'))).toBe('sam');
  });

  it('detects GFA from the version header or a headerless Segment line', () => {
    expect(detectFormat(ascii('H\tVN:Z:1.0\nS\ts1\tACGT\n'))).toBe('gfa');
    expect(detectFormat(ascii('S\ts1\tACGTACGT\tLN:i:8\n'))).toBe('gfa');
    // VN:Z: need not be the first tag on the H line.
    expect(detectFormat(ascii('H\tTS:i:1\tVN:Z:1.0\n'))).toBe('gfa');
  });

  it('detects BAM from its "BAM\\1" magic (present once BGZF has been inflated)', () => {
    expect(detectFormat(new Uint8Array([0x42, 0x41, 0x4d, 0x01, 0, 0, 0, 0]))).toBe('bam');
  });

  it('returns "unknown" for empty input and non-matching content', () => {
    expect(detectFormat(new Uint8Array(0))).toBe('unknown');
    expect(detectFormat(ascii('hello world'))).toBe('unknown');
  });
});
