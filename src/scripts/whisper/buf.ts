// buf.ts — tiny shared buffer utilities (zero deps)
//
// extracted from wasm.ts so that codec-only consumers (prism, live-loop,
// live-crypto) don't transitively pull in seal.ts and the full whisper
// embed/extract machinery.

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // provide an exact ArrayBuffer containing only [byteOffset, byteOffset+byteLength).
  // this keeps runtime fast for "owning" buffers (offset=0,len=bufLen) and satisfies
  // DOM typings that require ArrayBuffer-backed BufferSource.
  const buf = bytes.buffer;
  if (buf instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) return buf;
    return buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const copy = new Uint8Array(bytes);
  return copy.buffer;
}

const HEX_LUT: string[] = [];
for (let i = 0; i < 256; i++) HEX_LUT[i] = i.toString(16).padStart(2, "0");

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX_LUT[bytes[i]];
  return out;
}
