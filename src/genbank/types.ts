/** A half-open character range in the decoded GenBank source. Lines and columns are one-based. */
export interface GenbankSourceSpan {
  /** Zero-based inclusive character offset. */
  start: number;
  /** Zero-based exclusive character offset. */
  end: number;
  /** One-based starting source line. */
  startLine: number;
  /** One-based starting source column. */
  startColumn: number;
  /** One-based ending source line. */
  endLine: number;
  /** One-based ending source column. */
  endColumn: number;
}

export type GenbankDiagnosticSeverity = 'warning' | 'error';

/** A recoverable problem found while reading a GenBank flat file. */
export interface GenbankDiagnostic {
  /** Stable machine-readable diagnostic code. */
  code: string;
  /** Diagnostic severity. */
  severity: GenbankDiagnosticSeverity;
  /** Human-readable diagnostic message. */
  message: string;
  /** Source location associated with the diagnostic. */
  span: GenbankSourceSpan;
  /** Zero-based record index when the diagnostic belongs to a parsed record. */
  recordIndex?: number;
  /** Zero-based feature index when the diagnostic belongs to a feature. */
  featureIndex?: number;
}

export type GenbankTopology = 'linear' | 'circular' | 'unknown';

/** Parsed fields from a LOCUS line. Raw tokens remain available when the line is non-canonical. */
export interface GenbankLocus {
  /** LOCUS identifier. */
  name: string;
  /** Declared sequence length. */
  length?: number;
  /** Declared length unit, usually bp or aa. */
  unit?: string;
  /** Declared strandedness token. */
  strandedness?: string;
  /** Declared molecule type. */
  moleculeType?: string;
  /** Declared molecule topology. */
  topology: GenbankTopology;
  /** Three-letter GenBank division code. */
  division?: string;
  /** LOCUS update date token. */
  date?: string;
  /** All whitespace-separated LOCUS tokens. */
  tokens: string[];
  /** Source span of the complete LOCUS line. */
  span: GenbankSourceSpan;
}

/** A top-level flat-file section, retained even when the parser does not interpret its semantics. */
export interface GenbankSection {
  /** Normalized top-level section key. */
  key: string;
  /** Continuation lines joined into a normalized value. */
  value: string;
  /** Original section text. */
  raw: string;
  /** Source span of the section. */
  span: GenbankSourceSpan;
}

/** SOURCE/ORGANISM information. */
export interface GenbankSource {
  /** Free-form SOURCE description. */
  description: string;
  /** Scientific organism name from ORGANISM. */
  organism?: string;
  /** Semicolon-separated taxonomy lineage. */
  taxonomy: string[];
  /** Source span covering SOURCE or ORGANISM. */
  span?: GenbankSourceSpan;
}

/** One REFERENCE block. */
export interface GenbankReference {
  /** Numeric REFERENCE identifier. */
  number?: number;
  /** Referenced sequence range. */
  range?: string;
  /** AUTHORS field. */
  authors?: string;
  /** CONSRTM field. */
  consortium?: string;
  /** TITLE field. */
  title?: string;
  /** JOURNAL field. */
  journal?: string;
  /** PUBMED identifier. */
  pubmed?: string;
  /** REMARK field. */
  remark?: string;
  /** All reference subfields, including unknown ones. */
  fields: Readonly<Record<string, string>>;
  /** Source span of the reference block. */
  span: GenbankSourceSpan;
}

export type GenbankPositionKind = 'exact' | 'before' | 'after' | 'within' | 'one-of' | 'unknown';

/** A one-based INSDC feature-table position. */
export interface GenbankPosition {
  /** Position uncertainty kind. */
  kind: GenbankPositionKind;
  /** Single numeric position when applicable. */
  value?: number;
  /** Numeric alternatives or within-range values. */
  values?: number[];
  /** Original position expression. */
  raw: string;
}

export interface GenbankPointLocation {
  /** Location node discriminator. */
  kind: 'point';
  /** Single position. */
  position: GenbankPosition;
  /** Original location expression. */
  raw: string;
}

export interface GenbankRangeLocation {
  /** Location node discriminator. */
  kind: 'range';
  /** First position. */
  start: GenbankPosition;
  /** Last position. */
  end: GenbankPosition;
  /** Original location expression. */
  raw: string;
}

export interface GenbankBetweenLocation {
  /** Location node discriminator. */
  kind: 'between';
  /** Position before the caret. */
  left: GenbankPosition;
  /** Position after the caret. */
  right: GenbankPosition;
  /** Original location expression. */
  raw: string;
}

export interface GenbankRemoteLocation {
  /** Location node discriminator. */
  kind: 'remote';
  /** Remote accession identifier. */
  accession: string;
  /** Location within the remote accession. */
  location: GenbankLocation;
  /** Original location expression. */
  raw: string;
}

export interface GenbankOperatorLocation {
  /** Location node discriminator. */
  kind: 'operator';
  /** Operator name, such as join or complement. */
  operator: string;
  /** Child location nodes. */
  parts: GenbankLocation[];
  /** Original location expression. */
  raw: string;
}

export interface GenbankUnparsedLocation {
  /** Location node discriminator. */
  kind: 'unparsed';
  /** Original unsupported or malformed expression. */
  raw: string;
}

export type GenbankLocation =
  | GenbankPointLocation
  | GenbankRangeLocation
  | GenbankBetweenLocation
  | GenbankRemoteLocation
  | GenbankOperatorLocation
  | GenbankUnparsedLocation;

/** A `/name[=value]` feature qualifier. Repeated names remain repeated and ordered. */
export interface GenbankQualifier {
  /** Qualifier name without the leading slash. */
  name: string;
  /** Decoded qualifier value. */
  value?: string;
  /** Original value text, including quotes when present. */
  rawValue?: string;
  /** Whether the value used GenBank double-quote syntax. */
  quoted: boolean;
  /** Whether a quoted value had a closing quote. */
  terminated: boolean;
  /** Source span of the complete qualifier. */
  span: GenbankSourceSpan;
}

/** One feature-table entry. */
export interface GenbankFeature {
  /** Feature key, such as CDS or gene. */
  key: string;
  /** Original concatenated location expression. */
  locationText: string;
  /** Parsed location AST. */
  location: GenbankLocation;
  /** Ordered feature qualifiers. */
  qualifiers: GenbankQualifier[];
  /** Source span of the complete feature. */
  span: GenbankSourceSpan;
  /** Source span of the location expression. */
  locationSpan: GenbankSourceSpan;
}

/** A complete read-only view of one GenBank/GenPept flat-file record. */
export interface GenbankDocument {
  /** Stable record identifier. */
  id: string;
  /** Parsed LOCUS fields. */
  locus: GenbankLocus;
  /** DEFINITION text. */
  definition?: string;
  /** ACCESSION identifiers. */
  accessions: string[];
  /** VERSION accession.version token. */
  version?: string;
  /** Legacy GI identifier. */
  gi?: string;
  /** KEYWORDS split on semicolons. */
  keywords: string[];
  /** DBLINK cross-references. */
  dbLinks: string[];
  /** SOURCE and ORGANISM metadata. */
  sourceInfo?: GenbankSource;
  /** Parsed literature references. */
  references: GenbankReference[];
  /** COMMENT sections. */
  comments: string[];
  /** Parsed feature table. */
  features: GenbankFeature[];
  /** Sequence from ORIGIN, with layout removed. */
  sequence: string;
  /** CONTIG expression when present. */
  contig?: string;
  /** BASE COUNT values keyed by residue. */
  baseCount?: Readonly<Record<string, number>>;
  /** Retained top-level sections. */
  sections: GenbankSection[];
  /** Absolute span in the original input text. */
  span: GenbankSourceSpan;
  /** Whether the record ended with an explicit // terminator. */
  terminated: boolean;
  /** The original text belonging only to this record, including its // terminator when present. */
  originalText: string;
  /** Diagnostics attached to this record. */
  diagnostics: GenbankDiagnostic[];
}

/** Backward-compatible alias for code that called one parsed record a GenBank record. */
export type GenbankRecord = GenbankDocument;

/** Select expensive or optional parts of the detailed parser. Every part is enabled by default. */
export interface GenbankDocumentParseOptions {
  /** Parse the feature table. */
  features?: boolean;
  /** Parse REFERENCE blocks. */
  references?: boolean;
  /** Parse and normalize ORIGIN sequence. */
  sequence?: boolean;
  /** Retain generic top-level sections. */
  sections?: boolean;
}
