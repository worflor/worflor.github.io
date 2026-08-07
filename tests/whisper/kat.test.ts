/**
 * Known-answer tests (KAT) for live-crypto primitives.
 *
 * Model-based and property tests validate the protocol against a model of
 * itself; they cannot prove the underlying primitives are *correct*. KAT is the
 * one place a real external oracle exists: RFC 5869 (HKDF-SHA256), RFC 4231
 * (HMAC-SHA256), and NIST AES-256-GCM published vectors. Anchoring these pins
 * the base of the whole tower — kdfChainDirect, the ratchet root KDF, and the
 * membrane keying all sit on top of these three primitives.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import {
  hkdf,
  hmacSha256,
  kdfChainDirect,
  aesGcmEncrypt,
  aesGcmDecrypt,
  compressP256,
  decompressP256,
} from "../../src/scripts/whisper/live-crypto.js";
import { braidFold, braidInit, braidSeal, braidOpen, encodeFrontier } from "../../src/scripts/whisper/live-braid.js";
import {
  buildGroupMsg,
  buildRingWant,
  buildBraidFold,
  parseBraidFold,
  BRAID_FOLD_PREFIX,
  BRAID_FOLD_SUFFIX,
  FOLD_RECIPIENT_LEN,
} from "../../src/scripts/whisper/campfire/wire.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";
import {
  loopInit,
  loopStep,
  loopExpand,
  modelDigest,
  loopFingerprint,
} from "../../src/scripts/whisper/live-loop.js";

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function rep(byte: number, n: number): Uint8Array {
  return new Uint8Array(n).fill(byte);
}

describe("KAT — HKDF-SHA256 (RFC 5869)", () => {
  it("Test Case 1", async () => {
    const okm = await hkdf(rep(0x0b, 22), hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"), 42);
    assertBytesEqual(
      okm,
      hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"),
      "RFC 5869 TC1 OKM",
    );
  });

  it("Test Case 2 (long inputs)", async () => {
    const ikm = new Uint8Array(80);
    for (let i = 0; i < 80; i++) ikm[i] = i;
    const salt = new Uint8Array(80);
    for (let i = 0; i < 80; i++) salt[i] = 0x60 + i;
    const info = new Uint8Array(80);
    for (let i = 0; i < 80; i++) info[i] = 0xb0 + i;
    const okm = await hkdf(ikm, salt, info, 82);
    assertBytesEqual(
      okm,
      hex(
        "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c" +
          "59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71" +
          "cc30c58179ec3e87c14c01d5c1f3434f1d87",
      ),
      "RFC 5869 TC2 OKM",
    );
  });
});

describe("KAT — HMAC-SHA256 (RFC 4231)", () => {
  it("Test Case 1", async () => {
    const mac = await hmacSha256(rep(0x0b, 20), hex("4869205468657265")); // "Hi There"
    assertBytesEqual(mac, hex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"), "RFC 4231 TC1");
  });

  it('Test Case 2 (key "Jefe")', async () => {
    const mac = await hmacSha256(hex("4a656665"), hex("7768617420646f2079612077616e7420666f72206e6f7468696e673f"));
    assertBytesEqual(mac, hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"), "RFC 4231 TC2");
  });
});

describe("KAT — kdfChainDirect anchored to HMAC", () => {
  it("chain ratchet = [HMAC(ck, 0x02), HMAC(ck, 0x01)]", async () => {
    // kdfChainDirect is defined as HMAC-SHA256(chainKey, 0x02) for the new chain
    // key and HMAC-SHA256(chainKey, 0x01) for the message key. Anchoring HMAC
    // above (RFC 4231) transitively anchors this; assert the exact composition.
    const ck = hex("42".repeat(32));
    const [newChain, msgKey] = await kdfChainDirect(ck);
    assertBytesEqual(newChain, await hmacSha256(ck, new Uint8Array([0x02])), "newChainKey = HMAC(ck, 0x02)");
    assertBytesEqual(msgKey, await hmacSha256(ck, new Uint8Array([0x01])), "messageKey = HMAC(ck, 0x01)");
    // the two outputs must differ (distinct info bytes)
    assert.notDeepEqual(Array.from(newChain), Array.from(msgKey), "chain and message keys must differ");
  });
});

describe("KAT — AES-256-GCM (NIST vectors)", () => {
  // key=0^256, iv=0^96, aad empty
  const key = rep(0x00, 32);
  const iv = rep(0x00, 12);

  it("empty plaintext → 16-byte tag matches", async () => {
    const ct = await aesGcmEncrypt(key, new Uint8Array(0), iv);
    // WebCrypto appends the 16-byte tag; empty PT → output is just the tag
    assertBytesEqual(ct, hex("530f8afbc74536b9a963b4f1c4cb738b"), "GCM tag for empty PT");
  });

  it("16 zero bytes → ciphertext||tag matches", async () => {
    const ct = await aesGcmEncrypt(key, rep(0x00, 16), iv);
    assertBytesEqual(
      ct,
      hex("cea7403d4d606b6e074ec5d3baf39d18" + "d0d1c8a799996bf0265b98b5d48ab919"),
      "GCM CT||tag for 16 zero bytes",
    );
  });

  it("decrypt inverts encrypt; a flipped tag byte fails authentication", async () => {
    const pt = hex("deadbeefcafef00d1122334455667788");
    const ct = await aesGcmEncrypt(key, pt, iv);
    const back = await aesGcmDecrypt(key, ct, iv);
    assertBytesEqual(back, pt, "decrypt(encrypt) = identity");
    const tampered = ct.slice();
    tampered[tampered.length - 1] ^= 0x01; // flip a tag bit
    await assert.rejects(() => aesGcmDecrypt(key, tampered, iv), "flipped tag must fail auth");
  });

  it("AAD binding: decrypt fails when AAD differs", async () => {
    const pt = hex("0011223344556677");
    const aad = hex("a1a2a3a4");
    const ct = await aesGcmEncrypt(key, pt, iv, aad);
    assertBytesEqual(await aesGcmDecrypt(key, ct, iv, aad), pt, "same AAD decrypts");
    await assert.rejects(() => aesGcmDecrypt(key, ct, iv, hex("b1b2b3b4")), "different AAD must fail");
  });
});

describe("KAT — P-256 point compression", () => {
  // the standard P-256 base point G
  const Gx = "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296";
  const Gy = "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";

  it("compress(G) yields 0x03 prefix (odd y)", () => {
    const uncompressed = hex("04" + Gx + Gy);
    const compressed = compressP256(uncompressed);
    assert.equal(compressed.length, 33);
    assert.equal(compressed[0], 0x03, "G has odd y → 0x03 prefix");
    assertBytesEqual(compressed.subarray(1), hex(Gx), "compressed x = Gx");
  });

  it("decompress(compress(G)) recovers the full point", () => {
    const uncompressed = hex("04" + Gx + Gy);
    const round = decompressP256(compressP256(uncompressed));
    assertBytesEqual(round, uncompressed, "decompress ∘ compress = identity on G");
  });

  it("decompress rejects an x outside the field (x >= p)", () => {
    // all-0xFF (2^256 - 1) exceeds the P-256 field prime, so it is not a valid
    // x-coordinate and must be rejected by the field-range check.
    assert.throws(() => decompressP256(hex("02" + "ff".repeat(32))), /not in field/);
  });
});

describe("KAT — membrane key schedule (frozen drift tripwire)", () => {
  // The base primitives above are anchored to external RFC/NIST vectors. The
  // membrane's key schedule (loopExpand/modelDigest/loopStep, the "kizuna-*"
  // info strings, the le32(step) salting, the modelDigest byte layout) sits above
  // them and is otherwise validated only by encoder/decoder self-agreement — so a
  // silent change to any of it would break interop with an independent
  // implementation while every other test stayed green. These vectors are FROZEN
  // literals captured from the current implementation; they are a regression
  // tripwire (any change to the schedule fails here), not an external oracle.
  const B16 = 65536;
  function fixedBlock(): Uint8Array {
    const b = new Uint8Array(B16);
    for (let i = 0; i < B16; i++) b[i] = (i * 131 + 7) & 0xff;
    return b;
  }
  function fixedKey(): Uint8Array {
    const k = new Uint8Array(32);
    for (let i = 0; i < 32; i++) k[i] = (i * 17 + 3) & 0xff;
    return k;
  }

  it("loopInit fingerprint is stable", () => {
    assert.equal(loopFingerprint(loopInit(fixedBlock())), "f838ae957b4c8333");
  });

  it("modelDigest of the fixed initial state is frozen", async () => {
    const d = await modelDigest(loopInit(fixedBlock()));
    assertBytesEqual(d, hex("92c48c2050dc488eac1b924ce3bdb9600d7c1e827da02f879ea07c245c0bd832"), "modelDigest");
  });

  it("loopExpand(fixed key) keystream prefix is frozen", async () => {
    const e = await loopExpand(fixedKey());
    assertBytesEqual(e.subarray(0, 32), hex("664c45a6ae06559368d5e931b450c77034d46ee1a158f9f25fc99004dd11a0d7"), "loopExpand[0:32]");
  });

  it("loopStep of the fixed initial state yields frozen message key + chain + next state", async () => {
    const { messageKey, next } = await loopStep(loopInit(fixedBlock()));
    assertBytesEqual(messageKey, hex("424995130b62f81d98b907fe0e6c367ab03136420af5ba0ee767593706f2a980"), "loopStep messageKey");
    assertBytesEqual(next.chain, hex("e6f26e4d9c83298fe3b8bed61bc6eae0265ac165b6beedc80dba8bbdc536d3be"), "loopStep next chain");
    assert.equal(loopFingerprint(next), "7cdd33b8bcf7673e", "loopStep next fingerprint");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen vectors for the BRAID key schedule and the CAMPFIRE wire.
//
// Nothing else in the suite pins these. Round-trip tests (parse(build(x)) === x)
// are self-referential: move a field by one byte, or change a KDF info string,
// and every one of them still passes while the protocol silently becomes a
// different protocol. These vectors are the tripwire. They are self-captured,
// not an external oracle — their only job is to make drift LOUD.
//
// If one of these fails, ask "did I mean to change the wire or the schedule?".
// If yes, re-capture. If no, you just caught a real bug.
// ─────────────────────────────────────────────────────────────────────────────
describe("KAT — braid key schedule (frozen drift tripwire)", () => {
  const ROSTER = ["aa".repeat(16), "bb".repeat(16), "cc".repeat(16)];
  const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

  it("braidFold root is stable: pins the epoch KDF and its info string", async () => {
    const root1 = await braidFold(null, fill(32, 0x11), 1, ROSTER);
    assert.equal(
      toHex(root1),
      "0eeb540460c0f667fdfbd006076de584f9e9525601cb77045c4fdf595118cdab",
      "epoch-1 root drifted: HKDF inputs, INFO_EPOCH, or the roster digest changed",
    );
  });

  it("the fold chain is order-dependent: epoch 2 folds FROM epoch 1", async () => {
    const root1 = await braidFold(null, fill(32, 0x11), 1, ROSTER);
    const root2 = await braidFold(root1, fill(32, 0x22), 2, ROSTER);
    assert.equal(
      toHex(root2),
      "7f71b1b4af029b9e3badb06475df11a79384a6f9a6c815eb4ee859ed46f2d161",
      "epoch-2 root drifted",
    );
    // and it genuinely depends on the predecessor, not just the entropy
    const orphan = await braidFold(null, fill(32, 0x22), 2, ROSTER);
    assert.notEqual(toHex(orphan), toHex(root2), "the chain must bind to prevRoot");
  });

  it("a sealed frame is byte-stable: pins INFO_SEAT, INFO_MSG, the nonce and the aad", async () => {
    // AES-GCM is deterministic given (key, nonce, aad, plaintext), and the braid
    // nonce is structural rather than random, so this ciphertext transitively
    // pins the ENTIRE key schedule: seat chain derivation, message-key
    // derivation, the TRANSCRIPT commitment, makeNonce and makeAad.
    // Re-captured 2026-08-05 three times: first when keying moved off the count
    // digest (order-blind, collides) onto the per-strand transcript, then when
    // the confirmation tag entered the AAD, then when length bucketing landed.
    //
    // That last drift is worth reading rather than just re-freezing. GCM is CTR
    // underneath, so appending pad bytes leaves the existing ciphertext prefix
    // BIT-IDENTICAL and only extends the tail and moves the tag — which is
    // exactly the shape the failure had. A drift that changed the prefix would
    // have meant the key schedule moved, and that is the thing this vector is
    // here to catch. Same assertion, two very different findings; check the
    // prefix before assuming a re-freeze is safe.
    const root = await braidFold(null, fill(32, 0x11), 1, ROSTER);
    const state = await braidInit(root, 1, ROSTER, ROSTER[0]);
    const sealed = await braidSeal(state, new TextEncoder().encode("frozen vector"));
    assert.equal(sealed.seq, 1);
    assert.equal(toHex(sealed.frontier), "00", "an empty frontier is the single byte 0x00");
    assert.equal(
      toHex(sealed.ciphertext),
      "a8226d01ab1d882d93d0521ea2325645b31caed58ff494e6168d4e358c78159f3c6159354142a75bc622c21a0a9cb74619d62f04fd7c1b59898703ff52bc155ed6b1e53e5473c65fa61b9df55d1f29fc",
      "sealed bytes drifted: some part of the braid key schedule changed",
    );
  });

  it("a frame sealed AFTER real history pins the transcript chain too", async () => {
    // The vector above seals a FIRST message, so every strand head is still zero
    // and it cannot see extendStrand at all. This one integrates two messages
    // from another seat first, so the frozen bytes depend on the per-strand
    // chain, its seat binding and its length prefixes — the order-committing
    // half of the schedule, which the empty-history vector is blind to.
    const roster = ["aa".repeat(16), "bb".repeat(16), "cc".repeat(16)];
    const root = await braidFold(null, fill(32, 0x11), 1, roster);
    const a = await braidInit(root, 1, roster, roster[0]);
    const b = await braidInit(root, 1, roster, roster[1]);

    for (const text of ["first", "second"]) {
      const sealed = await braidSeal(b, new TextEncoder().encode(text));
      const res = await braidOpen(a, {
        attachment: undefined, senderIndex: b.seatIndex, seq: sealed.seq, epochId: b.epochId,
        confirm: sealed.confirm, frontier: sealed.frontier, ciphertext: sealed.ciphertext,
      });
      assert.equal(res.status, "delivered", "precondition: the history really landed");
    }

    const sealed = await braidSeal(a, new TextEncoder().encode("after history"));
    assert.equal(toHex(sealed.frontier), "010102000000", "frontier names seat 1 up to seq 2");
    assert.equal(
      toHex(sealed.ciphertext),
      "f903ea5eac67e48a64f6033458862ed4d592a4e32a8b3db2377c31297fa9bb53835b65992f48ac8c3c13c6573d3eba5406be63f4ad626f3aa92515e5f1014f0034a20b9a7abeead16e9d19efc07be396",
      "sealed-after-history bytes drifted: the transcript chain changed",
    );
  });
});

describe("KAT — campfire wire layout (frozen field offsets)", () => {
  const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

  it("CF_GROUP_MSG field offsets are exact", () => {
    const wire = buildGroupMsg(
      fill(32, 0xA1), fill(16, 0xA2), 0x03020100, 0x07060504, 0, 0xA3, 0xA4,
      fill(8, 0xA8), encodeFrontier(Uint32Array.from([1, 0, 2])), fill(4, 0xA5),
      fill(33, 0xA6), fill(64, 0xA7),
    );
    // [0]type [1..32]msgId [33..48]senderId [49..52]seq [53..56]epochId
    // [57..64]timestamp [65]hop [66]contentType [67..99]pubkey [100..163]sig
    // [164..]frontier then ciphertext
    assert.equal(wire[0], 0x51, "sub-type byte");
    assert.equal(toHex(wire.subarray(49, 53)), "00010203", "seq is u32 little-endian at 49");
    assert.equal(toHex(wire.subarray(53, 57)), "04050607", "epochId is u32 little-endian at 53");
    assert.equal(wire[65], 0xA3, "hopCount at 65 — rewrapGroupMsg hard-codes this offset");
    assert.equal(wire[66], 0xA4, "contentType at 66");
    assert.equal(toHex(wire.subarray(67, 100)), "a6".repeat(33), "author public key at 67");
    assert.equal(toHex(wire.subarray(100, 164)), "a7".repeat(64), "signature at 100");
    assert.equal(toHex(wire.subarray(164, 172)), "a8".repeat(8), "confirmation tag follows the signature");
    assert.equal(toHex(wire.subarray(172, 183)), "0200010000000202000000", "frontier follows the tag");
    assert.equal(toHex(wire.subarray(183)), "a5a5a5a5", "ciphertext is the remainder");
  });

  it("CF_RING_WANT carries the epoch: a seq only names a position inside one", () => {
    const wire = buildRingWant(fill(16, 0xC1), fill(16, 0xC2), 0x0B0A0908, 0x03020100, 0x07060504);
    assert.equal(wire[0], 0x5b);
    assert.equal(toHex(wire.subarray(33, 37)), "08090a0b", "epochId at 33");
    assert.equal(toHex(wire.subarray(37, 41)), "00010203", "fromSeq at 37");
    assert.equal(toHex(wire.subarray(41, 45)), "04050607", "toSeq at 41");
  });

  it("CF_BRAID_FOLD carries one sealed entropy copy per recipient", () => {
    // The fold is variable-length by design: the entropy that advances the epoch
    // root is sealed once per member of the new roster rather than shipped in
    // the clear, so a removed seat gets no copy.
    const recipients = fill(2 * FOLD_RECIPIENT_LEN, 0xB6);
    const wire = buildBraidFold(
      0x03020100, 2, fill(16, 0xB1), recipients, fill(32, 0xB3), fill(33, 0xB4),
      fill(33, 0xB7), fill(64, 0xB5),
    );
    assert.equal(
      wire.length, 1 + BRAID_FOLD_PREFIX + recipients.length + BRAID_FOLD_SUFFIX,
      "type byte + prefix + recipient list + suffix",
    );
    const parsed = parseBraidFold(wire.subarray(1));
    assert.ok(parsed, "a well-formed fold parses");
    assert.equal(parsed!.newEpochId, 0x03020100);
    assert.equal(parsed!.reason, 2);
    assert.equal(parsed!.recipients.length, recipients.length, "both copies survive the round-trip");
    // the signed region must be everything except the signature, or a forger
    // could keep a valid signature while editing the fold
    assertBytesEqual(parsed!.signingBody, wire.subarray(1, wire.length - 64), "signing body");
  });

  it("parseBraidFold refuses a truncated fold or a lying recipient count", () => {
    const recipients = fill(FOLD_RECIPIENT_LEN, 7);
    const wire = buildBraidFold(
      1, 1, fill(16, 1), recipients, fill(32, 3), fill(33, 4), fill(33, 6), fill(64, 5),
    );
    assert.equal(parseBraidFold(wire.subarray(1, wire.length - 1)), null, "truncated");
    assert.equal(parseBraidFold(new Uint8Array(0)), null, "empty");
    // a count the bytes cannot back must not read past the end
    const lying = wire.subarray(1).slice();
    lying[BRAID_FOLD_PREFIX - 1] = 0xFF; // claim 255 recipients
    assert.equal(parseBraidFold(lying), null, "lying recipient count");
  });
});
