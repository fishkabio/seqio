import { GenbankLocation, GenbankPosition } from './types';

export interface LocationParseResult {
  location: GenbankLocation;
  complete: boolean;
}

class LocationParser {
  private offset = 0;

  public constructor(private readonly source: string) {}

  public parse(): LocationParseResult {
    this.skipWhitespace();
    const location = this.parseLocation();
    this.skipWhitespace();
    return { location, complete: location.kind !== 'unparsed' && this.offset === this.source.length };
  }

  private parseLocation(): GenbankLocation {
    this.skipWhitespace();
    const start = this.offset;
    const identifier = this.readIdentifier();
    if (identifier && identifier.toLowerCase() !== 'one-of' && this.peek() === '(') {
      this.offset += 1;
      const parts: GenbankLocation[] = [];
      while (this.offset < this.source.length && this.peek() !== ')') {
        parts.push(this.parseLocation());
        this.skipWhitespace();
        if (this.peek() !== ',') break;
        this.offset += 1;
      }
      this.skipWhitespace();
      if (this.peek() !== ')') return this.unparsed(start);
      this.offset += 1;
      return {
        kind: 'operator',
        operator: identifier.toLowerCase(),
        parts,
        raw: this.source.slice(start, this.offset),
      };
    }
    this.offset = start;

    const colon = this.findRemoteColon();
    if (colon !== undefined) {
      const accession = this.source.slice(this.offset, colon).trim();
      this.offset = colon + 1;
      const location = this.parseLocation();
      return { kind: 'remote', accession, location, raw: this.source.slice(start, this.offset) };
    }

    const left = this.parsePosition();
    if (left.kind === 'unknown') return this.unparsed(start);
    this.skipWhitespace();
    if (this.source.startsWith('..', this.offset)) {
      this.offset += 2;
      const right = this.parsePosition();
      if (right.kind === 'unknown') return this.unparsed(start);
      return { kind: 'range', start: left, end: right, raw: this.source.slice(start, this.offset) };
    }
    if (this.peek() === '^') {
      this.offset += 1;
      const right = this.parsePosition();
      if (right.kind === 'unknown') return this.unparsed(start);
      return { kind: 'between', left, right, raw: this.source.slice(start, this.offset) };
    }
    return { kind: 'point', position: left, raw: this.source.slice(start, this.offset) };
  }

  private parsePosition(): GenbankPosition {
    this.skipWhitespace();
    const start = this.offset;
    const marker = this.peek();
    if (marker === '<' || marker === '>') this.offset += 1;

    const oneOf = this.readIdentifier();
    if (oneOf?.toLowerCase() === 'one-of' && this.peek() === '(') {
      this.offset += 1;
      const values: number[] = [];
      while (this.offset < this.source.length && this.peek() !== ')') {
        this.skipWhitespace();
        const value = this.readInteger();
        if (value === undefined) return { kind: 'unknown', raw: this.source.slice(start, this.offset) };
        values.push(value);
        this.skipWhitespace();
        if (this.peek() !== ',') break;
        this.offset += 1;
      }
      if (this.peek() !== ')') return { kind: 'unknown', raw: this.source.slice(start, this.offset) };
      this.offset += 1;
      return { kind: 'one-of', values, raw: this.source.slice(start, this.offset) };
    }
    this.offset = marker === '<' || marker === '>' ? start + 1 : start;
    const value = this.readInteger();
    if (value === undefined) return { kind: 'unknown', raw: this.source.slice(start, this.offset) };
    if (this.peek() === '.' && this.source[this.offset + 1] !== '.') {
      this.offset += 1;
      const right = this.readInteger();
      if (right === undefined) return { kind: 'unknown', raw: this.source.slice(start, this.offset) };
      return { kind: 'within', values: [value, right], raw: this.source.slice(start, this.offset) };
    }
    return {
      kind: marker === '<' ? 'before' : marker === '>' ? 'after' : 'exact',
      value,
      raw: this.source.slice(start, this.offset),
    };
  }

  private findRemoteColon(): number | undefined {
    let cursor = this.offset;
    while (cursor < this.source.length) {
      const char = this.source[cursor];
      if (char === ':') return cursor;
      if (char === '(' || char === ')' || char === ',' || char === '^' || /[ \t\r\n]/.test(char)) return undefined;
      if (char === '.' && this.source[cursor + 1] === '.') return undefined;
      cursor += 1;
    }
    return undefined;
  }

  private readIdentifier(): string | undefined {
    const match = /^[A-Za-z][A-Za-z0-9_-]*/.exec(this.source.slice(this.offset));
    if (!match) return undefined;
    this.offset += match[0].length;
    return match[0];
  }

  private readInteger(): number | undefined {
    const match = /^-?\d+/.exec(this.source.slice(this.offset));
    if (!match) return undefined;
    this.offset += match[0].length;
    return Number.parseInt(match[0], 10);
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek())) this.offset += 1;
  }

  private peek(): string {
    return this.source[this.offset] ?? '';
  }

  private unparsed(start: number): GenbankLocation {
    this.offset = this.source.length;
    return { kind: 'unparsed', raw: this.source.slice(start) };
  }
}

/** Parse an INSDC feature location while retaining unrecognized input as an unparsed node. */
export function parseGenbankLocation(source: string): LocationParseResult {
  return new LocationParser(source).parse();
}
