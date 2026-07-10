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

  it('returns "unknown" for empty input and non-matching content', () => {
    expect(detectFormat(new Uint8Array(0))).toBe('unknown');
    expect(detectFormat(ascii('hello world'))).toBe('unknown');
  });
});
