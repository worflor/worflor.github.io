import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { deterministicUint16Array, makeDeterministicRng, randomBytes } from "./_helpers/generators.js";
import {
  encodeBlock16D,
  decodeBlock16D,
  handshake16D,
  factored16D,
  encode16,
  decode16,
} from "../../src/scripts/whisper/live-wasm-kizuna.js";

const B16 = 65536;

const PARITY16 = new Uint8Array(B16);
for (let mask = 1; mask < B16; mask++) PARITY16[mask] = PARITY16[mask >> 1] ^ (mask & 1);

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 0x100000000;
  };
}

function makeBlock(seed: number): Uint8Array {
  const rng = lcg(seed);
  const out = new Uint8Array(B16);
  for (let i = 0; i < B16; i++) out[i] = (rng() * 256) | 0;
  return out;
}

function predAntiAtMask(block: Uint8Array, mask: number): number {
  let pred = 0;
  for (let subset = 1; subset < B16; subset++) {
    pred += PARITY16[subset] ? block[mask | subset] : -block[mask | subset];
  }
  return pred;
}

function residualAtOrigin(block: Uint8Array): number {
  return (block[0] - Math.round(predAntiAtMask(block, 0))) | 0;
}

function whtAllOnes(block: Uint8Array): number {
  let w = 0;
  for (let mask = 0; mask < B16; mask++) w += PARITY16[mask] ? -block[mask] : block[mask];
  return w;
}

describe("live-wasm-kizuna", () => {
  describe("encodeBlock16D/decodeBlock16D", () => {
    it("round-trip 50 LCG-seeded random blocks", () => {
      for (let seed = 0; seed < 50; seed++) {
        const block = makeBlock(seed * 7 + 13);
        const encoded = encodeBlock16D(block);
        const decoded = decodeBlock16D(encoded);
        assertBytesEqual(decoded, block, `LCG seed=${seed * 7 + 13}`);
      }
    });

    it("round-trip 20 crypto-random blocks", () => {
      for (let i = 0; i < 20; i++) {
        const block = randomBytes(B16);
        const encoded = encodeBlock16D(block);
        const decoded = decodeBlock16D(encoded);
        assertBytesEqual(decoded, block, `crypto-random iter ${i}`);
      }
    });

    it("round-trip all-zeros block", () => {
      const block = new Uint8Array(B16);
      const encoded = encodeBlock16D(block);
      const decoded = decodeBlock16D(encoded);
      assertBytesEqual(decoded, block, "all-zeros");
    });

    it("round-trip all-0xFF block", () => {
      const block = new Uint8Array(B16).fill(0xFF);
      const encoded = encodeBlock16D(block);
      const decoded = decodeBlock16D(encoded);
      assertBytesEqual(decoded, block, "all-0xFF");
    });

    it("round-trip ascending pattern block", () => {
      const block = new Uint8Array(B16);
      for (let i = 0; i < B16; i++) block[i] = i & 0xFF;
      const encoded = encodeBlock16D(block);
      const decoded = decodeBlock16D(encoded);
      assertBytesEqual(decoded, block, "ascending pattern");
    });

    it("round-trip single-value blocks (0x00-0xFF boundary)", () => {
      for (const val of [0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF]) {
        const block = new Uint8Array(B16).fill(val);
        const encoded = encodeBlock16D(block);
        const decoded = decodeBlock16D(encoded);
        assertBytesEqual(decoded, block, `constant value 0x${val.toString(16)}`);
      }
    });

    it("rejects wrong-size input", () => {
      assert.throws(() => encodeBlock16D(new Uint8Array(100)));
      assert.throws(() => encodeBlock16D(new Uint8Array(B16 - 1)));
      assert.throws(() => encodeBlock16D(new Uint8Array(B16 + 1)));
      assert.throws(() => decodeBlock16D(new Uint8Array(100)));
    });

    it("encoded size is 4 + 65535 bytes", () => {
      for (let i = 0; i < 5; i++) {
        const block = randomBytes(B16);
        const encoded = encodeBlock16D(block);
        assert.equal(encoded.length, 4 + B16 - 1,
          `encoded size iter ${i}: expected ${4 + B16 - 1}, got ${encoded.length}`);
      }
    });

    it("all-zeros encodes to zero residual + zero boundary payload", () => {
      const block = new Uint8Array(B16);
      const encoded = encodeBlock16D(block);

      const residual = encoded[0] | (encoded[1] << 8) | (encoded[2] << 16) | (encoded[3] << 24);
      assert.equal(residual, 0, "origin residual should be zero");
      for (let i = 4; i < encoded.length; i++) {
        assert.equal(encoded[i], 0, `boundary payload byte ${i - 4} should be zero`);
      }

      const decoded = decodeBlock16D(encoded);
      assertBytesEqual(decoded, block, "all-zeros round-trip");
    });

    it("decoder clamps corrupted residual to [0,255]", () => {
      const block = makeBlock(0xC0FFEE42);
      const encoded = encodeBlock16D(block);
      const corrupt = new Uint8Array(encoded);

      const high = 200_000;
      corrupt[0] = high & 0xff;
      corrupt[1] = (high >>> 8) & 0xff;
      corrupt[2] = (high >>> 16) & 0xff;
      corrupt[3] = (high >>> 24) & 0xff;
      const hi = decodeBlock16D(corrupt);
      assert.ok(hi[0] >= 0 && hi[0] <= 255, "high residual must clamp to byte range");

      const low = (-200_000) >>> 0;
      corrupt[0] = low & 0xff;
      corrupt[1] = (low >>> 8) & 0xff;
      corrupt[2] = (low >>> 16) & 0xff;
      corrupt[3] = (low >>> 24) & 0xff;
      const lo = decodeBlock16D(corrupt);
      assert.ok(lo[0] >= 0 && lo[0] <= 255, "low residual must clamp to byte range");
    });
  });

  describe("16D math invariants", () => {
    it("origin residual equals WHT all-ones coefficient", () => {
      for (const seed of [1, 42, 0xDEAD, 0xF00D, 0xBEEF, 0x7777]) {
        const block = makeBlock(seed);
        assert.equal(residualAtOrigin(block), whtAllOnes(block), `WHT identity failed for seed ${seed}`);
      }
    });

    it("boundary theorem: non-origin masks have zero residual", () => {
      const rng = makeDeterministicRng(0xB0ABCDEF);
      for (let trial = 0; trial < 3; trial++) {
        const block = makeBlock(0xDEAD0000 + trial);
        for (let i = 0; i < 20; i++) {
          const mask = Math.max(1, (rng() * B16) | 0);
          const residual = block[mask] - Math.round(predAntiAtMask(block, mask));
          assert.equal(residual, 0, `boundary residual mismatch at mask=0x${mask.toString(16)}`);
        }
      }
    });
  });

  describe("handshake16D", () => {
    it("determinism: same input -> same output (10 iterations)", () => {
      for (let i = 0; i < 10; i++) {
        const shared = randomBytes(B16);
        const a = handshake16D(new Uint8Array(shared));
        const b = handshake16D(new Uint8Array(shared));
        assert.equal(a.residual, b.residual, `residual deterministic iter ${i}`);
        assert.deepStrictEqual(
          Array.from(a.rowWitnesses8D), Array.from(b.rowWitnesses8D),
          `rowWitnesses8D deterministic iter ${i}`,
        );
        assert.deepStrictEqual(
          Array.from(a.countsBitM), Array.from(b.countsBitM),
          `countsBitM deterministic iter ${i}`,
        );
      }
    });

    it("result shape: correct sizes and types", () => {
      for (let i = 0; i < 5; i++) {
        const result = handshake16D(makeBlock(0x1000 + i));
        assert.equal(typeof result.residual, "number", `residual is number iter ${i}`);
        assert.equal(result.rowWitnesses8D.length, 256, `rowWitnesses8D is 256 entries iter ${i}`);
        assert.equal(result.countsBitM.length, 1024, `countsBitM is 1024 uint32 iter ${i}`);
        assert.ok(result.rowWitnesses8D instanceof Int32Array, "rowWitnesses8D is Int32Array");
      }
    });

    it("different inputs -> different residuals and rowWitnesses8D", () => {
      const results = [];
      for (let i = 0; i < 10; i++) results.push(handshake16D(makeBlock(0x6000 + i)));

      let residualDiffs = 0;
      for (let i = 0; i < results.length; i++) {
        for (let j = i + 1; j < results.length; j++) {
          if (results[i].residual !== results[j].residual) residualDiffs++;
        }
      }

      const totalPairs = (results.length * (results.length - 1)) / 2;
      assert.ok(residualDiffs > totalPairs * 0.8,
        `${residualDiffs}/${totalPairs} residual pairs differ (expected >80%)`);
    });

    it("countsBitM is primed above Laplace prior", () => {
      for (let i = 0; i < 5; i++) {
        const result = handshake16D(makeBlock(0x4000 + i));
        let total = 0;
        for (let j = 0; j < 1024; j++) total += result.countsBitM[j];
        assert.ok(total > 1024, `primed total ${total} should exceed Laplace prior (1024) iter ${i}`);
      }
    });

    it("rowWitnesses8D are non-trivial for random data", () => {
      for (let i = 0; i < 5; i++) {
        const result = handshake16D(makeBlock(0x5000 + i));
        let nonZero = 0;
        for (let h = 0; h < 256; h++) if (result.rowWitnesses8D[h] !== 0) nonZero++;
        assert.ok(nonZero > 200, `sub-witnesses should be non-trivial (${nonZero}/256 non-zero) iter ${i}`);
      }
    });

    it("factored16D residual = direct residual", () => {
      for (let i = 0; i < 8; i++) {
        const block = makeBlock(0x7000 + i);
        const directR = residualAtOrigin(block);
        const { residual: factoredR } = factored16D(block);
        assert.equal(factoredR, directR, `factored vs direct mismatch at seed ${0x7000 + i}`);
      }
    });

    it("single-byte corruption changes exactly one sub-witness", () => {
      const block = makeBlock(0xF00DCAFE);
      const { rowWitnesses: orig } = factored16D(block);
      for (const targetRow of [0, 3, 127, 255]) {
        const corrupted = block.slice();
        corrupted[targetRow * 256 + 17] ^= 0x42;
        const { rowWitnesses: corr } = factored16D(corrupted);
        let changed = 0;
        for (let h = 0; h < 256; h++) if (orig[h] !== corr[h]) changed++;
        assert.equal(changed, 1, `corruption in row ${targetRow}: exactly 1 sub-witness should change`);
      }
    });

    it("rejects wrong-size input", () => {
      assert.throws(() => handshake16D(new Uint8Array(100)));
      assert.throws(() => handshake16D(new Uint8Array(B16 - 1)));
      assert.throws(() => handshake16D(new Uint8Array(B16 + 1)));
    });
  });

  describe("encode16/decode16", () => {
    it("round-trip empty Uint16Array", () => {
      const data = new Uint16Array(0);
      const encoded = encode16(data);
      const decoded = decode16(encoded, data.length);
      assert.equal(decoded.length, 0);
    });

    it("round-trip 30 deterministic pseudo-random Uint16Arrays (varying sizes)", () => {
      const rng = makeDeterministicRng(0xC0DEC0DE);
      for (let i = 0; i < 30; i++) {
        const len = 10 + ((rng() * 2000) | 0);
        const data = deterministicUint16Array(len, 0x1000 + i);
        const encoded = encode16(data);
        const decoded = decode16(encoded, data.length);
        assert.deepStrictEqual(Array.from(decoded), Array.from(data),
          `deterministic Uint16 iter ${i} (len=${len})`);
      }
    });

    it("round-trip all-zeros", () => {
      const data = new Uint16Array(256);
      const encoded = encode16(data);
      const decoded = decode16(encoded, data.length);
      assert.deepStrictEqual(Array.from(decoded), Array.from(data), "all-zeros");
    });

    it("round-trip constant value", () => {
      const data = new Uint16Array(1024).fill(12345);
      const encoded = encode16(data);
      const decoded = decode16(encoded, data.length);
      assert.deepStrictEqual(Array.from(decoded), Array.from(data), "constant 12345");
    });

    it("round-trip monotonic ramp", () => {
      const data = new Uint16Array(1024);
      for (let i = 0; i < 1024; i++) data[i] = i & 0xFFFF;
      const encoded = encode16(data);
      const decoded = decode16(encoded, data.length);
      assert.deepStrictEqual(Array.from(decoded), Array.from(data), "ramp");
    });

    it("round-trip alternating extremes", () => {
      const data = new Uint16Array(512);
      for (let i = 0; i < 512; i++) data[i] = (i & 1) ? 65535 : 0;
      const encoded = encode16(data);
      const decoded = decode16(encoded, data.length);
      assert.deepStrictEqual(Array.from(decoded), Array.from(data), "alternating");
    });

    it("round-trip boundary values", () => {
      const data = new Uint16Array([0, 1, 255, 256, 32767, 32768, 65534, 65535]);
      const encoded = encode16(data);
      const decoded = decode16(encoded, data.length);
      assert.deepStrictEqual(Array.from(decoded), Array.from(data), "boundary values");
    });

    it("round-trip single element", () => {
      for (const val of [0, 1, 32768, 65535]) {
        const data = new Uint16Array([val]);
        const encoded = encode16(data);
        const decoded = decode16(encoded, data.length);
        assert.deepStrictEqual(Array.from(decoded), Array.from(data), `single ${val}`);
      }
    });

    it("structured data compresses better than pseudo-random", () => {
      const zeros = new Uint16Array(1024);
      const randomish = deterministicUint16Array(1024, 0x12345678);

      const encZeros = encode16(zeros);
      const encRandom = encode16(randomish);

      assert.ok(encZeros.length < encRandom.length,
        `zeros encoded (${encZeros.length}) should be smaller than random (${encRandom.length})`);
    });
  });
});
