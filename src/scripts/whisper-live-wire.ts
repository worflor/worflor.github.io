/**
 * Whisper Live — message wire format.
 *
 * Header:
 *   [0]      flags (1B): bit0 = isFile
 *   [1..65]  ratchet public key (65B, uncompressed P-256)
 *   [66..69] message counter (4B LE)
 *   [70..73] previous chain length (4B LE)
 *   [74..85] nonce (12B)
 * Payload:
 *   [86..]   AES-256-GCM ciphertext (includes 16B auth tag)
 *
 * For file messages, the plaintext is:
 *   [0..3]   filename length (4B LE)
 *   [4..4+N] filename (UTF-8)
 *   [4+N..]  file type (null-terminated) + file bytes
 */

import { TE, TD } from "./whisper-live-crypto";

export const HEADER_SIZE = 86;

export function buildHeader(
  flags: number, pubKey: Uint8Array, counter: number, prevChainLen: number, nonce: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header[0] = flags;
  header.set(pubKey, 1);
  view.setUint32(66, counter, true);
  view.setUint32(70, prevChainLen, true);
  header.set(nonce, 74);
  return header;
}

export function parseHeader(data: Uint8Array): {
  flags: number;
  pubKey: Uint8Array;
  counter: number;
  prevChainLen: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    flags: data[0],
    pubKey: data.subarray(1, 66),
    counter: view.getUint32(66, true),
    prevChainLen: view.getUint32(70, true),
    nonce: data.subarray(74, 86),
    ciphertext: data.subarray(86),
  };
}

export function encodeFilePlaintext(fileName: string, fileType: string, fileBytes: Uint8Array): Uint8Array {
  const nameBytes = TE.encode(fileName);
  const typeBytes = TE.encode(fileType);
  const buf = new Uint8Array(4 + nameBytes.length + typeBytes.length + 1 + fileBytes.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, nameBytes.length, true);
  buf.set(nameBytes, 4);
  buf.set(typeBytes, 4 + nameBytes.length);
  buf[4 + nameBytes.length + typeBytes.length] = 0; // null terminator for type
  buf.set(fileBytes, 4 + nameBytes.length + typeBytes.length + 1);
  return buf;
}

/** Strip path separators, control chars, and null bytes from a filename. */
export function sanitizeFileName(name: string): string {
  // Remove path separators and null bytes, then strip control characters (U+0000–U+001F, U+007F)
  return name.replace(/[/\\]/g, "_").replace(/[\x00-\x1f\x7f]/g, "") || "file";
}

export function decodeFilePlaintext(data: Uint8Array): { fileName: string; fileType: string; fileBytes: Uint8Array } {
  if (data.length < 5) throw new Error("file payload too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nameLen = view.getUint32(0, true);
  if (nameLen > data.length - 4) throw new Error("file name length exceeds payload");
  const fileName = sanitizeFileName(TD.decode(data.subarray(4, 4 + nameLen)));
  // Find null terminator after name
  let typeEnd = 4 + nameLen;
  while (typeEnd < data.length && data[typeEnd] !== 0) typeEnd++;
  const fileType = TD.decode(data.subarray(4 + nameLen, typeEnd));
  const fileBytes = data.subarray(typeEnd + 1);
  return { fileName, fileType, fileBytes };
}
