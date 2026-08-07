/**
 * equivocation-evidence.test.ts — what a seat can prove, to whom, about what.
 *
 * ══ WHY THIS FILE EXISTS ══
 *
 * The braid's accountability story rests on a claim that had never been stated
 * as a test: that when a seat forks its own strand, the resulting pair of frames
 * is EVIDENCE — self-contained, checkable by someone outside the circle, naming
 * its author.
 *
 * That claim was nearly traded away. The commitment over the circle's history is
 * a flat `sha256(head_0 ‖ … ‖ head_{n-1})`, and a flat hash cannot open in
 * parts, so a tree was proposed to allow disclosing one seat's head without the
 * rest. The proposal dissolves under one question: what would the recipient DO
 * with a head? A head is a hash chain over plaintexts an outsider does not have.
 * Proving "this opaque digest sits under that root" tells an arbiter nothing
 * about whether the digest was honestly computed. The commitment can be made
 * auditable in parts while the parts stay meaningless outside the group.
 *
 * The evidence was never supposed to come from the commitment. It comes from the
 * SIGNATURE, and the boundary lands exactly where it should:
 *
 *   OUTSIDE the circle   equivocation is provable to anyone. Two frames, one
 *                        (epoch, seat, seq), different content, both signed by a
 *                        key whose hash IS the seat's name. No group state, no
 *                        secrets, no roster required.
 *
 *   INSIDE the circle    everything softer. Whether a declared frontier was
 *                        HONEST is only meaningful against group state an
 *                        outsider does not hold, and no hash-shaped object
 *                        changes that.
 *
 * The confirmation tag deliberately proves nothing to anyone: it is keyed, so
 * members can derive it and an outsider sees noise. That buys unlinkability at
 * the cost of being repudiable, which is the right trade and worth pinning so
 * nobody later mistakes it for proof.
 *
 * These tests take the ARBITER'S seat: given only bytes that crossed the wire
 * and no privileged knowledge whatsoever, what can be established?
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateIdentity, signBytes, verifyAuthored, peerIdFromPublicKey,
  PUBKEY_LEN, SIGNATURE_LEN,
} from "../../src/scripts/whisper/campfire/identity.js";
import {
  buildGroupMsg, parseGroupMsgHeader, groupMsgSigningBody,
} from "../../src/scripts/whisper/campfire/wire.js";
import { CF_GROUP_MSG } from "../../src/scripts/whisper/campfire/types.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";
import { deterministicBytes, makeDeterministicRng } from "./_helpers/generators.js";
import type { CampfireIdentity } from "../../src/scripts/whisper/campfire/identity.js";

const TE = new TextEncoder();

interface FrameSpec {
  seq: number;
  epochId: number;
  timestamp: number;
  contentType: number;
  confirm: Uint8Array;
  frontier: Uint8Array;
  ciphertext: Uint8Array;
}

const spec = (over: Partial<FrameSpec> = {}): FrameSpec => ({
  seq: 7,
  epochId: 3,
  timestamp: 1_700_000_000_000,
  contentType: 0,
  confirm: deterministicBytes(8, 0xC0FFEE),
  frontier: Uint8Array.from([2, 0, 4, 0, 0, 1, 9, 0, 0]),
  ciphertext: deterministicBytes(48, 0xBEEF),
  ...over,
});

/** produce a wire frame exactly as a seat would. */
async function emit(id: CampfireIdentity, s: FrameSpec): Promise<Uint8Array> {
  const body = groupMsgSigningBody(
    id.peerId, s.seq, s.epochId, s.timestamp, s.contentType,
    s.confirm, s.frontier, s.ciphertext, id.publicKey,
  );
  const signature = await signBytes(id, body);
  const msgId = deterministicBytes(32, s.seq * 31 + s.epochId);
  return buildGroupMsg(
    msgId, id.peerId, s.seq, s.epochId, s.timestamp, 0, s.contentType,
    s.confirm, s.frontier, s.ciphertext, id.publicKey, signature,
  );
}

/**
 * THE ARBITER.
 *
 * Deliberately given nothing but two frames. No roster, no epoch root, no keys,
 * no notion of who is in the circle — everything it uses, it reads out of the
 * bytes it was handed. If this function can reach a verdict, so can a stranger.
 */
async function adjudicate(frameA: Uint8Array, frameB: Uint8Array): Promise<
  | { verdict: "equivocation"; seat: string; epochId: number; seq: number }
  | { verdict: "no-case"; reason: string }
> {
  // A wire frame leads with its type byte; the header parser starts at the
  // payload, exactly as the relay does before dispatching.
  const a = frameA.length > 1 && frameA[0] === CF_GROUP_MSG ? parseGroupMsgHeader(frameA.subarray(1)) : null;
  const b = frameB.length > 1 && frameB[0] === CF_GROUP_MSG ? parseGroupMsgHeader(frameB.subarray(1)) : null;
  if (!a || !b) return { verdict: "no-case", reason: "unparseable" };

  // Both must genuinely be from the seat they name. peerId commits to the
  // signing key, so this is checkable without knowing the roster.
  for (const f of [a, b]) {
    const claimed = toHex(f.senderId);
    const body = groupMsgSigningBody(
      f.senderId, f.seq, f.epochId, f.timestamp, f.contentType,
      f.confirm, f.frontier, f.ciphertext, f.authorPublicKey,
    );
    if (!(await verifyAuthored(f.authorPublicKey, claimed, body, f.signature))) {
      return { verdict: "no-case", reason: "a frame is not authentically from the seat it names" };
    }
  }

  if (toHex(a.senderId) !== toHex(b.senderId)) {
    return { verdict: "no-case", reason: "different seats: no single author to blame" };
  }
  if (a.epochId !== b.epochId || a.seq !== b.seq) {
    return { verdict: "no-case", reason: "different positions: a strand may say different things at different places" };
  }
  if (toHex(a.ciphertext) === toHex(b.ciphertext)
      && toHex(a.frontier) === toHex(b.frontier)
      && toHex(a.confirm) === toHex(b.confirm)) {
    return { verdict: "no-case", reason: "the same statement twice is a duplicate, not a contradiction" };
  }
  return { verdict: "equivocation", seat: toHex(a.senderId), epochId: a.epochId, seq: a.seq };
}

describe("equivocation evidence — provable to a stranger", () => {
  it("two contradictory frames at one position convict their author, using only the frames", async () => {
    const seat = await generateIdentity();
    const one = await emit(seat, spec({ ciphertext: deterministicBytes(48, 1) }));
    const two = await emit(seat, spec({ ciphertext: deterministicBytes(48, 2) }));

    const ruling = await adjudicate(one, two);
    assert.equal(ruling.verdict, "equivocation",
      "a fork of one's own strand must be establishable with no group state at all");
    if (ruling.verdict === "equivocation") {
      assert.equal(ruling.seat, seat.peerIdHex, "and the evidence must NAME the author");
      assert.equal(ruling.epochId, 3);
      assert.equal(ruling.seq, 7);
    }
  });

  it("the seat's name is derivable from the frame, so the arbiter needs no directory", async () => {
    // This is what makes the evidence self-contained: identity is not looked up,
    // it is recomputed. peerId = sha256(signing key), and the key rides along.
    const seat = await generateIdentity();
    const frame = await emit(seat, spec());
    const parsed = parseGroupMsgHeader(frame.subarray(1))!;

    const recomputed = toHex(await peerIdFromPublicKey(parsed.authorPublicKey));
    assert.equal(recomputed, toHex(parsed.senderId),
      "the frame carries its own proof of authorship: no roster lookup required");
  });

  it("a fabricated accusation fails: you cannot frame a seat you lack the key for", async () => {
    const victim = await generateIdentity();
    const forger = await generateIdentity();

    const genuine = await emit(victim, spec({ ciphertext: deterministicBytes(48, 1) }));
    // the forger signs its own frame but stamps the victim's seat id on it
    const s = spec({ ciphertext: deterministicBytes(48, 2) });
    const body = groupMsgSigningBody(
      victim.peerId, s.seq, s.epochId, s.timestamp, s.contentType,
      s.confirm, s.frontier, s.ciphertext, forger.publicKey,
    );
    const forged = buildGroupMsg(
      deterministicBytes(32, 99), victim.peerId, s.seq, s.epochId, s.timestamp, 0,
      s.contentType, s.confirm, s.frontier, s.ciphertext,
      forger.publicKey, await signBytes(forger, body),
    );

    const ruling = await adjudicate(genuine, forged);
    assert.equal(ruling.verdict, "no-case",
      "an accusation must not stand on a frame the accused did not sign");
  });

  it("the DECLARED FRONTIER is signed, so a lie about one's view is attributable", async () => {
    // The frontier is a claim about what the sender had integrated. It rides in
    // cleartext because the receiver needs it to reconstruct the view, and it is
    // inside the signed body, so the claim is attributable even though whether
    // it was HONEST needs group state to judge.
    const seat = await generateIdentity();
    const frame = await emit(seat, spec());
    const parsed = parseGroupMsgHeader(frame.subarray(1))!;

    const tampered = parsed.frontier.slice();
    tampered[2] ^= 0xff; // alter a declared position
    const body = groupMsgSigningBody(
      parsed.senderId, parsed.seq, parsed.epochId, parsed.timestamp,
      parsed.contentType, parsed.confirm, tampered, parsed.ciphertext, parsed.authorPublicKey,
    );
    assert.ok(!(await verifyAuthored(parsed.authorPublicKey, toHex(parsed.senderId), body, parsed.signature)),
      "changing one byte of the declared frontier must break the signature");
  });

  it("every coordinate that locates a statement is signed", async () => {
    // (epoch, seat, seq) is the position, and a contradiction is only meaningful
    // relative to a position. If any coordinate were unsigned, an attacker could
    // relocate a genuine frame and manufacture a collision.
    const seat = await generateIdentity();
    const frame = await emit(seat, spec());
    const p = parseGroupMsgHeader(frame.subarray(1))!;

    const variants: Array<[string, () => Uint8Array]> = [
      ["seq", () => groupMsgSigningBody(p.senderId, p.seq + 1, p.epochId, p.timestamp, p.contentType, p.confirm, p.frontier, p.ciphertext, p.authorPublicKey)],
      ["epochId", () => groupMsgSigningBody(p.senderId, p.seq, p.epochId + 1, p.timestamp, p.contentType, p.confirm, p.frontier, p.ciphertext, p.authorPublicKey)],
      ["ciphertext", () => { const c = p.ciphertext.slice(); c[0] ^= 1; return groupMsgSigningBody(p.senderId, p.seq, p.epochId, p.timestamp, p.contentType, p.confirm, p.frontier, c, p.authorPublicKey); }],
      ["confirm", () => { const c = p.confirm.slice(); c[0] ^= 1; return groupMsgSigningBody(p.senderId, p.seq, p.epochId, p.timestamp, p.contentType, c, p.frontier, p.ciphertext, p.authorPublicKey); }],
      ["contentType", () => groupMsgSigningBody(p.senderId, p.seq, p.epochId, p.timestamp, p.contentType ^ 1, p.confirm, p.frontier, p.ciphertext, p.authorPublicKey)],
      ["authorPublicKey", () => { const k = p.authorPublicKey.slice(); k[1] ^= 1; return groupMsgSigningBody(p.senderId, p.seq, p.epochId, p.timestamp, p.contentType, p.confirm, p.frontier, p.ciphertext, k); }],
    ];

    for (const [field, build] of variants) {
      assert.ok(!(await verifyAuthored(p.authorPublicKey, toHex(p.senderId), build(), p.signature)),
        `${field} must be inside the signed body, or a frame can be relocated or rewritten`);
    }
  });

  it("the CONFIRMATION TAG is not evidence, and must never be mistaken for it", async () => {
    // Keyed on the sender's chain, which every member can derive. So any member
    // could have produced it: it is repudiable by construction. That is the price
    // of job 2 (an outsider sees noise and cannot correlate conversations), and
    // it is why attribution rests on the asymmetric signature instead.
    const seat = await generateIdentity();
    const frame = await emit(seat, spec());
    const p = parseGroupMsgHeader(frame.subarray(1))!;

    assert.equal(p.confirm.length, 8, "the tag is 8 bytes of keyed material");
    // an arbiter holding only public data cannot check it: there is no public
    // key under which it verifies, because it is symmetric.
    assert.equal(PUBKEY_LEN, 33);
    assert.equal(SIGNATURE_LEN, 64);
    assert.notEqual(p.confirm.length, SIGNATURE_LEN,
      "the tag is not a signature and carries none of a signature's transferability");
  });

  it("duplicates are not contradictions", async () => {
    const seat = await generateIdentity();
    const s = spec();
    const once = await emit(seat, s);
    const again = await emit(seat, s);
    const ruling = await adjudicate(once, again);
    assert.equal(ruling.verdict, "no-case",
      "relaying the same statement twice is what a mesh does; it must not convict anyone");
  });

  it("different positions are not contradictions", async () => {
    const seat = await generateIdentity();
    const a = await emit(seat, spec({ seq: 7 }));
    const b = await emit(seat, spec({ seq: 8, ciphertext: deterministicBytes(48, 5) }));
    assert.equal((await adjudicate(a, b)).verdict, "no-case", "a strand may say different things at different seqs");

    const c = await emit(seat, spec({ epochId: 3 }));
    const d = await emit(seat, spec({ epochId: 4, ciphertext: deterministicBytes(48, 6) }));
    assert.equal((await adjudicate(c, d)).verdict, "no-case",
      "every fold restarts strands at seq 1, so the same seq in a later epoch is a different place");
  });

  it("STRESS: over many seats and schedules, only genuine forks ever convict", async () => {
    /**
     * The property that matters is two-sided and must hold for EVERY pairing, not
     * just the ones a hand-written case thinks to try: an honest seat is never
     * convicted, and a forking seat always is. Enumerate every pair over a mixed
     * population and check both directions at once.
     */
    const rng = makeDeterministicRng(0xE0170CA7);
    const seats = await Promise.all(Array.from({ length: 6 }, () => generateIdentity()));
    const forkers = new Set([seats[1].peerIdHex, seats[4].peerIdHex]);

    const frames: Array<{ bytes: Uint8Array; seat: string; forked: boolean }> = [];
    for (const seat of seats) {
      const forks = forkers.has(seat.peerIdHex);
      for (let epochId = 1; epochId <= 3; epochId++) {
        for (let seq = 1; seq <= 4; seq++) {
          const base = spec({ seq, epochId, ciphertext: deterministicBytes(40, seq * 7 + epochId) });
          frames.push({ bytes: await emit(seat, base), seat: seat.peerIdHex, forked: false });
          if (forks && rng() < 0.5) {
            // the same position, a different statement
            frames.push({
              bytes: await emit(seat, { ...base, ciphertext: deterministicBytes(40, 0xF000 + seq * 7 + epochId) }),
              seat: seat.peerIdHex, forked: true,
            });
          }
        }
      }
    }

    let convicted = new Set<string>();
    let comparisons = 0;
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        comparisons++;
        const ruling = await adjudicate(frames[i].bytes, frames[j].bytes);
        if (ruling.verdict !== "equivocation") continue;
        convicted.add(ruling.seat);
        // a conviction must always be sound: same seat, same position, real fork
        assert.equal(frames[i].seat, frames[j].seat, "convicted a pair from different seats");
        assert.ok(frames[i].forked || frames[j].forked,
          "convicted on a pair where neither frame was a fork");
      }
    }

    assert.ok(comparisons > 1000, `expected an exhaustive sweep, made ${comparisons} comparisons`);
    assert.deepEqual([...convicted].sort(), [...forkers].sort(),
      "exactly the forking seats are convicted: no false accusation, no missed fork");
  });

  it("STRESS: corruption cannot MANUFACTURE an accusation", async () => {
    /**
     * The property stated the wrong way round at first, and the correction is
     * worth keeping. Starting from a genuine equivocation and corrupting a frame
     * does NOT have to yield "no case": two byte ranges survive a flip with the
     * signature still valid — msgId (bytes 1..32) and hopCount (byte 65) — and
     * both are excluded from the signed body on purpose, because relays rewrite
     * hopCount and msgId is verified by recomputation elsewhere. Neither is a
     * field the verdict rests on, so a genuine fork stays a genuine fork and
     * convicting is right.
     *
     * What must never happen is the other direction: corruption turning an
     * innocent pair into a conviction. That is the direction an attacker wants,
     * and it is the one worth thousands of trials.
     */
    const rng = makeDeterministicRng(0x4B17);
    const alice = await generateIdentity();
    const bob = await generateIdentity();

    // three innocent pairings: different seats, same statement twice, and
    // different positions from one seat. None is a case; none may become one.
    const innocent: Array<[Uint8Array, Uint8Array, string]> = [
      [await emit(alice, spec()), await emit(bob, spec({ ciphertext: deterministicBytes(48, 9) })), "different seats"],
      [await emit(alice, spec()), await emit(alice, spec()), "duplicate"],
      [await emit(alice, spec({ seq: 7 })), await emit(alice, spec({ seq: 8, ciphertext: deterministicBytes(48, 3) })), "different seqs"],
    ];

    for (const [left, right, label] of innocent) {
      assert.equal((await adjudicate(left, right)).verdict, "no-case", `precondition: ${label} is innocent`);
      for (let i = 0; i < 500; i++) {
        const target = rng() < 0.5 ? left.slice() : right.slice();
        const flips = 1 + Math.floor(rng() * 4);
        for (let f = 0; f < flips; f++) {
          target[Math.floor(rng() * target.length)] ^= 1 << Math.floor(rng() * 8);
        }
        const ruling = rng() < 0.5
          ? await adjudicate(target, right)
          : await adjudicate(left, target);
        assert.notEqual(ruling.verdict, "equivocation",
          `${label}, iteration ${i}: corruption manufactured an accusation out of an innocent pair`);
      }
    }
  });

  it("STRESS: exactly the unsigned fields are the ones that may be corrupted freely", async () => {
    // Pins the coverage measured above, so a future field added to the frame but
    // forgotten in the signing body fails here rather than silently becoming a
    // place where evidence can be rewritten.
    const seat = await generateIdentity();
    const frame = await emit(seat, spec());
    const p0 = parseGroupMsgHeader(frame.subarray(1))!;

    const survives: number[] = [];
    for (let i = 1; i < frame.length; i++) {   // skip the type byte
      const m = frame.slice();
      m[i] ^= 0x01;
      const p = parseGroupMsgHeader(m.subarray(1));
      if (!p) continue;
      const body = groupMsgSigningBody(
        p.senderId, p.seq, p.epochId, p.timestamp, p.contentType,
        p.confirm, p.frontier, p.ciphertext, p.authorPublicKey,
      );
      if (await verifyAuthored(p.authorPublicKey, toHex(p.senderId), body, p.signature)) survives.push(i);
    }

    // msgId is bytes 1..32; hopCount sits after msgId+senderId+seq+epoch+timestamp
    const hopCountAt = 1 + 32 + 16 + 4 + 4 + 8;
    const expected = [...Array.from({ length: 32 }, (_, k) => 1 + k), hopCountAt];
    assert.deepEqual(survives, expected,
      "only msgId and hopCount may be altered without breaking the signature: " +
      "hopCount because relays rewrite it, msgId because it is verified by recomputation. " +
      "Anything else appearing here is a field the evidence rests on that nobody is signing.");
    assert.equal(p0.hopCount, 0, "sanity: the probe frame really carries the fields it claims");
  });

  it("STRESS: truncation at every length is dismissed without throwing", async () => {
    const seat = await generateIdentity();
    const good = await emit(seat, spec({ ciphertext: deterministicBytes(48, 1) }));
    const full = await emit(seat, spec({ ciphertext: deterministicBytes(48, 2) }));

    for (let len = 0; len < full.length; len++) {
      const ruling = await adjudicate(good, full.subarray(0, len));
      assert.equal(ruling.verdict, "no-case", `truncation to ${len} bytes must not convict`);
    }
  });
});
