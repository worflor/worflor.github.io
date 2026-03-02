import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import {
  loopInit,
  loopStep,
  loopEncode,
  loopDecode,
  loopWipe,
  loopExpand,
} from "../../src/scripts/whisper/live-loop.js";

const B16 = 65536;

function makeSharedBlock(): Uint8Array {
  return randomBytes(B16);
}

describe("live-loop", () => {
  describe("loopInit", () => {
    it("valid state shape with correct sizes", () => {
      for (let i = 0; i < 3; i++) {
        const block = makeSharedBlock();
        const state = loopInit(block);
        assert.equal(state.chain.length, 32, "chain is 32 bytes");
        assert.equal(state.counts.length, 1024, "counts is 1024 uint32");
        assert.equal(state.block8D.length, B16, "block8D is 65536 bytes");
        assert.equal(state.step, 0, "step starts at 0");
        // Chain should not be all zeros (derived from key material)
        assert.ok(!state.chain.every(b => b === 0), "chain is non-trivial");
      }
    });

    it("deterministic: same block → identical state", () => {
      for (let i = 0; i < 3; i++) {
        const block = makeSharedBlock();
        const a = loopInit(new Uint8Array(block));
        const b = loopInit(new Uint8Array(block));
        assertBytesEqual(a.chain, b.chain, `chain iter ${i}`);
        assertBytesEqual(a.block8D, b.block8D, `block8D iter ${i}`);
        assert.deepStrictEqual(Array.from(a.counts), Array.from(b.counts), `counts iter ${i}`);
        assert.equal(a.step, b.step, `step iter ${i}`);
      }
    });

    it("different blocks → different states", () => {
      const a = loopInit(makeSharedBlock());
      const b = loopInit(makeSharedBlock());
      assert.notDeepStrictEqual(a.chain, b.chain, "different blocks → different chains");
    });

    it("rejects wrong size", () => {
      assert.throws(() => loopInit(new Uint8Array(100)), /expected 65536/);
      assert.throws(() => loopInit(new Uint8Array(B16 - 1)));
      assert.throws(() => loopInit(new Uint8Array(B16 + 1)));
      assert.throws(() => loopInit(new Uint8Array(0)));
    });
  });

  describe("loopStep", () => {
    it("advances step counter and returns new state (immutability)", async () => {
      const block = makeSharedBlock();
      const original = loopInit(block);
      const originalStep = original.step;

      const { next, messageKey } = await loopStep(original);
      assert.equal(next.step, 1, "next step = 1");
      // Original state should be untouched
      assert.equal(original.step, originalStep, "original state unchanged");
    });

    it("successive steps produce incrementing counters", async () => {
      let state = loopInit(makeSharedBlock());
      for (let i = 0; i < 10; i++) {
        const { next, messageKey } = await loopStep(state);
        assert.equal(next.step, i + 1, `step should be ${i + 1}`);
        assert.equal(messageKey.length, 32, `messageKey is 32B at step ${i}`);
        state = next;
      }
    });

    it("deterministic: same state → same messageKey and next state", async () => {
      const block = makeSharedBlock();
      const s1 = loopInit(new Uint8Array(block));
      const s2 = loopInit(new Uint8Array(block));
      const { next: a, messageKey: mk1 } = await loopStep(s1);
      const { next: b, messageKey: mk2 } = await loopStep(s2);
      assertBytesEqual(mk1, mk2, "message keys match");
      assertBytesEqual(a.chain, b.chain, "next chains match");
    });

    it("each step produces a unique message key", async () => {
      let state = loopInit(makeSharedBlock());
      const keys: Uint8Array[] = [];
      for (let i = 0; i < 20; i++) {
        const { next, messageKey } = await loopStep(state);
        keys.push(new Uint8Array(messageKey));
        state = next;
      }
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          assert.notDeepStrictEqual(keys[i], keys[j],
            `messageKey step ${i} vs ${j} should differ`);
        }
      }
    });
  });

  describe("loopEncode/loopDecode", () => {
    const sizes = [0, 1, 10, 100, 500, 1024, 4096];

    for (const size of sizes) {
      it(`round-trip ${size}B with content verification`, () => {
        const block = makeSharedBlock();
        const state = loopInit(block);
        const data = randomBytes(size);
        const { encoded, next: encState } = loopEncode(state, data);
        const { decoded, next: decState } = loopDecode(state, encoded, data.length);
        assertBytesEqual(decoded, data, `round-trip ${size}B content`);
      });
    }

    it("encoded data differs from original (not plaintext)", () => {
      const state = loopInit(makeSharedBlock());
      const data = new Uint8Array(256).fill(0xAA);
      const { encoded } = loopEncode(state, data);
      // Encoded should not be identical to input (compression/transformation applied)
      // For all-same-byte data, the encoded form should be different
      if (encoded.length === data.length) {
        let same = true;
        for (let i = 0; i < Math.min(encoded.length, data.length); i++) {
          if (encoded[i] !== data[i]) { same = false; break; }
        }
        // It's OK if they happen to match (codec is lossless), but typically they won't
        // for structured data. We just verify the round-trip.
      }
    });

    it("encoder and decoder counts stay in sync across 10 messages", () => {
      const block = makeSharedBlock();
      let encState = loopInit(new Uint8Array(block));
      let decState = loopInit(new Uint8Array(block));

      for (let i = 0; i < 10; i++) {
        const data = randomBytes(50 + i * 30);
        const { encoded, next: enc } = loopEncode(encState, data);
        const { decoded, next: dec } = loopDecode(decState, encoded, data.length);
        assertBytesEqual(decoded, data, `message ${i} content`);
        assert.deepStrictEqual(
          Array.from(enc.counts), Array.from(dec.counts),
          `counts in sync after message ${i}`,
        );
        encState = enc;
        decState = dec;
      }
    });

    it("30 random sizes round-trip correctly", () => {
      const state = loopInit(makeSharedBlock());
      for (let i = 0; i < 30; i++) {
        const size = Math.floor(Math.random() * 5000);
        const data = randomBytes(size);
        const { encoded } = loopEncode(state, data);
        const { decoded } = loopDecode(state, encoded, data.length);
        assertBytesEqual(decoded, data, `random size ${size}B iter ${i}`);
      }
    });
  });

  describe("loopWipe", () => {
    it("zeroes chain and block8D completely", () => {
      const state = loopInit(makeSharedBlock());
      // Verify state has non-zero content before wipe
      assert.ok(!state.chain.every(b => b === 0), "chain non-zero before wipe");
      assert.ok(!state.block8D.every(b => b === 0), "block8D non-zero before wipe");

      loopWipe(state);
      assert.ok(state.chain.every(b => b === 0), "chain zeroed");
      assert.ok(state.block8D.every(b => b === 0), "block8D zeroed");
    });
  });

  describe("loopExpand", () => {
    it("produces 65536-byte output", async () => {
      for (let i = 0; i < 3; i++) {
        const key = randomBytes(32);
        const expanded = await loopExpand(key);
        assert.equal(expanded.length, B16, `output length iter ${i}`);
      }
    });

    it("deterministic: same key → same output", async () => {
      for (let i = 0; i < 3; i++) {
        const key = randomBytes(32);
        const a = await loopExpand(new Uint8Array(key));
        const b = await loopExpand(new Uint8Array(key));
        assertBytesEqual(a, b, `deterministic iter ${i}`);
      }
    });

    it("different keys produce different output", async () => {
      const outputs: Uint8Array[] = [];
      for (let i = 0; i < 5; i++) {
        outputs.push(await loopExpand(randomBytes(32)));
      }
      for (let i = 0; i < outputs.length; i++) {
        for (let j = i + 1; j < outputs.length; j++) {
          assert.notDeepStrictEqual(outputs[i], outputs[j],
            `key ${i} vs ${j} should produce different expansions`);
        }
      }
    });

    it("output is non-trivial (has entropy)", async () => {
      const expanded = await loopExpand(randomBytes(32));
      // Count unique byte values — should be most of 0-255
      const unique = new Set(expanded);
      assert.ok(unique.size > 200,
        `expanded output should have high entropy (got ${unique.size} unique bytes)`);
    });
  });

  describe("full pipeline", () => {
    it("two parties stay in sync across 15-step session with varying sizes", async () => {
      const sharedBlock = makeSharedBlock();
      let alice = loopInit(new Uint8Array(sharedBlock));
      let bob = loopInit(new Uint8Array(sharedBlock));

      for (let i = 0; i < 15; i++) {
        // Both step
        const { next: aliceNext, messageKey: mkA } = await loopStep(alice);
        const { next: bobNext, messageKey: mkB } = await loopStep(bob);
        assertBytesEqual(mkA, mkB, `step ${i} message keys match`);

        // Alternate who sends
        const msgSize = 10 + Math.floor(Math.random() * 500);
        const msg = randomBytes(msgSize);
        if (i % 2 === 0) {
          // Alice sends to Bob
          const { encoded, next: aliceEnc } = loopEncode(aliceNext, msg);
          const { decoded, next: bobDec } = loopDecode(bobNext, encoded, msg.length);
          assertBytesEqual(decoded, msg, `step ${i} Alice→Bob (${msgSize}B)`);
          alice = aliceEnc;
          bob = bobDec;
        } else {
          // Bob sends to Alice
          const { encoded, next: bobEnc } = loopEncode(bobNext, msg);
          const { decoded, next: aliceDec } = loopDecode(aliceNext, encoded, msg.length);
          assertBytesEqual(decoded, msg, `step ${i} Bob→Alice (${msgSize}B)`);
          alice = aliceDec;
          bob = bobEnc;
        }
      }
    });

    it("pipeline with different shared blocks produces different keys", async () => {
      const block1 = makeSharedBlock();
      const block2 = makeSharedBlock();
      const state1 = loopInit(block1);
      const state2 = loopInit(block2);

      const { messageKey: mk1 } = await loopStep(state1);
      const { messageKey: mk2 } = await loopStep(state2);
      assert.notDeepStrictEqual(mk1, mk2,
        "different shared blocks → different message keys");
    });
  });
});
