/**
 * L1 — property + metamorphic tests for the adaptive membrane codec (live-loop).
 *
 * The unit of testing here is the SESSION, not the message. A per-message
 * round-trip can pass for years while a lockstep desync bug ships: encoder and
 * decoder count tables diverge at message i, and everything from i+1 onward
 * silently decodes as garbage. So the workhorse property runs a whole session
 * and asserts, after EVERY message, that the encoder and decoder hold identical
 * model state (loopFingerprint) — which fires at the exact message where the
 * models diverged, long before the corruption becomes visible in the plaintext.
 *
 * Also here: the poisoned-backing-buffer aliasing property (catches the
 * byteOffset-ignored / output-aliases-scratch / mutate-after-handoff class that
 * is invisible to any offset-0 suite), cross-run determinism, and targeted
 * carry/rescale torture inputs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import {
  loopInit,
  loopEncode,
  loopDecode,
  loopFingerprint,
  type LoopState,
} from "../../src/scripts/whisper/live-loop.js";

const B16 = 65536;
const LOOP_RAW_THRESHOLD = 1 * 1024 * 1024;

function freshBlock(seed: number): Uint8Array {
  // deterministic 64KB shared block (not crypto — just reproducible entropy)
  const b = new Uint8Array(B16);
  let s = seed >>> 0;
  for (let i = 0; i < B16; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    b[i] = (s >>> 16) & 0xff;
  }
  return b;
}

/**
 * Frame a loopEncode result the way live.ts does: the >=1MB fast path returns
 * the bare payload with raw=true and NO mode byte, and the caller prepends 0xFF.
 * Every other path already carries its mode byte.
 */
function frame(res: { encoded: Uint8Array; raw: boolean }): Uint8Array {
  if (res.raw) {
    const out = new Uint8Array(1 + res.encoded.length);
    out[0] = 0xff;
    out.set(res.encoded, 1);
    return out;
  }
  return res.encoded;
}

describe("live-loop — L1 property/metamorphic", () => {
  // ── The workhorse: long-session lockstep with per-message digest equality ──

  // payloads straddle the RAW threshold (<5B RAW), mode-selection boundary
  // sizes, and coded sizes, and interleave random / patterned / ascii content
  // so every model path is exercised across a session.
  const payloadArb: fc.Arbitrary<Uint8Array> = fc.oneof(
    { weight: 2, arbitrary: fc.uint8Array({ minLength: 0, maxLength: 4 }) }, // RAW path
    { weight: 3, arbitrary: fc.uint8Array({ minLength: 5, maxLength: 80 }) }, // small coded
    { weight: 3, arbitrary: fc.uint8Array({ minLength: 81, maxLength: 1200 }) }, // medium
    {
      weight: 2, // patterned / low-entropy: exercises the compressing branches
      arbitrary: fc
        .tuple(fc.nat(255), fc.integer({ min: 1, max: 600 }))
        .map(([b, n]) => new Uint8Array(n).fill(b)),
    },
    {
      weight: 2, // ascii-ish text bytes: exercises Bit1/BitX structure models
      arbitrary: fc
        .array(fc.integer({ min: 0x20, max: 0x7e }), { minLength: 1, maxLength: 400 })
        .map((a) => Uint8Array.from(a)),
    },
  );

  it("session lockstep: encoder/decoder models stay bit-identical across a whole session", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }), // shared-block seed
        fc.array(payloadArb, { minLength: 20, maxLength: 120 }),
        (blockSeed, msgs) => {
          const block = freshBlock(blockSeed);
          let enc: LoopState = loopInit(new Uint8Array(block));
          let dec: LoopState = loopInit(new Uint8Array(block));

          // two independently constructed instances — never share/clone one
          assert.equal(loopFingerprint(enc), loopFingerprint(dec), "initial state must match");

          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            const e = loopEncode(enc, msg);
            const framed = frame(e);
            const d = loopDecode(dec, framed, msg.length);

            assertBytesEqual(d.decoded, msg, `payload diverged at msg ${i} (${msg.length}B)`);
            // fires BEFORE payload corruption would ever be visible
            assert.equal(
              loopFingerprint(e.next),
              loopFingerprint(d.next),
              `model desync at msg ${i} (${msg.length}B, mode 0x${framed[0].toString(16)})`,
            );
            enc = e.next;
            dec = d.next;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // ── Poisoned-backing-buffer aliasing (the whole Uint8Array-view bug class) ──

  // wraps a payload inside an oversized backing buffer at a random byteOffset,
  // painting the margins with a 0xAA canary. Catches: (1) view.buffer accessed
  // without byteOffset -> output differs from the offset-0 encode; (2) codec
  // writes outside its lane -> canary trampled; (3) output aliases the caller's
  // buffer -> mutate-after-handoff changes it; (4) output aliases internal
  // scratch -> a second encode clobbers the first result.
  const hostileView = (inner: fc.Arbitrary<Uint8Array>) =>
    fc.tuple(inner, fc.nat(64), fc.nat(64)).map(([payload, pre, post]) => {
      const backing = new Uint8Array(pre + payload.length + post);
      backing.fill(0xaa);
      backing.set(payload, pre);
      return { view: backing.subarray(pre, pre + payload.length), backing, pre, payload };
    });

  it("aliasing: byteOffset views, canaries, mutate-after-handoff, scratch reuse (encode)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        // keep below the 1MB raw fast path (which intentionally returns the input ref)
        hostileView(fc.uint8Array({ minLength: 0, maxLength: 2000 })),
        (blockSeed, { view, backing, pre, payload }) => {
          const state = loopInit(freshBlock(blockSeed));

          const outView = frame(loopEncode(state, view));
          const outClean = frame(loopEncode(state, payload.slice())); // offset-0 fresh copy
          assertBytesEqual(outView, outClean, "byteOffset changed the encoded output");

          // canary lanes intact — encoder never wrote outside the view
          for (let i = 0; i < pre; i++) assert.equal(backing[i], 0xaa, `wrote before view at ${i}`);
          for (let i = pre + payload.length; i < backing.length; i++) {
            assert.equal(backing[i], 0xaa, `wrote after view at ${i}`);
          }

          // output must be a snapshot, not a live view into the caller's buffer
          const frozen = outView.slice();
          backing.fill(0x55);
          assertBytesEqual(outView, frozen, "encoded output aliases the caller's buffer");

          // a second encode must not clobber the first result (internal scratch reuse)
          loopEncode(state, randomBytes(64));
          assertBytesEqual(outView, frozen, "encoded output aliases internal scratch");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("aliasing: decode tolerates wire bytes at a nonzero byteOffset", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.uint8Array({ minLength: 0, maxLength: 2000 }),
        fc.nat(48),
        (blockSeed, payload, pre) => {
          const block = freshBlock(blockSeed);
          const enc = loopInit(new Uint8Array(block));
          const dec = loopInit(new Uint8Array(block));
          const wire = frame(loopEncode(enc, payload));

          // place the wire bytes at a nonzero offset in a larger buffer
          const backing = new Uint8Array(pre + wire.length + 17);
          backing.fill(0xaa);
          backing.set(wire, pre);
          const wireView = backing.subarray(pre, pre + wire.length);

          const { decoded } = loopDecode(dec, wireView, payload.length);
          assertBytesEqual(decoded, payload, "decode from offset view diverged");
        },
      ),
      { numRuns: 150 },
    );
  });

  // ── Cross-run determinism ──

  it("determinism: same block + same messages -> byte-identical wire and final fingerprint", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0x7fffffff }),
        fc.array(payloadArb, { minLength: 5, maxLength: 40 }),
        (blockSeed, msgs) => {
          const block = freshBlock(blockSeed);

          const run = (): { wire: Uint8Array[]; fp: string } => {
            let st = loopInit(new Uint8Array(block));
            const wire: Uint8Array[] = [];
            for (const m of msgs) {
              const e = loopEncode(st, m);
              wire.push(frame(e));
              st = e.next;
            }
            return { wire, fp: loopFingerprint(st) };
          };

          const a = run();
          const b = run();
          assert.equal(a.fp, b.fp, "final fingerprints diverged across identical runs");
          assert.equal(a.wire.length, b.wire.length);
          for (let i = 0; i < a.wire.length; i++) {
            assertBytesEqual(a.wire[i], b.wire[i], `wire bytes diverged at msg ${i}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Targeted carry/rescale torture (deterministic, not property) ──
  // range-coder carry cascades and count-table rescale off-by-ones surface
  // under saturation, which random generation reaches too slowly.

  it("carry/rescale torture: adversarial low/high-entropy runs round-trip in lockstep", () => {
    const cases: Uint8Array[] = [
      new Uint8Array(4096).fill(0x00), // drives range wide toward 0 — carry chains
      new Uint8Array(4096).fill(0xff), // 0xFF pending-byte cascade
      new Uint8Array(4096).fill(0x55),
      Uint8Array.from({ length: 4096 }, (_, i) => (i & 1 ? 0x00 : 0xff)), // renorm boundary
      Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff), // ascending ramp
      Uint8Array.from({ length: 2048 }, (_, i) => (i % 3 === 0 ? 0x41 : i % 3 === 1 ? 0x42 : 0x43)),
      new Uint8Array(0), // empty
      new Uint8Array([0x00]), // single byte
    ];
    // one long session mixing all torture inputs, twice through, plus a regime
    // switch (saturate on zeros, then random) which stresses rescale + carry +
    // learning-rate simultaneously.
    const block = freshBlock(0xc0ffee);
    let enc = loopInit(new Uint8Array(block));
    let dec = loopInit(new Uint8Array(block));
    const session: Uint8Array[] = [
      ...cases,
      new Uint8Array(10000).fill(0), // saturate
      randomBytes(4000), // regime switch to high entropy
      new Uint8Array(2000).fill(0xaa), // switch back
      ...cases,
    ];
    for (let i = 0; i < session.length; i++) {
      const msg = session[i];
      const e = loopEncode(enc, msg);
      const d = loopDecode(dec, frame(e), msg.length);
      assertBytesEqual(d.decoded, msg, `torture msg ${i} (${msg.length}B) round-trip`);
      assert.equal(loopFingerprint(e.next), loopFingerprint(d.next), `torture desync at msg ${i}`);
      enc = e.next;
      dec = d.next;
    }
  });

  // ── Expansion bound: high-entropy input must not blow up (RAW fallback) ──

  it("expansion bound: random payloads never expand beyond mode byte + payload", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x7fffffff }), fc.uint8Array({ minLength: 5, maxLength: 4096 }), (blockSeed, data) => {
        const state = loopInit(freshBlock(blockSeed));
        const { encoded, raw } = loopEncode(state, data);
        if (!raw) {
          // coded/raw-framed output is 1 mode byte + at most the payload length
          assert.ok(
            encoded.length <= data.length + 1,
            `expanded: ${encoded.length} > ${data.length} + 1`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  // ── Large-payload RAW fast path (>=1MB) round-trips via the framing contract ──

  it("large payload (>=1MB) uses raw fast path and round-trips when framed", () => {
    const block = freshBlock(0x5eed);
    const enc = loopInit(new Uint8Array(block));
    const dec = loopInit(new Uint8Array(block));
    const big = randomBytes(LOOP_RAW_THRESHOLD + 1234);
    const e = loopEncode(enc, big);
    assert.equal(e.raw, true, "1MB+ payload should take the raw fast path");
    const d = loopDecode(dec, frame(e), big.length);
    assertBytesEqual(d.decoded, big, "1MB+ payload round-trip");
    assert.equal(loopFingerprint(e.next), loopFingerprint(d.next), "1MB+ model stays in lockstep");
  });
});
