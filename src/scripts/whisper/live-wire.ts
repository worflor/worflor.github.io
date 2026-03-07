/**
 * Whisper Live — message wire format.
 *
 * Nonce reconstruction:
 *   Both sides build the 12-byte AES-GCM nonce deterministically:
 *     [0..3]  counter (4B LE)
 *     [4]     direction bit (0 = offerer, 1 = answerer)
 *     [5..8]  salt (4B random, sent on wire — safety net against key reuse bugs)
 *     [9..11] 0x00 padding
 *
 * Full header (flags bit3 = 0):
 *   [0]      flags (1B): bit0 = isFile, bit3 = sameKey
 *   [1..33]  ratchet public key (33B, compressed P-256)
 *   [34..37] message counter (4B LE)
 *   [38..41] previous chain length (4B LE)
 *   [42..45] salt (4B)
 *   [46..]   ciphertext
 *
 * Compact header (flags bit3 = 1, pubkey omitted):
 *   [0]      flags (1B)
 *   [1..4]   message counter (4B LE)
 *   [5..8]   previous chain length (4B LE)
 *   [9..12]  salt (4B)
 *   [13..]   ciphertext
 *
 * For file messages, the plaintext is:
 *   [0..3]   filename length (4B LE)
 *   [4..4+N] filename (UTF-8)
 *   [4+N..]  file type (null-terminated) + file bytes
 */

import { TD } from "./live-crypto";

const TE = new TextEncoder();

export const HEADER_SIZE = 46;
export const HEADER_SIZE_COMPACT = 13;
const PUBKEY_LEN = 33;
const SALT_LEN = 4;
export const LIVE_FLAG_SAME_KEY = 0x08;
const HEADER_OFFSET = {
  FLAGS: 0,
  PUBKEY: 1,
  COUNTER: 34,
  PREV_CHAIN_LEN: 38,
  SALT: 42,
  CIPHERTEXT: 46,
} as const;
const COMPACT_OFFSET = {
  FLAGS: 0,
  COUNTER: 1,
  PREV_CHAIN_LEN: 5,
  SALT: 9,
  CIPHERTEXT: 13,
} as const;

/** Reconstruct the 12-byte AES-GCM nonce from counter, direction bit, and salt. */
export function buildNonce(counter: number, dirBit: number, salt: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(0, counter, true);
  nonce[4] = dirBit;
  nonce.set(salt, 5);
  // bytes 9..11 remain 0x00
  return nonce;
}

const FILE_PLAINTEXT_OFFSET = {
  NAME_LENGTH: 0,
  NAME_BYTES: 4,
} as const;

export function buildHeader(
  flags: number, pubKey: Uint8Array, counter: number, prevChainLen: number, salt: Uint8Array,
): Uint8Array {
  if (salt.length !== SALT_LEN) throw new Error("invalid salt length");

  if (flags & LIVE_FLAG_SAME_KEY) {
    // Compact header — no pubkey
    const header = new Uint8Array(HEADER_SIZE_COMPACT);
    const view = new DataView(header.buffer);
    header[COMPACT_OFFSET.FLAGS] = flags;
    view.setUint32(COMPACT_OFFSET.COUNTER, counter, true);
    view.setUint32(COMPACT_OFFSET.PREV_CHAIN_LEN, prevChainLen, true);
    header.set(salt, COMPACT_OFFSET.SALT);
    return header;
  }

  if (pubKey.length !== PUBKEY_LEN) throw new Error("invalid ratchet pubkey length");
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header[HEADER_OFFSET.FLAGS] = flags;
  header.set(pubKey, HEADER_OFFSET.PUBKEY);
  view.setUint32(HEADER_OFFSET.COUNTER, counter, true);
  view.setUint32(HEADER_OFFSET.PREV_CHAIN_LEN, prevChainLen, true);
  header.set(salt, HEADER_OFFSET.SALT);
  return header;
}

export function parseHeader(data: Uint8Array): {
  flags: number;
  pubKey: Uint8Array | null;  // null when sameKey flag is set
  counter: number;
  prevChainLen: number;
  salt: Uint8Array;
  ciphertext: Uint8Array;
} {
  const flags = data[0];
  if (flags & LIVE_FLAG_SAME_KEY) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      flags,
      pubKey: null,
      counter: view.getUint32(COMPACT_OFFSET.COUNTER, true),
      prevChainLen: view.getUint32(COMPACT_OFFSET.PREV_CHAIN_LEN, true),
      salt: data.subarray(COMPACT_OFFSET.SALT, COMPACT_OFFSET.CIPHERTEXT),
      ciphertext: data.subarray(COMPACT_OFFSET.CIPHERTEXT),
    };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    flags,
    pubKey: data.subarray(HEADER_OFFSET.PUBKEY, HEADER_OFFSET.COUNTER),
    counter: view.getUint32(HEADER_OFFSET.COUNTER, true),
    prevChainLen: view.getUint32(HEADER_OFFSET.PREV_CHAIN_LEN, true),
    salt: data.subarray(HEADER_OFFSET.SALT, HEADER_OFFSET.CIPHERTEXT),
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

/** Strip path separators, control chars, null bytes, and reserved device names from a filename. */
function sanitizeFileName(name: string): string {
  let sanitized = name
    .replace(/[/\\]/g, "_")            // path separators → underscore
    .replace(/[\x00-\x1f\x7f]/g, "")  // strip control characters
    .replace(/[<>:"|?*]/g, "_")        // characters illegal on Windows
    .replace(/\s+$/, "")               // trailing whitespace
    .replace(/\.+$/, "");              // trailing dots (Windows strips these silently)
  // Windows reserved device names — prefix with underscore to defuse
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(sanitized)) {
    sanitized = "_" + sanitized;
  }
  return sanitized || "file";
}

/** Application-level multi-part file chunk header. */
export interface FilePartHeader {
  transferId: number;
  chunkIndex: number;
  totalChunks: number;
  totalFileSize: number;
  /** Only present on chunk 0. */
  fileName?: string;
  /** Only present on chunk 0. */
  fileType?: string;
  chunkData: Uint8Array;
}

/**
 * Encode a FILE_PART plaintext chunk.
 *
 * Chunk 0 layout:
 *   [0..3]   transferId (4B LE)
 *   [4..7]   chunkIndex = 0
 *   [8..11]  totalChunks (4B LE)
 *   [12..15] totalFileSize (4B LE)
 *   [16..17] nameLen (2B LE)
 *   [18..]   name bytes, type bytes (null-terminated), chunk data
 *
 * Chunks 1..N-1 layout:
 *   [0..3]   transferId (4B LE)
 *   [4..7]   chunkIndex (4B LE)
 *   [8..11]  totalChunks (4B LE)
 *   [12..15] totalFileSize (4B LE)
 *   [16..]   chunk data
 */
export function encodeFilePartPlaintext(
  transferId: number,
  chunkIndex: number,
  totalChunks: number,
  totalFileSize: number,
  chunkData: Uint8Array,
  fileName?: string,
  fileType?: string,
): Uint8Array {
  if (chunkIndex === 0) {
    const nameBytes = TE.encode(fileName ?? "");
    const typeBytes = TE.encode(fileType ?? "");
    const out = new Uint8Array(18 + nameBytes.length + typeBytes.length + 1 + chunkData.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, transferId, true);
    v.setUint32(4, 0, true);
    v.setUint32(8, totalChunks, true);
    v.setUint32(12, totalFileSize, true);
    v.setUint16(16, nameBytes.length, true);
    out.set(nameBytes, 18);
    out.set(typeBytes, 18 + nameBytes.length);
    out[18 + nameBytes.length + typeBytes.length] = 0; // null terminator
    out.set(chunkData, 19 + nameBytes.length + typeBytes.length);
    return out;
  } else {
    const out = new Uint8Array(16 + chunkData.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, transferId, true);
    v.setUint32(4, chunkIndex, true);
    v.setUint32(8, totalChunks, true);
    v.setUint32(12, totalFileSize, true);
    out.set(chunkData, 16);
    return out;
  }
}

export function decodeFilePartPlaintext(data: Uint8Array): FilePartHeader {
  if (data.length < 16) throw new Error("file part too short");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const transferId = v.getUint32(0, true);
  const chunkIndex = v.getUint32(4, true);
  const totalChunks = v.getUint32(8, true);
  const totalFileSize = v.getUint32(12, true);
  if (chunkIndex === 0) {
    if (data.length < 18) throw new Error("file part first chunk too short");
    const nameLen = v.getUint16(16, true);
    if (18 + nameLen > data.length) throw new Error("file part name out of bounds");
    const fileName = sanitizeFileName(TD.decode(data.subarray(18, 18 + nameLen)));
    let typeEnd = 18 + nameLen;
    while (typeEnd < data.length && data[typeEnd] !== 0) typeEnd++;
    const fileType = TD.decode(data.subarray(18 + nameLen, typeEnd));
    const chunkData = data.subarray(Math.min(typeEnd + 1, data.length));
    return { transferId, chunkIndex, totalChunks, totalFileSize, fileName, fileType, chunkData };
  } else {
    return { transferId, chunkIndex, totalChunks, totalFileSize, chunkData: data.subarray(16) };
  }
}

export function decodeFilePlaintext(data: Uint8Array): { fileName: string; fileType: string; fileBytes: Uint8Array } {
  if (data.length < 5) throw new Error("file payload too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nameLen = view.getUint32(FILE_PLAINTEXT_OFFSET.NAME_LENGTH, true);
  const nameStart = FILE_PLAINTEXT_OFFSET.NAME_BYTES;
  if (nameLen > data.length - nameStart) throw new Error("file name length exceeds payload");

  const typeStart = nameStart + nameLen;
  if (typeStart > data.length) throw new Error("file name extends past payload");
  const fileName = sanitizeFileName(TD.decode(data.subarray(nameStart, typeStart)));
  let typeEnd = typeStart;
  while (typeEnd < data.length && data[typeEnd] !== 0) typeEnd++;
  const fileType = TD.decode(data.subarray(typeStart, typeEnd));
  const fileStart = Math.min(typeEnd + 1, data.length);
  const fileBytes = data.subarray(fileStart);
  return { fileName, fileType, fileBytes };
}
