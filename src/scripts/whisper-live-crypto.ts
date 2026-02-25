// Whisper Live crypto primitives (WebCrypto wrappers).

import { toArrayBuffer } from "./whisper-wasm";

export const TE = new TextEncoder();
export const TD = new TextDecoder();

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

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await importHmacSha256Key(key);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(data)));
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
