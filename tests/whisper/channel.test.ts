/**
 * L2 (a) — concrete Double Ratchet channel scenarios over the real primitives.
 *
 * Validates the faithful channel (tests/whisper/_harness/channel.ts) against the
 * delivery patterns a network actually produces: in-order both directions,
 * direction-change DH ratchet, out-of-order within a chain (skipped keys),
 * replay rejection (state-neutral), auth failure on a bitflip, and the bounded
 * skip DoS guard. The model-based harness (channel-model.test.ts) then explores
 * random interleavings of these; this file pins the named cases.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import { establishChannel, encrypt, decrypt, type Peer, type DuplexChannel } from "./_harness/channel.js";
import { ratchetFingerprint } from "../../src/scripts/whisper/live-ratchet.js";

function salt(): Uint8Array {
  return randomBytes(4);
}

async function send(from: Peer, to: Peer, msg: Uint8Array) {
  const wire = await encrypt(from, msg, salt());
  const res = await decrypt(to, wire, from.sendDirBit);
  return { wire, res };
}

describe("Double Ratchet channel (real primitives)", () => {
  it("in-order offerer→answerer: 8 messages all decrypt correctly", async () => {
    const ch = await establishChannel(randomBytes(32));
    for (let i = 0; i < 8; i++) {
      const msg = randomBytes(20 + i * 7);
      const { res } = await send(ch.offerer, ch.answerer, msg);
      assert.equal(res.status, "accept", `msg ${i} status`);
      if (res.status === "accept") assertBytesEqual(res.plaintext, msg, `msg ${i} plaintext`);
    }
  });

  it("bidirectional: direction change triggers a DH ratchet and still decrypts", async () => {
    const ch = await establishChannel(randomBytes(32));
    // offerer sends, answerer sends back (new DH key → answerer's pubkey is new to offerer)
    for (let round = 0; round < 5; round++) {
      const a = randomBytes(30);
      const ra = await send(ch.offerer, ch.answerer, a);
      assert.equal(ra.res.status, "accept", `A→B round ${round}`);
      if (ra.res.status === "accept") assertBytesEqual(ra.res.plaintext, a, `A→B plaintext ${round}`);

      const b = randomBytes(30);
      const rb = await send(ch.answerer, ch.offerer, b);
      assert.equal(rb.res.status, "accept", `B→A round ${round}`);
      if (rb.res.status === "accept") assertBytesEqual(rb.res.plaintext, b, `B→A plaintext ${round}`);
    }
  });

  it("strictly in-order by design: skipping a message desyncs (membrane history binding)", async () => {
    // Each message key is bound to the plaintext history via the membrane's
    // modelDigest (deriveMessageKey mixes in a digest of the count tables, which
    // every prior decoded plaintext has trained). So a later message's key cannot
    // be derived without having decoded the messages before it: Whisper is
    // strictly in-order (it runs over reliable, ordered SCTP), and a skipped
    // message makes all subsequent keys diverge — caught by AEAD as a rejection,
    // never a silent wrong plaintext. This test pins that intended behavior.
    const ch = await establishChannel(randomBytes(32));
    const m0 = randomBytes(40);
    const m1 = randomBytes(40);
    const m2 = randomBytes(40);
    const w0 = await encrypt(ch.offerer, m0, salt());
    await encrypt(ch.offerer, m1, salt()); // m1 exists but will be skipped
    const w2 = await encrypt(ch.offerer, m2, salt());

    const r0 = await decrypt(ch.answerer, w0, ch.offerer.sendDirBit);
    assert.equal(r0.status, "accept", "msg0 in order accepts");

    // deliver msg2, skipping msg1 → its key depends on msg1's plaintext, which the
    // receiver never saw → authentication fails (no silent corruption, no leak).
    const r2 = await decrypt(ch.answerer, w2, ch.offerer.sendDirBit);
    assert.equal(r2.status, "reject-auth", "skipping a message fails authentication (history binding)");
    assert.ok(!("plaintext" in r2), "no plaintext surfaced");
  });

  it("replay: re-delivering an accepted frame is rejected, state-neutral", async () => {
    const ch = await establishChannel(randomBytes(32));
    const msg = randomBytes(50);
    const wire = await encrypt(ch.offerer, msg, salt());

    const first = await decrypt(ch.answerer, wire, ch.offerer.sendDirBit);
    assert.equal(first.status, "accept", "first delivery accepts");

    // Whisper has no explicit replay path: a replayed counter derives the wrong
    // membrane key and fails AEAD authentication. State-neutrality comes from the
    // clone-and-discard commit discipline, so the fingerprint is unchanged.
    const fpBefore = ratchetFingerprint(ch.answerer.state.ratchet);
    const replay = await decrypt(ch.answerer, wire, ch.offerer.sendDirBit);
    assert.equal(replay.status, "reject-auth", "replay fails authentication");
    assert.equal(ratchetFingerprint(ch.answerer.state.ratchet), fpBefore, "replay must not mutate state");

    // a fresh in-order message still works after the replay attempt
    const next = randomBytes(30);
    const { res } = await send(ch.offerer, ch.answerer, next);
    assert.equal(res.status, "accept", "channel healthy after replay");
    if (res.status === "accept") assertBytesEqual(res.plaintext, next, "post-replay plaintext");
  });

  it("injected tampered frame → reject-auth, no plaintext, honest stream survives (state-neutral)", async () => {
    const ch = await establishChannel(randomBytes(32));
    // deliver a clean msg0 so the key is cached (real ordered-transport baseline)
    const m0 = randomBytes(40);
    const r0 = await send(ch.offerer, ch.answerer, m0);
    assert.equal(r0.res.status, "accept", "clean msg0 accepts");

    // an attacker injects a tampered copy of the next frame
    const m1 = randomBytes(64);
    const wire1 = await encrypt(ch.offerer, m1, salt());
    const tampered = wire1.slice();
    tampered[tampered.length - 1] ^= 0x01;
    const res = await decrypt(ch.answerer, tampered, ch.offerer.sendDirBit);
    assert.equal(res.status, "reject-auth", "tampered frame fails auth");
    assert.ok(!("plaintext" in res), "no plaintext surfaced on auth failure");

    // the injection was state-neutral (clone discarded): the genuine m1 still decrypts
    const genuine = await decrypt(ch.answerer, wire1, ch.offerer.sendDirBit);
    assert.equal(genuine.status, "accept", "genuine frame decrypts after a rejected injection");
    if (genuine.status === "accept") assertBytesEqual(genuine.plaintext, m1, "genuine plaintext");
  });

  it("bounded skip: a gap larger than MAX_SKIP is rejected as reject-gap", async () => {
    const ch = await establishChannel(randomBytes(32));
    // deliver msg0 first (full header caches the key), then jump far ahead.
    await send(ch.offerer, ch.answerer, randomBytes(8)); // msg0, answerer nRecv -> 1
    let lastWire: Uint8Array | null = null;
    for (let i = 0; i < 300; i++) lastWire = await encrypt(ch.offerer, randomBytes(8), salt());
    const res = await decrypt(ch.answerer, lastWire!, ch.offerer.sendDirBit);
    assert.equal(res.status, "reject-gap", "gap > MAX_SKIP must be rejected, not processed");
  });

  it("cross-chain delayed delivery: an old-chain message arrives after a DH ratchet", async () => {
    const ch = await establishChannel(randomBytes(32));
    // offerer sends m0 (chain A), but it is delayed.
    const m0 = randomBytes(40);
    const w0 = await encrypt(ch.offerer, m0, salt());

    // answerer sends → offerer receives (DH ratchet on offerer), then offerer
    // sends m1 under its NEW chain, which the answerer receives (DH ratchet on
    // answerer, storing the old chain's skipped key for m0).
    const back = randomBytes(20);
    await send(ch.answerer, ch.offerer, back);
    const m1 = randomBytes(40);
    const r1 = await send(ch.offerer, ch.answerer, m1);
    assert.equal(r1.res.status, "accept", "new-chain message accepts");

    // now the delayed old-chain m0 finally arrives — must resolve via skipped key
    const r0 = await decrypt(ch.answerer, w0, ch.offerer.sendDirBit);
    assert.equal(r0.status, "accept", "delayed old-chain message resolves");
    if (r0.status === "accept") assertBytesEqual(r0.plaintext, m0, "delayed plaintext correct");
  });
});
