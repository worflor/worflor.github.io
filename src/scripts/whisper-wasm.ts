export interface WhisperInertCandidate {
  offset: number;
  length: number;
  zeroDensity: number;
  ffDensity: number;
  entropy: number;
  score: number;
  kind: "padding" | "gap";
}

export interface WhisperScanOptions {
  windowSize?: number;
  stride?: number;
  minCandidateLength?: number;
  maxCandidates?: number;
}

export interface WhisperPayloadInput {
  bytes: Uint8Array;
  name: string;
  type: string;
  label?: string;
}

export interface WhisperEmbedOptions {
  preferInertSpace?: boolean;
  maxCandidates?: number;
  /** When true, payload can only be decrypted on this browser profile (local IndexedDB receipt required). */
  onlyDecodeHere?: boolean;
}

export interface WhisperEnvelopeInfo {
  offset: number;
  length: number;
  mode: "inert-slot" | "eof-tail";
  locatorHex: string;
  carrierBindHex: string;
}

export interface WhisperEmbedResult {
  outputBytes: Uint8Array;
  outputName: string;
  outputType: string;
  payloadHashHex: string;
  envelope: WhisperEnvelopeInfo;
  candidates: WhisperInertCandidate[];
  logs: string[];
}

export interface WhisperEmbedFileResult {
  outputFile: File;
  outputName: string;
  outputType: string;
  payloadHashHex: string;
  envelope: WhisperEnvelopeInfo;
  logs: string[];
}

export interface WhisperExtractOptions {
  clue?: string;
  destructOnExtract?: boolean;
}

export interface WhisperExtractPayload {
  name: string;
  type: string;
  label: string;
  bytes: Uint8Array;
  hashHex: string;
  createdAt: string;
}

export interface WhisperExtractResult {
  found: boolean;
  confidence: number;
  offset: number | null;
  payload: WhisperExtractPayload | null;
  scrubbedCarrierBytes: Uint8Array | null;
  logs: string[];
}

export interface WhisperExtractFileResult {
  found: boolean;
  confidence: number;
  offset: number | null;
  payload: WhisperExtractPayload | null;
  scrubbedFile: File | null;
  logs: string[];
}

export interface WhisperHuntCarrier {
  name: string;
  bytes: Uint8Array;
  type?: string;
}

export interface WhisperHuntMatch {
  sourceName: string;
  sourceType: string;
  confidence: number;
  offset: number;
  payload: WhisperExtractPayload;
  scrubbedCarrierBytes: Uint8Array | null;
}

export interface WhisperHuntResult {
  matches: WhisperHuntMatch[];
  scannedCount: number;
  logs: string[];
}

interface WhisperWasmExports {
  memory: WebAssembly.Memory;
  /** Single-pass histogram builder. Writes 256 × i32 bins at histOutPtr. */
  build_histogram: (dataPtr: number, dataLen: number, histOutPtr: number) => number;
}

/** Fixed offset where the 256×4-byte histogram is written in WASM linear memory. */
const HISTOGRAM_OFFSET = 2048;

interface WhisperWasmCore {
  instance: WebAssembly.Instance;
  exports: WhisperWasmExports;
}

interface WhisperPackedPayload {
  name: string;
  type: string;
  label: string;
  createdAt: string;
  payload: Uint8Array;
}

interface WhisperEnvelopeHeader {
  version: number;
  flags: number;
  headerLength: number;
  manifestLength: number;
  cipherLength: number;
  embedOffset: number;
  embedLength: number;
  salt: Uint8Array;
  nonce: Uint8Array;
  bindDigest: Uint8Array;
}

const PAGE_SIZE = 64 * 1024;
const I32 = 0x7f;
const BLOCK_VOID = 0x40;
/** Carrier data starts immediately after the 256×i32 histogram bins in WASM linear memory. */
const CARRIER_OFFSET = HISTOGRAM_OFFSET + 256 * 4; // 3072

const DEFAULT_WINDOW = 4096;
const DEFAULT_STRIDE = 1024;
const DEFAULT_MIN_LEN = 96;
const DEFAULT_MAX_CANDIDATES = 24;
const SMALL_CARRIER_THRESHOLD = 64 * 1024 * 1024; // 64 MiB — below this, embedFile uses bytes-based embed() for inert-space scan

const LOCATOR_LEN = 12;
const HEADER_LEN = 64;
const HEADER_VERSION = 2;
const HEADER_FLAGS = 0;
const FLAG_RECEIPT_REQUIRED = 1 << 0;
const FLAG_RECEIPT_LOCALKEY = 1 << 1;
const ENVELOPE_AAD_CONTEXT = "whisper-envelope-v2";
const LOCATOR_CONTEXT = "whisper-locator-v2";
const KDF_CONTEXT = "whisper-kdf-v2";
const PBKDF2_ITERATIONS = 310_000;

const RECEIPT_DB_NAME = "whisper.receipts";
const RECEIPT_DB_VERSION = 1;
const RECEIPT_STORE = "receipts";

/** Thresholds for console warnings — no hard limits, just let the browser decide. */
const WARN_CARRIER_BYTES = 1024 * 1024 * 1024; // 1 GiB
const WARN_PAYLOAD_BYTES = 256 * 1024 * 1024; // 256 MiB

let whisperCorePromise: Promise<WhisperWasmCore> | undefined;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function verifyEnvelopeCipher(
  password: string,
  locator: Uint8Array,
  headerBytes: Uint8Array,
  header: WhisperEnvelopeHeader,
  cipherBytes: Uint8Array,
  immutableHash: Uint8Array,
  expectedPayloadHashHex: string,
  receiptKeyHint: CryptoKey | null,
  receiptSecretHint: Uint8Array | null,
): Promise<void> {
  const bindDigest = immutableHash.subarray(0, 16);
  if (!bytesEqual(bindDigest, header.bindDigest)) {
    throw new Error("verify: carrier bind mismatch");
  }

  const needsReceipt = (header.flags & FLAG_RECEIPT_REQUIRED) !== 0;
  const localKeyMode = (header.flags & FLAG_RECEIPT_LOCALKEY) !== 0;
  const { inner: nonceInner, outer: nonceOuter } = await deriveLayerNoncesAsync(header.nonce);

  let innerCipherBytes = cipherBytes;
  if (needsReceipt && localKeyMode) {
    let localKey = receiptKeyHint;
    if (!localKey) {
      const receiptId = await deriveReceiptId(locator, headerBytes);
      localKey = await getReceiptKey(receiptId);
    }
    if (!localKey) throw new Error("verify: local lock key missing");

    const aadOuter = concatBytes(locator, headerBytes, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|outer`));
    const outerPlainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonceOuter), additionalData: toArrayBuffer(aadOuter) },
      localKey,
      toArrayBuffer(innerCipherBytes),
    );
    innerCipherBytes = new Uint8Array(outerPlainBuf);
  }

  let packedPlain: ArrayBuffer;
  if (needsReceipt && !localKeyMode) {
    let receiptSecret = receiptSecretHint;
    if (!receiptSecret) {
      const receiptId = await deriveReceiptId(locator, headerBytes);
      receiptSecret = await getReceipt(receiptId);
    }
    if (!receiptSecret) throw new Error("verify: local lock receipt missing");

    const key = await deriveAesKeyWithReceipt(password, immutableHash, header.salt, receiptSecret);
    const aad = concatBytes(locator, headerBytes, textEncoder.encode(ENVELOPE_AAD_CONTEXT));
    packedPlain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aad) },
      key,
      toArrayBuffer(innerCipherBytes),
    );
  } else {
    const key = await deriveAesKey(password, immutableHash, header.salt);
    const aadInner = concatBytes(locator, headerBytes, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|inner`));
    packedPlain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aadInner) },
      key,
      toArrayBuffer(innerCipherBytes),
    );
  }

  const packed = unpackPayload(new Uint8Array(packedPlain));
  const hashHex = toHex(await sha256(packed.payload));
  if (hashHex !== expectedPayloadHashHex) {
    throw new Error("verify: payload hash mismatch");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Provide an exact ArrayBuffer containing only [byteOffset, byteOffset+byteLength).
  // This keeps runtime fast for “owning” buffers (offset=0,len=bufLen) and satisfies
  // DOM typings that require ArrayBuffer-backed BufferSource.
  const buf = bytes.buffer;
  if (buf instanceof ArrayBuffer) {
    if (bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength) return buf;
    return buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const copy = new Uint8Array(bytes);
  return copy.buffer;
}

type WhisperReceiptRecord = {
  id: string;
  secret?: ArrayBuffer;
  key?: CryptoKey;
  createdAt: string;
};

function openReceiptDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable."));
      return;
    }

    const req = indexedDB.open(RECEIPT_DB_NAME, RECEIPT_DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("Failed to open receipt DB."));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECEIPT_STORE)) {
        db.createObjectStore(RECEIPT_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function putReceipt(id: string, secretBytes: Uint8Array): Promise<void> {
  const db = await openReceiptDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECEIPT_STORE, "readwrite");
      tx.onabort = () => reject(tx.error ?? new Error("Receipt write aborted."));
      tx.onerror = () => reject(tx.error ?? new Error("Receipt write failed."));
      tx.oncomplete = () => resolve();

      const store = tx.objectStore(RECEIPT_STORE);
      const record: WhisperReceiptRecord = {
        id,
        secret: toArrayBuffer(secretBytes),
        createdAt: new Date().toISOString(),
      };
      store.put(record);
    });
  } finally {
    db.close();
  }
}

async function putReceiptKey(id: string, key: CryptoKey): Promise<void> {
  const db = await openReceiptDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(RECEIPT_STORE, "readwrite");
      tx.onabort = () => reject(tx.error ?? new Error("Receipt key write aborted."));
      tx.onerror = () => reject(tx.error ?? new Error("Receipt key write failed."));
      tx.oncomplete = () => resolve();

      const store = tx.objectStore(RECEIPT_STORE);
      const record: WhisperReceiptRecord = {
        id,
        key,
        createdAt: new Date().toISOString(),
      };
      store.put(record);
    });
  } finally {
    db.close();
  }
}

async function getReceipt(id: string): Promise<Uint8Array | null> {
  const db = await openReceiptDb();
  try {
    const record = await new Promise<WhisperReceiptRecord | null>((resolve, reject) => {
      const tx = db.transaction(RECEIPT_STORE, "readonly");
      tx.onabort = () => reject(tx.error ?? new Error("Receipt read aborted."));
      tx.onerror = () => reject(tx.error ?? new Error("Receipt read failed."));

      const store = tx.objectStore(RECEIPT_STORE);
      const req = store.get(id);
      req.onerror = () => reject(req.error ?? new Error("Receipt read failed."));
      req.onsuccess = () => resolve((req.result as WhisperReceiptRecord | undefined) ?? null);
    });
    if (!record?.secret) return null;
    return new Uint8Array(record.secret);
  } finally {
    db.close();
  }
}

async function getReceiptKey(id: string): Promise<CryptoKey | null> {
  const db = await openReceiptDb();
  try {
    const record = await new Promise<WhisperReceiptRecord | null>((resolve, reject) => {
      const tx = db.transaction(RECEIPT_STORE, "readonly");
      tx.onabort = () => reject(tx.error ?? new Error("Receipt key read aborted."));
      tx.onerror = () => reject(tx.error ?? new Error("Receipt key read failed."));

      const store = tx.objectStore(RECEIPT_STORE);
      const req = store.get(id);
      req.onerror = () => reject(req.error ?? new Error("Receipt key read failed."));
      req.onsuccess = () => resolve((req.result as WhisperReceiptRecord | undefined) ?? null);
    });
    const key = record?.key;
    if (!key) return null;
    return key;
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental SHA-256 (in-house, no deps). Used for streaming Blob/File hashing.
// ─────────────────────────────────────────────────────────────────────────────

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

class Sha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  private buffer = new Uint8Array(64);
  private bufferLen = 0;
  private bytesHashed = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error("Sha256: digest() already called.");
    let pos = 0;
    this.bytesHashed += data.length;

    while (pos < data.length) {
      const take = Math.min(64 - this.bufferLen, data.length - pos);
      this.buffer.set(data.subarray(pos, pos + take), this.bufferLen);
      this.bufferLen += take;
      pos += take;
      if (this.bufferLen === 64) {
        this.compress(this.buffer);
        this.bufferLen = 0;
      }
    }

    return this;
  }

  digest(): Uint8Array {
    if (!this.finished) {
      const bitsHashed = this.bytesHashed * 8;

      // append 0x80
      this.buffer[this.bufferLen++] = 0x80;

      // pad with zeros until we have 8 bytes left for length
      if (this.bufferLen > 56) {
        while (this.bufferLen < 64) this.buffer[this.bufferLen++] = 0;
        this.compress(this.buffer);
        this.bufferLen = 0;
      }
      while (this.bufferLen < 56) this.buffer[this.bufferLen++] = 0;

      // write big-endian 64-bit length
      const hi = Math.floor(bitsHashed / 0x1_0000_0000);
      const lo = bitsHashed >>> 0;
      this.buffer[56] = (hi >>> 24) & 0xff;
      this.buffer[57] = (hi >>> 16) & 0xff;
      this.buffer[58] = (hi >>> 8) & 0xff;
      this.buffer[59] = hi & 0xff;
      this.buffer[60] = (lo >>> 24) & 0xff;
      this.buffer[61] = (lo >>> 16) & 0xff;
      this.buffer[62] = (lo >>> 8) & 0xff;
      this.buffer[63] = lo & 0xff;

      this.compress(this.buffer);
      this.finished = true;
    }

    const out = new Uint8Array(32);
    const words = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    for (let i = 0; i < words.length; i++) {
      const w = words[i] >>> 0;
      out[i * 4 + 0] = (w >>> 24) & 0xff;
      out[i * 4 + 1] = (w >>> 16) & 0xff;
      out[i * 4 + 2] = (w >>> 8) & 0xff;
      out[i * 4 + 3] = w & 0xff;
    }
    return out;
  }

  private compress(chunk: Uint8Array): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      const j = i * 4;
      w[i] = (
        (chunk[j] << 24) |
        (chunk[j + 1] << 16) |
        (chunk[j + 2] << 8) |
        (chunk[j + 3])
      ) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }
}

async function hashBlobSha256(blob: Blob): Promise<Uint8Array> {
  const hasher = new Sha256();
  if (typeof (blob as unknown as { stream?: unknown }).stream !== "function") {
    const buf = await blob.arrayBuffer();
    return hasher.update(new Uint8Array(buf)).digest();
  }

  const reader = blob.stream().getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      hasher.update(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digest();
}

async function hashBlobSha256Excluding(blob: Blob, excludeOffset: number, excludeLength: number): Promise<Uint8Array> {
  const start = Math.max(0, Math.min(excludeOffset, blob.size));
  const end = Math.max(start, Math.min(excludeOffset + excludeLength, blob.size));
  if (end <= start) return hashBlobSha256(blob);
  const hasher = new Sha256();

  const hashPart = async (part: Blob) => {
    if (typeof (part as unknown as { stream?: unknown }).stream !== "function") {
      const buf = await part.arrayBuffer();
      hasher.update(new Uint8Array(buf));
      return;
    }

    const reader = part.stream().getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        hasher.update(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  };

  await hashPart(blob.slice(0, start));
  await hashPart(blob.slice(end));
  return hasher.digest();
}

async function findSubsequenceInBlob(
  blob: Blob,
  needle: Uint8Array,
  options: { chunkSize?: number; maxHits?: number } = {},
): Promise<number[]> {
  const chunkSize = Math.max(64 * 1024, options.chunkSize ?? (1024 * 1024));
  const maxHits = Math.max(1, options.maxHits ?? 24);
  const hits: number[] = [];

  if (needle.length === 0 || blob.size < needle.length) return hits;

  let offset = 0;
  let carry = new Uint8Array(0);
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + chunkSize);
    const sliceBuf = await blob.slice(offset, end).arrayBuffer();
    const chunk = new Uint8Array(sliceBuf);
    const combined = new Uint8Array(carry.length + chunk.length);
    combined.set(carry, 0);
    combined.set(chunk, carry.length);

    const localHits = findSubsequence(combined, needle);
    for (const local of localHits) {
      const absolute = (offset - carry.length) + local;
      if (absolute < 0) continue;
      // De-duplicate hits that land in overlap.
      const prev = hits[hits.length - 1];
      if (prev === absolute) continue;
      hits.push(absolute);
      if (hits.length >= maxHits) return hits;
    }

    if (needle.length > 1) {
      const keep = Math.min(needle.length - 1, combined.length);
      carry = combined.subarray(combined.length - keep);
    }

    offset = end;
  }

  return hits;
}

function encodeU32(value: number): number[] {
  let v = value >>> 0;
  const out: number[] = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function encodeS32(value: number): number[] {
  let v = value | 0;
  const out: number[] = [];
  let done = false;
  while (!done) {
    let byte = v & 0x7f;
    v >>= 7;
    const signBitSet = (byte & 0x40) !== 0;
    const shouldStop = (v === 0 && !signBitSet) || (v === -1 && signBitSet);
    if (!shouldStop) byte |= 0x80;
    out.push(byte);
    done = shouldStop;
  }
  return out;
}

function encodeName(name: string): number[] {
  const bytes = Array.from(textEncoder.encode(name));
  return [...encodeU32(bytes.length), ...bytes];
}

function makeSection(id: number, payload: number[]): number[] {
  return [id, ...encodeU32(payload.length), ...payload];
}

function localGet(index: number): number[] {
  return [0x20, ...encodeU32(index)];
}

function localSet(index: number): number[] {
  return [0x21, ...encodeU32(index)];
}

function i32Const(value: number): number[] {
  return [0x41, ...encodeS32(value)];
}

function br(label: number): number[] {
  return [0x0c, ...encodeU32(label)];
}

function brIf(label: number): number[] {
  return [0x0d, ...encodeU32(label)];
}

type LocalDecl = { count: number; type: number };

function encodeLocalDecls(decls: LocalDecl[]): number[] {
  const out: number[] = [...encodeU32(decls.length)];
  for (const decl of decls) out.push(...encodeU32(decl.count), decl.type);
  return out;
}

function encodeFuncBody(decls: LocalDecl[], instructions: number[]): number[] {
  const body = [...encodeLocalDecls(decls), ...instructions];
  return [...encodeU32(body.length), ...body];
}

/**
 * WASM function: build_histogram(dataPtr, dataLen, histOutPtr) -> 0
 *
 * Single-pass byte-frequency histogram. Writes 256 × i32 bins at histOutPtr.
 * Replaces two separate count_byte calls + a JS entropy loop with one WASM pass.
 *
 * Params: 0: dataPtr  1: dataLen  2: histOutPtr
 * Locals: 3: i        4: byteVal  5: binAddr
 */
function buildHistogramBody(): number[] {
  const instructions: number[] = [
    // ── Zero 256 histogram bins (256 × 4 = 1024 bytes) ──
    ...i32Const(0), ...localSet(3),                                    // i = 0
    0x02, BLOCK_VOID,                                                   // block $break
    0x03, BLOCK_VOID,                                                   // loop  $continue
    ...localGet(3), ...i32Const(256), 0x4f, ...brIf(1),                // if i >= 256: break
    ...localGet(2), ...localGet(3), ...i32Const(2), 0x74, 0x6a,        // histOutPtr + (i << 2)
    ...i32Const(0), 0x36, 0x02, 0x00,                                  // i32.store 0
    ...localGet(3), ...i32Const(1), 0x6a, ...localSet(3),              // i++
    ...br(0),                                                           // br $continue
    0x0b, 0x0b,                                                         // end loop, end block

    // ── Build histogram: for each byte, bins[byte] += 1 ──
    ...i32Const(0), ...localSet(3),                                    // i = 0
    0x02, BLOCK_VOID,                                                   // block $break2
    0x03, BLOCK_VOID,                                                   // loop  $continue2
    ...localGet(3), ...localGet(1), 0x4f, ...brIf(1),                  // if i >= dataLen: break

    ...localGet(0), ...localGet(3), 0x6a, 0x2d, 0x00, 0x00,           // byteVal = load8_u(dataPtr + i)
    ...localSet(4),

    ...localGet(2), ...localGet(4), ...i32Const(2), 0x74, 0x6a,        // binAddr = histOutPtr + (byteVal << 2)
    ...localSet(5),

    ...localGet(5),                                                     // store target addr
    ...localGet(5), 0x28, 0x02, 0x00,                                  // i32.load(binAddr)
    ...i32Const(1), 0x6a,                                              // + 1
    0x36, 0x02, 0x00,                                                   // i32.store

    ...localGet(3), ...i32Const(1), 0x6a, ...localSet(3),              // i++
    ...br(0),                                                           // br $continue2
    0x0b, 0x0b,                                                         // end loop, end block

    ...i32Const(0),                                                     // return 0
    0x0b,                                                               // end
  ];
  return encodeFuncBody([{ count: 3, type: I32 }], instructions);
}

function buildWhisperScanWasmBytes(): Uint8Array {
  const magicVersion = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  const typeSection = makeSection(1, [
    ...encodeU32(1),
    0x60,
    ...encodeU32(3), I32, I32, I32,
    ...encodeU32(1), I32,
  ]);

  const funcSection = makeSection(3, [...encodeU32(1), ...encodeU32(0)]);
  const memorySection = makeSection(5, [...encodeU32(1), 0x01, ...encodeU32(1), ...encodeU32(2048)]);
  const exportSection = makeSection(7, [
    ...encodeU32(2),
    ...encodeName("memory"), 0x02, ...encodeU32(0),
    ...encodeName("build_histogram"), 0x00, ...encodeU32(0),
  ]);
  const codeSection = makeSection(10, [...encodeU32(1), ...buildHistogramBody()]);

  return new Uint8Array([
    ...magicVersion,
    ...typeSection,
    ...funcSection,
    ...memorySection,
    ...exportSection,
    ...codeSection,
  ]);
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown WASM error.";
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]);
  return diff === 0;
}

async function initWhisperCore(): Promise<WhisperWasmCore> {
  if (whisperCorePromise) return whisperCorePromise;

  const promise = (async () => {
    if (
      typeof WebAssembly === "undefined" ||
      typeof WebAssembly.compile !== "function" ||
      typeof WebAssembly.instantiate !== "function"
    ) {
      throw new Error("WebAssembly is unavailable in this browser.");
    }

    const bytes = buildWhisperScanWasmBytes();
    const module = await WebAssembly.compile(toArrayBuffer(bytes));
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as unknown as WhisperWasmExports;

    if (
      !(exports.memory instanceof WebAssembly.Memory) ||
      typeof exports.build_histogram !== "function"
    ) {
      throw new Error("Whisper WASM exports are invalid.");
    }

    return { instance, exports };
  })();

  whisperCorePromise = promise;
  return promise;
}

/** Shannon entropy from a raw byte buffer (JS fallback when WASM unavailable). */
function entropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const bins = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i++) bins[bytes[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (bins[i] === 0) continue;
    const p = bins[i] / bytes.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Shannon entropy from a pre-built 256-bin histogram (from WASM build_histogram). */
function entropyFromHistogram(histView: DataView, totalBytes: number): number {
  if (totalBytes === 0) return 0;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    const count = histView.getUint32(i * 4, true);
    if (count === 0) continue;
    const p = count / totalBytes;
    h -= p * Math.log2(p);
  }
  return h;
}

function scoreWindow(zeroDensity: number, ffDensity: number, windowEntropy: number): number {
  const dense = Math.max(zeroDensity, ffDensity);
  // Quadratic falloff: entropy 0-1 is fine, 1-3 is the discrimination zone, >4 kills score.
  // Old linear formula (windowEntropy/8) was too lenient in the 2-6 range.
  const entropyPenalty = Math.min(1, (windowEntropy * windowEntropy) / 16);
  return dense * 0.7 + (1 - entropyPenalty) * 0.3;
}

function mergeCandidates(candidates: WhisperInertCandidate[], minCandidateLength: number): WhisperInertCandidate[] {
  if (candidates.length === 0) return [];
  const merged: WhisperInertCandidate[] = [];

  for (const current of candidates) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...current });
      continue;
    }

    const prevEnd = prev.offset + prev.length;
    const currentEnd = current.offset + current.length;
    if (current.offset <= prevEnd + 64) {
      const combinedLen = currentEnd - prev.offset;
      const prevWeight = prev.length;
      const curWeight = current.length;
      const weightTotal = prevWeight + curWeight;
      prev.length = combinedLen;
      prev.zeroDensity = (prev.zeroDensity * prevWeight + current.zeroDensity * curWeight) / weightTotal;
      prev.ffDensity = (prev.ffDensity * prevWeight + current.ffDensity * curWeight) / weightTotal;
      prev.entropy = (prev.entropy * prevWeight + current.entropy * curWeight) / weightTotal;
      prev.score = Math.max(prev.score, current.score);
      prev.kind = prev.score >= 0.7 ? "padding" : "gap";
      continue;
    }

    merged.push({ ...current });
  }

  return merged.filter((candidate) => candidate.length >= minCandidateLength);
}

/** Grow WASM memory if needed so it can hold at least `minBytes`. */
function growMemory(core: WhisperWasmCore, minBytes: number): void {
  const memory = core.exports.memory;
  const currentBytes = memory.buffer.byteLength;
  if (currentBytes >= minBytes) return;
  const neededPages = Math.ceil((minBytes - currentBytes) / PAGE_SIZE);
  memory.grow(neededPages);
}

/**
 * Scan a window already resident in WASM linear memory.
 * Caller copies the full carrier once; this just slides the pointer per window.
 * Zero per-window memcpys — plays directly into WASM's linear memory model.
 */
function scanWindowWasm(
  core: WhisperWasmCore,
  dataPtr: number,
  len: number,
): { zeroDensity: number; ffDensity: number; windowEntropy: number } {
  core.exports.build_histogram(dataPtr, len, HISTOGRAM_OFFSET);

  const histView = new DataView(core.exports.memory.buffer, HISTOGRAM_OFFSET, 1024);
  const zeroCount = histView.getUint32(0x00 * 4, true);
  const ffCount = histView.getUint32(0xff * 4, true);

  return {
    zeroDensity: zeroCount / len,
    ffDensity: ffCount / len,
    windowEntropy: entropyFromHistogram(histView, len),
  };
}

/** JS fallback: count + entropy without WASM. */
function scanWindowJs(windowBytes: Uint8Array): { zeroDensity: number; ffDensity: number; windowEntropy: number } {
  const len = windowBytes.length;
  let zeroCount = 0;
  let ffCount = 0;
  for (let i = 0; i < len; i++) {
    const b = windowBytes[i];
    if (b === 0x00) zeroCount++;
    else if (b === 0xff) ffCount++;
  }
  return {
    zeroDensity: zeroCount / len,
    ffDensity: ffCount / len,
    windowEntropy: entropy(windowBytes),
  };
}

export async function scanInertSpace(bytes: Uint8Array, options: WhisperScanOptions = {}): Promise<WhisperInertCandidate[]> {
  const windowSize = Math.max(128, options.windowSize ?? DEFAULT_WINDOW);
  const stride = Math.max(32, options.stride ?? DEFAULT_STRIDE);
  const minCandidateLength = Math.max(32, options.minCandidateLength ?? DEFAULT_MIN_LEN);
  const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);

  if (bytes.length < minCandidateLength) return [];

  let core: WhisperWasmCore | null = null;
  try {
    core = await initWhisperCore();
  } catch (error) {
    console.warn(`[whisper-wasm] scan fallback to JS: ${normalizeErrorMessage(error)}`);
  }

  // WASM path: copy the entire carrier into linear memory once, then slide pointers.
  // Eliminates ~N memcpys (one per window) — the carrier is contiguous, so use it that way.
  if (core) {
    growMemory(core, CARRIER_OFFSET + bytes.length);
    const wasmView = new Uint8Array(core.exports.memory.buffer);
    wasmView.set(bytes, CARRIER_OFFSET); // single copy of the full carrier
  }

  const rawCandidates: WhisperInertCandidate[] = [];
  for (let offset = 0; offset < bytes.length; offset += stride) {
    const end = Math.min(bytes.length, offset + windowSize);
    const windowLen = end - offset;
    if (windowLen < minCandidateLength) continue;

    const { zeroDensity, ffDensity, windowEntropy } = core
      ? scanWindowWasm(core, CARRIER_OFFSET + offset, windowLen)
      : scanWindowJs(bytes.subarray(offset, end));

    const score = scoreWindow(zeroDensity, ffDensity, windowEntropy);
    if (score < 0.44) continue;

    rawCandidates.push({
      offset,
      length: windowLen,
      zeroDensity,
      ffDensity,
      entropy: windowEntropy,
      score,
      kind: score >= 0.7 ? "padding" : "gap",
    });
  }

  return mergeCandidates(rawCandidates, minCandidateLength)
    .sort((a, b) => b.score - a.score || b.length - a.length)
    .slice(0, maxCandidates);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function writeU16(view: Uint8Array, offset: number, value: number): void {
  view[offset] = value & 0xff;
  view[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(view: Uint8Array, offset: number, value: number): void {
  view[offset] = value & 0xff;
  view[offset + 1] = (value >>> 8) & 0xff;
  view[offset + 2] = (value >>> 16) & 0xff;
  view[offset + 3] = (value >>> 24) & 0xff;
}

function readU16(view: Uint8Array, offset: number): number {
  return view[offset] | (view[offset + 1] << 8);
}

function readU32(view: Uint8Array, offset: number): number {
  return (
    (view[offset]) |
    (view[offset + 1] << 8) |
    (view[offset + 2] << 16) |
    ((view[offset + 3] << 24) >>> 0)
  ) >>> 0;
}

// Pre-computed hex lookup: avoids Array.from + map + join per call (5-10× faster for hash-length inputs).
const HEX_LUT = /*#__PURE__*/ (() => {
  const t = new Array<string>(256);
  for (let i = 0; i < 256; i++) t[i] = i.toString(16).padStart(2, "0");
  return t;
})();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX_LUT[bytes[i]];
  return out;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return new Uint8Array(digest);
}

function looksCryptographicallyInert(candidate: WhisperInertCandidate): boolean {
  const dense = Math.max(candidate.zeroDensity, candidate.ffDensity);
  return dense >= 0.92 && candidate.entropy <= 1.2;
}

function warnLargeSizes(carrierBytes: Uint8Array, payloadBytes?: Uint8Array): void {
  if (carrierBytes.length > WARN_CARRIER_BYTES) {
    console.warn(
      `[whisper] Large carrier (${Math.round(carrierBytes.length / (1024 * 1024))} MB) — may be slow or OOM in this browser.`,
    );
  }
  if (payloadBytes && payloadBytes.length > WARN_PAYLOAD_BYTES) {
    console.warn(
      `[whisper] Large payload (${Math.round(payloadBytes.length / (1024 * 1024))} MB) — may be slow or OOM in this browser.`,
    );
  }
}

function packPayload(input: WhisperPayloadInput, payloadHashHex: string): Uint8Array {
  const manifest = {
    name: input.name || "payload.bin",
    type: input.type || "application/octet-stream",
    label: input.label || input.name || "payload",
    createdAt: new Date().toISOString(),
    byteLength: input.bytes.length,
    payloadHashHex,
  };

  const manifestBytes = textEncoder.encode(JSON.stringify(manifest));
  const header = new Uint8Array(4);
  writeU32(header, 0, manifestBytes.length);
  return concatBytes(header, manifestBytes, input.bytes);
}

function unpackPayload(plain: Uint8Array): WhisperPackedPayload {
  if (plain.length < 4) throw new Error("Whisper payload is truncated.");

  const manifestLength = readU32(plain, 0);
  if (manifestLength <= 0 || 4 + manifestLength > plain.length) {
    throw new Error("Whisper payload manifest length is invalid.");
  }

  const manifestRaw = plain.subarray(4, 4 + manifestLength);
  const payload = plain.subarray(4 + manifestLength);
  const parsed = JSON.parse(textDecoder.decode(manifestRaw)) as {
    name?: unknown;
    type?: unknown;
    label?: unknown;
    createdAt?: unknown;
  };

  return {
    name: typeof parsed.name === "string" && parsed.name ? parsed.name : "payload.bin",
    type: typeof parsed.type === "string" && parsed.type ? parsed.type : "application/octet-stream",
    label: typeof parsed.label === "string" && parsed.label ? parsed.label : "payload",
    createdAt: typeof parsed.createdAt === "string" && parsed.createdAt ? parsed.createdAt : new Date().toISOString(),
    payload: new Uint8Array(payload),
  };
}

async function deriveLocatorTag(password: string): Promise<Uint8Array> {
  const hash = await sha256(textEncoder.encode(`${LOCATOR_CONTEXT}|${password}`));
  return hash.subarray(0, LOCATOR_LEN);
}

async function deriveAesKey(password: string, immutableHash: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(textEncoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: toArrayBuffer(concatBytes(textEncoder.encode(KDF_CONTEXT), immutableHash, salt)),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveAesKeyWithReceipt(
  password: string,
  immutableHash: Uint8Array,
  salt: Uint8Array,
  receiptSecret: Uint8Array | null,
): Promise<CryptoKey> {
  if (!receiptSecret || receiptSecret.length === 0) {
    return deriveAesKey(password, immutableHash, salt);
  }

  const base = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(textEncoder.encode(password)),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  // Receipt secret becomes an additional salt component; password cracking alone is insufficient.
  const fullSalt = concatBytes(textEncoder.encode(KDF_CONTEXT), immutableHash, salt, receiptSecret);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: toArrayBuffer(fullSalt),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveReceiptId(locator: Uint8Array, header: Uint8Array): Promise<string> {
  const material = concatBytes(locator, header, textEncoder.encode("whisper-receipt-id-v1"));
  const digest = await sha256(material);
  // 16 bytes is plenty; keeps IDs short.
  return toHex(digest.subarray(0, 16));
}

async function deriveLayerNoncesAsync(baseNonce: Uint8Array): Promise<{ inner: Uint8Array; outer: Uint8Array }> {
  const innerHash = await sha256(concatBytes(textEncoder.encode("whisper-nonce-inner"), baseNonce));
  const outerHash = await sha256(concatBytes(textEncoder.encode("whisper-nonce-outer"), baseNonce));
  return {
    inner: innerHash.subarray(0, 12),
    outer: outerHash.subarray(0, 12),
  };
}

async function hashExcludingRegion(bytes: Uint8Array, offset: number, length: number): Promise<Uint8Array> {
  const start = Math.max(0, Math.min(offset, bytes.length));
  const end = Math.max(start, Math.min(offset + length, bytes.length));
  if (end <= start) return sha256(bytes);
  return sha256(concatBytes(bytes.subarray(0, start), bytes.subarray(end)));
}

function buildHeader(
  flags: number,
  manifestLength: number,
  cipherLength: number,
  embedOffset: number,
  embedLength: number,
  salt: Uint8Array,
  nonce: Uint8Array,
  bindDigest: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(HEADER_LEN);
  let ptr = 0;
  header[ptr++] = HEADER_VERSION;
  header[ptr++] = flags & 0xff;
  writeU16(header, ptr, HEADER_LEN);
  ptr += 2;
  writeU32(header, ptr, manifestLength);
  ptr += 4;
  writeU32(header, ptr, cipherLength);
  ptr += 4;
  writeU32(header, ptr, embedOffset);
  ptr += 4;
  writeU32(header, ptr, embedLength);
  ptr += 4;
  header.set(salt, ptr);
  ptr += 16;
  header.set(nonce, ptr);
  ptr += 12;
  header.set(bindDigest, ptr);
  ptr += 16;
  while (ptr < HEADER_LEN) header[ptr++] = 0;
  return header;
}

function parseHeader(view: Uint8Array): WhisperEnvelopeHeader | null {
  if (view.length < HEADER_LEN) return null;

  let ptr = 0;
  const version = view[ptr++];
  const flags = view[ptr++];
  const headerLength = readU16(view, ptr);
  ptr += 2;
  const manifestLength = readU32(view, ptr);
  ptr += 4;
  const cipherLength = readU32(view, ptr);
  ptr += 4;
  const embedOffset = readU32(view, ptr);
  ptr += 4;
  const embedLength = readU32(view, ptr);
  ptr += 4;
  const salt = view.subarray(ptr, ptr + 16);
  ptr += 16;
  const nonce = view.subarray(ptr, ptr + 12);
  ptr += 12;
  const bindDigest = view.subarray(ptr, ptr + 16);

  if (
    version !== HEADER_VERSION ||
    headerLength !== HEADER_LEN ||
    cipherLength <= 16 ||
    embedLength < LOCATOR_LEN + HEADER_LEN + 17 ||
    manifestLength === 0
  ) {
    return null;
  }

  return {
    version,
    flags,
    headerLength,
    manifestLength,
    cipherLength,
    embedOffset,
    embedLength,
    salt: new Uint8Array(salt),
    nonce: new Uint8Array(nonce),
    bindDigest: new Uint8Array(bindDigest),
  };
}

function findSubsequence(haystack: Uint8Array, needle: Uint8Array): number[] {
  const hits: number[] = [];
  const n = needle.length;
  const h = haystack.length;
  if (n === 0 || h < n) return hits;

  // Boyer–Moore–Horspool (bytewise) — fast for small needles like our 12-byte locator.
  const skip = new Uint16Array(256);
  skip.fill(n);
  for (let i = 0; i < n - 1; i++) skip[needle[i]] = n - 1 - i;

  let pos = 0;
  while (pos <= h - n) {
    let j = n - 1;
    while (j >= 0 && haystack[pos + j] === needle[j]) j -= 1;

    if (j < 0) {
      hits.push(pos);
      pos += 1;
      continue;
    }

    pos += skip[haystack[pos + n - 1]];
  }

  return hits;
}

function findEmbedCandidate(
  candidates: WhisperInertCandidate[],
  envelopeLength: number,
  carrierLength: number,
): WhisperInertCandidate | null {
  // Prefer the deepest/highest scoring candidate to reduce the chance of touching structural bytes.
  const sorted = candidates
    .filter((candidate) => looksCryptographicallyInert(candidate) && candidate.length >= envelopeLength)
    .sort((a, b) => (b.score - a.score) || (b.offset - a.offset) || (b.length - a.length));

  for (const candidate of sorted) {
    // Avoid embedding extremely close to the beginning — most formats keep critical structures early.
    if (candidate.offset < 4096) continue;
    // Avoid embedding beyond carrier bounds.
    if (candidate.offset + envelopeLength > carrierLength) continue;
    return candidate;
  }

  return null;
}

function clueMatches(clueRaw: string | undefined, sourceName: string, payload: WhisperExtractPayload): boolean {
  const clue = (clueRaw ?? "").trim().toLowerCase();
  if (!clue) return true;

  const hexLike = /^[a-f0-9]{12,64}$/i.test(clue);
  if (hexLike) return payload.hashHex.startsWith(clue);

  const fields = [sourceName, payload.name, payload.type, payload.label].map((value) => value.toLowerCase());
  return fields.some((field) => field.includes(clue));
}

function randomizeRegion(source: Uint8Array, offset: number, length: number): Uint8Array {
  const out = new Uint8Array(source);
  const start = Math.max(0, Math.min(offset, out.length));
  const end = Math.max(start, Math.min(offset + length, out.length));
  if (end <= start) return out;
  const random = randomBytes(end - start);
  out.set(random, start);
  return out;
}

export class WhisperEngine {
  private assertCrypto(): void {
    if (!crypto?.subtle) throw new Error("Whisper requires WebCrypto support.");
  }

  async embed(
    carrierBytes: Uint8Array,
    carrierName: string,
    carrierType: string,
    payload: WhisperPayloadInput,
    password: string,
    options: WhisperEmbedOptions = {},
  ): Promise<WhisperEmbedResult> {
    this.assertCrypto();
    if (!password) throw new Error("Password is required.");
    if (carrierBytes.length === 0) throw new Error("Carrier is empty.");
    if (payload.bytes.length === 0) throw new Error("Payload is empty.");

    warnLargeSizes(carrierBytes, payload.bytes);

    const logs: string[] = [];
    const payloadHash = await sha256(payload.bytes);
    const payloadHashHex = toHex(payloadHash);
    const packed = packPayload(payload, payloadHashHex);
    const locator = await deriveLocatorTag(password);

    const onlyHere = options.onlyDecodeHere === true;
    // Portable mode: 1x GCM tag. Local-key mode: 2x tags (inner+outer).
    const cipherLength = onlyHere ? (packed.length + 32) : (packed.length + 16);
    const envelopeLength = LOCATOR_LEN + HEADER_LEN + cipherLength;

    const preferInert = options.preferInertSpace !== false;
    const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);

    logs.push(`payload packed: ${packed.length} bytes`);
    logs.push(`envelope target length: ${envelopeLength} bytes`);

    const candidates = preferInert
      ? await scanInertSpace(carrierBytes, {
        maxCandidates,
        minCandidateLength: Math.min(Math.max(DEFAULT_MIN_LEN, envelopeLength), 1_048_576),
      })
      : [];

    if (preferInert) logs.push(`inert candidates: ${candidates.length}`);

    const selected = preferInert ? findEmbedCandidate(candidates, envelopeLength, carrierBytes.length) : null;
    const offset = selected ? selected.offset : carrierBytes.length;
    const mode: WhisperEnvelopeInfo["mode"] = selected ? "inert-slot" : "eof-tail";

    if (selected) logs.push(`embed mode: inert-slot @ ${offset}`);
    else logs.push("embed mode: eof-tail fallback");

    const immutableHash = await hashExcludingRegion(carrierBytes, offset, envelopeLength);
    const bindDigest = immutableHash.subarray(0, 16);
    const salt = randomBytes(16);
    const nonce = randomBytes(12);

    let receiptSecret: Uint8Array | null = null;
    let receiptKey: CryptoKey | null = null;

    const manifestLength = readU32(packed, 0);

    let headerFlags = HEADER_FLAGS;
    if (onlyHere) headerFlags |= FLAG_RECEIPT_REQUIRED;

    // Build header once (flags might be updated after we know which local lock method we used).
    let header = buildHeader(headerFlags & 0xff, manifestLength, cipherLength, offset, envelopeLength, salt, nonce, bindDigest);

    const receiptId = onlyHere ? await deriveReceiptId(locator, header) : null;
    if (onlyHere && receiptId) {
      // Prefer non-extractable local CryptoKey (harder to reverse). Fall back to secret bytes if necessary.
      try {
        receiptKey = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        await putReceiptKey(receiptId, receiptKey);
        headerFlags |= FLAG_RECEIPT_LOCALKEY;
        header = buildHeader(headerFlags & 0xff, manifestLength, cipherLength, offset, envelopeLength, salt, nonce, bindDigest);
        logs.push(`receipt: stored local key lock (${receiptId})`);
      } catch {
        receiptSecret = randomBytes(32);
        await putReceipt(receiptId, receiptSecret);
        logs.push(`receipt: stored local secret lock (${receiptId})`);
      }
    }

    const baseKey = await deriveAesKey(password, immutableHash, salt);
    const { inner: nonceInner, outer: nonceOuter } = await deriveLayerNoncesAsync(nonce);

    const aadInner = concatBytes(locator, header, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|inner`));
    const innerCipherBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aadInner) },
      baseKey,
      toArrayBuffer(packed),
    );
    const innerCipher = new Uint8Array(innerCipherBuf);

    let finalCipher: Uint8Array;
    if (receiptKey) {
      const aadOuter = concatBytes(locator, header, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|outer`));
      const outerCipherBuf = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nonceOuter), additionalData: toArrayBuffer(aadOuter) },
        receiptKey,
        innerCipher,
      );
      finalCipher = new Uint8Array(outerCipherBuf);
    } else if (receiptSecret) {
      // Fallback: single-layer, receipt secret included in PBKDF2 salt.
      const key = await deriveAesKeyWithReceipt(password, immutableHash, salt, receiptSecret);
      const aad = concatBytes(locator, header, textEncoder.encode(ENVELOPE_AAD_CONTEXT));
      const cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aad) },
        key,
        toArrayBuffer(packed),
      );
      finalCipher = new Uint8Array(cipherBuffer);
    } else {
      // Portable mode: single-layer.
      finalCipher = innerCipher;
    }

    const envelope = concatBytes(locator, header, finalCipher);

    let outputBytes: Uint8Array;
    if (selected) {
      outputBytes = new Uint8Array(carrierBytes.length);
      outputBytes.set(carrierBytes);
      outputBytes.set(envelope, offset);
    } else {
      outputBytes = concatBytes(carrierBytes, envelope);
    }

    // Post-embed verification: decrypt what we just wrote and confirm payload hash.
    try {
      const locBytes = outputBytes.subarray(offset, offset + LOCATOR_LEN);
      if (!bytesEqual(locBytes, locator)) throw new Error("verify: locator mismatch");

      const headerStart = offset + LOCATOR_LEN;
      const headerEnd = headerStart + HEADER_LEN;
      const cipherStart = headerEnd;
      const cipherEnd = cipherStart + cipherLength;
      if (cipherEnd > outputBytes.length) throw new Error("verify: envelope truncated");

      const headerBytes = outputBytes.subarray(headerStart, headerEnd);
      const parsed = parseHeader(headerBytes);
      if (!parsed) throw new Error("verify: failed to parse header");
      const cipherBytes = outputBytes.subarray(cipherStart, cipherEnd);
      const immutableHashVerify = await hashExcludingRegion(outputBytes, offset, envelope.length);
      await verifyEnvelopeCipher(
        password,
        locator,
        headerBytes,
        parsed,
        cipherBytes,
        immutableHashVerify,
        payloadHashHex,
        receiptKey,
        receiptSecret,
      );
      logs.push("verify: ok");
    } catch (e) {
      logs.push(`verify: failed (${e instanceof Error ? e.message : "unknown"})`);
      throw e;
    }

    const outputName = carrierName.replace(/(\.[^.]+)?$/, ".whisper$1");
    const outputType = carrierType || "application/octet-stream";

    return {
      outputBytes,
      outputName,
      outputType,
      payloadHashHex,
      envelope: {
        offset,
        length: envelope.length,
        mode,
        locatorHex: toHex(locator),
        carrierBindHex: toHex(bindDigest),
      },
      candidates,
      logs,
    };
  }

  // Robust entrypoint: avoids full carrier buffering for large files by default.
  // - If inert embedding is feasible (small carrier) it uses embed() for best results.
  // - Otherwise uses EOF tail mode with streaming hash + zero-copy Blob assembly.
  async embedFile(
    carrierFile: File,
    payloadFile: File,
    password: string,
    options: WhisperEmbedOptions = {},
  ): Promise<WhisperEmbedFileResult> {
    this.assertCrypto();
    if (!password) throw new Error("Password is required.");
    if (carrierFile.size === 0) throw new Error("Carrier is empty.");
    if (payloadFile.size === 0) throw new Error("Payload is empty.");

    if ((options.preferInertSpace ?? true) && carrierFile.size <= SMALL_CARRIER_THRESHOLD) {
      const carrierBytes = new Uint8Array(await carrierFile.arrayBuffer());
      const payloadBytes = new Uint8Array(await payloadFile.arrayBuffer());
      const result = await this.embed(
        carrierBytes,
        carrierFile.name,
        carrierFile.type,
        {
          bytes: payloadBytes,
          name: payloadFile.name,
          type: payloadFile.type || "application/octet-stream",
          label: payloadFile.name,
        },
        password,
        options,
      );

      const outputFile = new File([toArrayBuffer(result.outputBytes)], result.outputName, { type: result.outputType });
      return {
        outputFile,
        outputName: result.outputName,
        outputType: result.outputType,
        payloadHashHex: result.payloadHashHex,
        envelope: result.envelope,
        logs: result.logs,
      };
    }

    // EOF tail mode: streaming carrier hash (carrier-bound) + zero-copy output.
    const payloadBytes = new Uint8Array(await payloadFile.arrayBuffer());
    if (payloadBytes.length > WARN_PAYLOAD_BYTES) {
      console.warn(`[whisper] Large payload (${Math.round(payloadBytes.length / (1024 * 1024))} MB) — may be slow or OOM in this browser.`);
    }

    const logs: string[] = [];
    logs.push("embedFile: using EOF tail mode (streaming carrier hash)");

    const payloadHashHex = toHex(await sha256(payloadBytes));
    const packed = packPayload(
      {
        bytes: payloadBytes,
        name: payloadFile.name,
        type: payloadFile.type || "application/octet-stream",
        label: payloadFile.name,
      },
      payloadHashHex,
    );

    const locator = await deriveLocatorTag(password);
    const onlyHere = options.onlyDecodeHere === true;
    const cipherLength = onlyHere ? (packed.length + 32) : (packed.length + 16);
    const envelopeLength = LOCATOR_LEN + HEADER_LEN + cipherLength;
    const offset = carrierFile.size;

    const immutableHash = await hashBlobSha256(carrierFile);
    const bindDigest = immutableHash.subarray(0, 16);
    const salt = randomBytes(16);
    const nonce = randomBytes(12);

    let receiptSecret: Uint8Array | null = null;
    let receiptKey: CryptoKey | null = null;
    const manifestLength = readU32(packed, 0);
    let headerFlags = HEADER_FLAGS;
    if (onlyHere) headerFlags |= FLAG_RECEIPT_REQUIRED;
    let header = buildHeader(headerFlags & 0xff, manifestLength, cipherLength, offset, envelopeLength, salt, nonce, bindDigest);

    const receiptId = onlyHere ? await deriveReceiptId(locator, header) : null;
    if (onlyHere && receiptId) {
      try {
        receiptKey = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        await putReceiptKey(receiptId, receiptKey);
        headerFlags |= FLAG_RECEIPT_LOCALKEY;
        header = buildHeader(headerFlags & 0xff, manifestLength, cipherLength, offset, envelopeLength, salt, nonce, bindDigest);
        logs.push(`receipt: stored local key lock (${receiptId})`);
      } catch {
        receiptSecret = randomBytes(32);
        await putReceipt(receiptId, receiptSecret);
        logs.push(`receipt: stored local secret lock (${receiptId})`);
      }
    }

    const baseKey = await deriveAesKey(password, immutableHash, salt);
    const { inner: nonceInner, outer: nonceOuter } = await deriveLayerNoncesAsync(nonce);

    const aadInner = concatBytes(locator, header, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|inner`));
    const innerCipherBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aadInner) },
      baseKey,
      toArrayBuffer(packed),
    );
    const innerCipher = new Uint8Array(innerCipherBuf);

    let finalCipher: Uint8Array;
    if (receiptKey) {
      const aadOuter = concatBytes(locator, header, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|outer`));
      const outerCipherBuf = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nonceOuter), additionalData: toArrayBuffer(aadOuter) },
        receiptKey,
        innerCipher,
      );
      finalCipher = new Uint8Array(outerCipherBuf);
    } else if (receiptSecret) {
      const key = await deriveAesKeyWithReceipt(password, immutableHash, salt, receiptSecret);
      const aad = concatBytes(locator, header, textEncoder.encode(ENVELOPE_AAD_CONTEXT));
      const cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aad) },
        key,
        toArrayBuffer(packed),
      );
      finalCipher = new Uint8Array(cipherBuffer);
    } else {
      finalCipher = innerCipher;
    }

    const envelope = concatBytes(locator, header, finalCipher);

    const outputName = carrierFile.name.replace(/(\.[^.]+)?$/, ".whisper$1");
    const outputType = carrierFile.type || "application/octet-stream";
    const outputFile = new File([carrierFile, toArrayBuffer(envelope)], outputName, { type: outputType });

    // Post-embed verification for EOF-tail streaming mode (no need to re-read outputFile).
    try {
      const parsed = parseHeader(header);
      if (!parsed) throw new Error("verify: failed to parse header");
      await verifyEnvelopeCipher(
        password,
        locator,
        header,
        parsed,
        finalCipher,
        immutableHash,
        payloadHashHex,
        receiptKey,
        receiptSecret,
      );
      logs.push("verify: ok");
    } catch (e) {
      logs.push(`verify: failed (${e instanceof Error ? e.message : "unknown"})`);
      throw e;
    }

    return {
      outputFile,
      outputName,
      outputType,
      payloadHashHex,
      envelope: {
        offset,
        length: envelope.length,
        mode: "eof-tail",
        locatorHex: toHex(locator),
        carrierBindHex: toHex(bindDigest),
      },
      logs,
    };
  }

  // Robust extraction from a File without requiring a full-buffer read.
  // Uses streaming locator scan, then validates header + carrier-bind hash before attempting decrypt.
  async extractFile(
    carrierFile: File,
    password: string,
    options: WhisperExtractOptions = {},
  ): Promise<WhisperExtractFileResult> {
    this.assertCrypto();
    if (!password) throw new Error("Password is required.");
    if (carrierFile.size === 0) {
      return { found: false, confidence: 0, offset: null, payload: null, scrubbedFile: null, logs: ["empty carrier"] };
    }
    if (carrierFile.size > WARN_CARRIER_BYTES) {
      console.warn(`[whisper] Large carrier (${Math.round(carrierFile.size / (1024 * 1024))} MB) — may be slow or OOM in this browser.`);
    }

    const logs: string[] = [];
    const locator = await deriveLocatorTag(password);
    const hits = await findSubsequenceInBlob(carrierFile, locator, { maxHits: 48, chunkSize: 1024 * 1024 });
    logs.push(`locator hits: ${hits.length}`);
    if (hits.length === 0) {
      return { found: false, confidence: 0, offset: null, payload: null, scrubbedFile: null, logs };
    }

    for (const hit of hits) {
      const headerStart = hit + LOCATOR_LEN;
      const headerEnd = headerStart + HEADER_LEN;
      if (headerEnd > carrierFile.size) continue;

      const headerBytes = new Uint8Array(await carrierFile.slice(headerStart, headerEnd).arrayBuffer());
      const header = parseHeader(headerBytes);
      if (!header) continue;
      if (header.embedOffset !== hit) continue;

      const expectedEnvelopeLength = LOCATOR_LEN + HEADER_LEN + header.cipherLength;
      if (header.embedLength !== expectedEnvelopeLength) continue;

      const cipherStart = headerEnd;
      const cipherEnd = cipherStart + header.cipherLength;
      if (cipherEnd > carrierFile.size) continue;

      // Carrier binding: hash carrier excluding envelope region.
      const immutableHash = await hashBlobSha256Excluding(carrierFile, hit, expectedEnvelopeLength);
      const bindDigest = immutableHash.subarray(0, 16);
      if (!bytesEqual(bindDigest, header.bindDigest)) {
        logs.push(`hit ${hit}: carrier bind mismatch`);
        continue;
      }
      try {
        const cipherBuf = await carrierFile.slice(cipherStart, cipherEnd).arrayBuffer();
        const cipherBytes = new Uint8Array(cipherBuf);

        const needsReceipt = (header.flags & FLAG_RECEIPT_REQUIRED) !== 0;
        const localKeyMode = (header.flags & FLAG_RECEIPT_LOCALKEY) !== 0;
        const { inner: nonceInner, outer: nonceOuter } = await deriveLayerNoncesAsync(header.nonce);

        let innerCipherBytes = cipherBytes;
        if (needsReceipt && localKeyMode) {
          const receiptId = await deriveReceiptId(locator, headerBytes);
          const localKey = await getReceiptKey(receiptId);
          if (!localKey) {
            logs.push(`hit ${hit}: local lock key missing (different browser/device)`);
            continue;
          }

          const aadOuter = concatBytes(locator, headerBytes, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|outer`));
          const outerPlainBuf = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toArrayBuffer(nonceOuter), additionalData: toArrayBuffer(aadOuter) },
            localKey,
            cipherBuf,
          );
          innerCipherBytes = new Uint8Array(outerPlainBuf);
        }

        let packedPlain: ArrayBuffer;
        if (needsReceipt && !localKeyMode) {
          const receiptId = await deriveReceiptId(locator, headerBytes);
          const secret = await getReceipt(receiptId);
          if (!secret) {
            logs.push(`hit ${hit}: local lock receipt missing (different browser/device)`);
            continue;
          }

          const key = await deriveAesKeyWithReceipt(password, immutableHash, header.salt, secret);
          const aad = concatBytes(locator, headerBytes, textEncoder.encode(ENVELOPE_AAD_CONTEXT));
          packedPlain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aad) },
            key,
            toArrayBuffer(innerCipherBytes),
          );
        } else {
          const key = await deriveAesKey(password, immutableHash, header.salt);
          const aadInner = concatBytes(locator, headerBytes, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|inner`));
          packedPlain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aadInner) },
            key,
            toArrayBuffer(innerCipherBytes),
          );
        }

        const packed = unpackPayload(new Uint8Array(packedPlain));
        const hashHex = toHex(await sha256(packed.payload));

        const payload: WhisperExtractPayload = {
          name: packed.name,
          type: packed.type,
          label: packed.label,
          bytes: packed.payload,
          hashHex,
          createdAt: packed.createdAt,
        };

        if (!clueMatches(options.clue, carrierFile.name, payload)) {
          logs.push(`hit ${hit}: payload decrypted but clue did not match`);
          continue;
        }

        let scrubbedFile: File | null = null;
        if (options.destructOnExtract) {
          const prefix = carrierFile.slice(0, hit);
          const suffix = carrierFile.slice(hit + expectedEnvelopeLength);
          const random = randomBytes(expectedEnvelopeLength);
          scrubbedFile = new File([prefix, toArrayBuffer(random), suffix], carrierFile.name.replace(/(\.[^.]+)?$/, ".scrubbed$1"), {
            type: carrierFile.type || "application/octet-stream",
          });
        }

        logs.push(`hit ${hit}: payload recovered`);
        return { found: true, confidence: 1, offset: hit, payload, scrubbedFile, logs };
      } catch {
        logs.push(`hit ${hit}: decrypt failed`);
        continue;
      }
    }

    return { found: false, confidence: 0, offset: null, payload: null, scrubbedFile: null, logs };
  }

  async extract(
    carrierBytes: Uint8Array,
    carrierName: string,
    password: string,
    options: WhisperExtractOptions = {},
  ): Promise<WhisperExtractResult> {
    this.assertCrypto();
    if (!password) throw new Error("Password is required.");
    if (carrierBytes.length === 0) {
      return { found: false, confidence: 0, offset: null, payload: null, scrubbedCarrierBytes: null, logs: ["empty carrier"] };
    }

    warnLargeSizes(carrierBytes);

    const logs: string[] = [];
    const locator = await deriveLocatorTag(password);
    const hits = findSubsequence(carrierBytes, locator);

    logs.push(`locator hits: ${hits.length}`);
    if (hits.length === 0) {
      return { found: false, confidence: 0, offset: null, payload: null, scrubbedCarrierBytes: null, logs };
    }

    for (const hit of hits) {
      const headerStart = hit + LOCATOR_LEN;
      const headerEnd = headerStart + HEADER_LEN;
      const cipherStart = headerEnd;
      if (headerEnd > carrierBytes.length) continue;

      const header = parseHeader(carrierBytes.subarray(headerStart, headerEnd));
      if (!header) continue;
      if (header.embedOffset !== hit) continue;

      const expectedEnvelopeLength = LOCATOR_LEN + HEADER_LEN + header.cipherLength;
      if (header.embedLength !== expectedEnvelopeLength) continue;

      const cipherEnd = cipherStart + header.cipherLength;
      if (cipherEnd > carrierBytes.length) continue;

      const immutableHash = await hashExcludingRegion(carrierBytes, hit, expectedEnvelopeLength);
      const bindDigest = immutableHash.subarray(0, 16);
      if (!bytesEqual(bindDigest, header.bindDigest)) {
        logs.push(`hit ${hit}: carrier bind mismatch`);
        continue;
      }

      try {
        const headerBytes = carrierBytes.subarray(headerStart, headerEnd);
        const cipherBytes = carrierBytes.subarray(cipherStart, cipherEnd);

        const needsReceipt = (header.flags & FLAG_RECEIPT_REQUIRED) !== 0;
        const localKeyMode = (header.flags & FLAG_RECEIPT_LOCALKEY) !== 0;
        const { inner: nonceInner, outer: nonceOuter } = await deriveLayerNoncesAsync(header.nonce);

        let innerCipherBytes = cipherBytes;
        if (needsReceipt && localKeyMode) {
          const receiptId = await deriveReceiptId(locator, headerBytes);
          const localKey = await getReceiptKey(receiptId);
          if (!localKey) {
            logs.push(`hit ${hit}: local lock key missing (different browser/device)`);
            continue;
          }
          const aadOuter = concatBytes(locator, headerBytes, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|outer`));
          const outerPlainBuf = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toArrayBuffer(nonceOuter), additionalData: toArrayBuffer(aadOuter) },
            localKey,
            toArrayBuffer(innerCipherBytes),
          );
          innerCipherBytes = new Uint8Array(outerPlainBuf);
        }

        let packedPlain: ArrayBuffer;
        if (needsReceipt && !localKeyMode) {
          const receiptId = await deriveReceiptId(locator, headerBytes);
          const secret = await getReceipt(receiptId);
          if (!secret) {
            logs.push(`hit ${hit}: local lock receipt missing (different browser/device)`);
            continue;
          }
          const key = await deriveAesKeyWithReceipt(password, immutableHash, header.salt, secret);
          const aad = concatBytes(locator, headerBytes, textEncoder.encode(ENVELOPE_AAD_CONTEXT));
          packedPlain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aad) },
            key,
            toArrayBuffer(innerCipherBytes),
          );
        } else {
          const key = await deriveAesKey(password, immutableHash, header.salt);
          const aadInner = concatBytes(locator, headerBytes, textEncoder.encode(`${ENVELOPE_AAD_CONTEXT}|inner`));
          packedPlain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toArrayBuffer(nonceInner), additionalData: toArrayBuffer(aadInner) },
            key,
            toArrayBuffer(innerCipherBytes),
          );
        }

        const packed = unpackPayload(new Uint8Array(packedPlain));
        const hashHex = toHex(await sha256(packed.payload));

        const payload: WhisperExtractPayload = {
          name: packed.name,
          type: packed.type,
          label: packed.label,
          bytes: packed.payload,
          hashHex,
          createdAt: packed.createdAt,
        };

        if (!clueMatches(options.clue, carrierName, payload)) {
          logs.push(`hit ${hit}: payload decrypted but clue did not match`);
          continue;
        }

        const scrubbed = options.destructOnExtract ? randomizeRegion(carrierBytes, hit, expectedEnvelopeLength) : null;

        logs.push(`hit ${hit}: payload recovered`);
        return {
          found: true,
          confidence: 1,
          offset: hit,
          payload,
          scrubbedCarrierBytes: scrubbed,
          logs,
        };
      } catch {
        logs.push(`hit ${hit}: decrypt failed`);
        continue;
      }
    }

    return { found: false, confidence: 0, offset: null, payload: null, scrubbedCarrierBytes: null, logs };
  }

  async hunt(carriers: WhisperHuntCarrier[], password: string, options: WhisperExtractOptions = {}): Promise<WhisperHuntResult> {
    this.assertCrypto();
    const matches: WhisperHuntMatch[] = [];
    const logs: string[] = [];

    for (let i = 0; i < carriers.length; i++) {
      const carrier = carriers[i];
      logs.push(`hunt ${i + 1}/${carriers.length}: ${carrier.name}`);
      const extracted = await this.extract(carrier.bytes, carrier.name, password, options);
      logs.push(...extracted.logs.map((line) => `${carrier.name}: ${line}`));
      if (!extracted.found || !extracted.payload || extracted.offset === null) continue;

      matches.push({
        sourceName: carrier.name,
        sourceType: carrier.type || "application/octet-stream",
        confidence: extracted.confidence,
        offset: extracted.offset,
        payload: extracted.payload,
        scrubbedCarrierBytes: extracted.scrubbedCarrierBytes,
      });
    }

    return {
      matches,
      scannedCount: carriers.length,
      logs,
    };
  }
}
