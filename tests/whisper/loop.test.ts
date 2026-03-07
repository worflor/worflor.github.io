import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { makeDeterministicRng, randomBytes } from "./_helpers/generators.js";
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
        assert.equal(state.countsBitM.length, 1024, "countsBitM is 1024 uint32");
        assert.equal(state.countsBit1.length, 8192, "countsBit1 is 8192 uint32");
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
        assert.deepStrictEqual(Array.from(a.countsBitM), Array.from(b.countsBitM), `countsBitM iter ${i}`);
        assert.deepStrictEqual(Array.from(a.countsBit1), Array.from(b.countsBit1), `countsBit1 iter ${i}`);
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

      const { next } = await loopStep(original);
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
        const { encoded } = loopEncode(state, data);
        const { decoded } = loopDecode(state, encoded, data.length);
        assertBytesEqual(decoded, data, `round-trip ${size}B content`);
      });
    }

    it("constant-byte data compresses significantly", () => {
      const state = loopInit(makeSharedBlock());
      const data = new Uint8Array(256).fill(0xAA);
      const { encoded } = loopEncode(state, data);
      // 256 identical bytes = near-zero entropy after Laplace prior converges.
      // encoded includes 1 mode byte + compressed payload.
      assert.ok(encoded.length < data.length,
        `constant data should compress (${encoded.length} >= ${data.length})`);
      // mode byte should be BitM or Bit1, not RAW
      assert.notEqual(encoded[0], 0xFF, "constant data should not fall back to RAW");
    });

    it("tiny messages (< 5B) use RAW mode", () => {
      const state = loopInit(makeSharedBlock());
      for (const size of [0, 1, 2, 3, 4]) {
        const data = randomBytes(size);
        const { encoded } = loopEncode(state, data);
        assert.equal(encoded[0], 0xFF, `${size}B should be RAW mode`);
        assert.equal(encoded.length, 1 + size, `RAW output = 1 mode + ${size} data`);
      }
    });

    it("rejects unknown mode byte", () => {
      const state = loopInit(makeSharedBlock());
      // craft a fake encoded blob with mode 0x01 (removed Bit0)
      const fakeEncoded = new Uint8Array([0x01, 0, 0, 0, 0]);
      assert.throws(
        () => loopDecode(state, fakeEncoded, 4),
        /unknown mode 0x1/,
      );
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
          Array.from(enc.countsBitM), Array.from(dec.countsBitM),
          `countsBitM in sync after message ${i}`,
        );
        assert.deepStrictEqual(
          Array.from(enc.countsBit1), Array.from(dec.countsBit1),
          `countsBit1 in sync after message ${i}`,
        );
        encState = enc;
        decState = dec;
      }
    });

    it("30 random sizes round-trip correctly with accumulating state", () => {
      const block = makeSharedBlock();
      let encState = loopInit(new Uint8Array(block));
      let decState = loopInit(new Uint8Array(block));
      const rng = makeDeterministicRng(0x51E5A11);
      for (let i = 0; i < 30; i++) {
        const size = (rng() * 5000) | 0;
        const data = randomBytes(size);
        const { encoded, next: encNext } = loopEncode(encState, data);
        const { decoded, next: decNext } = loopDecode(decState, encoded, data.length);
        assertBytesEqual(decoded, data, `random size ${size}B iter ${i}`);
        encState = encNext;
        decState = decNext;
      }
    });
  });

  describe("loopWipe", () => {
    it("zeroes chain and all count arrays completely", () => {
      const state = loopInit(makeSharedBlock());
      // Verify state has non-zero content before wipe
      assert.ok(!state.chain.every(b => b === 0), "chain non-zero before wipe");
      assert.ok(!state.countsBitM.every(v => v === 0), "countsBitM non-zero before wipe");
      assert.ok(!state.countsBit1.every(v => v === 0), "countsBit1 non-zero before wipe");

      loopWipe(state);
      assert.ok(state.chain.every(b => b === 0), "chain zeroed");
      assert.ok(state.countsBitM.every(v => v === 0), "countsBitM zeroed");
      assert.ok(state.countsBit1.every(v => v === 0), "countsBit1 zeroed");
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
      const rng = makeDeterministicRng(0xD00D1234);

      for (let i = 0; i < 15; i++) {
        // Both step
        const { next: aliceNext, messageKey: mkA } = await loopStep(alice);
        const { next: bobNext, messageKey: mkB } = await loopStep(bob);
        assertBytesEqual(mkA, mkB, `step ${i} message keys match`);

        // Alternate who sends
        const msgSize = 10 + ((rng() * 500) | 0);
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

    it("desync detection: different shared blocks produce different message keys", async () => {
      const blockA = makeSharedBlock();
      const blockB = makeSharedBlock();

      const stateA = loopInit(blockA);
      const stateB = loopInit(blockB);

      // The security-critical keying is in loopStep (message keys), not loopEncode (compression)
      const { messageKey: mkA } = await loopStep(stateA);
      const { messageKey: mkB } = await loopStep(stateB);

      assert.notDeepStrictEqual(mkA, mkB,
        "different shared blocks must produce different message keys");

      // After multiple steps, keys should continue to diverge
      let sA = stateA;
      let sB = stateB;
      for (let i = 0; i < 5; i++) {
        const a = await loopStep(sA);
        const b = await loopStep(sB);
        sA = a.next;
        sB = b.next;
        assert.notDeepStrictEqual(a.messageKey, b.messageKey,
          `step ${i + 1}: keys must differ with different shared blocks`);
      }
    });

    it("desync detection: skipped loopStep produces different message keys", async () => {
      const block = makeSharedBlock();
      const stateSync = loopInit(new Uint8Array(block));
      const stateSkip = loopInit(new Uint8Array(block));

      // Both do step 0
      const { next: syncNext, messageKey: mkSync0 } = await loopStep(stateSync);
      const { next: skipNext0, messageKey: mkSkip0 } = await loopStep(stateSkip);
      assertBytesEqual(mkSync0, mkSkip0, "step 0 should match");

      // Sync does step 1, skip does step 1 AND step 2 (skipping ahead)
      const { next: syncNext1, messageKey: mkSync1 } = await loopStep(syncNext);
      const { next: skipNext1 } = await loopStep(skipNext0);
      const { messageKey: mkSkip2 } = await loopStep(skipNext1);

      // sync step 1 key ≠ skip step 2 key (different chain positions)
      assert.notDeepStrictEqual(mkSync1, mkSkip2,
        "different chain positions must produce different keys");
    });
  });
});
