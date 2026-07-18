/**
 * braid-commutativity.test.ts
 *
 * Mathematical cornerstone proof for the upcoming n-party protocol ("braid").
 *
 * the braid needs every seat to converge on the same model state regardless of
 * which order messages are integrated in (network delivery order is not
 * guaranteed across N>2 parties). this file proves the two properties that
 * make that possible, using only the exported surface of live-loop.ts:
 *
 *   1. delta purity — a message's count-delta (elementwise increment on
 *      countsBitM / countsBit1 / countsBitX) is the same whether the message
 *      is integrated via loopTrain, loopEncode, or loopDecode. counts only
 *      ever increment, so the delta is a pure function of the plaintext.
 *
 *   2. commutativity — integrating the same set of messages in any order
 *      yields identical final counts, and therefore an identical modelDigest.
 *
 * plus a digest-sensitivity check (dropping, altering, or duplicating a
 * message must change the digest) and a base-state-independence check (a
 * message's delta does not depend on which counts it is applied against).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { makeDeterministicRng, randomBytes, generateTestData } from "./_helpers/generators.js";
import {
  loopInit,
  loopEncode,
  loopDecode,
  loopTrain,
  modelDigest,
} from "../../src/scripts/whisper/live-loop.js";
import type { LoopState, ModelCounts } from "../../src/scripts/whisper/live-loop.js";

const B16 = 65536;

// mirrors LOOP_RAW_THRESHOLD / LOOP_TRAIN_LIMIT in live-loop.ts. not exported —
// these tests pin the exact numeric boundary as part of the proof, so the
// constants are restated here deliberately rather than imported.
const RAW_THRESHOLD = 1 * 1024 * 1024; // 1 MB
const TRAIN_LIMIT   = 64 * 1024;       // 64 KB

// --- generic helpers ---

function cloneCounts(c: ModelCounts): ModelCounts {
  return {
    countsBitM: c.countsBitM.slice(),
    countsBit1: c.countsBit1.slice(),
    countsBitX: c.countsBitX.slice(),
  };
}

// bare accumulator shaped like a LoopState, for calling loopEncode/loopDecode
// against a plain ModelCounts. the chain is never read by either function
// except to be sliced into `next.chain`, so a zero chain is harmless here.
function makeState(counts: ModelCounts): LoopState {
  return {
    chain: new Uint8Array(32),
    countsBitM: counts.countsBitM,
    countsBit1: counts.countsBit1,
    countsBitX: counts.countsBitX,
    step: 0,
  };
}

function cloneState(s: LoopState): LoopState {
  return {
    chain: s.chain.slice(),
    countsBitM: s.countsBitM.slice(),
    countsBit1: s.countsBit1.slice(),
    countsBitX: s.countsBitX.slice(),
    step: s.step,
  };
}

function countsDelta(before: Uint32Array, after: Uint32Array): number[] {
  const out = new Array(before.length);
  for (let i = 0; i < before.length; i++) out[i] = after[i] - before[i];
  return out;
}

interface Delta { M: number[]; C1: number[]; X: number[]; }

function modelDelta(before: ModelCounts, after: ModelCounts): Delta {
  return {
    M:  countsDelta(before.countsBitM, after.countsBitM),
    C1: countsDelta(before.countsBit1, after.countsBit1),
    X:  countsDelta(before.countsBitX, after.countsBitX),
  };
}

function assertDeltasEqual(a: Delta, b: Delta, label: string): void {
  assert.deepStrictEqual(a.M,  b.M,  `${label}: countsBitM delta mismatch`);
  assert.deepStrictEqual(a.C1, b.C1, `${label}: countsBit1 delta mismatch`);
  assert.deepStrictEqual(a.X,  b.X,  `${label}: countsBitX delta mismatch`);
}

function assertCountsEqual(a: ModelCounts, b: ModelCounts, label: string): void {
  assert.deepStrictEqual(Array.from(a.countsBitM), Array.from(b.countsBitM), `${label}: countsBitM mismatch`);
  assert.deepStrictEqual(Array.from(a.countsBit1), Array.from(b.countsBit1), `${label}: countsBit1 mismatch`);
  assert.deepStrictEqual(Array.from(a.countsBitX), Array.from(b.countsBitX), `${label}: countsBitX mismatch`);
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// frame an encoded payload the way a caller must: loopEncode's raw===true
// path returns the plaintext bare (zero-copy) and expects the caller to
// prepend the RAW mode byte; raw===false already includes its mode byte.
function frameEncoded(encoded: Uint8Array, raw: boolean): Uint8Array {
  return raw ? concatBytes(Uint8Array.of(0xFF), encoded) : encoded;
}

// Fisher-Yates using a deterministic rng, so permutations are reproducible.
function shuffled(indices: number[], rng: () => number): number[] {
  const out = indices.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

// eight assorted messages, deterministic sizes (7..3000B) cycling through
// random / ascii-text / constant-byte content. content bytes may come from
// crypto randomness — only the sizes and the later permutations need to be
// reproducible for the commutativity checks to be meaningful.
function buildMessageSet(): Uint8Array[] {
  const rng = makeDeterministicRng(0xB4A1D001);
  const styles: Array<(n: number) => Uint8Array> = [
    (n) => randomBytes(n),
    (n) => generateTestData(n, "text"),
    (n) => new Uint8Array(n).fill(0xAA),
  ];
  const messages: Uint8Array[] = [];
  for (let i = 0; i < 8; i++) {
    const size = 7 + Math.floor(rng() * (3000 - 7));
    messages.push(styles[i % styles.length](size));
  }
  return messages;
}

describe("braid commutativity", () => {
  describe("delta purity", () => {
    const sizes = [0, 1, 4, 5, 17, 100, 1000, 4096];
    const payloadStyles: Array<[string, (n: number) => Uint8Array]> = [
      ["random",        (n) => randomBytes(n)],
      ["ascii text",    (n) => generateTestData(n, "text")],
      ["constant 0xAA", (n) => new Uint8Array(n).fill(0xAA)],
    ];

    it("delta purity: train, encode, and decode paths produce identical deltas", () => {
      const sharedBlock = randomBytes(B16);
      const base = loopInit(sharedBlock);
      const baseCounts = cloneCounts(base);

      for (const [styleName, build] of payloadStyles) {
        for (const size of sizes) {
          const data = build(size);
          const label = `${styleName} ${size}B`;

          // path a: loopTrain on a bare cloned accumulator.
          const trainCounts = cloneCounts(baseCounts);
          loopTrain(trainCounts, data);
          const trainDelta = modelDelta(baseCounts, trainCounts);

          // path b: loopEncode, compare returned `next` counts vs the input counts.
          const encState = cloneState(base);
          const { encoded, raw, next: encNext } = loopEncode(encState, data);
          const encodeDelta = modelDelta(baseCounts, encNext);
          assertDeltasEqual(trainDelta, encodeDelta, `${label}: train vs encode`);

          // path c: loopDecode on an identical clone, fed the encoder's output.
          const decState = cloneState(base);
          const framed = frameEncoded(encoded, raw);
          const { decoded, next: decNext } = loopDecode(decState, framed, data.length);
          assertBytesEqual(decoded, data, `${label}: decode round-trip`);
          const decodeDelta = modelDelta(baseCounts, decNext);
          assertDeltasEqual(trainDelta, decodeDelta, `${label}: train vs decode`);
        }
      }
    });

    it("delta purity holds at the RAW threshold (1MB prefix rule)", () => {
      const sharedBlock = randomBytes(B16);
      const base = loopInit(sharedBlock);
      const baseCounts = cloneCounts(base);

      // exactly at the threshold: structured prefix + random fill, deterministic length.
      const atThreshold = concatBytes(
        generateTestData(TRAIN_LIMIT, "text"),
        randomBytes(RAW_THRESHOLD - TRAIN_LIMIT),
      );
      assert.equal(atThreshold.length, RAW_THRESHOLD, "sanity: payload is exactly 1MB");

      // train path: loopTrain internally slices to the 64KB prefix for large payloads.
      const trainCounts = cloneCounts(baseCounts);
      loopTrain(trainCounts, atThreshold);
      const trainDelta = modelDelta(baseCounts, trainCounts);

      // encode path: must take the RAW fast path (no trial-encode) at this size.
      const encState = cloneState(base);
      const { encoded, raw, next: encNext } = loopEncode(encState, atThreshold);
      assert.equal(raw, true, "1MB payload must hit the RAW fast path");
      const encodeDelta = modelDelta(baseCounts, encNext);
      assertDeltasEqual(trainDelta, encodeDelta, "1MB: train vs encode");

      // decode path: raw===true means the caller frames with 0xFF.
      const decState = cloneState(base);
      const framed = frameEncoded(encoded, raw);
      const { decoded, next: decNext } = loopDecode(decState, framed, atThreshold.length);
      assertBytesEqual(decoded, atThreshold, "1MB payload round-trips through the RAW frame");
      const decodeDelta = modelDelta(baseCounts, decNext);
      assertDeltasEqual(trainDelta, decodeDelta, "1MB: train vs decode");
    });

    it("delta purity holds just below the RAW threshold (full training, single expensive check)", () => {
      const sharedBlock = randomBytes(B16);
      const base = loopInit(sharedBlock);
      const baseCounts = cloneCounts(base);

      const size = RAW_THRESHOLD - 1;
      const belowThreshold = concatBytes(
        generateTestData(TRAIN_LIMIT, "text"),
        randomBytes(size - TRAIN_LIMIT),
      );
      assert.equal(belowThreshold.length, size, "sanity: payload is 1 byte short of the RAW threshold");

      // train path: below threshold, loopTrain trains on the FULL payload.
      const trainCounts = cloneCounts(baseCounts);
      loopTrain(trainCounts, belowThreshold);
      const trainDelta = modelDelta(baseCounts, trainCounts);

      // encode path: below threshold means a real trial-encode with all three
      // models over ~1MB of data — this is the expensive branch, run once.
      const encState = cloneState(base);
      const { encoded, raw, next: encNext } = loopEncode(encState, belowThreshold);
      assert.equal(raw, false, "just-below-threshold payload must trial-encode, not take the RAW fast path");
      const encodeDelta = modelDelta(baseCounts, encNext);
      assertDeltasEqual(trainDelta, encodeDelta, "just-below-threshold: train vs encode");

      // decode path: raw===false means `encoded` already carries its own mode byte.
      const decState = cloneState(base);
      const { decoded, next: decNext } = loopDecode(decState, encoded, belowThreshold.length);
      assertBytesEqual(decoded, belowThreshold, "just-below-threshold payload round-trips");
      const decodeDelta = modelDelta(baseCounts, decNext);
      assertDeltasEqual(trainDelta, decodeDelta, "just-below-threshold: train vs decode");
    });
  });

  describe("integration order commutativity", () => {
    it("a set of messages yields identical counts and digest in any integration order", async () => {
      const sharedBlock = randomBytes(B16);
      const base = loopInit(sharedBlock);
      const baseCounts = cloneCounts(base);
      const messages = buildMessageSet();
      const indices = messages.map((_, i) => i);

      const orders: number[][] = [
        indices,                    // identity
        indices.slice().reverse(),  // reverse
      ];
      for (let seed = 0; seed < 10; seed++) {
        orders.push(shuffled(indices, makeDeterministicRng(0xC0FFEE00 + seed)));
      }

      const finalsByOrder = orders.map((order) => {
        const counts = cloneCounts(baseCounts);
        for (const idx of order) loopTrain(counts, messages[idx]);
        return counts;
      });

      for (let i = 1; i < finalsByOrder.length; i++) {
        assertCountsEqual(finalsByOrder[0], finalsByOrder[i], `order 0 vs order ${i}`);
      }

      const digests = await Promise.all(finalsByOrder.map((c) => modelDigest(c)));
      for (let i = 1; i < digests.length; i++) {
        assertBytesEqual(digests[0], digests[i], `digest: order 0 vs order ${i}`);
      }
    });

    it("mixed integration paths commute", async () => {
      const sharedBlock = randomBytes(B16);
      const base = loopInit(sharedBlock);
      const baseCounts = cloneCounts(base);
      const messages = buildMessageSet();
      const indices = messages.map((_, i) => i);

      const orderA = indices;                                            // encode-chain and encode/decode-chain
      const orderB = shuffled(indices, makeDeterministicRng(0x5EED1234)); // loopTrain, a DIFFERENT permutation

      // approach 1: loopEncode path, chaining state.next through orderA.
      let encChainState = makeState(cloneCounts(baseCounts));
      for (const idx of orderA) {
        const { next } = loopEncode(encChainState, messages[idx]);
        encChainState = next;
      }
      const encChainFinal: ModelCounts = cloneCounts(encChainState);

      // approach 2: loopTrain on a bare cloned accumulator, orderB.
      const trainFinal = cloneCounts(baseCounts);
      for (const idx of orderB) loopTrain(trainFinal, messages[idx]);

      // approach 3: paired encode/decode chain, SAME order as approach 1 (orderA) —
      // the decoder state must track the encoder state step by step, or the
      // ciphertext framing (mode byte, context tables) won't decode correctly.
      let encForDecState = makeState(cloneCounts(baseCounts));
      let decChainState  = makeState(cloneCounts(baseCounts));
      for (const idx of orderA) {
        const msg = messages[idx];
        const { encoded, raw, next: encNext } = loopEncode(encForDecState, msg);
        const framed = frameEncoded(encoded, raw);
        const { decoded, next: decNext } = loopDecode(decChainState, framed, msg.length);
        assertBytesEqual(decoded, msg, `encode/decode chain round-trip, message index ${idx}`);
        encForDecState = encNext;
        decChainState  = decNext;
      }
      const decChainFinal: ModelCounts = cloneCounts(decChainState);

      assertCountsEqual(encChainFinal, trainFinal, "encode-chain (orderA) vs train (orderB)");
      assertCountsEqual(decChainFinal, trainFinal, "decode-chain (orderA) vs train (orderB)");
      assertCountsEqual(encChainFinal, decChainFinal, "encode-chain vs decode-chain (both orderA)");

      const [dEnc, dTrain, dDec] = await Promise.all([
        modelDigest(encChainFinal),
        modelDigest(trainFinal),
        modelDigest(decChainFinal),
      ]);
      assertBytesEqual(dEnc, dTrain, "digest: encode-chain vs train");
      assertBytesEqual(dDec, dTrain, "digest: decode-chain vs train");
    });
  });

  describe("digest sensitivity", () => {
    it("dropping one message from the set changes the digest", async () => {
      const sharedBlock = randomBytes(B16);
      const base = loopInit(sharedBlock);
      const baseCounts = cloneCounts(base);
      const messages = buildMessageSet();

      const fullCounts = cloneCounts(baseCounts);
      for (const m of messages) loopTrain(fullCounts, m);
      const fullDigest = await modelDigest(fullCounts);

      const droppedCounts = cloneCounts(baseCounts);
      for (let i = 0; i < messages.length; i++) {
        if (i === 3) continue; // drop one message
        loopTrain(droppedCounts, messages[i]);
      }
      const droppedDigest = await modelDigest(droppedCounts);

      assert.notDeepStrictEqual(droppedDigest, fullDigest, "dropping a message must change the digest");
    });

    it("flipping one byte in one message changes the digest", async () => {
      const sharedBlock = randomBytes(B16);
      const base = loopInit(sharedBlock);
      const baseCounts = cloneCounts(base);
      const messages = buildMessageSet();

      const fullCounts = cloneCounts(baseCounts);
      for (const m of messages) loopTrain(fullCounts, m);
      const fullDigest = await modelDigest(fullCounts);

      const alteredMessages = messages.map((m) => m.slice());
      alteredMessages[3][0] ^= 0xFF;
      const alteredCounts = cloneCounts(baseCounts);
      for (const m of alteredMessages) loopTrain(alteredCounts, m);
      const alteredDigest = await modelDigest(alteredCounts);

      assert.notDeepStrictEqual(alteredDigest, fullDigest, "flipping one byte must change the digest");
    });

    it("integrating a message twice changes the digest", async () => {
      const sharedBlock = randomBytes(B16);
      const base = loopInit(sharedBlock);
      const baseCounts = cloneCounts(base);
      const messages = buildMessageSet();

      const fullCounts = cloneCounts(baseCounts);
      for (const m of messages) loopTrain(fullCounts, m);
      const fullDigest = await modelDigest(fullCounts);

      const dupedCounts = cloneCounts(baseCounts);
      for (const m of messages) loopTrain(dupedCounts, m);
      loopTrain(dupedCounts, messages[3]); // integrate one message a second time
      const dupedDigest = await modelDigest(dupedCounts);

      assert.notDeepStrictEqual(dupedDigest, fullDigest, "duplicating a message must change the digest");
    });
  });

  describe("base-state independence", () => {
    it("deltas are insensitive to base state", () => {
      const stateA = loopInit(randomBytes(B16));
      const stateB = loopInit(randomBytes(B16));
      assert.notDeepStrictEqual(stateA.countsBitM, stateB.countsBitM, "sanity: different blocks give different base counts");

      const cases: Array<[string, Uint8Array]> = [
        ["random 500B",        randomBytes(500)],
        ["ascii text 800B",    generateTestData(800, "text")],
        ["constant 0xAA 250B", new Uint8Array(250).fill(0xAA)],
      ];

      for (const [label, payload] of cases) {
        const beforeA = cloneCounts(stateA);
        const afterA  = cloneCounts(stateA);
        loopTrain(afterA, payload);
        const deltaA = modelDelta(beforeA, afterA);

        const beforeB = cloneCounts(stateB);
        const afterB  = cloneCounts(stateB);
        loopTrain(afterB, payload);
        const deltaB = modelDelta(beforeB, afterB);

        assertDeltasEqual(deltaA, deltaB, `delta(${label}) must be identical regardless of base state`);
      }
    });
  });
});
