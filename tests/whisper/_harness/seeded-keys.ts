/**
 * A deterministic, seed-driven P-256 keypair source for the test harness, shaped
 * exactly like the production generateDHKeyPair result ({ publicKey: 33-byte
 * compressed point, privateKey: a WebCrypto ECDH CryptoKey }). Installing this via
 * setDHKeyPairSource makes establishChannel + every dhRatchetStep deterministic,
 * so a whole simulation run is bit-exactly reproducible from its seed — the
 * capability the rng.ts design intended but which was defeated by the real CSPRNG
 * keygen. Test-only: never install a non-CSPRNG source outside tests.
 *
 * Private scalars are SHA-256(seed || counter), which for P-256 (whose group
 * order n is just below 2^256) is a valid private key with overwhelming
 * probability; the rare invalid draw is skipped. The public point is computed
 * with node:crypto's ECDH, and the private key is imported into WebCrypto via JWK
 * so it interoperates with the real live-ratchet dhExchange.
 */

import { createECDH, createHash } from "node:crypto";
import { compressP256 } from "../../../src/scripts/whisper/live-crypto.js";

type KeyPair = { publicKey: Uint8Array; privateKey: CryptoKey };

function deriveScalar(seed: number, counter: number): Uint8Array {
  const h = createHash("sha256");
  const buf = new Uint8Array(8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, seed >>> 0, true);
  dv.setUint32(4, counter >>> 0, true);
  h.update(buf);
  return new Uint8Array(h.digest());
}

function b64url(u: Uint8Array): string {
  return Buffer.from(u).toString("base64url");
}

/** Build a deterministic keypair source keyed by `seed`; each call advances a counter. */
export function makeSeededKeyPairSource(seed: number): () => Promise<KeyPair> {
  let counter = 0;
  return async (): Promise<KeyPair> => {
    let scalar: Uint8Array;
    let pub: Buffer;
    for (;;) {
      scalar = deriveScalar(seed, counter++);
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
      kty: "EC",
      crv: "P-256",
      d: b64url(scalar),
      x: b64url(pubU8.subarray(1, 33)),
      y: b64url(pubU8.subarray(33, 65)),
      ext: false,
    };
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    return { publicKey: compressP256(pubU8), privateKey };
  };
}
