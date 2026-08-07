/**
 * A deterministic, seed-driven source of campfire seat identities, shaped exactly
 * like generateIdentity's result. Installing it via setIdentitySource fixes the
 * peer ids a scenario produces, and a seat id is what the roster sorts by, so it
 * fixes WHICH seat is elder and which sits where in the ring.
 *
 * That is the whole point. Peer ids are hashes of freshly generated keys, so
 * without this seam every campfire test samples one roster ordering at random
 * per run and any bug that depends on ordering surfaces as an unnamed flake at
 * whatever rate that ordering appears. With it a test enumerates the orderings
 * instead.
 *
 * Private scalars are SHA-256(domain || seed || counter), valid P-256 keys with
 * overwhelming probability; the rare invalid draw is skipped. Keys are imported
 * into WebCrypto via JWK so they interoperate with the real signing and sealing
 * paths. Test-only: never install a non-CSPRNG source outside tests.
 */

import { createECDH, createHash } from "node:crypto";
import { compressP256 } from "../../../src/scripts/whisper/live-crypto.js";
import { sha256, toHex } from "../../../src/scripts/whisper/wasm.js";
import { PEER_ID_LEN, type CampfireIdentity } from "../../../src/scripts/whisper/campfire/identity.js";

function deriveScalar(domain: string, seed: number, counter: number): Uint8Array {
  const h = createHash("sha256");
  const buf = new Uint8Array(8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, seed >>> 0, true);
  dv.setUint32(4, counter >>> 0, true);
  h.update(domain);
  h.update(buf);
  return new Uint8Array(h.digest());
}

function b64url(u: Uint8Array): string {
  return Buffer.from(u).toString("base64url");
}

async function seededKey(
  domain: string, seed: number, counter: number, algorithm: "ECDSA" | "ECDH", usages: KeyUsage[],
): Promise<{ publicKey: Uint8Array; privateKey: CryptoKey }> {
  let scalar: Uint8Array;
  let pub: Buffer;
  let n = counter;
  for (;;) {
    scalar = deriveScalar(domain, seed, n++);
    const ecdh = createECDH("prime256v1");
    try {
      ecdh.setPrivateKey(Buffer.from(scalar));
      pub = ecdh.getPublicKey(); // 65B uncompressed: 0x04 || x || y
      break;
    } catch {
      // invalid scalar for this curve — extremely rare; try the next counter
    }
  }
  const pubU8 = new Uint8Array(pub);
  const jwk: JsonWebKey = {
    kty: "EC", crv: "P-256", d: b64url(scalar),
    x: b64url(pubU8.subarray(1, 33)), y: b64url(pubU8.subarray(33, 65)), ext: false,
  };
  const privateKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: algorithm, namedCurve: "P-256" }, false, usages,
  );
  return { publicKey: compressP256(pubU8), privateKey };
}

/** Mint the identity numbered `index` under `seed`. Same (seed, index) always
 *  yields the same seat id, so a scenario can be replayed exactly. */
export async function seededIdentity(seed: number, index: number): Promise<CampfireIdentity> {
  const signing = await seededKey("cf-sign", seed, index, "ECDSA", ["sign"]);
  const agreement = await seededKey("cf-agree", seed, index, "ECDH", ["deriveBits"]);
  const peerId = (await sha256(signing.publicKey)).subarray(0, PEER_ID_LEN);
  return {
    peerId, peerIdHex: toHex(peerId),
    publicKey: signing.publicKey, privateKey: signing.privateKey,
    agreement,
  };
}

/**
 * A source that hands out `identities` in order, one per generateIdentity call.
 * Nodes mint their identity when they create or join, so position in this list
 * is position in node-creation order: the caller decides which created node gets
 * which seat id, and therefore which one the roster makes elder.
 *
 * Throws once the list runs out rather than falling back to a random identity,
 * because a silent fallback would reintroduce exactly the nondeterminism this
 * exists to remove.
 */
export function identityListSource(identities: CampfireIdentity[]): () => Promise<CampfireIdentity> {
  let next = 0;
  return async () => {
    if (next >= identities.length) {
      throw new Error(`seeded identity source exhausted after ${identities.length} nodes`);
    }
    return identities[next++];
  };
}

/** `count` seeded identities sorted by seat id — i.e. in roster order, so index
 *  0 is the seat that will be elder. */
export async function seededIdentitiesInRosterOrder(seed: number, count: number): Promise<CampfireIdentity[]> {
  const out: CampfireIdentity[] = [];
  for (let i = 0; i < count; i++) out.push(await seededIdentity(seed, i));
  return out.sort((a, b) => (a.peerIdHex < b.peerIdHex ? -1 : a.peerIdHex > b.peerIdHex ? 1 : 0));
}

/** every permutation of `items`, in a stable order. */
export function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}
