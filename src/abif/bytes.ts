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
