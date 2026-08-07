/**
 * L2 (c) — protocol-level property + adversarial tests, added after a fresh-eyes
 * audit that found several headline invariants were self-fulfilling. These test
 * the REAL protocolEncrypt/protocolDecrypt (the functions live.ts runs) directly.
 *
 * Highlights:
 *  - NON-VACUOUS state neutrality: a rejected frame is run on the LIVE state's
 *    clone and we prove the clone actually mutated while the original stayed
 *    byte-identical (a full digest, not just the ratchet fingerprint) — so the
 *    clone-and-discard safety mechanism is exercised, not assumed.
 *  - msgId parity + sender/receiver agreement (drives ACK/SEEN/REACT targeting).
 *  - encrypt determinism (fixed state+salt+plaintext → identical wire).
 *  - header AAD binding: any single header-byte mutation is rejected.
 *  - membrane key non-reuse: same plaintext at successive steps → distinct wire.
 *  - the ≥1MB payload path end-to-end through the protocol (bespoke raw framing).
 *  - the F1 security invariant: no unauthenticated frame can end the session.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import {
  establishChannel,
  establishBootstrap,
  encrypt,
  encryptWithId,
  craftAuthenticated,
  decrypt,
  fullStateDigest,
  type Peer,
} from "./_harness/channel.js";
import { protocolDecrypt, cloneProtocolState, protocolEncrypt } from "../../src/scripts/whisper/live-protocol.js";
import { generateDHKeyPair } from "../../src/scripts/whisper/live-ratchet.js";
import { buildHeader, HEADER_SIZE } from "../../src/scripts/whisper/live-wire.js";

function salt(): Uint8Array {
  return randomBytes(4);
}

describe("live-protocol — L2 protocol-level adversarial/property", () => {
  // ── NON-VACUOUS state neutrality ──
  // The old tests asserted ratchetFingerprint(state) unchanged after a reject —
  // true by construction (the clone is discarded). Here we prove the mechanism:
  // run protocolDecrypt on a CLONE of the live state, show the ORIGINAL is
  // byte-identical afterward (full digest) AND the clone actually diverged — so
  // the deep clone is genuinely load-bearing, not a no-op.
  it("clone-and-discard is load-bearing: rejected frame mutates the clone, never the original", async () => {
    const ch = await establishChannel(randomBytes(32));
    // one clean message so both sides are past the bootstrap
    const w0 = await encrypt(ch.offerer, randomBytes(30), salt());
    await decrypt(ch.answerer, w0);

    const before = fullStateDigest(ch.answerer.state);

    // a hostile frame carrying a fresh VALID pubkey forces a real DH ratchet on
    // the clone (heavy mutation) before authentication fails.
    const rogue = await generateDHKeyPair();
    const hostile = new Uint8Array(HEADER_SIZE + 24);
    hostile.set(buildHeader(0, rogue.publicKey, 0, 0, salt()), 0);
    hostile.set(randomBytes(24), HEADER_SIZE);

    const clone = cloneProtocolState(ch.answerer.state);
    const outcome = await protocolDecrypt(clone, hostile).catch(() => ({ ok: false as const }));
    assert.equal(outcome.ok, false, "hostile frame must not authenticate");

    // the clone was genuinely mutated by the (failed) transform...
    assert.notEqual(fullStateDigest(clone), before, "clone should have diverged (proves clone does real work)");
    // ...and the harness never committed it, so the live state is byte-identical.
    assert.equal(fullStateDigest(ch.answerer.state), before, "original state must be untouched by a rejected frame");
  });

  // ── msgId parity + agreement ──
  it("msgId: sender and receiver agree; offerer msgs even, answerer msgs odd", async () => {
    const ch = await establishChannel(randomBytes(32));
    for (let i = 0; i < 12; i++) {
      const fromOfferer = i % 3 !== 2; // mostly offerer, occasional answerer (drives DH ratchet)
      const from: Peer = fromOfferer ? ch.offerer : ch.answerer;
      const to: Peer = fromOfferer ? ch.answerer : ch.offerer;
      const pt = randomBytes(20 + i);
      const { wire, msgId: sentId } = await encryptWithId(from, pt, salt());
      const res = await decrypt(to, wire);
      assert.equal(res.status, "accept", `msg ${i} accepts`);
      if (res.status === "accept") {
        assert.equal(res.msgId, sentId, `msg ${i}: receiver-derived msgId equals sender's`);
        assert.equal(sentId % 2, fromOfferer ? 0 : 1, `msg ${i}: parity encodes the sender`);
      }
    }
  });

  // ── encrypt determinism ──
  it("determinism: identical state + salt + plaintext → byte-identical wire", async () => {
    const ch = await establishChannel(randomBytes(32));
    const fixedSalt = new Uint8Array([9, 8, 7, 6]);
    const pt = randomBytes(200);
    const clone = cloneProtocolState(ch.offerer.state);
    const a = await protocolEncrypt(ch.offerer.state, pt, 0, fixedSalt);
    const b = await protocolEncrypt(clone, pt, 0, fixedSalt);
    assertBytesEqual(a.wire, b.wire, "encrypt is a pure function of (state, plaintext, flags, salt)");
    assert.equal(a.msgId, b.msgId, "msgId deterministic");
  });

  // ── header AAD binding (avalanche) ──
  it("AAD binding: any single header-byte mutation is rejected (never accepted)", async () => {
    const ch = await establishChannel(randomBytes(32));
    const pt = randomBytes(48);
    const wire = await encrypt(ch.offerer, pt, salt());
    assert.equal(wire.length >= HEADER_SIZE, true);

    for (let pos = 0; pos < HEADER_SIZE; pos++) {
      // fresh channel per flip so each is an independent first message
      const fresh = await establishChannel(randomBytes(32));
      const w = await encrypt(fresh.offerer, pt, salt());
      const tampered = w.slice();
      tampered[pos] ^= 0x01;
      const res = await decrypt(fresh.answerer, tampered);
      assert.notEqual(res.status, "accept", `flipping header byte ${pos} must not be accepted`);
    }
  });

  // ── wire-level non-repetition ──
  // NOTE ON WHAT THIS CAN AND CANNOT PROVE. It is tempting to read distinct
  // ciphertext as evidence that the membrane key advanced. It is not: buildNonce
  // puts the counter in the nonce, so AES-GCM produces different ciphertext for
  // identical plaintext even under a frozen key. The membrane-advance property is
  // proven where it can be, at the layer that owns it, by loop.test.ts asserting
  // pairwise-distinct messageKeys across successive loopStep calls. What THIS
  // test pins is the end-to-end wire property: repeating the exact same send must
  // never put the same bytes on the wire twice.
  it("wire non-repetition: the same plaintext+salt never yields the same ciphertext twice", async () => {
    const ch = await establishChannel(randomBytes(32));
    const pt = TEncode("identical every time");
    const fixedSalt = new Uint8Array([1, 1, 1, 1]);
    const w1 = await encrypt(ch.offerer, pt, fixedSalt);
    const w2 = await encrypt(ch.offerer, pt, fixedSalt);
    // Compare the CIPHERTEXT regions, not the whole wires. The headers differ no
    // matter what, because the counter advances, so comparing wires would pass
    // even if the membrane key were reused and the ciphertext byte-identical.
    // w2 uses the compact header (same-key flag), so locate its ciphertext from
    // the end: both encrypt the same plaintext, so both ciphertexts are the same
    // length.
    const ctLen = w1.length - HEADER_SIZE;
    const c1 = w1.subarray(HEADER_SIZE);
    const c2 = w2.subarray(w2.length - ctLen);
    assert.equal(c1.length, c2.length, "sanity: equal plaintext yields equal ciphertext length");
    assert.ok(w2.length < w1.length, "sanity: the second frame really used the compact header");
    assert.notDeepEqual(
      Array.from(c1),
      Array.from(c2),
      "an identical send must never repeat ciphertext on the wire",
    );
  });

  // ── ≥1MB payload end-to-end (bespoke raw framing path) ──
  it("large payload (>=1MB) round-trips end-to-end through the protocol", async () => {
    const ch = await establishChannel(randomBytes(32));
    const big = randomBytes(1024 * 1024 + 777);
    const wire = await encrypt(ch.offerer, big, salt());
    const res = await decrypt(ch.answerer, wire);
    assert.equal(res.status, "accept", "1MB+ message decrypts");
    if (res.status === "accept") assertBytesEqual(res.plaintext, big, "1MB+ plaintext round-trips");
  });

  // ── SECURITY (F1, fixed): no unauthenticated frame may end the session ──
  // protocolDecrypt still performs the DH ratchet step before the AEAD opens, but
  // it runs on a clone that is discarded whole on any rejection, so the ratchet it
  // moved was never the committed one. The old code reported a post-ratchet auth
  // failure as `fatal`, which live.ts turned into a full teardown: one crafted
  // frame carrying a fresh VALID pubkey and an in-window counter killed an honest
  // session. The signal is gone. The invariant is stated as the property that
  // actually matters, session survival, not the absence of a flag: after a burst of
  // crafted new-pubkey frames the peer must still decrypt genuine traffic.
  it("SECURITY (F1): crafted new-pubkey frames never end the session", async () => {
    const ch = await establishChannel(randomBytes(32));
    await decrypt(ch.answerer, await encrypt(ch.offerer, randomBytes(20), salt())); // bootstrap

    const before = fullStateDigest(ch.answerer.state);
    for (let i = 0; i < 8; i++) {
      const rogue = await generateDHKeyPair();
      const hostile = new Uint8Array(HEADER_SIZE + 24);
      hostile.set(buildHeader(0, rogue.publicKey, 0, 0, salt()), 0);
      hostile.set(randomBytes(24), HEADER_SIZE);
      const res = await decrypt(ch.answerer, hostile);
      assert.notEqual(res.status, "accept", `crafted frame ${i} must not authenticate`);
    }
    assert.equal(fullStateDigest(ch.answerer.state), before, "committed state is untouched by every crafted frame");

    // the real test: the honest peer's next genuine message still round-trips.
    const genuine = randomBytes(64);
    const res = await decrypt(ch.answerer, await encrypt(ch.offerer, genuine, salt()));
    assert.equal(res.status, "accept", "the session survived the burst");
    if (res.status === "accept") assertBytesEqual(res.plaintext, genuine, "genuine plaintext intact");
  });

  // ── answerer bootstrap: the chainKeyRecv === null path through protocolDecrypt ──
  it("answerer bootstrap: the first received message drives the DH ratchet from a null recv chain", async () => {
    const ch = await establishBootstrap(randomBytes(32));
    // the answerer starts with no receive chain / no receive membrane
    assert.equal(ch.answerer.state.ratchet.chainKeyRecv, null, "answerer starts with null recv chain");
    assert.equal(ch.answerer.state.loopRecv, null, "answerer starts with null recv membrane");

    const m0 = randomBytes(40);
    const r0 = await decrypt(ch.answerer, await encrypt(ch.offerer, m0, salt()));
    assert.equal(r0.status, "accept", "first message bootstraps the recv chain and decrypts");
    if (r0.status === "accept") assertBytesEqual(r0.plaintext, m0, "bootstrapped plaintext");
    assert.notEqual(ch.answerer.state.ratchet.chainKeyRecv, null, "recv chain now established");

    // and the session keeps working afterward
    const m1 = randomBytes(30);
    const r1 = await decrypt(ch.answerer, await encrypt(ch.offerer, m1, salt()));
    assert.equal(r1.status, "accept", "second message decrypts after bootstrap");
    if (r1.status === "accept") assertBytesEqual(r1.plaintext, m1, "post-bootstrap plaintext");
  });

  // ── malicious-but-keyed peer: reach the post-authentication payload guards ──
  // These branches are dead to honest frames and tampering (they only trigger on
  // a payload that AUTHENTICATES yet is malformed), so a keyed hostile peer crafts
  // them directly.
  it("decodedLen bound: an authenticated frame claiming >64MB is rejected, not allocated", async () => {
    const ch = await establishChannel(randomBytes(32));
    // payload = [decodedLen:4B LE = 64MB+1][mode 0xFF][a few bytes]
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setUint32(0, 64 * 1024 * 1024 + 1, true);
    payload[4] = 0xff;
    const wire = await craftAuthenticated(ch.offerer, payload, salt());

    const t0 = performance.now();
    const res = await decrypt(ch.answerer, wire);
    assert.notEqual(res.status, "accept", "over-sized decodedLen must be rejected");
    if (res.status !== "accept") {
      assert.match(res.reason, /decodedLen/, "rejected specifically by the decodedLen bound (so it authenticated)");
    }
    assert.ok(performance.now() - t0 < 100, "rejected fast — no 64MB allocation");
  });

  it("payload-too-short guard: an authenticated payload under 4 bytes is rejected", async () => {
    const ch = await establishChannel(randomBytes(32));
    const wire = await craftAuthenticated(ch.offerer, new Uint8Array([1, 2, 3]), salt());
    const res = await decrypt(ch.answerer, wire);
    assert.notEqual(res.status, "accept", "under-length payload must be rejected");
    if (res.status !== "accept") assert.match(res.reason, /too short/, "rejected by the payload-length guard");
  });

  // ── forward secrecy: the consumed send membrane is zeroized on send ──
  it("forward secrecy: protocolEncrypt zeroizes the superseded send-membrane state", async () => {
    const ch = await establishChannel(randomBytes(32));
    const old = ch.offerer.state.loopSend!;
    assert.ok(
      old.countsBitM.some((v) => v !== 0) && !old.chain.every((b) => b === 0),
      "precondition: the send membrane holds live key/count material",
    );
    await encrypt(ch.offerer, randomBytes(40), salt());
    // the old membrane object (now superseded by next) must be wiped — a message
    // key recovered from it would break forward secrecy.
    assert.ok(old.chain.every((b) => b === 0), "old chain zeroized");
    assert.ok(old.countsBitM.every((v) => v === 0), "old countsBitM zeroized");
    assert.ok(old.countsBit1.every((v) => v === 0), "old countsBit1 zeroized");
    assert.ok(old.countsBitX.every((v) => v === 0), "old countsBitX zeroized");
  });

  it("forward secrecy: a committed decrypt zeroizes the superseded receive membrane", async () => {
    // the harness commit mirrors production commitReceiveState (selective copy +
    // wipe of superseded secrets), so a recovered old receive membrane can't leak.
    const ch = await establishChannel(randomBytes(32));
    await decrypt(ch.answerer, await encrypt(ch.offerer, randomBytes(20), salt())); // bootstrap
    const oldRecv = ch.answerer.state.loopRecv!;
    assert.ok(oldRecv.countsBitM.some((v) => v !== 0), "precondition: recv membrane live");

    const m1 = randomBytes(30);
    const r = await decrypt(ch.answerer, await encrypt(ch.offerer, m1, salt()));
    assert.equal(r.status, "accept", "message decrypts");
    if (r.status === "accept") assertBytesEqual(r.plaintext, m1, "plaintext intact (state not corrupted by the wipe)");
    assert.ok(oldRecv.chain.every((b) => b === 0), "superseded recv chain zeroized");
    assert.ok(oldRecv.countsBitM.every((v) => v === 0), "superseded recv countsBitM zeroized");
    assert.ok(oldRecv.countsBitX.every((v) => v === 0), "superseded recv countsBitX zeroized");
  });
});

function TEncode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
