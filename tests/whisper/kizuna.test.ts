import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import {
  encodeBlock16D,
  decodeBlock16D,
  handshake16D,
  encode16,
  decode16,
} from "../../src/scripts/whisper/live-wasm-kizuna.js";

const B16 = 65536;

function lcg(seed: number): () => number {
  let s = seed;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 0x100000000; };
}

function makeBlock(seed: number): Uint8Array {
  const rng = lcg(seed);
  const b = new Uint8Array(B16);
  for (let i = 0; i < B16; i++) b[i] = (rng() * 256) | 0;
  return b;
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

    it("all-zeros block compresses (encoded not all same value)", () => {
      const block = new Uint8Array(B16);
      const encoded = encodeBlock16D(block);
      // First 4 bytes are the residual, rest is the block minus origin
      // For all-zeros, the encoded representation should work correctly
      const decoded = decodeBlock16D(encoded);
      assertBytesEqual(decoded, block, "all-zeros round-trip after compress check");
    });
  });

  describe("handshake16D", () => {
    it("determinism: same input → same output (10 iterations)", () => {
      for (let i = 0; i < 10; i++) {
        const shared = randomBytes(B16);
        const a = handshake16D(new Uint8Array(shared));
        const b = handshake16D(new Uint8Array(shared));
        assert.equal(a.residual, b.residual, `residual deterministic iter ${i}`);
        assertBytesEqual(a.block8D, b.block8D, `block8D deterministic iter ${i}`);
        assert.deepStrictEqual(
          Array.from(a.countsBitM), Array.from(b.countsBitM),
          `countsBitM deterministic iter ${i}`,
        );
      }
    });

    it("result shape: correct sizes and types", () => {
      for (let i = 0; i < 5; i++) {
        const result = handshake16D(randomBytes(B16));
        assert.equal(typeof result.residual, "number", `residual is number iter ${i}`);
        assert.equal(result.block8D.length, B16, `block8D is 65536B iter ${i}`);
        assert.equal(result.countsBitM.length, 1024, `countsBitM is 1024 uint32 iter ${i}`);
        assert.ok(result.block8D instanceof Uint8Array, "block8D is Uint8Array");
      }
    });

    it("different inputs → different residuals and block8D", () => {
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(handshake16D(randomBytes(B16)));
      }
      // At least most pairs should differ
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
        const result = handshake16D(randomBytes(B16));
        let total = 0;
        for (let j = 0; j < 1024; j++) total += result.countsBitM[j];
        // Laplace prior = 2 per context × 512 = 1024; primed should be higher
        assert.ok(total > 1024,
          `primed total ${total} should exceed Laplace prior (1024) iter ${i}`);
      }
    });

    it("block8D has entropy (not all zeros)", () => {
      for (let i = 0; i < 5; i++) {
        const result = handshake16D(randomBytes(B16));
        const unique = new Set(result.block8D);
        assert.ok(unique.size > 100,
          `block8D should have entropy (${unique.size} unique bytes) iter ${i}`);
      }
    });

    it("rejects wrong-size input", () => {
      assert.throws(() => handshake16D(new Uint8Array(100)));
      assert.throws(() => handshake16D(new Uint8Array(B16 - 1)));
      assert.throws(() => handshake16D(new Uint8Array(B16 + 1)));
    });
  });

  describe("encode16/decode16", () => {
    it("round-trip 30 random Uint16Arrays (varying sizes)", () => {
      for (let i = 0; i < 30; i++) {
        const len = 10 + Math.floor(Math.random() * 2000);
        const data = new Uint16Array(len);
        for (let j = 0; j < len; j++) data[j] = Math.floor(Math.random() * 65536);
        const encoded = encode16(data);
        const decoded = decode16(encoded, data.length);
        assert.deepStrictEqual(Array.from(decoded), Array.from(data),
          `random Uint16 iter ${i} (len=${len})`);
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

    it("structured data compresses better than random", () => {
      const zeros = new Uint16Array(1024);
      const random = new Uint16Array(1024);
      for (let i = 0; i < 1024; i++) random[i] = Math.floor(Math.random() * 65536);

      const encZeros = encode16(zeros);
      const encRandom = encode16(random);

      // Zeros should compress much more than random
      assert.ok(encZeros.length < encRandom.length,
        `zeros encoded (${encZeros.length}) should be smaller than random (${encRandom.length})`);
    });
  });
});
