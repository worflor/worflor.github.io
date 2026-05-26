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

export function encodeAllBlocks(strokes: SignatureStroke[]): GlyphBlock[] {
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

const DIGEST_LAYOUT = [
  { key: "kR",    axis: "shape"    },
  { key: "kI",    axis: "shape"    },
  { key: "gR",    axis: "speed"    },
  { key: "gI",    axis: "speed"    },
  { key: "scK",   axis: "pressure" },
  { key: "scG",   axis: "pressure" },
  { key: "cplW",  axis: "pressure" },
  { key: "mkR",   axis: "shape"    },
  { key: "mkI",   axis: "shape"    },
  { key: "mgR",   axis: "speed"    },
  { key: "mgI",   axis: "speed"    },
  { key: "tiltK", axis: "shape"    },
  { key: "tiltG", axis: "shape"    },
  { key: "azimK", axis: "shape"    },
  { key: "azimG", axis: "shape"    },
] as const;

type DigestKey = typeof DIGEST_LAYOUT[number]["key"];
type DigestAxis = typeof DIGEST_LAYOUT[number]["axis"];

const DIGEST_OFFSET = Object.fromEntries(
  DIGEST_LAYOUT.map((e, i) => [e.key, i * 2])
) as Record<DigestKey, number>;

const DIGEST_AXIS_OFFSETS: Record<DigestAxis, number[]> = { shape: [], speed: [], pressure: [] };
for (const e of DIGEST_LAYOUT) DIGEST_AXIS_OFFSETS[e.axis].push(DIGEST_OFFSET[e.key]);

export const DIGEST_AXIS_COUNTS = {
  shape: DIGEST_AXIS_OFFSETS.shape.length,
  speed: DIGEST_AXIS_OFFSETS.speed.length,
  pressure: DIGEST_AXIS_OFFSETS.pressure.length,
} as const;

const DIGEST_COEFS = DIGEST_LAYOUT.length;
const DIGEST_BYTES_PER_BLOCK = DIGEST_COEFS * 2;

/**
 * quantize an eigenmotion into a commitment digest. the attention array can be
 * overridden for unseal (where stored attention from seal-time is used instead
 * of the current hand's attention).
 */
function buildDigest(
  em: EigenMotion,
  base: SealStrictness,
  attentionOverride?: Float32Array,
): Uint8Array {
  if (em.n === 0) {
    throw new Error("signature too short to fit any glyph block");
  }
  const att = attentionOverride ?? em.attention;
  const buf = new Uint8Array(em.n * DIGEST_BYTES_PER_BLOCK);
  const view = new DataView(buf.buffer);
  let off = 0;
  const baseShapeBw = binWidthFromSlider(base.shape);
  const baseSpeedBw = binWidthFromSlider(base.speed);
  const basePressureBw = binWidthFromSlider(base.pressure);
  const bwByAxis = { shape: 0, speed: 0, pressure: 0 };
  for (let i = 0; i < em.n; i++) {
    const a = att[i] ?? 0.5;
    bwByAxis.shape = effectiveBinWidth(baseShapeBw, a);
    bwByAxis.speed = effectiveBinWidth(baseSpeedBw, a);
    bwByAxis.pressure = effectiveBinWidth(basePressureBw, a);
    for (let j = 0; j < DIGEST_COEFS; j++) {
      view.setInt16(off, quantizeIndex(eigenCoef(em, i, j), bwByAxis[DIGEST_LAYOUT[j].axis]), true);
      off += 2;
    }
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
  const em = extractEigenMotion(blocks);
  const attBytes = packAttentionContinuous(em.attention);
  const quantizedAtt = unpackAttentionContinuous(attBytes, em.n);
  const digest = buildDigest(em, strictness, quantizedAtt);
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const trimmed = phrase?.trim() || undefined;
  const key = await deriveKey(digest, salt, trimmed);
  const header = buildV3Header(strictness, filename, em.n, salt, nonce, attBytes);
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
  const em = extractEigenMotion(blocks);
  const digest = buildDigest(em, parsed.strictness, parsed.attention);
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

// ── eigenmotion vector ────────────────────────────────────────────────────────

/**
 * raw coefficient vector for a block sequence. this is the canonical representation
 * of a signature's eigenmotion — both the seal (quantized projection) and the
 * likeness engine (continuous distance) read from this same structure.
 */
export interface EigenMotion {
  n: number;
  vectors: Float32Array; // n × DIGEST_COEFS, row-major
  attention: Float32Array; // n values in [0,1]
}

export function extractEigenMotion(blocks: GlyphBlock[]): EigenMotion {
  const n = blocks.length;
  const vectors = new Float32Array(n * DIGEST_COEFS);
  for (let i = 0; i < n; i++) {
    const b = blocks[i];
    const off = i * DIGEST_COEFS;
    for (let j = 0; j < DIGEST_COEFS; j++) {
      vectors[off + j] = b[DIGEST_LAYOUT[j].key];
    }
  }
  return { n, vectors, attention: computeAttention(blocks) };
}

function eigenCoef(em: EigenMotion, block: number, coef: number): number {
  return em.vectors[block * DIGEST_COEFS + coef];
}

// ── signal-level likeness (DTW on the actual kinetic trajectory) ──────────────

export interface Trajectory {
  n: number;       // sample count
  x: Float32Array; // normalized position x [0,1]
  y: Float32Array; // normalized position y [0,1]
  p: Float32Array; // pressure [0,1]
}

export interface LikenessResult {
  samplesA: number;
  samplesB: number;
  compared: number;
  shape: number;
  speed: number;
  pressure: number;
  overall: number;
  perStep: Array<{ shape: number; speed: number; pressure: number }>;
}

// downsample a trajectory to at most maxN points via linear interpolation.
// keeps the signal shape faithful while bounding DTW cost to O(maxN^2).
function downsample(t: Trajectory, maxN: number): Trajectory {
  if (t.n <= maxN) return t;
  const x = new Float32Array(maxN);
  const y = new Float32Array(maxN);
  const p = new Float32Array(maxN);
  for (let i = 0; i < maxN; i++) {
    const frac = i / (maxN - 1) * (t.n - 1);
    const lo = Math.floor(frac);
    const hi = Math.min(lo + 1, t.n - 1);
    const a = frac - lo;
    x[i] = t.x[lo] * (1 - a) + t.x[hi] * a;
    y[i] = t.y[lo] * (1 - a) + t.y[hi] * a;
    p[i] = t.p[lo] * (1 - a) + t.p[hi] * a;
  }
  return { n: maxN, x, y, p };
}

// normalize position: translate centroid to (0.5, 0.5), scale so max
// extent fits [0,1]. makes comparison translation/scale invariant.
function normalizePosition(t: Trajectory): Trajectory {
  let cx = 0, cy = 0;
  for (let i = 0; i < t.n; i++) { cx += t.x[i]; cy += t.y[i]; }
  cx /= t.n; cy /= t.n;

  let maxExt = 0;
  for (let i = 0; i < t.n; i++) {
    maxExt = Math.max(maxExt, Math.abs(t.x[i] - cx), Math.abs(t.y[i] - cy));
  }
  const scale = maxExt > 1e-6 ? 0.5 / maxExt : 1;

  const x = new Float32Array(t.n);
  const y = new Float32Array(t.n);
  for (let i = 0; i < t.n; i++) {
    x[i] = (t.x[i] - cx) * scale + 0.5;
    y[i] = (t.y[i] - cy) * scale + 0.5;
  }
  return { n: t.n, x, y, p: t.p };
}

// extract trajectory from blocks via zero-seed reconstruction. the resulting
// curve differs from the original (zero seeds ≠ original seeds), but is
// deterministic and consistent for comparison between two block sets.
export function trajectoryFromBlocks(blocks: GlyphBlock[]): Trajectory {
  if (blocks.length === 0) return { n: 0, x: new Float32Array(0), y: new Float32Array(0), p: new Float32Array(0) };
  const zeroSeed = [0, 0, 0, 0, 0];
  const raw = GlyphCodec.decode(blocks, zeroSeed, zeroSeed);
  const total = raw.length / GLYPH_CHANNELS;
  // skip first 2 samples (seeds) to avoid transient
  const start = 2;
  const n = total - start;
  if (n <= 0) return { n: 0, x: new Float32Array(0), y: new Float32Array(0), p: new Float32Array(0) };
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const off = (start + i) * GLYPH_CHANNELS;
    x[i] = raw[off] / 32767;
    y[i] = raw[off + 1] / 32767;
    p[i] = Math.max(0, raw[off + 2] / 32767);
  }
  return { n, x, y, p };
}

export function likeness(a: Trajectory, b: Trajectory): LikenessResult {
  if (a.n < 2 || b.n < 2) {
    return {
      samplesA: a.n, samplesB: b.n, compared: 0,
      shape: 0, speed: 0, pressure: 0, overall: 0, perStep: [],
    };
  }

  // normalize position for translation/scale invariance
  const na = normalizePosition(a);
  const nb = normalizePosition(b);

  // downsample to cap DTW at O(128^2)
  const sa = downsample(na, 128);
  const sb = downsample(nb, 128);
  const nA = sa.n, nB = sb.n;

  // precompute velocity (finite differences on normalized position)
  const vxA = new Float32Array(nA), vyA = new Float32Array(nA);
  const vxB = new Float32Array(nB), vyB = new Float32Array(nB);
  for (let i = 1; i < nA; i++) { vxA[i] = sa.x[i] - sa.x[i - 1]; vyA[i] = sa.y[i] - sa.y[i - 1]; }
  for (let i = 1; i < nB; i++) { vxB[i] = sb.x[i] - sb.x[i - 1]; vyB[i] = sb.y[i] - sb.y[i - 1]; }

  // per-sample distance decomposed into shape, speed, pressure
  function sampleDist(i: number, j: number): [number, number, number] {
    const dx = sa.x[i] - sb.x[j], dy = sa.y[i] - sb.y[j];
    const shapeDist = Math.sqrt(dx * dx + dy * dy);

    const dvx = vxA[i] - vxB[j], dvy = vyA[i] - vyB[j];
    const speedDist = Math.sqrt(dvx * dvx + dvy * dvy);

    const pressDist = Math.abs(sa.p[i] - sb.p[j]);
    return [shapeDist, speedDist, pressDist];
  }

  // DTW cumulative cost matrix
  const dtw = new Float64Array(nA * nB);
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nB; j++) {
      const [sd, spd, pd] = sampleDist(i, j);
      const cost = sd + spd + pd;
      let prev: number;
      if (i === 0 && j === 0) prev = 0;
      else if (i === 0) prev = dtw[j - 1];
      else if (j === 0) prev = dtw[i * nB];
      else prev = Math.min(dtw[(i - 1) * nB + j], dtw[i * nB + j - 1], dtw[(i - 1) * nB + j - 1]);
      dtw[i * nB + j] = cost + prev;
    }
  }

  // backtrace
  const path: [number, number][] = [];
  let ci = nA - 1, cj = nB - 1;
  path.push([ci, cj]);
  while (ci > 0 || cj > 0) {
    if (ci === 0) { cj--; }
    else if (cj === 0) { ci--; }
    else {
      const d = dtw[(ci - 1) * nB + cj - 1];
      const l = dtw[ci * nB + cj - 1];
      const u = dtw[(ci - 1) * nB + cj];
      if (d <= l && d <= u) { ci--; cj--; }
      else if (l <= u) { cj--; }
      else { ci--; }
    }
    path.push([ci, cj]);
  }
  path.reverse();

  // convert distances to likeness [0,1] along the warping path.
  // gaussian kernel: likeness = exp(-dist^2 / (2 * sigma^2))
  // shape sigma 0.15: 50% at ~17.6% normalized position error
  // speed sigma 0.10: 50% at ~11.8% velocity error (meaningful threshold)
  // pressure sigma 0.20: 50% at ~23.5% pressure error
  const SHAPE_SIGMA = 0.15;
  const SPEED_SIGMA = 0.10;
  const PRESS_SIGMA = 0.2;
  function gauss(dist: number, sigma: number): number {
    return Math.exp(-(dist * dist) / (2 * sigma * sigma));
  }

  const perStep: LikenessResult["perStep"] = [];
  let shapeSum = 0, speedSum = 0, pressureSum = 0;

  for (const [ai, bj] of path) {
    const [sd, spd, pd] = sampleDist(ai, bj);
    const s = gauss(sd, SHAPE_SIGMA);
    const sp = gauss(spd, SPEED_SIGMA);
    const p = gauss(pd, PRESS_SIGMA);
    perStep.push({ shape: s, speed: sp, pressure: p });
    shapeSum += s; speedSum += sp; pressureSum += p;
  }

  const pLen = path.length;
  const shape = shapeSum / pLen;
  const speed = speedSum / pLen;
  const pressure = pressureSum / pLen;
  // shape-biased: for signature comparison, spatial fidelity dominates
  const overall = 0.5 * shape + 0.25 * speed + 0.25 * pressure;

  return {
    samplesA: a.n, samplesB: b.n, compared: pLen,
    shape, speed, pressure, overall,
    perStep,
  };
}

// ── fingerprint (block-count invariant summary) ───────────────────────────────

/**
 * fixed-size eigenmotion fingerprint: mean and variance of each coefficient
 * across all blocks. comparable without alignment, invariant to signature length.
 * two signatures from the same hand produce similar fingerprints regardless of
 * how many blocks each contains or where the block boundaries fell.
 */
export interface EigenFingerprint {
  mean: Float32Array;     // DIGEST_COEFS values
  variance: Float32Array; // DIGEST_COEFS values
  omega: number;          // dominant angular frequency (from mean |kI|)
  damping: number;        // mean damping ratio (from mean |gR|/|gI| magnitude)
}

export function fingerprint(em: EigenMotion): EigenFingerprint {
  const mean = new Float32Array(DIGEST_COEFS);
  const variance = new Float32Array(DIGEST_COEFS);
  if (em.n === 0) return { mean, variance, omega: 0, damping: 0 };

  for (let j = 0; j < DIGEST_COEFS; j++) {
    let sum = 0;
    for (let i = 0; i < em.n; i++) sum += eigenCoef(em, i, j);
    mean[j] = sum / em.n;
  }
  for (let j = 0; j < DIGEST_COEFS; j++) {
    let sumSq = 0;
    for (let i = 0; i < em.n; i++) {
      const d = eigenCoef(em, i, j) - mean[j];
      sumSq += d * d;
    }
    variance[j] = sumSq / em.n;
  }

  const kIIndex = DIGEST_LAYOUT.findIndex(e => e.key === "kI");
  const gRIndex = DIGEST_LAYOUT.findIndex(e => e.key === "gR");
  const gIIndex = DIGEST_LAYOUT.findIndex(e => e.key === "gI");
  const omega = Math.abs(mean[kIIndex]) / 16384 * Math.PI;
  const dampMag = Math.sqrt(mean[gRIndex] ** 2 + mean[gIIndex] ** 2) / 16384;
  return { mean, variance, omega, damping: Math.min(1, dampMag) };
}

/**
 * likeness between two fingerprints. fast O(DIGEST_COEFS) comparison that
 * doesn't require block alignment. useful for "is this the same hand" checks
 * before committing to full block-level comparison. variance-weighted: only
 * coefficients with actual spread in either signature contribute.
 */
export function fingerprintLikeness(a: EigenFingerprint, b: EigenFingerprint): number {
  let dist = 0, weight = 0;
  for (let j = 0; j < DIGEST_COEFS; j++) {
    const pooledStd = Math.sqrt((a.variance[j] + b.variance[j]) / 2);
    if (pooledStd < 1) continue;
    dist += Math.min(1, Math.abs(a.mean[j] - b.mean[j]) / (pooledStd * 3));
    weight++;
  }
  return weight > 0 ? 1 - dist / weight : 0;
}

// ── comparison (quantized, for seal compatibility) ────────────────────────────

export interface CompareResult {
  blocksA: number;
  blocksB: number;
  compared: number;
  shape: number;
  speed: number;
  pressure: number;
  overall: number;
  perBlock: Array<{ shape: boolean; speed: boolean; pressure: boolean }>;
}

export function compareBlocks(
  a: EigenMotion,
  b: EigenMotion,
  strictness: SealStrictness,
): CompareResult {
  const n = Math.min(a.n, b.n);
  if (n === 0) {
    return {
      blocksA: a.n, blocksB: b.n, compared: 0,
      shape: 0, speed: 0, pressure: 0, overall: 0, perBlock: [],
    };
  }

  const digestA = buildDigest(a, strictness);
  const digestB = buildDigest(b, strictness);
  const viewA = new DataView(digestA.buffer);
  const viewB = new DataView(digestB.buffer);

  const perBlock: CompareResult["perBlock"] = [];
  let shapeHits = 0, speedHits = 0, pressureHits = 0;

  for (let i = 0; i < n; i++) {
    const off = i * DIGEST_BYTES_PER_BLOCK;
    const eq = (o: number) => viewA.getInt16(off + o, true) === viewB.getInt16(off + o, true);
    const shape = DIGEST_AXIS_OFFSETS.shape.every(eq);
    const speed = DIGEST_AXIS_OFFSETS.speed.every(eq);
    const pressure = DIGEST_AXIS_OFFSETS.pressure.every(eq);
    if (shape) shapeHits++;
    if (speed) speedHits++;
    if (pressure) pressureHits++;
    perBlock.push({ shape, speed, pressure });
  }

  return {
    blocksA: a.n, blocksB: b.n, compared: n,
    shape: shapeHits / n, speed: speedHits / n, pressure: pressureHits / n,
    overall: (shapeHits + speedHits + pressureHits) / (n * 3),
    perBlock,
  };
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
