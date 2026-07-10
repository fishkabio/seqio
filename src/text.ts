/**
 * Small text helpers shared by the text-format readers (FASTA/FASTQ, GenBank, EMBL,
 * Swiss-Prot, the alignment family, …). Browser- and Node-safe: decoding goes through
 * TextDecoder, never Node's Buffer.
 */

/** Decode bytes as UTF-8 (ASCII is a subset), dropping a leading BOM; pass strings through. */
export function decodeText(input: string | Uint8Array): string {
  let text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  // A leading UTF-8 BOM (U+FEFF) from a Windows editor would otherwise hide the first
  // line's marker. TextDecoder already strips it from byte input; this covers strings.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/** Decode and split into lines on any newline style (LF, CRLF, CR). */
export function toLines(input: string | Uint8Array): string[] {
  return decodeText(input).split(/\r\n|\r|\n/);
}

/** Remove every whitespace character (used to concatenate wrapped residue/quality lines). */
export function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, '');
}

/** Whether a line is empty or whitespace-only. */
export function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** The first whitespace-delimited token of a string (trimmed); '' when there is none. */
export function firstToken(s: string): string {
  const t = s.trim();
  const space = t.search(/\s/);
  return space < 0 ? t : t.slice(0, space);
}
