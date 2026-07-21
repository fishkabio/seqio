/**
 * Tiny binary helpers used across the ABIF reader/writer.
 *
 * Everything here operates on Uint8Array + DataView so the same code runs in
 * Node (where Buffer extends Uint8Array) and the browser.
 */

export function asciiString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Strict UTF-8 decoder — throws on any invalid sequence instead of substituting U+FFFD. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode the payload of a text tag (char / pString / cString).
 *
 * ABIF fixes no encoding for its string types — the spec says ASCII, but instruments write whatever
 * their locale produces: UTF-8 (Nanofor writes cyrillic that way), Latin-1, Shift-JIS. So we sniff:
 * bytes that decode as strict UTF-8 are UTF-8, anything else falls back to the byte-per-character
 * reading that has always been used here (Latin-1). Pure ASCII decodes identically either way.
 *
 * The guess is not infallible — a Latin-1 payload that happens to satisfy UTF-8's multi-byte structure
 * (`C3 A9`, i.e. "Ã©") reads back as "é". Single high bytes, the common Latin-1 case, do not decode as
 * UTF-8 and so take the fallback. Encoding is not stored anywhere, so a heuristic is the only option
 * short of an explicit setting; the raw layer keeps the original bytes either way.
 */
export function decodeAbifText(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return asciiString(bytes);
  }
}

/** Encode text for a string tag as UTF-8 — the counterpart of {@link decodeAbifText}. */
export function encodeAbifText(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Returns a DataView over the given bytes, regardless of input shape. */
export function asDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Returns a Uint8Array view over a slice; never copies. */
export function subview(bytes: Uint8Array, start: number, length: number): Uint8Array {
  return bytes.subarray(start, start + length);
}

/** Tag name encoded as a big-endian uint32 (e.g. "DATA" → 0x44415441). */
export function tagNameToInt32(tag: string): number {
  return (
    ((tag.charCodeAt(0) & 0xff) << 24) |
    ((tag.charCodeAt(1) & 0xff) << 16) |
    ((tag.charCodeAt(2) & 0xff) << 8) |
    (tag.charCodeAt(3) & 0xff)
  );
}

export function tagNameFromInt32(n: number): string {
  return String.fromCharCode((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}
