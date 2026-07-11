/** GenBank / GenPept flat-file readers. */

import { makeSeqRecord, SeqRecord } from '../seq-record';
import { decodeText, firstToken, stripWhitespace, toLines } from '../text';
import { parseGenbankLocation } from './location';
import {
  GenbankDiagnostic,
  GenbankDocument,
  GenbankDocumentParseOptions,
  GenbankFeature,
  GenbankLocus,
  GenbankQualifier,
  GenbankRecord,
  GenbankReference,
  GenbankSection,
  GenbankSource,
  GenbankSourceSpan,
  GenbankTopology,
} from './types';

interface SourceLine {
  text: string;
  start: number;
  end: number;
  number: number;
}

interface RecordRange {
  startLine: number;
  endLine: number;
  terminated: boolean;
}

interface ParsedSections {
  sections: GenbankSection[];
  byKey: Map<string, GenbankSection[]>;
}

interface ResolvedDocumentParseOptions {
  features: boolean;
  references: boolean;
  sequence: boolean;
  sections: boolean;
}

interface QualifierBuilder {
  name: string;
  chunks: string[];
  rawChunks: string[];
  quoted: boolean;
  closed: boolean;
  startLine: SourceLine;
  startColumn: number;
  endLine: SourceLine;
}

const TOP_LEVEL_WIDTH = 12;
const FEATURE_KEY_START = 5;
const FEATURE_LOCATION_START = 21;

/** Extract every sequence through the lightweight path without parsing annotations. */
export function parseGenbank(input: string | Uint8Array): SeqRecord[] {
  return parseSequences(input);
}

/** Parse every concatenated GenBank/GenPept record into its own document object. */
export function parseGenbankDocument(
  input: string | Uint8Array,
  options: GenbankDocumentParseOptions = {},
): GenbankDocument[] {
  const source = decodeText(input);
  const lines = splitSourceLines(source);
  const diagnostics: GenbankDiagnostic[] = [];
  const ranges = findRecordRanges(lines, diagnostics);
  const resolvedOptions: ResolvedDocumentParseOptions = {
    features: options.features ?? true,
    references: options.references ?? true,
    sequence: options.sequence ?? true,
    sections: options.sections ?? true,
  };
  const records = ranges.map((range, recordIndex) =>
    parseRecord(source, lines, range, recordIndex, diagnostics, resolvedOptions),
  );
  return records.map(record => ({
    ...record,
    diagnostics: diagnostics.filter(item => item.span.start >= record.span.start && item.span.start <= record.span.end),
  }));
}

function parseSequences(input: string | Uint8Array): SeqRecord[] {
  const lines = toLines(input);
  const records: SeqRecord[] = [];
  let started = false;
  let locus = '';
  let accession = '';
  let version = '';
  let definition: string[] = [];
  let sequence: string[] = [];
  let mode: 'header' | 'definition' | 'origin' = 'header';

  const flush = (): void => {
    if (!started) return;
    records.push(
      makeSeqRecord(version || accession || locus, definition.join(' ').trim(), stripWhitespace(sequence.join(''))),
    );
    started = false;
    locus = '';
    accession = '';
    version = '';
    definition = [];
    sequence = [];
    mode = 'header';
  };

  for (const line of lines) {
    if (line.startsWith('//')) {
      flush();
      continue;
    }
    const key = topLevelKey(line);
    if (mode === 'origin') {
      if (!key) {
        sequence.push(line.replace(/[\s\d]/g, ''));
        continue;
      }
      mode = 'header';
    }
    if (mode === 'definition' && !key) {
      definition.push(line.trim());
      continue;
    }
    if (!key) continue;
    const value = key === 'LOCUS' ? line.replace(/^LOCUS\s*/i, '') : line.slice(TOP_LEVEL_WIDTH).trim();
    if (key === 'LOCUS' && started) flush();
    started = true;
    mode = 'header';
    if (key === 'LOCUS') locus = firstToken(value);
    else if (key === 'ACCESSION') accession = firstToken(value);
    else if (key === 'VERSION') version = firstToken(value);
    else if (key === 'DEFINITION') {
      definition = [value];
      mode = 'definition';
    } else if (key === 'ORIGIN') mode = 'origin';
  }
  flush();
  return records;
}

function splitSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const raw = match[0];
    if (raw.length === 0) break;
    const text = raw.replace(/[\r\n]+$/, '');
    lines.push({ text, start: match.index, end: match.index + text.length, number: lines.length + 1 });
    if (pattern.lastIndex === source.length) break;
  }
  return lines;
}

function findRecordRanges(lines: SourceLine[], diagnostics: GenbankDiagnostic[]): RecordRange[] {
  const ranges: RecordRange[] = [];
  let startLine: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (topLevelKey(line.text) === 'LOCUS') {
      if (startLine !== undefined) {
        ranges.push({ startLine, endLine: index - 1, terminated: false });
        // Anchor the diagnostic to the unterminated record's last line, not the next LOCUS,
        // so per-record diagnostic filtering attributes it to the record that lacked the //.
        const closedLine = lines[index - 1] ?? line;
        diagnostics.push(
          diagnostic('missing-record-terminator', 'Record ended at the next LOCUS without //.', lineSpan(closedLine)),
        );
      }
      startLine = index;
      continue;
    }
    if (startLine !== undefined && /^\/\/\s*$/.test(line.text)) {
      ranges.push({ startLine, endLine: index, terminated: true });
      startLine = undefined;
    }
  }
  if (startLine !== undefined) {
    const endLine = Math.max(startLine, lines.length - 1);
    const line = lines[endLine];
    if (line) {
      ranges.push({ startLine, endLine, terminated: false });
      diagnostics.push(diagnostic('truncated-record', 'Final record has no // terminator.', lineSpan(line)));
    }
  }
  return ranges;
}

function parseRecord(
  source: string,
  lines: SourceLine[],
  range: RecordRange,
  recordIndex: number,
  diagnostics: GenbankDiagnostic[],
  options: ResolvedDocumentParseOptions,
): GenbankRecord {
  const recordLines = lines.slice(range.startLine, range.endLine + 1);
  const firstLine = recordLines[0];
  const lastLine = recordLines[recordLines.length - 1];
  if (!firstLine || !lastLine) throw new Error('Internal GenBank record range is empty.');
  const span = spanBetween(firstLine, 0, lastLine, lastLine.text.length);
  const locus = parseLocus(firstLine);
  const parsedSections = parseSections(source, recordLines);
  const { sections, byKey } = parsedSections;
  const definition = joinedValue(byKey.get('DEFINITION'));
  const accessions = splitTokens(joinedValue(byKey.get('ACCESSION')));
  const versionTokens = splitTokens(joinedValue(byKey.get('VERSION')));
  const version = versionTokens.find(token => !/^GI:/i.test(token));
  const giToken = versionTokens.find(token => /^GI:/i.test(token));
  const sourceMetadata = parseSource(byKey);
  const features = options.features ? parseFeatures(recordLines, recordIndex, diagnostics) : [];
  const sequence = options.sequence ? parseSequence(recordLines) : '';
  const references = options.references ? parseReferences(recordLines) : [];
  const id = version ?? accessions[0] ?? locus.name;

  return {
    id,
    locus,
    definition: definition || undefined,
    accessions,
    version,
    gi: giToken?.slice(3),
    keywords: parseDelimited(joinedValue(byKey.get('KEYWORDS')), ';'),
    dbLinks: byKey.get('DBLINK')?.flatMap(section => parseDbLinks(section.value)) ?? [],
    sourceInfo: sourceMetadata,
    references,
    comments: byKey.get('COMMENT')?.map(section => section.value) ?? [],
    features,
    sequence,
    contig: joinedValue(byKey.get('CONTIG')) || undefined,
    baseCount: parseBaseCount(joinedValue(byKey.get('BASE COUNT'))),
    sections: options.sections ? sections : [],
    span,
    terminated: range.terminated,
    originalText: source.slice(span.start, span.end),
    diagnostics: [],
  };
}

function parseLocus(line: SourceLine): GenbankLocus {
  const value = line.text.replace(/^LOCUS\s*/i, '');
  const tokens = value.split(/\s+/).filter(Boolean);
  const name = tokens[0] ?? '';
  const lengthToken = tokens[1];
  const length = lengthToken && /^\d+$/.test(lengthToken) ? Number.parseInt(lengthToken, 10) : undefined;
  const unit = length === undefined ? undefined : tokens[2];
  const remaining = tokens.slice(length === undefined ? 1 : 3);
  const topologyToken = remaining.find(token => /^(linear|circular)$/i.test(token));
  const topology: GenbankTopology = topologyToken ? (topologyToken.toLowerCase() as GenbankTopology) : 'unknown';
  const date = [...remaining].reverse().find(token => /^\d{2}-[A-Za-z]{3}-\d{4}$/.test(token));
  const dateIndex = date ? remaining.indexOf(date) : -1;
  const divisionCandidate = dateIndex > 0 ? remaining[dateIndex - 1] : undefined;
  const division = divisionCandidate && /^[A-Za-z]{3}$/.test(divisionCandidate) ? divisionCandidate : undefined;
  const strandedToken = remaining.find(token => /^(ss-|ds-|ms-)/i.test(token));
  const strandedMatch = /^(ss-|ds-|ms-)(.*)$/i.exec(strandedToken ?? '');
  const strandedness = strandedMatch?.[1];
  const attachedMoleculeType = strandedMatch?.[2] || undefined;
  const excluded = new Set(
    [topologyToken, date, division, strandedToken].filter((token): token is string => token !== undefined),
  );
  const moleculeType =
    [attachedMoleculeType, ...remaining.filter(token => !excluded.has(token))].filter(Boolean).join(' ') || undefined;
  return {
    name,
    length,
    unit,
    strandedness,
    moleculeType,
    topology,
    division,
    date,
    tokens,
    span: lineSpan(line),
  };
}

function parseSections(source: string, lines: SourceLine[]): ParsedSections {
  const sections: GenbankSection[] = [];
  const byKey = new Map<string, GenbankSection[]>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    const key = topLevelKey(line.text);
    if (key === 'FEATURES') {
      index += 1;
      while (index < lines.length) {
        const featureLine = lines[index]?.text ?? '';
        if (topLevelKey(featureLine) && !featureKey(featureLine)) break;
        index += 1;
      }
      continue;
    }
    if (!key || key === 'LOCUS' || key === 'ORIGIN' || key === '//') {
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (!next || topLevelKey(next.text)) break;
      end += 1;
    }
    const block = lines.slice(index, end + 1);
    const last = block[block.length - 1] ?? line;
    const chunks = [line.text.slice(TOP_LEVEL_WIDTH).trim(), ...block.slice(1).map(item => item.text.trim())];
    const value = chunks.filter(Boolean).join(' ');
    const span = spanBetween(line, 0, last, last.text.length);
    const section: GenbankSection = {
      key,
      value,
      raw: source.slice(span.start, span.end),
      span,
    };
    sections.push(section);
    const existing = byKey.get(key) ?? [];
    existing.push(section);
    byKey.set(key, existing);
    index = end + 1;
  }
  return { sections, byKey };
}

function parseFeatures(lines: SourceLine[], recordIndex: number, diagnostics: GenbankDiagnostic[]): GenbankFeature[] {
  const features: GenbankFeature[] = [];
  const start = lines.findIndex(line => topLevelKey(line.text) === 'FEATURES');
  if (start < 0) return features;
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    const key = featureKey(line.text);
    if (topLevelKey(line.text) && !key) break;
    if (!key) {
      index += 1;
      continue;
    }
    const featureStart = index;
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index];
      if (!candidate || featureKey(candidate.text) || topLevelKey(candidate.text)) break;
      index += 1;
    }
    const featureLines = lines.slice(featureStart, index);
    const feature = parseFeature(featureLines, recordIndex, features.length, diagnostics);
    features.push(feature);
  }
  return features;
}

function parseFeature(
  lines: SourceLine[],
  recordIndex: number,
  featureIndex: number,
  diagnostics: GenbankDiagnostic[],
): GenbankFeature {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) throw new Error('Internal GenBank feature range is empty.');
  const key = featureKey(first.text) ?? '';
  const locationLines: SourceLine[] = [first];
  for (const line of lines.slice(1)) {
    if (featureContent(line.text).startsWith('/')) break;
    locationLines.push(line);
  }
  const locationText = locationLines.map(line => featureContent(line.text).trim()).join('');
  const locationResult = parseGenbankLocation(locationText);
  const locationLast = locationLines[locationLines.length - 1] ?? first;
  const locationSpan = spanBetween(first, FEATURE_LOCATION_START, locationLast, locationLast.text.length);
  if (!locationResult.complete) {
    diagnostics.push({
      ...diagnostic(
        'unparsed-feature-location',
        `Could not fully parse feature location: ${locationText}`,
        locationSpan,
      ),
      recordIndex,
      featureIndex,
    });
  }
  return {
    key,
    locationText,
    location: locationResult.location,
    qualifiers: parseQualifiers(lines.slice(locationLines.length), recordIndex, featureIndex, diagnostics),
    span: spanBetween(first, FEATURE_KEY_START, last, last.text.length),
    locationSpan,
  };
}

function parseQualifiers(
  lines: SourceLine[],
  recordIndex: number,
  featureIndex: number,
  diagnostics: GenbankDiagnostic[],
): GenbankQualifier[] {
  const qualifiers: GenbankQualifier[] = [];
  let builder: QualifierBuilder | undefined;
  const flush = (): void => {
    if (!builder) return;
    if (builder.quoted && !builder.closed) {
      diagnostics.push({
        ...diagnostic(
          'unterminated-qualifier',
          `Qualifier /${builder.name} has no closing quote.`,
          lineSpan(builder.endLine),
        ),
        recordIndex,
        featureIndex,
      });
    }
    qualifiers.push(finishQualifier(builder));
    builder = undefined;
  };

  for (const line of lines) {
    const content = featureContent(line.text);
    if (content.startsWith('/')) {
      flush();
      builder = startQualifier(line, content);
      continue;
    }
    if (!builder) continue;
    builder.chunks.push(content.trim());
    builder.rawChunks.push(content);
    builder.endLine = line;
    if (builder.quoted && hasClosingQuote(content)) builder.closed = true;
  }
  flush();
  return qualifiers;
}

function startQualifier(line: SourceLine, content: string): QualifierBuilder {
  const equal = content.indexOf('=');
  const name = content.slice(1, equal < 0 ? undefined : equal).trim();
  const rawValue = equal < 0 ? '' : content.slice(equal + 1).trim();
  const quoted = rawValue.startsWith('"');
  return {
    name,
    chunks: equal < 0 ? [] : [rawValue],
    rawChunks: equal < 0 ? [] : [content.slice(equal + 1)],
    quoted,
    closed: !quoted || hasClosingQuote(rawValue.slice(1)),
    startLine: line,
    startColumn: Math.max(FEATURE_LOCATION_START, line.text.indexOf('/')),
    endLine: line,
  };
}

function finishQualifier(builder: QualifierBuilder): GenbankQualifier {
  const { name, chunks, rawChunks, quoted, startLine, startColumn, endLine } = builder;
  const rawValue = rawChunks.length > 0 ? rawChunks.join('\n') : undefined;
  let value: string | undefined;
  if (chunks.length > 0) {
    const normalized =
      name === 'translation' ? chunks.join('').replace(/\s+/g, '') : chunks.join(' ').replace(/\s+/g, ' ');
    value = quoted ? normalized.replace(/^"/, '').replace(/"$/, '').replace(/""/g, '"') : normalized;
  }
  return {
    name,
    value,
    rawValue,
    quoted,
    terminated: !quoted || builder.closed,
    span: spanBetween(startLine, startColumn, endLine, endLine.text.length),
  };
}

function parseSequence(lines: SourceLine[]): string {
  const start = lines.findIndex(line => topLevelKey(line.text) === 'ORIGIN');
  if (start < 0) return '';
  const chunks: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (topLevelKey(line.text) || /^\/\/\s*$/.test(line.text)) break;
    chunks.push(line.text.replace(/[\s\d]/g, ''));
  }
  return chunks.join('');
}

function parseReferences(lines: SourceLine[]): GenbankReference[] {
  const references: GenbankReference[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || topLevelKey(line.text) !== 'REFERENCE') {
      index += 1;
      continue;
    }
    const block: SourceLine[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next) break;
      // Reference subfields (AUTHORS, TITLE, JOURNAL, ...) are indented; any unindented
      // top-level key (COMMENT, PRIMARY, FEATURES, ORIGIN, the next REFERENCE, //) ends the block.
      if (topLevelKey(next.text) && !/^\s/.test(next.text)) break;
      block.push(next);
      index += 1;
    }
    references.push(buildReference(block));
  }
  return references;
}

function buildReference(lines: SourceLine[]): GenbankReference {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) throw new Error('Internal GenBank reference range is empty.');
  const firstValue = first.text.slice(TOP_LEVEL_WIDTH).trim();
  const numberMatch = /^(\d+)/.exec(firstValue);
  const rangeMatch = /\((.+)\)\s*$/.exec(firstValue);
  const fields: Record<string, string[]> = {};
  let currentKey: string | undefined;
  for (const line of lines.slice(1)) {
    const key = topLevelKey(line.text);
    if (key) {
      currentKey = key;
      fields[key] = [line.text.slice(TOP_LEVEL_WIDTH).trim()];
    } else if (currentKey) {
      fields[currentKey]?.push(line.text.trim());
    }
  }
  const joined = Object.fromEntries(
    Object.entries(fields).map(([key, chunks]) => [key, chunks.filter(Boolean).join(' ')]),
  );
  return {
    number: numberMatch ? Number.parseInt(numberMatch[1] ?? '', 10) : undefined,
    range: rangeMatch?.[1],
    authors: joined['AUTHORS'],
    consortium: joined['CONSRTM'],
    title: joined['TITLE'],
    journal: joined['JOURNAL'],
    pubmed: joined['PUBMED'],
    remark: joined['REMARK'],
    fields: joined,
    span: spanBetween(first, 0, last, last.text.length),
  };
}

function parseSource(byKey: Map<string, GenbankSection[]>): GenbankSource | undefined {
  const sourceSection = byKey.get('SOURCE')?.[0];
  const organismSection = byKey.get('ORGANISM')?.[0];
  if (!sourceSection && !organismSection) return undefined;
  const organismLines = organismSection?.raw.split(/\r\n|\r|\n/) ?? [];
  const organism = organismLines[0]?.slice(TOP_LEVEL_WIDTH).trim() ?? '';
  const taxonomyText = organismLines
    .slice(1)
    .map(line => line.trim())
    .join(' ');
  return {
    description: sourceSection?.value ?? '',
    organism: organism || undefined,
    taxonomy: parseDelimited(taxonomyText, ';'),
    span: sourceSection?.span ?? organismSection?.span,
  };
}

function parseBaseCount(value: string): Readonly<Record<string, number>> | undefined {
  const counts: Record<string, number> = {};
  const pattern = /(\d+)\s+([A-Za-z]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const count = match[1];
    const residue = match[2];
    if (count && residue) counts[residue.toLowerCase()] = Number.parseInt(count, 10);
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function parseDbLinks(value: string): string[] {
  return value
    .split(/\s+(?=[A-Za-z][A-Za-z0-9_-]*:)/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseDelimited(value: string, separator: string): string[] {
  const withoutPeriod = value.replace(/\.\s*$/, '');
  if (!withoutPeriod || withoutPeriod === '.') return [];
  return withoutPeriod
    .split(separator)
    .map(item => item.trim())
    .filter(Boolean);
}

function joinedValue(sections: GenbankSection[] | undefined): string {
  return (
    sections
      ?.map(section => section.value)
      .join(' ')
      .trim() ?? ''
  );
}

function splitTokens(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function topLevelKey(line: string): string | undefined {
  if (/^\/\/\s*$/.test(line)) return '//';
  if (/^LOCUS(?:\s|$)/i.test(line)) return 'LOCUS';
  const field = line.slice(0, TOP_LEVEL_WIDTH).trim();
  return /^[A-Za-z][A-Za-z0-9_ ]*$/.test(field) ? field.toUpperCase() : undefined;
}

function featureKey(line: string): string | undefined {
  if (line.length <= FEATURE_KEY_START || !/^\s{5}\S/.test(line)) return undefined;
  const key = line.slice(FEATURE_KEY_START, FEATURE_LOCATION_START).trim();
  return key && !key.startsWith('/') ? key : undefined;
}

function featureContent(line: string): string {
  return line.slice(FEATURE_LOCATION_START);
}

function hasClosingQuote(value: string): boolean {
  let quoteCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '"') continue;
    if (value[index + 1] === '"') {
      index += 1;
      continue;
    }
    quoteCount += 1;
  }
  return quoteCount % 2 === 1;
}

function lineSpan(line: SourceLine): GenbankSourceSpan {
  return spanBetween(line, 0, line, line.text.length);
}

function spanBetween(
  startLine: SourceLine,
  startColumn: number,
  endLine: SourceLine,
  endColumn: number,
): GenbankSourceSpan {
  return {
    start: startLine.start + startColumn,
    end: endLine.start + endColumn,
    startLine: startLine.number,
    startColumn: startColumn + 1,
    endLine: endLine.number,
    endColumn: endColumn + 1,
  };
}

function diagnostic(code: string, message: string, span: GenbankSourceSpan): GenbankDiagnostic {
  return { code, severity: 'warning', message, span };
}
