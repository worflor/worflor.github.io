// Whisper Live crypto primitives (WebCrypto wrappers).

import { toArrayBuffer } from "./wasm";

export const TE = new TextEncoder();
export const TD = new TextDecoder();

const PBKDF2_HASH = "SHA-256";

/** Pre-allocated KDF chain constants (avoids per-call allocations). */
const KDF_BYTE_01 = new Uint8Array([0x01]);
const KDF_BYTE_02 = new Uint8Array([0x02]);

async function importHmacSha256Key(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function importPbkdf2Key(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
}

async function importAesGcmKey(
  key: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    "AES-GCM",
    false,
    [usage],
  );
}

function buildAesGcmParams(nonce: Uint8Array, aad?: Uint8Array): AesGcmParams {
  const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(nonce) };
  if (aad) params.additionalData = toArrayBuffer(aad);
  return params;
}

/**
 * Single-importKey chain ratchet: imports the chain key once, then
 * parallelizes the two HMAC-SHA256 signs for newChainKey and messageKey.
 */
export async function kdfChainDirect(
  chainKey: Uint8Array,
): Promise<[Uint8Array, Uint8Array]> {
  const ck = await importHmacSha256Key(chainKey);
  const [newChainKey, messageKey] = await Promise.all([
    crypto.subtle.sign("HMAC", ck, KDF_BYTE_02),
    crypto.subtle.sign("HMAC", ck, KDF_BYTE_01),
  ]);
  return [new Uint8Array(newChainKey), new Uint8Array(messageKey)];
}

export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function pbkdf2(
  secret: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const key = await importPbkdf2Key(secret);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: PBKDF2_HASH,
      salt: toArrayBuffer(salt),
      iterations,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await importHmacSha256Key(key);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(data)));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importAesGcmKey(key, "encrypt");
  const params = buildAesGcmParams(nonce, aad);
  return new Uint8Array(await crypto.subtle.encrypt(params, cryptoKey, toArrayBuffer(plaintext)));
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await importAesGcmKey(key, "decrypt");
  const params = buildAesGcmParams(nonce, aad);
  return new Uint8Array(await crypto.subtle.decrypt(params, cryptoKey, toArrayBuffer(ciphertext)));
}

/** Compress an uncompressed P-256 public key (65B, 0x04||x||y) to 33B (0x02/0x03||x). */
export function compressP256(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error("invalid uncompressed P-256 point");
  }
  const compressed = new Uint8Array(33);
  compressed[0] = (uncompressed[64] & 1) ? 0x03 : 0x02;
  compressed.set(uncompressed.subarray(1, 33), 1);
  return compressed;
}

// P-256 curve constants for point decompression
const P256_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFn;
const P256_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604Bn;
const P256_A = P256_P - 3n;
// p ≡ 3 (mod 4), so modular square root is base^((p+1)/4)
const P256_SQRT_EXP = (P256_P + 1n) >> 2n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/** Decompress a compressed P-256 public key (33B, 0x02/0x03||x) to 65B (0x04||x||y). */
export function decompressP256(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33 || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) {
    throw new Error("invalid compressed P-256 point");
  }
  const wantOdd = compressed[0] === 0x03;
  // read x as big-endian BigInt
  let x = 0n;
  for (let i = 1; i < 33; i++) x = (x << 8n) | BigInt(compressed[i]);
  // y² = x³ + ax + b (mod p)
  const ySquared = (modPow(x, 3n, P256_P) + ((P256_A * x) % P256_P) + P256_B) % P256_P;
  let y = modPow((ySquared + P256_P) % P256_P, P256_SQRT_EXP, P256_P);
  if (((y & 1n) === 1n) !== wantOdd) y = P256_P - y;
  // build uncompressed point
  const out = new Uint8Array(65);
  out[0] = 0x04;
  for (let i = 32; i >= 1; i--) { out[i] = Number(x & 0xFFn); x >>= 8n; }
  for (let i = 64; i >= 33; i--) { out[i] = Number(y & 0xFFn); y >>= 8n; }
  return out;
}

/* ── Sealed CTRL: lightweight AES-GCM with 32-bit tag + implicit nonce ── */

function ctrlNonce(counter: number, directionBit: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[0] = counter & 0xff;
  nonce[1] = (counter >>> 8) & 0xff;
  nonce[2] = (counter >>> 16) & 0xff;
  nonce[3] = (counter >>> 24) & 0xff;
  nonce[11] = directionBit;
  return nonce;
}

export async function importCtrlKey(
  rawKey: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(rawKey),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealCtrl(
  key: CryptoKey,
  plaintext: Uint8Array,
  counter: number,
  directionBit: number,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const nonce = ctrlNonce(counter, directionBit);
  const params: AesGcmParams = { name: "AES-GCM", iv: nonce, tagLength: 32, additionalData: toArrayBuffer(aad) };
  return new Uint8Array(await crypto.subtle.encrypt(params, key, toArrayBuffer(plaintext)));
}

export async function openCtrl(
  key: CryptoKey,
  ciphertext: Uint8Array,
  counter: number,
  directionBit: number,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const nonce = ctrlNonce(counter, directionBit);
  const params: AesGcmParams = { name: "AES-GCM", iv: nonce, tagLength: 32, additionalData: toArrayBuffer(aad) };
  return new Uint8Array(await crypto.subtle.decrypt(params, key, toArrayBuffer(ciphertext)));
}
