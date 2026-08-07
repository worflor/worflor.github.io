/**
 * identity.ts — self-certifying seat identity for the campfire.
 *
 * A seat's id IS the hash of its public key. Nothing distributes keys and
 * nothing signs for anyone else: a roster of peer ids is already a roster of
 * public-key commitments, so any member can check that a message claiming to
 * come from a seat really carries that seat's key.
 *
 * This is what makes an epoch fold authentic. The fold carries the entropy that
 * advances the root, so whoever mints one knows the epoch it produces. Without
 * an author signature any member — including the member being removed — can mint
 * a fold and land everyone on a root it chose. The epoch root is shared by the
 * whole circle, so nothing derived FROM the root can authenticate an author;
 * the authority has to come from outside the shared secret, which is exactly
 * what an asymmetric key is for.
 *
 * P-256 ECDSA rather than Ed25519: WebCrypto ships P-256 everywhere, the
 * codebase already carries P-256 point compression for the ratchet, and the
 * signature is raw r||s at a fixed 64 bytes.
 */

import { compressP256, decompressP256, hkdf, aesGcmEncrypt, aesGcmDecrypt } from "../live-crypto";
import { sha256, toHex } from "../wasm";
import { toArrayBuffer } from "../buf";

/** bytes of the public-key hash that become the peer id. */
export const PEER_ID_LEN = 16;
/** compressed P-256 point. */
export const PUBKEY_LEN = 33;
/** raw ECDSA r||s. */
export const SIGNATURE_LEN = 64;

const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;
// the wrapping key is fresh per seal (a new ephemeral every time), so the nonce
// carries no uniqueness burden and is fixed.
const SEAL_NONCE = new Uint8Array(12);

/**
 * A seat's KEY AGREEMENT half, separate from its signing half on purpose.
 *
 * The signing key is the seat's long-term name: peerId = sha256(signing pubkey),
 * so it must never change or the seat becomes a different seat. The agreement
 * key is the opposite — it MUST be rotatable, because rotating it is exactly how
 * a compromised seat heals. An attacker holding the old agreement key cannot
 * read anything sealed to the new one, while the seat keeps its identity.
 *
 * This is the same split MLS makes between a leaf's signature key and its HPKE
 * key, and it is why peerId commits to the signing key alone.
 */
export interface CampfireAgreementKey {
  publicKey: Uint8Array;   // 33-byte compressed P-256 point
  privateKey: CryptoKey;   // non-extractable ECDH private key
}

export interface CampfireIdentity {
  /** sha256(publicKey) truncated to PEER_ID_LEN. */
  peerId: Uint8Array;
  peerIdHex: string;
  /** 33-byte compressed P-256 point. */
  publicKey: Uint8Array;
  /** non-extractable signing key. */
  privateKey: CryptoKey;
  /** rotatable key-agreement half; NOT committed to by peerId. */
  agreement: CampfireAgreementKey;
}

/** the seat id committed to by a public key. */
export async function peerIdFromPublicKey(publicKey: Uint8Array): Promise<Uint8Array> {
  const digest = await sha256(publicKey);
  return digest.subarray(0, PEER_ID_LEN);
}

/** mint a fresh seat identity. the private key never leaves this object. */
export async function generateAgreementKey(): Promise<CampfireAgreementKey> {
  const pair = await crypto.subtle.generateKey(ECDH_PARAMS, false, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: compressP256(raw), privateKey: pair.privateKey };
}

export async function generateIdentity(): Promise<CampfireIdentity> {
  return currentIdentitySource();
}

async function realIdentity(): Promise<CampfireIdentity> {
  const pair = await crypto.subtle.generateKey(ECDSA_PARAMS, false, ["sign", "verify"]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = compressP256(rawPublic);
  const peerId = await peerIdFromPublicKey(publicKey);
  return {
    peerId, peerIdHex: toHex(peerId), publicKey, privateKey: pair.privateKey,
    agreement: await generateAgreementKey(),
  };
}

// Injectable identity source (test seam). A seat id is the hash of a freshly
// generated key, so the roster sort order — and with it WHICH seat is elder — is
// a fresh coin flip on every run. That made whole families of ordering bugs show
// up as one-in-N flakes instead of failures a test could name. With a source
// installed a test can enumerate orderings rather than sample one. The default
// is byte-for-byte the prior behavior; never install a non-CSPRNG source outside
// tests.
let currentIdentitySource: () => Promise<CampfireIdentity> = realIdentity;

/** Install a deterministic identity source. Test-only. Returns the previous source. */
export function setIdentitySource(source: () => Promise<CampfireIdentity>): () => Promise<CampfireIdentity> {
  const prev = currentIdentitySource;
  currentIdentitySource = source;
  return prev;
}

/** Restore the production CSPRNG-backed identity source. Test-only. */
export function resetIdentitySource(): void {
  currentIdentitySource = realIdentity;
}

/**
 * Seal 32 bytes to a recipient's agreement key with a FRESH ephemeral, and
 * return [ephemeral pubkey 33][ciphertext+tag 48].
 *
 * This is what makes removal cryptographic rather than transport-conditional. A
 * fold's entropy is the secret that advances the epoch root; shipped in
 * cleartext, the only thing withholding it from a removed member is that nobody
 * relayed the packet to them, and they still hold the previous root. Sealed to
 * each REMAINING member, a removed seat cannot derive the new root even given
 * the entire frame.
 */
export async function sealToAgreement(
  recipientPublicKey: Uint8Array, secret: Uint8Array, info: Uint8Array,
): Promise<Uint8Array | null> {
  if (recipientPublicKey.length !== PUBKEY_LEN) return null;
  try {
    const eph = await crypto.subtle.generateKey(ECDH_PARAMS, false, ["deriveBits"]);
    const ephPub = compressP256(new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey)));
    const shared = await deriveShared(eph.privateKey, recipientPublicKey);
    const key = await hkdf(shared, ephPub, info, 32);
    shared.fill(0);
    const ct = await aesGcmEncrypt(key, secret, SEAL_NONCE, ephPub);
    key.fill(0);
    return concatU8(ephPub, ct);
  } catch {
    return null;
  }
}

/** inverse of sealToAgreement; null on any malformed or unopenable input. */
export async function openFromAgreement(
  agreement: CampfireAgreementKey, sealed: Uint8Array, info: Uint8Array,
): Promise<Uint8Array | null> {
  if (sealed.length !== PUBKEY_LEN + 48) return null;
  try {
    const ephPub = sealed.subarray(0, PUBKEY_LEN);
    const shared = await deriveShared(agreement.privateKey, ephPub);
    const key = await hkdf(shared, ephPub, info, 32);
    shared.fill(0);
    const out = await aesGcmDecrypt(key, sealed.subarray(PUBKEY_LEN), SEAL_NONCE, ephPub);
    key.fill(0);
    return out;
  } catch {
    return null;
  }
}

async function deriveShared(priv: CryptoKey, peerCompressed: Uint8Array): Promise<Uint8Array> {
  const peer = await crypto.subtle.importKey(
    "raw", toArrayBuffer(decompressP256(peerCompressed)), ECDH_PARAMS, false, [],
  );
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, priv, 256));
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

/** sign `body`. returns raw r||s, SIGNATURE_LEN bytes. */
export async function signBytes(identity: CampfireIdentity, body: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign(ECDSA_SIGN, identity.privateKey, toArrayBuffer(body));
  return new Uint8Array(sig);
}

/**
 * Verify `signature` over `body` under `publicKey`, AND that the key commits to
 * `expectedPeerIdHex`. Both halves matter: the signature alone proves someone
 * holds a key, and the commitment is what ties that key to the seat the roster
 * names. Returns false rather than throwing on any malformed input, so a
 * caller can treat a bad frame as a rejection instead of an exception.
 */
export async function verifyAuthored(
  publicKey: Uint8Array,
  expectedPeerIdHex: string,
  body: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== PUBKEY_LEN || signature.length !== SIGNATURE_LEN) return false;
  let committed: Uint8Array;
  try {
    committed = await peerIdFromPublicKey(publicKey);
  } catch {
    return false;
  }
  if (toHex(committed) !== expectedPeerIdHex) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw", toArrayBuffer(decompressP256(publicKey)), ECDSA_PARAMS, false, ["verify"],
    );
    return await crypto.subtle.verify(ECDSA_SIGN, key, toArrayBuffer(signature), toArrayBuffer(body));
  } catch {
    return false; // uninterpretable point, malformed signature, unsupported curve
  }
}
