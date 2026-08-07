/**
 * concurrency.test.ts — the ratchet lock, which nothing tested until now.
 *
 * `live.ts` guards every ratchet operation with `withRatchetLock`. It is the only
 * lock in the system, and it is load-bearing in the strongest sense available:
 * `buildProtoState()` hands out REFERENCES to the live ratchet, both membranes
 * and the skipped-key map, and `protocolEncrypt` mutates them in place. If two
 * sends interleave, both read `nSend` before either writes it, and both frames go
 * out on the same counter with the same message key.
 *
 * For AES-GCM that is nonce reuse. Nonce reuse under one key is keystream reuse,
 * so two ciphertexts XOR to the XOR of their plaintexts, and the GCM
 * authentication key is recoverable outright. It is the single worst failure this
 * codebase could have.
 *
 * Every existing test awaited each call before making the next, so the lock was
 * never contended and a deleted lock would have looked identical to a working
 * one. These tests enter it concurrently, and the first one demonstrates the
 * hazard directly so the rest are not taken on faith.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivedRandom } from "./_harness/rng.js";
import {
  establishChannel, encrypt, decrypt, withPeerLock, fullStateDigest,
} from "./_harness/channel.js";
import { protocolEncrypt, cloneProtocolState } from "../../src/scripts/whisper/live-protocol.js";
import { parseHeader } from "../../src/scripts/whisper/live-wire.js";

const TE = new TextEncoder();
const TD = new TextDecoder();

/**
 * Fail fast instead of hanging.
 *
 * A broken lock does not produce a wrong answer, it produces no answer. Measured
 * against two mutants (dropping `await prior`, and releasing before the operation
 * instead of after), the suite ran forever: corrupt membrane state sends the
 * range coder into a CPU-bound loop.
 *
 * The deadline converts that into a failure, but it cannot make it a FAST one,
 * and it is worth being clear about why rather than leaving someone to wonder.
 * A synchronous loop cannot be preempted by a timer in a single-threaded runtime,
 * so the timeout only fires once the coder yields. Reducing the concurrency does
 * not help either: five concurrent unlocked sends are already slow enough,
 * because the cost is in the corrupted encode, not in the number of them. So a
 * lock regression is caught in roughly 160s where a healthy run takes 300ms.
 * Slow, but named, and bounded, which is all three of the things a hang is not.
 */
function withDeadline<T>(work: Promise<T>, label: string, ms = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: did not settle in ${ms}ms — the ratchet lock is not serializing`)),
      ms,
    );
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

describe("the ratchet lock", () => {
  it("THE HAZARD, shown deterministically: two sends from one state collide on a counter", async () => {
    /**
     * WHY THIS DOES NOT ACTUALLY RACE.
     *
     * Firing concurrent unlocked encrypts at a shared state does reproduce the
     * bug, and it was measured that way: eight sends all carrying counter 0.
     * But the corrupted membrane it leaves behind can put the range coder into a
     * loop that never returns, and a runaway loop in a test file poisons every
     * test after it. A suite that can hang is worse than the hazard it documents.
     *
     * So the premise is demonstrated instead of the symptom, deterministically.
     * `protocolEncrypt` MUTATES the state object it is handed, and live.ts's
     * `buildProtoState()` hands it references to the live ratchet rather than a
     * copy. Two calls that both begin from the same state therefore both read the
     * same `nSend` and both emit that counter. Running them on two clones of one
     * snapshot produces exactly what interleaving on one shared object produces,
     * with none of the corruption.
     */
    const ch = await establishChannel(new Uint8Array(32).fill(3));
    const salt = new Uint8Array(4);

    // 1. the state is shared-mutable: one call moves the caller's own object
    const before = ch.offerer.state.ratchet.nSend;
    await protocolEncrypt(ch.offerer.state, TE.encode("first"), 0, salt);
    assert.equal(ch.offerer.state.ratchet.nSend, before + 1,
      "protocolEncrypt must mutate the state it is given, or none of this applies");

    // 2. two sends beginning from the same snapshot emit the SAME counter, which
    //    is nonce reuse under one message key: keystream reuse, so the two
    //    ciphertexts XOR to the XOR of their plaintexts.
    const snapshot = cloneProtocolState(ch.offerer.state);
    const a = await protocolEncrypt(cloneProtocolState(snapshot), TE.encode("alpha"), 0, salt);
    const b = await protocolEncrypt(cloneProtocolState(snapshot), TE.encode("bravo"), 0, salt);

    const ca = parseHeader(a.wire).counter;
    const cb = parseHeader(b.wire).counter;
    assert.equal(ca, cb, "two sends from one starting state must land on the same counter");

    // and the nonce really is identical, which is the part that matters
    const ha = parseHeader(a.wire), hb = parseHeader(b.wire);
    assert.deepEqual(Array.from(ha.salt), Array.from(hb.salt), "same salt");
    assert.equal(ha.counter, hb.counter, "same counter, so buildNonce yields the same nonce");

    // 3. and serialized sends do NOT collide, so the lock is what separates them
    const s1 = await protocolEncrypt(ch.offerer.state, TE.encode("one"), 0, salt);
    const s2 = await protocolEncrypt(ch.offerer.state, TE.encode("two"), 0, salt);
    assert.notEqual(parseHeader(s1.wire).counter, parseHeader(s2.wire).counter,
      "sequential sends advance the counter; only overlap collapses them");
  });

  it("concurrent sends THROUGH the lock get distinct counters and all decrypt", async () => {
    const ch = await establishChannel(new Uint8Array(32).fill(7));
    const rng = derivedRandom("locked-sends");

    // CANARY FIRST, and cheaply. A broken lock does not fail this test by
    // asserting false, it fails it by never finishing: the corrupted membrane
    // sends the range coder into a CPU-bound loop, and a synchronous loop cannot
    // be preempted by a deadline timer. Two frames are enough to prove the lock
    // serializes, and they get out before a storm of sixteen can wedge anything.
    const canary = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      encrypt(ch.offerer, TE.encode(`canary-${i}`), rng.at("canary", i).bytes(4))));
    const canaryCounters = canary.map((w) => parseHeader(w).counter);
    assert.equal(new Set(canaryCounters).size, canary.length,
      `concurrent sends collided on a counter (${canaryCounters.join(",")}): ` +
      `the ratchet lock is not serializing`);

    // fired without awaiting between them, exactly as a UI would if the user
    // pasted several lines or a file went out as a run of chunks
    const pending = Array.from({ length: 16 }, (_, i) =>
      encrypt(ch.offerer, TE.encode(`locked ${i}`), rng.at("salt", i).bytes(4)));
    const wires = await withDeadline(Promise.all(pending), "concurrent locked sends");

    const counters = wires.map((w) => parseHeader(w).counter);
    assert.equal(new Set(counters).size, counters.length,
      `the lock must serialize counters, got ${counters.join(",")}`);
    assert.deepEqual(counters, counters.slice().sort((a, b) => a - b),
      "and issue them in order, since the queue is FIFO");

    // the receiver reads every one, in order, on a reliable transport. the two
    // canary frames were sent first, so they are delivered first.
    for (const c of canary) {
      assert.equal((await decrypt(ch.answerer, c)).status, "accept", "canary frame decrypts");
    }
    for (let i = 0; i < wires.length; i++) {
      const r = await decrypt(ch.answerer, wires[i]);
      assert.equal(r.status, "accept", `frame ${i} must decrypt`);
      if (r.status === "accept") {
        assert.equal(TD.decode(r.plaintext), `locked ${i}`, `frame ${i} content`);
      }
    }
  });

  it("a send racing a receive leaves committed state consistent", async () => {
    // The mixed case, which is the one that actually happens: the user types
    // while a frame is arriving. live.ts takes the SAME lock on both paths, so
    // the receive's clone-and-commit cannot interleave with a send's in-place
    // mutation of the very objects it cloned.
    const ch = await establishChannel(new Uint8Array(32).fill(11));
    const rng = derivedRandom("mixed");

    const inbound: Uint8Array[] = [];
    for (let i = 0; i < 12; i++) {
      inbound.push(await encrypt(ch.answerer, TE.encode(`from-B ${i}`), rng.at("b", i).bytes(4)));
    }

    // interleave A's own sends with A's receives, all fired concurrently
    const ops: Promise<unknown>[] = [];
    const sent: string[] = [];
    const outbound: Uint8Array[] = [];
    const got: string[] = [];
    for (let i = 0; i < 12; i++) {
      ops.push(decrypt(ch.offerer, inbound[i]).then((r) => {
        if (r.status === "accept") got.push(TD.decode(r.plaintext));
      }));
      const text = `from-A ${i}`;
      sent.push(text);
      ops.push(encrypt(ch.offerer, TE.encode(text), rng.at("a", i).bytes(4))
        .then((w) => { outbound[i] = w; }));
    }
    await withDeadline(Promise.all(ops), "send racing receive");

    assert.deepEqual(got, Array.from({ length: 12 }, (_, i) => `from-B ${i}`),
      "every inbound frame decrypted, in order, despite concurrent sends");

    // A's own stream, produced while A was busy receiving, must still be exactly
    // what B reads back. Deliver it: an earlier version of this test skipped the
    // delivery and asserted only on a 13th frame, which failed for a reason that
    // has nothing to do with locking. A had ratcheted several times while
    // receiving, so B was multiple DH generations behind and could not have
    // followed a lone later frame no matter how well the lock worked. Missing a
    // whole ratchet generation is unrecoverable by construction, so the honest
    // test hands B the stream rather than asking it to leap a gap.
    for (let i = 0; i < outbound.length; i++) {
      const r = await decrypt(ch.answerer, outbound[i]);
      assert.equal(r.status, "accept", `A's frame ${i}, produced under contention, must decrypt`);
      if (r.status === "accept") {
        assert.equal(TD.decode(r.plaintext), sent[i], `A's frame ${i} content survived the interleaving`);
      }
    }
  });

  it("the lock is FIFO, so ordering is a property and not an accident", async () => {
    // A lock that admits in arrival order gives senders their counters in the
    // order they asked. One that does not would still prevent nonce reuse while
    // silently reordering the user's messages.
    const ch = await establishChannel(new Uint8Array(32).fill(13));
    const order: number[] = [];
    await withDeadline(Promise.all(Array.from({ length: 10 }, (_, i) =>
      withPeerLock(ch.offerer, async () => {
        order.push(i);
        // yield inside the critical section: a lock that only works when the
        // body is synchronous is not a lock
        await Promise.resolve();
        await Promise.resolve();
        order.push(i);
      }))), "FIFO admission");

    // each entry must appear twice ADJACENTLY, or a second holder entered the
    // critical section before the first left
    for (let i = 0; i < order.length; i += 2) {
      assert.equal(order[i], order[i + 1],
        `overlapping critical sections at position ${i}: ${order.join(",")}`);
    }
    assert.deepEqual(order.filter((_, i) => i % 2 === 0), [0,1,2,3,4,5,6,7,8,9], "admitted in arrival order");
  });

  it("a thrown operation releases the lock instead of wedging the session", async () => {
    // The `finally` in withRatchetLock is what makes this true. Without it one
    // failed decrypt would deadlock every later ratchet operation, which reads to
    // a user as the app silently freezing rather than as an error.
    const ch = await establishChannel(new Uint8Array(32).fill(17));

    await assert.rejects(
      () => withPeerLock(ch.offerer, async () => { throw new Error("boom"); }),
      /boom/,
    );

    const wire = await encrypt(ch.offerer, TE.encode("still alive"), new Uint8Array(4));
    assert.equal((await decrypt(ch.answerer, wire)).status, "accept",
      "the lock was released despite the throw");
  });

  it("concurrent rejected frames do not corrupt committed state", async () => {
    // Rejections run the full transform on a clone and discard it. Fired
    // concurrently, the clones must not alias each other or the committed state.
    const ch = await establishChannel(new Uint8Array(32).fill(19));
    const rng = derivedRandom("hostile-concurrent");
    const before = fullStateDigest(ch.answerer.state);

    await withDeadline(Promise.all(Array.from({ length: 24 }, (_, i) =>
      decrypt(ch.answerer, rng.at("junk", i).bytes(46 + (i % 40))))), "concurrent rejections");

    assert.equal(fullStateDigest(ch.answerer.state), before,
      "concurrent garbage must leave committed state byte-identical");

    const wire = await encrypt(ch.offerer, TE.encode("after the noise"), rng.stream("tail").bytes(4));
    assert.equal((await decrypt(ch.answerer, wire)).status, "accept",
      "and the session still works");
  });
});
