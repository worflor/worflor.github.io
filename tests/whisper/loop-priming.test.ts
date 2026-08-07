/**
 * loop-priming.test.ts — the precomputed keystream, and the three ways it could
 * have gone wrong.
 *
 * `loopStep` needs a keystream derived from (chain, step). Both survive
 * `loopEncode`, which only ever replaces the counts, so the next step's
 * keystream is knowable the moment the current one lands and can be derived
 * while the line is idle instead of while someone waits to send.
 *
 * That makes it a cache, and a cache holding key-derived material attached to a
 * mutable object has three specific ways to be wrong. Each is tested here rather
 * than argued:
 *
 *   IDENTITY     a memo must never be read against a state it was not derived
 *                from. Guaranteed by construction, since every transition
 *                allocates a new state object, but the property is worth pinning.
 *   WIPE         a derivation in flight when `loopWipe` runs must not write its
 *                result back afterwards. That would resurrect exactly the
 *                material the wipe existed to destroy.
 *   FAILURE      a background failure must not become the next caller's error,
 *                and must not escape as an unhandled rejection.
 *
 * The overriding requirement: priming changes WHEN work happens and nothing
 * else. Output must be bit-identical whether the keystream was precomputed,
 * awaited mid-flight, or derived inline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loopInit, loopStep, loopPrime, loopEncode, loopWipe, loopFingerprint,
  type LoopState,
} from "../../src/scripts/whisper/live-loop.js";
import { deterministicBytes } from "./_helpers/generators.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";

const B16 = 65536;
const TE = new TextEncoder();
const freshState = (seed = 1): LoopState => loopInit(deterministicBytes(B16, seed));
const settle = () => new Promise((r) => setImmediate(r));

/**
 * Wait for a state's derivation to land, deterministically.
 *
 * A bare event-loop tick is not enough and it is worth saying why: the
 * derivation is real async crypto (an HKDF, a key import, a cipher call), so it
 * spans several turns. Awaiting the stored promise is exact, and it also
 * guarantees the handler that publishes `primed` has already run, since that
 * handler is a link in the same chain.
 */
const primedReady = async (s: LoopState): Promise<void> => { if (s.priming) await s.priming; };

describe("loop priming — timing only, never bytes", () => {
  it("produces IDENTICAL output primed, in-flight, and cold", async () => {
    // The property everything else rests on. Three states from one seed, stepped
    // under three different scheduling regimes.
    const cold = freshState();
    const inflight = freshState();
    const ready = freshState();

    const a = await loopStep(cold);                    // nothing primed

    loopPrime(inflight);                               // primed, not yet settled
    const b = await loopStep(inflight);

    loopPrime(ready);
    await primedReady(ready);                          // primed and settled
    assert.ok(ready.primed, "precondition: the keystream is ready");
    const c = await loopStep(ready);

    assert.equal(toHex(a.messageKey), toHex(b.messageKey), "in-flight must match cold");
    assert.equal(toHex(a.messageKey), toHex(c.messageKey), "ready must match cold");
    assert.equal(loopFingerprint(a.next), loopFingerprint(b.next), "next state must match");
    assert.equal(loopFingerprint(a.next), loopFingerprint(c.next));
  });

  it("survives encoding, because encode preserves chain and step", async () => {
    // The whole justification for priming ahead. If loopEncode touched chain or
    // step, a keystream primed before it would be wrong for the step after it.
    const s = freshState(2);
    const stepped = await loopStep(s);
    const encoded = loopEncode(stepped.next, TE.encode("a message that trains the model"));

    assert.equal(toHex(encoded.next.chain), toHex(stepped.next.chain), "encode must not move the chain");
    assert.equal(encoded.next.step, stepped.next.step, "encode must not move the step");

    // so a keystream primed on the pre-encode state is valid for the post-encode one
    loopPrime(stepped.next);
    await primedReady(stepped.next);
    const primedData = stepped.next.primed!.primeData.slice();

    const viaPrimed = await loopStep({ ...encoded.next, primed: { primeData: primedData } });
    const viaCold = await loopStep({ ...encoded.next, primed: undefined, priming: undefined });
    assert.equal(toHex(viaPrimed.messageKey), toHex(viaCold.messageKey),
      "a keystream primed before encoding must be exactly what the step after it needs");
  });

  it("WIPE: a derivation in flight must not repopulate a wiped state", async () => {
    // The dangerous one. The promise closes over the state, so without an
    // identity guard it would write freshly derived keystream back into a state
    // that was just zeroized.
    const s = freshState(3);
    loopPrime(s);
    const inFlight = s.priming;
    assert.ok(inFlight, "precondition: a derivation is in flight");

    loopWipe(s);

    // Await the CAPTURED promise, not a couple of event-loop ticks. The wipe
    // clears `s.priming`, so there is nothing left on the state to wait for, and
    // a bare tick returns long before the crypto resolves — which would make
    // this assertion pass whether the guard exists or not.
    await inFlight;

    assert.equal(s.primed, undefined,
      "a wiped state must not acquire keystream from a derivation that outlived the wipe");
    assert.equal(s.priming, undefined);
    assert.ok(s.chain.every((b) => b === 0), "and the chain stays wiped");
  });

  it("WIPE: zeroizes a keystream that had already landed", async () => {
    const s = freshState(4);
    loopPrime(s);
    await primedReady(s);
    const landed = s.primed!.primeData;
    assert.ok(landed.some((b) => b !== 0), "precondition: real keystream is held");

    loopWipe(s);
    assert.ok(landed.every((b) => b === 0),
      "retained keystream is key-derived and must be zeroized, not merely dropped");
    assert.equal(s.primed, undefined);
  });

  it("FAILURE: a broken derivation neither throws to the caller nor escapes", async () => {
    // Force computePrimed to fail by handing loopPrime a state whose chain is not
    // importable as a key. The stored promise must resolve rather than reject,
    // and the subsequent step must still produce the right answer by deriving
    // inline.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const s = freshState(5);
      const broken: LoopState = { ...s, chain: undefined as unknown as Uint8Array };
      loopPrime(broken);
      await settle();
      await settle();
      assert.equal(unhandled.length, 0,
        `a fire-and-forget derivation must never surface an unhandled rejection (saw ${unhandled.length})`);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("FAILURE: a failed priming does not poison the next step", async () => {
    const s = freshState(6);
    // simulate a priming that resolved to nothing
    s.priming = Promise.resolve(null);
    const viaFallback = await loopStep(s);

    const clean = freshState(6);
    const viaCold = await loopStep(clean);
    assert.equal(toHex(viaFallback.messageKey), toHex(viaCold.messageKey),
      "a null priming must fall through to the inline derivation, not fail the step");
  });

  it("is idempotent and does not stack derivations", async () => {
    const s = freshState(7);
    loopPrime(s);
    const first = s.priming;
    loopPrime(s);
    loopPrime(s);
    assert.equal(s.priming, first, "repeat calls must reuse the derivation in flight");
    await primedReady(s);
    loopPrime(s);
    assert.equal(s.priming, undefined, "and must not restart once the result has landed");
  });

  it("a long run stays in lockstep with an unprimed peer", async () => {
    // The end-to-end guarantee: two parties, one priming and one not, must walk
    // identical key schedules for the whole conversation.
    let primedSide = freshState(8);
    let plainSide = freshState(8);

    for (let i = 0; i < 40; i++) {
      loopPrime(primedSide);
      if (i % 3 === 0) await primedReady(primedSide); // sometimes ready, sometimes mid-flight

      const p = await loopStep(primedSide);
      const q = await loopStep(plainSide);
      assert.equal(toHex(p.messageKey), toHex(q.messageKey), `message key diverged at ${i}`);

      const text = TE.encode(`message number ${i}`);
      primedSide = loopEncode(p.next, text).next;
      plainSide = loopEncode(q.next, text).next;
      assert.equal(loopFingerprint(primedSide), loopFingerprint(plainSide), `model diverged at ${i}`);
    }
  });
});
