/**
 * vectors-external.test.ts — the only tests in this repo that are checkable by
 * someone who does not trust this repo.
 *
 * Every other suite compares Whisper against Whisper. That catches drift, and it
 * catches nothing else: a primitive that has been subtly wrong since the first
 * commit is self-consistent, round-trips perfectly, and passes every property we
 * can state about it. Freezing our own output as a "vector" preserves the bug as
 * a requirement.
 *
 * So the anchors here come from outside — published RFC test vectors, byte for
 * byte. If `hkdf` ever stops being HKDF, or `pbkdf2` silently swaps its hash, or
 * a WebCrypto polyfill lands with different semantics, these fail and nothing
 * else in the suite does.
 *
 * The second half freezes the HANDSHAKE derivations. Those are ours, so a frozen
 * value cannot prove correctness — it proves stability, which is the property
 * that actually matters for them: every info string and every length prefix is
 * part of the wire contract, and changing one silently makes two builds of
 * Whisper unable to talk while every unit test still passes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hkdf, pbkdf2, hmacSha256, TE } from "../../src/scripts/whisper/live-crypto.js";
import {
  derivePhraseRoot,
  derivePhraseScopedKey,
  deriveHandshakeTranscriptHash,
  deriveSessionRoot,
  deriveSilentKey,
  deriveAudioKey,
  deriveCtrlKey,
  deriveConfirmContextHash,
  buildConfirmProof,
  verifyConfirmProof,
} from "../../src/scripts/whisper/live-handshake.js";
import { sha256, toHex } from "../../src/scripts/whisper/wasm.js";

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 0x00,0x01,...,0x(n-1) — the "counting" input RFC 5869 uses for its long cases. */
function counting(from: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (from + i) & 0xff;
  return out;
}

describe("external vectors — RFC 5869 HKDF-SHA256", () => {
  // https://www.rfc-editor.org/rfc/rfc5869#appendix-A
  it("A.1 basic case", async () => {
    const okm = await hkdf(
      new Uint8Array(22).fill(0x0b),
      fromHex("000102030405060708090a0b0c"),
      fromHex("f0f1f2f3f4f5f6f7f8f9"),
      42,
    );
    assert.equal(toHex(okm),
      "3cb25f25faacd57a90434f64d0362f2a" +
      "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
      "34007208d5b887185865");
  });

  it("A.2 longer inputs and output", async () => {
    const okm = await hkdf(counting(0x00, 80), counting(0x60, 80), counting(0xb0, 80), 82);
    assert.equal(toHex(okm),
      "b11e398dc80327a1c8e7f78c596a4934" +
      "4f012eda2d4efad8a050cc4c19afa97c" +
      "59045a99cac7827271cb41c65e590e09" +
      "da3275600c2f09b8367793a9aca3db71" +
      "cc30c58179ec3e87c14c01d5c1f3434f" +
      "1d87");
  });

  it("A.3 zero-length salt and info", async () => {
    // The degenerate case is worth pinning: an implementation that quietly
    // substitutes a default salt for an empty one still passes A.1.
    const okm = await hkdf(new Uint8Array(22).fill(0x0b), new Uint8Array(0), new Uint8Array(0), 42);
    assert.equal(toHex(okm),
      "8da4e775a563c18f715f802a063c5a31" +
      "b8a11f5c5ee1879ec3454e5f3c738d2d" +
      "9d201395faa4b61a96c8");
  });
});

describe("external vectors — RFC 4231 HMAC-SHA256", () => {
  // https://www.rfc-editor.org/rfc/rfc4231#section-4
  it("case 1", async () => {
    const mac = await hmacSha256(new Uint8Array(20).fill(0x0b), TE.encode("Hi There"));
    assert.equal(toHex(mac), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  it("case 2 — key shorter than the block", async () => {
    const mac = await hmacSha256(TE.encode("Jefe"), TE.encode("what do ya want for nothing?"));
    assert.equal(toHex(mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("case 6 — key longer than the block, which must be hashed down", async () => {
    const mac = await hmacSha256(
      new Uint8Array(131).fill(0xaa),
      TE.encode("Test Using Larger Than Block-Size Key - Hash Key First"),
    );
    assert.equal(toHex(mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });
});

describe("external vectors — RFC 7914 §11 PBKDF2-HMAC-SHA256", () => {
  // https://www.rfc-editor.org/rfc/rfc7914#section-11 — the SHA-256 vectors.
  // RFC 6070's are SHA-1 and would not exercise the hash this codebase uses.
  it("c=1, dkLen=64", async () => {
    const dk = await pbkdf2(TE.encode("passwd"), TE.encode("salt"), 1, 64);
    assert.equal(toHex(dk),
      "55ac046e56e3089fec1691c22544b605" +
      "f94185216dde0465e68b9d57c20dacbc" +
      "49ca9cccf179b645991664b39d77ef31" +
      "7c71b845b1e30bd509112041d3a19783");
  });

  it("c=80000, dkLen=64 — iteration count is actually honoured", async () => {
    // A one-iteration vector cannot distinguish PBKDF2 from a single HMAC, so an
    // implementation that ignored `iterations` would pass the case above.
    const dk = await pbkdf2(TE.encode("Password"), TE.encode("NaCl"), 80000, 64);
    assert.equal(toHex(dk),
      "4ddcd8f60b98be21830cee5ef22701f9" +
      "641a4418d04c0414aeff08876b34ab56" +
      "a1d425a1225833549adb841b51c9b317" +
      "6a272bdebba1d078478f62b397f33c8d");
  });
});

describe("external vectors — SHA-256 (FIPS 180-4 examples)", () => {
  // The WASM sha256 is ours; these are not.
  it("the empty string", async () => {
    assert.equal(toHex(await sha256(new Uint8Array(0))),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("\"abc\"", async () => {
    assert.equal(toHex(await sha256(TE.encode("abc"))),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("the 448-bit two-block message", async () => {
    assert.equal(
      toHex(await sha256(TE.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("a million 'a' — the length encoding past 2^32 bits of buffering", async () => {
    assert.equal(toHex(await sha256(new Uint8Array(1_000_000).fill(0x61))),
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });
});

/* ------------------------------------------------------------------------- */

const FIXED_ECDH = counting(0x10, 32);
const FIXED_TRANSCRIPT_INPUTS = {
  offerSdpBytes: TE.encode("v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n"),
  answerSdpBytes: TE.encode("v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\n"),
  offererEphemeralKey: counting(0x40, 65),
  answererEphemeralKey: counting(0x80, 65),
};

describe("frozen vectors — handshake derivations", () => {
  it("the transcript hash is stable", async () => {
    const h = await deriveHandshakeTranscriptHash(FIXED_TRANSCRIPT_INPUTS);
    assert.equal(toHex(h), "b407db9c5efc623edbca2b31670a549c6accf3cb0fb9a2b27024586350f0f598");
  });

  it("the session root is stable, with and without a phrase", async () => {
    const t = await deriveHandshakeTranscriptHash(FIXED_TRANSCRIPT_INPUTS);
    assert.equal(toHex(await deriveSessionRoot(FIXED_ECDH.slice(), t, null)), "42e3880a80c459659da8ddd4f0186fe1fac0a833500bc8fbae94891a94e62cbd");
    assert.equal(
      toHex(await deriveSessionRoot(FIXED_ECDH.slice(), t, counting(0xc0, 32))),
      "4dc8c8d368e3c6a08b7a67371b5f00862b39a58ac9c698d242f50522fc0d3345",
    );
  });

  it("the purpose keys are stable and mutually distinct", async () => {
    const root = counting(0x01, 32);
    const silent = await deriveSilentKey(root);
    const audio = await deriveAudioKey(root);
    const ctrl = await deriveCtrlKey(root);
    assert.equal(toHex(silent), "15f1bfc871bd69137dc02276b673a9bafe2f36566a677539e0f155565d0356ff");
    assert.equal(toHex(audio), "2ff6bcf43b8539aa553e35be0fc581ac");
    assert.equal(toHex(ctrl), "eb7c6e760ef4acdbded01de0d0dfb8752ec60f99b6d23b1a1d8550df6f4653e5");

    // domain separation, stated as a property rather than as three constants:
    // one root must never yield the same bytes for two different purposes.
    assert.notEqual(toHex(silent), toHex(ctrl));
    assert.notEqual(toHex(silent.subarray(0, 16)), toHex(audio));
    assert.notEqual(toHex(ctrl.subarray(0, 16)), toHex(audio));
  });
});

describe("transcript framing — the property the length prefixes exist for", () => {
  /**
   * Every field goes in as le32(len)‖bytes. Without that, "AB"‖"C" and "A"‖"BC"
   * hash identically and the transcript no longer pins WHICH sdp said what — an
   * attacker who can shift a byte across a boundary keeps the hash and changes
   * the meaning. This is the canonical concatenation ambiguity, and it is
   * exactly what confirm-proof binding rests on.
   */
  it("moving a byte across a field boundary changes the hash", async () => {
    const a = await deriveHandshakeTranscriptHash({
      ...FIXED_TRANSCRIPT_INPUTS,
      offerSdpBytes: TE.encode("AB"),
      answerSdpBytes: TE.encode("C"),
    });
    const b = await deriveHandshakeTranscriptHash({
      ...FIXED_TRANSCRIPT_INPUTS,
      offerSdpBytes: TE.encode("A"),
      answerSdpBytes: TE.encode("BC"),
    });
    assert.notEqual(toHex(a), toHex(b), "unframed concatenation would collide here");
  });

  it("swapping the two ephemeral keys changes the hash", async () => {
    const a = await deriveHandshakeTranscriptHash(FIXED_TRANSCRIPT_INPUTS);
    const b = await deriveHandshakeTranscriptHash({
      ...FIXED_TRANSCRIPT_INPUTS,
      offererEphemeralKey: FIXED_TRANSCRIPT_INPUTS.answererEphemeralKey,
      answererEphemeralKey: FIXED_TRANSCRIPT_INPUTS.offererEphemeralKey,
    });
    assert.notEqual(toHex(a), toHex(b), "roles must be pinned, not merely present");
  });

  it("every field is load-bearing", async () => {
    const base = await deriveHandshakeTranscriptHash(FIXED_TRANSCRIPT_INPUTS);
    for (const field of Object.keys(FIXED_TRANSCRIPT_INPUTS) as Array<keyof typeof FIXED_TRANSCRIPT_INPUTS>) {
      const mutated = { ...FIXED_TRANSCRIPT_INPUTS };
      const orig = mutated[field];
      const flipped = orig.slice(); flipped[0] ^= 0xff;
      mutated[field] = flipped;
      assert.notEqual(
        toHex(await deriveHandshakeTranscriptHash(mutated)), toHex(base),
        `${field} does not reach the transcript hash`,
      );
    }
  });
});

describe("confirm proof — what the short authentication string actually binds", () => {
  async function context(overrides: Partial<Parameters<typeof deriveConfirmContextHash>[0]> = {}) {
    return deriveConfirmContextHash({
      transcriptHash: await deriveHandshakeTranscriptHash(FIXED_TRANSCRIPT_INPUTS),
      offererRatchetKey: counting(0x20, 65),
      answererRatchetKey: counting(0x60, 65),
      kizunaWitness: fromHex("deadbeef"),
      ...overrides,
    });
  }

  it("a genuine proof verifies under both roles", async () => {
    const root = counting(0x07, 32);
    const ctx = await context();
    for (const role of ["offerer", "answerer"] as const) {
      const proof = await buildConfirmProof(root, ctx, role);
      assert.ok(await verifyConfirmProof(root, ctx, role, proof), `${role} proof verifies`);
    }
  });

  it("a proof does not transfer between roles", async () => {
    // Otherwise a reflection attack replays the offerer's proof back at it and
    // the session confirms against nobody.
    const root = counting(0x07, 32);
    const ctx = await context();
    const offererProof = await buildConfirmProof(root, ctx, "offerer");
    assert.ok(!(await verifyConfirmProof(root, ctx, "answerer", offererProof)),
      "role must be bound into the proof, not just into the ceremony");
  });

  it("a proof does not transfer between contexts or roots", async () => {
    const root = counting(0x07, 32);
    const ctx = await context();
    const proof = await buildConfirmProof(root, ctx, "offerer");

    const otherWitness = await context({ kizunaWitness: fromHex("deadbeee") });
    assert.ok(!(await verifyConfirmProof(root, otherWitness, "offerer", proof)),
      "a one-bit change in the witness must break the proof");

    const otherRatchet = await context({ offererRatchetKey: counting(0x21, 65) });
    assert.ok(!(await verifyConfirmProof(root, otherRatchet, "offerer", proof)),
      "the ratchet keys are what an MITM would have to substitute");

    assert.ok(!(await verifyConfirmProof(counting(0x08, 32), ctx, "offerer", proof)),
      "a different session root must not confirm");
  });

  it("verification rejects malformed proofs instead of throwing", async () => {
    const root = counting(0x07, 32);
    const ctx = await context();
    const proof = await buildConfirmProof(root, ctx, "offerer");
    const truncated = proof.subarray(0, proof.length - 1);
    const flipped = proof.slice(); flipped[0] ^= 0x01;

    assert.ok(!(await verifyConfirmProof(root, ctx, "offerer", truncated)), "truncated");
    assert.ok(!(await verifyConfirmProof(root, ctx, "offerer", flipped)), "one flipped bit");
    assert.ok(!(await verifyConfirmProof(root, ctx, "offerer", new Uint8Array(0))), "empty");
  });
});

describe("phrase derivation — namespacing and cost", () => {
  it("distinct scopes never collide", async () => {
    const root = counting(0x33, 32);
    const a = await derivePhraseScopedKey(root, "rendezvous", 32);
    const b = await derivePhraseScopedKey(root, "rendezvou", 32);   // prefix of the above
    const c = await derivePhraseScopedKey(root, "s", 32);
    assert.notEqual(toHex(a), toHex(b));
    assert.notEqual(toHex(a), toHex(c));
    assert.notEqual(toHex(b), toHex(c));
  });

  it("the phrase root is a slow, salted function of the phrase", async () => {
    const a = await derivePhraseRoot("correct horse battery staple");
    const b = await derivePhraseRoot("correct horse battery stapl");
    assert.equal(a.length, 32);
    assert.notEqual(toHex(a), toHex(b));
    assert.equal(toHex(await derivePhraseRoot("correct horse battery staple")), toHex(a),
      "deterministic: both sides of a pairing must land on the same root");
  });
});
