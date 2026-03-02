import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import {
  encode0DArith,
  decode0DArith,
  encode0DBit,
  decode0DBit,
  encode0DBitO1,
  decode0DBitO1,
  encode0DBitM,
  decode0DBitM,
  encode0D,
  decode0D,
} from "../../src/scripts/whisper/live-wasm-logos.js";

const TE = new TextEncoder();

function makeData(kind: string, size: number): Uint8Array {
  switch (kind) {
    case "zeros": return new Uint8Array(size);
    case "constant": return new Uint8Array(size).fill(0xAB);
    case "random": return randomBytes(size);
    case "text": return TE.encode("Hello, World! ".repeat(Math.ceil(size / 14)).slice(0, size));
    case "pattern": {
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) buf[i] = i & 0xFF;
      return buf;
    }
    case "single": return new Uint8Array([0x42]);
    case "empty": return new Uint8Array(0);
    case "biased": {
      // Low-entropy data biased toward 0x00
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) buf[i] = Math.random() < 0.9 ? 0 : Math.floor(Math.random() * 256);
      return buf;
    }
    case "utf8-jp": return TE.encode("あいうえおかきくけこ".repeat(Math.ceil(size / 30)).slice(0, size));
    default: return randomBytes(size);
  }
}

describe("live-wasm-logos", () => {
  const codecs: Array<{
    name: string;
    encode: (d: Uint8Array) => Uint8Array;
    decode: (d: Uint8Array, len: number) => Uint8Array;
  }> = [
    { name: "Arith", encode: encode0DArith, decode: decode0DArith },
    { name: "Bit0", encode: encode0DBit, decode: decode0DBit },
    { name: "BitO1", encode: encode0DBitO1, decode: decode0DBitO1 },
    { name: "BitM", encode: encode0DBitM, decode: decode0DBitM },
  ];

  const distributions = [
    { kind: "zeros", size: 1024 },
    { kind: "constant", size: 512 },
    { kind: "random", size: 1024 },
    { kind: "text", size: 500 },
    { kind: "pattern", size: 256 },
    { kind: "single", size: 1 },
    { kind: "biased", size: 1024 },
  ];

  for (const { name, encode, decode } of codecs) {
    describe(`${name} round-trip`, () => {
      for (const { kind, size } of distributions) {
        it(`${kind} (${size}B)`, () => {
          const data = makeData(kind, size);
          const encoded = encode(data);
          const decoded = decode(encoded, data.length);
          assertBytesEqual(decoded, data, `${name} ${kind}`);
        });
      }

      it("empty input", () => {
        const data = new Uint8Array(0);
        const encoded = encode(data);
        const decoded = decode(encoded, 0);
        assert.equal(decoded.length, 0);
      });

      it("20 random sizes (1-2000B) with random data", () => {
        for (let i = 0; i < 20; i++) {
          const size = 1 + Math.floor(Math.random() * 2000);
          const data = randomBytes(size);
          const encoded = encode(data);
          const decoded = decode(encoded, data.length);
          assertBytesEqual(decoded, data, `${name} random ${size}B iter ${i}`);
        }
      });

      it("4KB structured data", () => {
        const data = makeData("text", 4096);
        const encoded = encode(data);
        const decoded = decode(encoded, data.length);
        assertBytesEqual(decoded, data, `${name} 4KB text`);
      });
    });
  }

  describe("adaptive encode0D/decode0D", () => {
    for (const { kind, size } of distributions) {
      it(`${kind} (${size}B) round-trip`, () => {
        const data = makeData(kind, size);
        const encoded = encode0D(data);
        const decoded = decode0D(encoded, data.length);
        assertBytesEqual(decoded, data, `adaptive ${kind}`);
      });
    }

    it("empty input", () => {
      const encoded = encode0D(new Uint8Array(0));
      const decoded = decode0D(encoded, 0);
      assert.equal(decoded.length, 0);
    });

    it("never expands beyond raw + 1 byte (50 random trials)", () => {
      for (let trial = 0; trial < 50; trial++) {
        const size = 1 + Math.floor(Math.random() * 2000);
        const data = randomBytes(size);
        const encoded = encode0D(data);
        assert.ok(
          encoded.length <= data.length + 1,
          `trial ${trial}: encoded ${encoded.length} > raw+1 ${data.length + 1} (size=${size})`,
        );
      }
    });

    it("mode byte is valid (0x00=Rice, 0x01=Bit0, 0x02=BitO1, 0x03=BitM, 0xFF=raw)", () => {
      const validModes = new Set([0x00, 0x01, 0x02, 0x03, 0xFF]);
      for (let i = 0; i < 30; i++) {
        const size = 10 + Math.floor(Math.random() * 1000);
        const data = randomBytes(size);
        const encoded = encode0D(data);
        assert.ok(encoded.length >= 1, "encoded must have at least mode byte");
        assert.ok(validModes.has(encoded[0]),
          `mode byte 0x${encoded[0].toString(16)} should be one of Rice/Bit0/BitO1/BitM/raw`);
      }
    });

    it("all-zeros compresses to <10%", () => {
      const data = new Uint8Array(4096);
      const encoded = encode0D(data);
      const ratio = encoded.length / data.length;
      assert.ok(ratio < 0.1,
        `all-zeros ratio ${(ratio * 100).toFixed(1)}% should be <10% (${encoded.length}/${data.length})`);
    });

    it("constant-value data compresses well", () => {
      const data = new Uint8Array(4096).fill(0xAB);
      const encoded = encode0D(data);
      const ratio = encoded.length / data.length;
      assert.ok(ratio < 0.15,
        `constant ratio ${(ratio * 100).toFixed(1)}% should be <15%`);
    });

    it("random data uses raw fallback (mode=0xFF) and doesn't expand", () => {
      for (let i = 0; i < 10; i++) {
        const data = randomBytes(1024);
        const encoded = encode0D(data);
        assert.equal(encoded[0], 0xFF, `random data should use raw fallback (mode=0xFF) iter ${i}`);
        assert.equal(encoded.length, data.length + 1, "raw = data + 1 mode byte");
      }
    });

    it("UTF-8 Japanese text compresses (ratio < 80%)", () => {
      const data = TE.encode("あいうえおかきくけこさしすせそ".repeat(100));
      const encoded = encode0D(data);
      const decoded = decode0D(encoded, data.length);
      assertBytesEqual(decoded, data, "Japanese round-trip");
      const ratio = encoded.length / data.length;
      assert.ok(ratio < 0.8,
        `Japanese ratio ${(ratio * 100).toFixed(1)}% should be <80%`);
    });

    it("English text compresses (ratio < 70%)", () => {
      const data = TE.encode("The quick brown fox jumps over the lazy dog. ".repeat(100));
      const encoded = encode0D(data);
      const decoded = decode0D(encoded, data.length);
      assertBytesEqual(decoded, data, "English round-trip");
      const ratio = encoded.length / data.length;
      assert.ok(ratio < 0.7,
        `English ratio ${(ratio * 100).toFixed(1)}% should be <70%`);
    });

    it("biased data compresses significantly", () => {
      const data = makeData("biased", 4096);
      const encoded = encode0D(data);
      const decoded = decode0D(encoded, data.length);
      assertBytesEqual(decoded, data, "biased round-trip");
      const ratio = encoded.length / data.length;
      assert.ok(ratio < 0.3,
        `biased ratio ${(ratio * 100).toFixed(1)}% should be <30%`);
    });
  });

  describe("larger data round-trips", () => {
    it("4KB random", () => {
      const data = randomBytes(4096);
      const encoded = encode0D(data);
      const decoded = decode0D(encoded, data.length);
      assertBytesEqual(decoded, data);
    });

    it("8KB pattern", () => {
      const data = makeData("pattern", 8192);
      const encoded = encode0D(data);
      const decoded = decode0D(encoded, data.length);
      assertBytesEqual(decoded, data);
    });

    it("16KB text", () => {
      const data = TE.encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(300));
      const encoded = encode0D(data);
      const decoded = decode0D(encoded, data.length);
      assertBytesEqual(decoded, data);
    });

    it("30 random trials at various sizes (1B-8KB)", () => {
      for (let i = 0; i < 30; i++) {
        const size = 1 + Math.floor(Math.random() * 8192);
        const data = randomBytes(size);
        const encoded = encode0D(data);
        const decoded = decode0D(encoded, data.length);
        assertBytesEqual(decoded, data, `random trial ${i} (${size}B)`);
      }
    });
  });
});
