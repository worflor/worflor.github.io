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

import { TE, TD } from "./live-crypto";

export const HEADER_SIZE = 86;
const PUBKEY_LEN = 65;
const NONCE_LEN = 12;
const HEADER_OFFSET = {
  FLAGS: 0,
  PUBKEY: 1,
  COUNTER: 66,
  PREV_CHAIN_LEN: 70,
  NONCE: 74,
  CIPHERTEXT: 86,
} as const;

const FILE_PLAINTEXT_OFFSET = {
  NAME_LENGTH: 0,
  NAME_BYTES: 4,
} as const;

export function buildHeader(
  flags: number, pubKey: Uint8Array, counter: number, prevChainLen: number, nonce: Uint8Array,
): Uint8Array {
  if (pubKey.length !== PUBKEY_LEN) throw new Error("invalid ratchet pubkey length");
  if (nonce.length !== NONCE_LEN) throw new Error("invalid nonce length");

  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header[HEADER_OFFSET.FLAGS] = flags;
  header.set(pubKey, HEADER_OFFSET.PUBKEY);
  view.setUint32(HEADER_OFFSET.COUNTER, counter, true);
  view.setUint32(HEADER_OFFSET.PREV_CHAIN_LEN, prevChainLen, true);
  header.set(nonce, HEADER_OFFSET.NONCE);
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
    flags: data[HEADER_OFFSET.FLAGS],
    pubKey: data.subarray(HEADER_OFFSET.PUBKEY, HEADER_OFFSET.COUNTER),
    counter: view.getUint32(HEADER_OFFSET.COUNTER, true),
    prevChainLen: view.getUint32(HEADER_OFFSET.PREV_CHAIN_LEN, true),
    nonce: data.subarray(HEADER_OFFSET.NONCE, HEADER_OFFSET.CIPHERTEXT),
    ciphertext: data.subarray(HEADER_OFFSET.CIPHERTEXT),
  };
}

export function encodeFilePlaintext(fileName: string, fileType: string, fileBytes: Uint8Array): Uint8Array {
  const nameBytes = TE.encode(fileName);
  const typeBytes = TE.encode(fileType);
  const buf = new Uint8Array(4 + nameBytes.length + typeBytes.length + 1 + fileBytes.length);
  const view = new DataView(buf.buffer);
  const nameStart = FILE_PLAINTEXT_OFFSET.NAME_BYTES;
  const typeStart = nameStart + nameBytes.length;
  const fileStart = typeStart + typeBytes.length + 1;

  view.setUint32(FILE_PLAINTEXT_OFFSET.NAME_LENGTH, nameBytes.length, true);
  buf.set(nameBytes, nameStart);
  buf.set(typeBytes, typeStart);
  buf[fileStart - 1] = 0; // null terminator for type
  buf.set(fileBytes, fileStart);
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
  const nameLen = view.getUint32(FILE_PLAINTEXT_OFFSET.NAME_LENGTH, true);
  const nameStart = FILE_PLAINTEXT_OFFSET.NAME_BYTES;
  if (nameLen > data.length - nameStart) throw new Error("file name length exceeds payload");

  const typeStart = nameStart + nameLen;
  const fileName = sanitizeFileName(TD.decode(data.subarray(nameStart, typeStart)));
  // Find null terminator after name
  let typeEnd = typeStart;
  while (typeEnd < data.length && data[typeEnd] !== 0) typeEnd++;
  const fileType = TD.decode(data.subarray(typeStart, typeEnd));
  const fileBytes = data.subarray(typeEnd + 1);
  return { fileName, fileType, fileBytes };
}
