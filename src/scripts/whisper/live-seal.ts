/**
 * live-seal.ts — Whisper Seal: digital signature encryption via Glyph coefficient quantization.
 *
 * strictness is now CONTINUOUS: the slider emits a value 0-100 that maps to a
 * bin width via an exponential curve (2048 at 0, 64 at 100). per-block attention
 * (from Glyph residual norms, normalized per-stroke) scales each block's bin width
 * by a factor (1.5 − attention), so predictable blocks get 50% wider bins and
 * surprising blocks get 50% narrower bins. all of this is stored in a v3 container
 * as uint8 values — one per axis for the base, one per block for attention.
 *
 * previous container versions (v1 tri-state, v2 tri-state + packed tertile attention)
 * are still readable for backwards compatibility.
 */

import { GlyphCodec, GLYPH_CHANNELS, type GlyphBlock } from "./live-wasm-glyph";
import { pbkdf2, hkdf, aesGcmEncrypt, aesGcmDecrypt } from "./live-crypto";
import { randomBytes } from "./wasm";

const MAGIC = new Uint8Array([0x57, 0x53, 0x45, 0x4C]); // 'WSEL'
const VERSION_V1 = 0x01;
const VERSION_V2 = 0x02;
const VERSION_V3 = 0x03;
const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;

const TE = new TextEncoder();
const TD = new TextDecoder();

// ── continuous strictness ──────────────────────────────────────────────────────

/** strictness per axis: each value is a slider position 0..100. */
export interface SealStrictness {
  shape: number;
  speed: number;
  pressure: number;
}

/**
 * exponential bin width from a slider value 0-100.
 *   0 → 2048 (loosest)
 *  40 → 512
 *  80 → 128
 * 100 → 64  (tightest)
 *
 * the curve is log-linear: evenly spaced slider values produce evenly spaced
 * powers of 2 in bin width. every 20 slider units halves the bin.
 */
export function binWidthFromSlider(v: number): number {
  const t = Math.max(0, Math.min(100, v)) / 100;
  const logMin = Math.log2(64);
  const logMax = Math.log2(2048);
  return Math.round(Math.pow(2, logMax - (logMax - logMin) * t));
}

/** bits of entropy per coefficient at a given bin width, assuming Q14 range. */
export function bitsPerCoef(binWidth: number): number {
  return Math.max(0, Math.log2(32768 / Math.max(1, binWidth)));
}

/**
 * effective bin width for one block, factoring in per-block attention.
 * attention ∈ [0,1]: 0 = predictable (50% wider), 1 = surprising (50% narrower).
 */
function effectiveBinWidth(baseBinWidth: number, attention: number): number {
  const scale = 1.5 - attention;
  return Math.max(16, Math.round(baseBinWidth * scale));
}

// ── signature stroke ───────────────────────────────────────────────────────────

export interface SignatureStroke {
  points: Int32Array;
}

function quantizeIndex(value: number, binWidth: number): number {
  return Math.round(value / binWidth);
}

function encodeAllBlocks(strokes: SignatureStroke[]): GlyphBlock[] {
  const blocks: GlyphBlock[] = [];
  for (const stroke of strokes) {
    if (stroke.points.length < 4 * GLYPH_CHANNELS) continue;
    const got = GlyphCodec.encode(stroke.points, undefined, { adaptiveSegmentation: false });
    for (const b of got) blocks.push(b);
  }
  return blocks;
}

// ── attention ──────────────────────────────────────────────────────────────────

/**
 * compute per-block attention from residual L1 norms, normalized to [0,1] across
 * the full block set. this is the continuous version — no tertile bucketing.
 */
export function computeAttention(blocks: GlyphBlock[]): Float32Array {
  const N = blocks.length;
  const att = new Float32Array(N);
  if (N === 0) return att;
  let max = 0;
  for (let i = 0; i < N; i++) {
    let sum = 0;
    const r = blocks[i].residuals;
    for (let j = 0; j < r.length; j++) sum += Math.abs(r[j]);
    att[i] = sum;
    if (sum > max) max = sum;
  }
  if (max > 0) for (let i = 0; i < N; i++) att[i] /= max;
  return att;
}

function packAttentionContinuous(att: Float32Array): Uint8Array {
  const out = new Uint8Array(att.length);
  for (let i = 0; i < att.length; i++) out[i] = Math.round(att[i] * 255);
  return out;
}

function unpackAttentionContinuous(bytes: Uint8Array, count: number): Float32Array {
  const att = new Float32Array(count);
  for (let i = 0; i < count; i++) att[i] = (bytes[i] ?? 0) / 255;
  return att;
}

// ── digest ─────────────────────────────────────────────────────────────────────

function buildDigest(
  blocks: GlyphBlock[],
  base: SealStrictness,
  attention: Float32Array,
): Uint8Array {
  if (blocks.length === 0) {
    throw new Error("signature too short to fit any glyph block");
  }
  const buf = new Uint8Array(blocks.length * 12);
  const view = new DataView(buf.buffer);
  let off = 0;
  const baseShapeBw = binWidthFromSlider(base.shape);
  const baseSpeedBw = binWidthFromSlider(base.speed);
  const basePressureBw = binWidthFromSlider(base.pressure);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const a = attention[i] ?? 0.5;
    const shapeBw = effectiveBinWidth(baseShapeBw, a);
    const speedBw = effectiveBinWidth(baseSpeedBw, a);
    const pressureBw = effectiveBinWidth(basePressureBw, a);
    view.setInt16(off, quantizeIndex(b.kR, shapeBw), true); off += 2;
    view.setInt16(off, quantizeIndex(b.kI, shapeBw), true); off += 2;
    view.setInt16(off, quantizeIndex(b.gR, speedBw), true); off += 2;
    view.setInt16(off, quantizeIndex(b.gI, speedBw), true); off += 2;
    view.setInt16(off, quantizeIndex(b.scK, pressureBw), true); off += 2;
    view.setInt16(off, quantizeIndex(b.scG, pressureBw), true); off += 2;
  }
  return buf;
}

const HKDF_INFO_PHRASE = TE.encode("whisper-seal-phrase");

async function deriveKey(digest: Uint8Array, salt: Uint8Array, phrase?: string): Promise<Uint8Array> {
  const stretched = await pbkdf2(digest, salt, PBKDF2_ITERATIONS, KEY_LENGTH);
  if (!phrase) return stretched;
  const phraseHash = new Uint8Array(await crypto.subtle.digest("SHA-256", TE.encode(phrase)));
  return await hkdf(stretched, phraseHash, HKDF_INFO_PHRASE, KEY_LENGTH);
}

// ── container format ───────────────────────────────────────────────────────────

/**
 * v3: WSEL | 03 | shape(u8) | speed(u8) | pressure(u8) | blockCount(u16 LE) |
 *     filenameLen(u16 LE) | filename | salt(16) | nonce(12) |
 *     attention(blockCount bytes) | ciphertext + tag(16)
 */

interface ParsedHeader {
  version: number;
  strictness: SealStrictness;
  filename: string;
  salt: Uint8Array;
  nonce: Uint8Array;
  attention: Float32Array;
  aad: Uint8Array;
  ciphertextOffset: number;
}

function buildV3Header(
  base: SealStrictness,
  filename: string,
  blockCount: number,
  salt: Uint8Array,
  nonce: Uint8Array,
  attentionBytes: Uint8Array,
): Uint8Array {
  const nameBytes = TE.encode(filename);
  const header = new Uint8Array(12 + nameBytes.length + SALT_LENGTH + NONCE_LENGTH + attentionBytes.length);
  let off = 0;
  header.set(MAGIC, off); off += 4;
  header[off++] = VERSION_V3;
  header[off++] = Math.round(Math.max(0, Math.min(100, base.shape)));
  header[off++] = Math.round(Math.max(0, Math.min(100, base.speed)));
  header[off++] = Math.round(Math.max(0, Math.min(100, base.pressure)));
  header[off++] = blockCount & 0xFF;
  header[off++] = (blockCount >> 8) & 0xFF;
  header[off++] = nameBytes.length & 0xFF;
  header[off++] = (nameBytes.length >> 8) & 0xFF;
  header.set(nameBytes, off); off += nameBytes.length;
  header.set(salt, off); off += SALT_LENGTH;
  header.set(nonce, off); off += NONCE_LENGTH;
  header.set(attentionBytes, off);
  return header;
}

function parseHeader(blob: Uint8Array): ParsedHeader {
  if (blob.length < 4) throw new Error("not a seal blob: too short");
  for (let i = 0; i < 4; i++) {
    if (blob[i] !== MAGIC[i]) throw new Error("not a seal blob: bad magic");
  }
  const version = blob[4];
  if (version === VERSION_V1) return parseHeaderV1(blob);
  if (version === VERSION_V2) return parseHeaderV2(blob);
  if (version === VERSION_V3) return parseHeaderV3(blob);
  throw new Error(`seal version ${version} unsupported`);
}

// v1 compat: tri-state strictness, no attention
function parseHeaderV1(blob: Uint8Array): ParsedHeader {
  const packed = blob[5];
  const strictness: SealStrictness = {
    shape: [0, 40, 80][packed & 0x3] ?? 40,
    speed: [0, 40, 80][(packed >> 2) & 0x3] ?? 40,
    pressure: [0, 40, 80][(packed >> 4) & 0x3] ?? 40,
  };
  const nameLen = blob[6] | (blob[7] << 8);
  let off = 8;
  const filename = TD.decode(blob.subarray(off, off + nameLen)); off += nameLen;
  const salt = new Uint8Array(blob.subarray(off, off + SALT_LENGTH)); off += SALT_LENGTH;
  const nonce = new Uint8Array(blob.subarray(off, off + NONCE_LENGTH)); off += NONCE_LENGTH;
  return {
    version: VERSION_V1, strictness, filename, salt, nonce,
    attention: new Float32Array(0),
    aad: new Uint8Array(blob.subarray(0, off)),
    ciphertextOffset: off,
  };
}

// v2 compat: tri-state strictness, packed 2-bit tertile attention
function parseHeaderV2(blob: Uint8Array): ParsedHeader {
  const packed = blob[5];
  const strictness: SealStrictness = {
    shape: [0, 40, 80][packed & 0x3] ?? 40,
    speed: [0, 40, 80][(packed >> 2) & 0x3] ?? 40,
    pressure: [0, 40, 80][(packed >> 4) & 0x3] ?? 40,
  };
  const blockCount = blob[6] | (blob[7] << 8);
  const nameLen = blob[8] | (blob[9] << 8);
  let off = 10;
  const filename = TD.decode(blob.subarray(off, off + nameLen)); off += nameLen;
  const salt = new Uint8Array(blob.subarray(off, off + SALT_LENGTH)); off += SALT_LENGTH;
  const nonce = new Uint8Array(blob.subarray(off, off + NONCE_LENGTH)); off += NONCE_LENGTH;
  const attentionLen = Math.ceil((blockCount * 2) / 8);
  // unpack 2-bit tertile to continuous: 0→0.0, 1→0.5, 2→1.0
  const attBytes = blob.subarray(off, off + attentionLen); off += attentionLen;
  const att = new Float32Array(blockCount);
  for (let i = 0; i < blockCount; i++) {
    const byteIdx = Math.floor((i * 2) / 8);
    const shift = (i * 2) % 8;
    const level = (attBytes[byteIdx] >> shift) & 0x3;
    att[i] = level / 2;
  }
  return {
    version: VERSION_V2, strictness, filename, salt, nonce,
    attention: att,
    aad: new Uint8Array(blob.subarray(0, off)),
    ciphertextOffset: off,
  };
}

function parseHeaderV3(blob: Uint8Array): ParsedHeader {
  const strictness: SealStrictness = {
    shape: blob[5],
    speed: blob[6],
    pressure: blob[7],
  };
  const blockCount = blob[8] | (blob[9] << 8);
  const nameLen = blob[10] | (blob[11] << 8);
  let off = 12;
  const filename = TD.decode(blob.subarray(off, off + nameLen)); off += nameLen;
  const salt = new Uint8Array(blob.subarray(off, off + SALT_LENGTH)); off += SALT_LENGTH;
  const nonce = new Uint8Array(blob.subarray(off, off + NONCE_LENGTH)); off += NONCE_LENGTH;
  const attention = unpackAttentionContinuous(blob.subarray(off, off + blockCount), blockCount);
  off += blockCount;
  return {
    version: VERSION_V3, strictness, filename, salt, nonce, attention,
    aad: new Uint8Array(blob.subarray(0, off)),
    ciphertextOffset: off,
  };
}

// ── public API ─────────────────────────────────────────────────────────────────

export async function sealFile(
  plaintext: Uint8Array,
  filename: string,
  strokes: SignatureStroke[],
  strictness: SealStrictness,
  phrase?: string,
): Promise<Uint8Array> {
  const blocks = encodeAllBlocks(strokes);
  if (blocks.length === 0) throw new Error("signature too short to fit any glyph block");
  const attention = computeAttention(blocks);
  const digest = buildDigest(blocks, strictness, attention);
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const trimmed = phrase?.trim() || undefined;
  const key = await deriveKey(digest, salt, trimmed);
  const attBytes = packAttentionContinuous(attention);
  const header = buildV3Header(strictness, filename, blocks.length, salt, nonce, attBytes);
  const ciphertext = await aesGcmEncrypt(key, plaintext, nonce, header);
  const out = new Uint8Array(header.length + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  return out;
}

export async function unsealFile(
  blob: Uint8Array,
  strokes: SignatureStroke[],
  phrase?: string,
): Promise<{ filename: string; plaintext: Uint8Array }> {
  const parsed = parseHeader(blob);
  const blocks = encodeAllBlocks(strokes);
  const digest = buildDigest(blocks, parsed.strictness, parsed.attention);
  const trimmed = phrase?.trim() || undefined;
  const key = await deriveKey(digest, parsed.salt, trimmed);
  const ciphertext = blob.subarray(parsed.ciphertextOffset);
  const plaintext = await aesGcmDecrypt(key, ciphertext, parsed.nonce, parsed.aad);
  return { filename: parsed.filename, plaintext };
}

export function isSealBlob(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

export function readSealStrictness(blob: Uint8Array): SealStrictness {
  return parseHeader(blob).strictness;
}

/** human-readable label for a continuous slider value (0-100). */
export function describeStrictness(v: number): string {
  if (v <= 2) return "loosest";
  if (v < 20) return "loose";
  if (v < 36) return "relaxed";
  if (v <= 44) return "medium";
  if (v < 60) return "firm";
  if (v < 76) return "tight";
  if (v <= 84) return "strict";
  if (v < 98) return "exacting";
  return "tightest";
}
