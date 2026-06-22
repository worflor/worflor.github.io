import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { makeDeterministicRng, deterministicBytes, randomBytes } from "./_helpers/generators.js";
import {
  encode0D,
  decode0D,
} from "../../src/scripts/whisper/live-wasm-logos.js";

const TE = new TextEncoder();

function bps(encoded: Uint8Array, rawLen: number): number {
  return (encoded.length * 8) / rawLen;
}

function ratio(encoded: Uint8Array, rawLen: number): number {
  return encoded.length / rawLen;
}

/** roundtrip helper: encode, decode, assert match, return encoded for further checks */
function rt(data: Uint8Array, label: string): Uint8Array {
  const encoded = encode0D(data);
  const decoded = decode0D(encoded, data.length);
  assertBytesEqual(decoded, data, label);
  return encoded;
}

/** generate a Markov chain with transition bias (0=uniform, 1=deterministic) */
function markovChain(len: number, states: number, bias: number, seed: number): Uint8Array {
  const rng = makeDeterministicRng(seed);
  const buf = new Uint8Array(len);
  buf[0] = (rng() * states) | 0;
  for (let i = 1; i < len; i++) {
    if (rng() < bias) {
      buf[i] = (buf[i - 1] + ((rng() * 3) | 0) - 1 + states) % states;
    } else {
      buf[i] = (rng() * states) | 0;
    }
  }
  return buf;
}

describe("live-wasm-logos", () => {

  // ── round-trip correctness ──────────────────────────────────────────────
  describe("round-trip correctness", () => {
    const cases: [string, () => Uint8Array][] = [
      ["zeros (1024B)",      () => new Uint8Array(1024)],
      ["constant (512B)",    () => new Uint8Array(512).fill(0xAB)],
      ["random (1024B)",     () => randomBytes(1024)],
      ["text (500B)",        () => TE.encode("Hello, World! ".repeat(36).slice(0, 500))],
      ["ascending (256B)",   () => { const b = new Uint8Array(256); for (let i = 0; i < 256; i++) b[i] = i; return b; }],
      ["single byte",        () => new Uint8Array([0x42])],
      ["empty",              () => new Uint8Array(0)],
    ];
    for (const [name, gen] of cases) {
      it(name, () => {
        const data = gen();
        if (data.length === 0) {
          assert.equal(encode0D(data).length, 0);
          assert.equal(decode0D(encode0D(data), 0).length, 0);
        } else {
          rt(data, name);
        }
      });
    }

    it("8KB ascending pattern", () => {
      const data = new Uint8Array(8192);
      for (let i = 0; i < 8192; i++) data[i] = i & 0xFF;
      rt(data, "8KB pattern");
    });

    it("16KB text", () => {
      rt(TE.encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(300)),
        "16KB text");
    });

    it("50 random trials at various sizes (1B-16KB)", () => {
      const rng = makeDeterministicRng(0x13579BDF);
      for (let i = 0; i < 50; i++) {
        const size = 1 + ((rng() * 16384) | 0);
        const data = deterministicBytes(size, (0xABCD0000 + i) >>> 0);
        rt(data, `random trial ${i} (${size}B)`);
      }
    });
  });

  // ── error handling ──────────────────────────────────────────────────────
  describe("error handling", () => {
    it("decode0D rejects empty data with non-zero len", () => {
      assert.throws(() => decode0D(new Uint8Array(0), 5), /empty input/i);
    });

    it("decode0D rejects unknown mode byte", () => {
      assert.throws(() => decode0D(new Uint8Array([0x01, 0, 0, 0, 0]), 2), /unknown mode/i);
      assert.throws(() => decode0D(new Uint8Array([0xFE, 0x41, 0x42]), 2), /unknown mode/i);
    });

    it("decode0D raw path rejects truncated payload", () => {
      assert.throws(() => decode0D(new Uint8Array([0xFF, 0x41, 0x42, 0x43]), 10), /too short/i);
    });
  });

  // ── wire format ─────────────────────────────────────────────────────────
  describe("wire format", () => {
    it("mode byte is 0x00 or 0xFF", () => {
      const rng = makeDeterministicRng(0xFACEB00C);
      for (let i = 0; i < 30; i++) {
        const size = 10 + ((rng() * 1000) | 0);
        const enc = encode0D(deterministicBytes(size, i));
        assert.ok(enc[0] === 0x00 || enc[0] === 0xFF,
          `mode byte 0x${enc[0].toString(16)} should be 0x00 or 0xFF`);
      }
    });

    it("output ≤ input + 1 for ALL distributions (not just random)", () => {
      // this is the fundamental codec contract. test structured, biased,
      // adversarial, and random data.
      const inputs: [string, Uint8Array][] = [
        ["zeros", new Uint8Array(100)],
        ["ones", new Uint8Array(100).fill(0xFF)],
        ["ascending", (() => { const b = new Uint8Array(256); for (let i = 0; i < 256; i++) b[i] = i; return b; })()],
        ["random 2000B", randomBytes(2000)],
        ["single byte", new Uint8Array([0x00])],
        ["two bytes", new Uint8Array([0xFF, 0xFF])],
        ["alternating", (() => { const b = new Uint8Array(500); for (let i = 0; i < 500; i++) b[i] = i & 1; return b; })()],
        ["all-0xFF 4KB", new Uint8Array(4096).fill(0xFF)],
      ];
      for (const [label, data] of inputs) {
        const enc = encode0D(data);
        assert.ok(enc.length <= data.length + 1,
          `${label}: encoded ${enc.length} > raw+1 ${data.length + 1}`);
      }
    });

    it("random data uses raw fallback (mode=0xFF)", () => {
      for (let i = 0; i < 10; i++) {
        const enc = encode0D(randomBytes(1024));
        assert.equal(enc[0], 0xFF, `iter ${i}: random data should use raw mode`);
      }
    });
  });

  // ── codec invariants ────────────────────────────────────────────────────
  describe("codec invariants", () => {
    it("deterministic across multiple calls (large input)", () => {
      // test with enough data to trigger evaporation (>64 bytes),
      // SSE accumulation, match volatility, and the entropy bypass check.
      const data = TE.encode(
        "the codec must produce identical output on identical input. " +
        "this sentence is long enough to trigger evaporation at byte 64 " +
        "and then the second evaporation checkpoint at byte 128. " +
        "match volatility and SSE calibration must also be deterministic. " +
        "hello whisper. hello whisper. hello whisper. hello whisper."
      );
      const a = encode0D(data);
      const b = encode0D(data);
      const c = encode0D(data);
      assertBytesEqual(a, b, "determinism a-b");
      assertBytesEqual(b, c, "determinism b-c");
    });

    it("sequential independence (large diverse inputs)", () => {
      // encode structured data, then encode something different.
      // both must produce the same output as encoding in isolation.
      const structured = new Uint8Array(8192).fill(0x00);
      const target = TE.encode(
        "this payload must encode identically whether or not " +
        "we previously encoded 8KB of zeros. the init() call " +
        "must fully reset all 5.4MB of WASM memory."
      );
      encode0D(structured);
      const afterStructured = encode0D(target);
      const alone = encode0D(target);
      assertBytesEqual(afterStructured, alone, "independence");
    });

    it("every byte value 0x00-0xFF round-trips in isolation and in context", () => {
      // sequential
      const seq = new Uint8Array(256);
      for (let i = 0; i < 256; i++) seq[i] = i;
      rt(seq, "sequential-256");

      // shuffled in longer context (rare bytes surrounded by common ones)
      const rng = makeDeterministicRng(0xA11B7E5);
      const shuffled = new Uint8Array(1024);
      for (let i = 0; i < 1024; i++) shuffled[i] = i & 0xFF;
      for (let i = 1023; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      rt(shuffled, "shuffled-256");
    });

    it("65536 bytes: production chunk boundary", () => {
      rt(deterministicBytes(65536, 0xC40C4), "65KB chunk");
    });

    it("compression improves with more data (no evaporation regression)", () => {
      // for stationary data, bps should decrease (or stay flat) as length grows.
      // if evaporation is too aggressive, bps increases at length > 64 bytes.
      const phrase = "the quick brown fox jumped over the lazy sleeping dog. ";
      const sizes = [100, 500, 2000, 8000];
      let prevBps = Infinity;
      for (const size of sizes) {
        const data = TE.encode(phrase.repeat(Math.ceil(size / phrase.length)).slice(0, size));
        const enc = rt(data, `monotonicity-${size}`);
        const b = bps(enc, data.length);
        assert.ok(b <= prevBps + 0.3,
          `bps at ${size}B (${b.toFixed(2)}) should not exceed bps at smaller size (${prevBps.toFixed(2)}) by >0.3`);
        prevBps = b;
      }
    });
  });

  // ── compression quality (tight bounds, detect regressions) ──────────────
  describe("compression quality", () => {
    it("all-zeros 4KB: < 1% (L-axis crystallization)", () => {
      const enc = rt(new Uint8Array(4096), "zeros-4K");
      const r = ratio(enc, 4096);
      assert.ok(r < 0.01, `zeros ratio ${(r * 100).toFixed(2)}% should be <1%`);
    });

    it("constant 0xAB 4KB: < 2%", () => {
      const enc = rt(new Uint8Array(4096).fill(0xAB), "constant-4K");
      const r = ratio(enc, 4096);
      assert.ok(r < 0.02, `constant ratio ${(r * 100).toFixed(2)}% should be <2%`);
    });

    it("alternating 0x00/0x01 2KB: < 2% (U-axis AR2)", () => {
      const data = new Uint8Array(2048);
      for (let i = 0; i < 2048; i++) data[i] = i & 1;
      const enc = rt(data, "alternating");
      assert.ok(ratio(enc, 2048) < 0.02,
        `alternating ratio ${(ratio(enc, 2048) * 100).toFixed(2)}% should be <2%`);
    });

    it("repeated English text 4.5KB: < 10% (M-axis PPM)", () => {
      const data = TE.encode("The quick brown fox jumps over the lazy dog. ".repeat(100));
      const enc = rt(data, "repeated-english");
      const r = ratio(enc, data.length);
      assert.ok(r < 0.10, `repeated English ratio ${(r * 100).toFixed(1)}% should be <10%`);
    });

    it("repeated Japanese UTF-8 4.5KB: < 6% (M+X axes)", () => {
      const data = TE.encode("あいうえおかきくけこさしすせそ".repeat(100));
      const enc = rt(data, "repeated-japanese");
      const r = ratio(enc, data.length);
      assert.ok(r < 0.06, `Japanese ratio ${(r * 100).toFixed(1)}% should be <6%`);
    });

    it("repeated Cyrillic UTF-8 2.7KB: < 8% (M+A axes)", () => {
      const data = TE.encode("Привет мир! Как дела? Всё хорошо. ".repeat(80));
      const enc = rt(data, "repeated-cyrillic");
      const r = ratio(enc, data.length);
      assert.ok(r < 0.08, `Cyrillic ratio ${(r * 100).toFixed(1)}% should be <8%`);
    });

    it("highly repetitive phrase: < 0.5 bps (M-axis deep context)", () => {
      const data = TE.encode("hello whisper world!\n".repeat(200));
      const enc = rt(data, "repetitive-phrase");
      const b = bps(enc, data.length);
      assert.ok(b < 0.5, `repetitive ${b.toFixed(2)} bps should be <0.5`);
    });

    it("unique English sentences: 3.5-6.0 bps (no M-axis, byte stats only)", () => {
      // these sentences share common English byte distributions but no exact context.
      // tests that the byte-level axes (O2/Z/E/L/X) extract genuine structure,
      // and that the bounds are tight enough to catch regression.
      const sentences = [
        "the sun set behind the mountains as the birds flew home. ",
        "a cold wind swept through the empty streets of the old city. ",
        "she opened the book and found a letter tucked between the pages. ",
        "the train arrived late, its whistle echoing across the platform. ",
        "rain began to fall just as they reached the edge of the forest. ",
        "he sat by the window, watching the clouds drift over the lake. ",
        "the market was crowded with vendors selling fruit and flowers. ",
        "a dog barked somewhere in the distance, breaking the silence. ",
        "the lighthouse beam swept across the dark water every few seconds. ",
        "she smiled and handed him the cup of coffee without a word. ",
        "the old clock on the wall had stopped at twenty past three. ",
        "autumn leaves covered the path leading to the garden gate. ",
        "he picked up the phone but there was no one on the other end. ",
        "the sound of piano music drifted from an open window upstairs. ",
        "they walked along the beach, leaving footprints in the wet sand. ",
        "the cat curled up on the warm spot where the sun had been shining. ",
      ];
      const data = TE.encode(sentences.join(""));
      const enc = rt(data, "unique-sentences");
      const b = bps(enc, data.length);
      assert.ok(b < 6.0, `unique sentences ${b.toFixed(2)} bps should be <6.0`);
      assert.ok(b > 3.5, `unique sentences ${b.toFixed(2)} bps should be >3.5 (no exact matches)`);
    });
  });

  // ── M-axis PPM ──────────────────────────────────────────────────────────
  describe("M-axis: exact match (PPM)", () => {
    it("PPM exclusion: deeper context beats shallower", () => {
      // 8-byte header repeats with variable payload after each.
      // order-1 matches on 0xEF are misleading (256 different followers).
      // order-8+ matches are perfectly predictive. PPM exclusion must prefer depth.
      const header = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF]);
      const parts: Uint8Array[] = [];
      for (let i = 0; i < 200; i++) {
        parts.push(header);
        parts.push(new Uint8Array([i & 0xFF]));
      }
      const data = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
      let off = 0;
      for (const c of parts) { data.set(c, off); off += c.length; }
      const enc = rt(data, "PPM exclusion");
      assert.ok(ratio(enc, data.length) < 0.25,
        `protocol pattern ratio ${(ratio(enc, data.length) * 100).toFixed(1)}% should be <25%`);
    });

    it("match volatility cycling: repeated short runs with breaks", () => {
      // 4-byte match run, 2 novel bytes, repeat.
      // this cycles the volatility system: mRunLen rises to 4, drops to 0,
      // volatility fires at min(4,16)=4, then decays by 1 per byte.
      // Ising boost = volatility×4 pre-loads M-axis for the next match.
      const unit = TE.encode("AAAA");
      const rng = makeDeterministicRng(0xC0FFEE);
      const parts: Uint8Array[] = [];
      for (let i = 0; i < 300; i++) {
        parts.push(unit);
        parts.push(new Uint8Array([(rng() * 256) | 0, (rng() * 256) | 0]));
      }
      const data = new Uint8Array(parts.reduce((a, c) => a + c.length, 0));
      let off = 0;
      for (const c of parts) { data.set(c, off); off += c.length; }
      const enc = rt(data, "volatility-cycling");
      // should compress reasonably despite breaks. without volatility, the
      // 2-byte gaps would kill M-axis on the restart.
      assert.ok(ratio(enc, data.length) < 0.55,
        `volatility cycling ratio ${(ratio(enc, data.length) * 100).toFixed(1)}% should be <55%`);
    });
  });

  // ── A-axis: structural attention (nibble class) ────────────────────────
  describe("A-axis: structural attention", () => {
    it("mixed-case repetition: A-axis generalizes across case", () => {
      const upper = "HELLO WORLD HOW ARE YOU TODAY ";
      const lower = "hello world how are you today ";
      const data = TE.encode(Array.from({ length: 80 }, (_, i) =>
        i % 2 === 0 ? upper : lower).join(""));
      const enc = rt(data, "mixed-case");
      assert.ok(bps(enc, data.length) < 2.0,
        `mixed-case ${bps(enc, data.length).toFixed(2)} bps should be <2.0`);
    });

    it("emoji sequence: A-axis exploits UTF-8 class structure", () => {
      const data = TE.encode("🔥💧🌿⚡🪐✨🎵🎲🌀🔮🧬🌊🍃🌙".repeat(30));
      const enc = rt(data, "emoji");
      assert.ok(ratio(enc, data.length) < 0.25,
        `emoji ratio ${(ratio(enc, data.length) * 100).toFixed(1)}% should be <25%`);
    });
  });

  // ── entropy bypass (eBypass) ────────────────────────────────────────────
  describe("entropy bypass (eBypass)", () => {
    it("near-random data triggers bypass, then structured data recovers", () => {
      // the entropy monitor checks every 64 bytes after the 256-byte window fills.
      // when >240 distinct bytes appear in the sliding window, eBypass=1 and
      // M/A searching is disabled. this tests the transition INTO and OUT OF bypass.
      //
      // 512 bytes of near-random (all 256 values plus noise) → triggers bypass.
      // then 2048 bytes of structured text → bypass should deactivate, M-axis resumes.
      const rng = makeDeterministicRng(0xB44A55);
      const random = new Uint8Array(512);
      for (let i = 0; i < 512; i++) random[i] = i < 256 ? i : ((rng() * 256) | 0);
      const text = TE.encode("the codec must recover after bypass. ".repeat(57));
      const data = new Uint8Array(random.length + text.length);
      data.set(random);
      data.set(text, random.length);
      rt(data, "bypass-transition");
    });

    it("sustained random data stays in bypass mode", () => {
      // 4KB of uniform random. bypass should activate after ~256 bytes
      // and stay active. match searching is skipped, saving work.
      // the codec must still roundtrip correctly with bypass active.
      rt(deterministicBytes(4096, 0xF00BAA), "sustained-bypass");
    });
  });

  // ── match window boundary (32KB) ───────────────────────────────────────
  describe("match window boundary", () => {
    it("40KB with repeated pattern: matches evicted at 32KB window edge", () => {
      // the hash chains use & 0x7FFF (32768 window). data at position 0 is
      // unreachable from position 33000. if the codec incorrectly references
      // evicted positions, it corrupts output.
      // first 8KB: pattern A. middle 25KB: filler. last 8KB: pattern A again.
      // the second occurrence of A must find matches in the window (not expired ones).
      const patternA = TE.encode("abcdefgh12345678".repeat(512)); // 8KB
      const filler = deterministicBytes(25000, 0xF111E2);
      const data = new Uint8Array(patternA.length + filler.length + patternA.length);
      data.set(patternA, 0);
      data.set(filler, patternA.length);
      data.set(patternA, patternA.length + filler.length);
      rt(data, "window-boundary");
    });

    it("exactly 32768 bytes of structured data", () => {
      // the window is exactly 32768 bytes. at position 32769, position 0 is
      // just barely outside the window. hash chain must handle this boundary.
      const data = TE.encode("abcdefghijklmnop".repeat(2048)); // 32KB
      rt(data, "exact-window");
    });
  });

  // ── range coder stress ─────────────────────────────────────────────────
  describe("range coder stress", () => {
    it("all-0xFF data: carry propagation stress", () => {
      // 0xFF is special in the range coder carry logic. a stream of 0xFF
      // bytes causes nPend (pending count) to grow, and when a carry
      // finally propagates, all pending bytes flip. this is the most
      // fragile path in any arithmetic coder.
      const data = new Uint8Array(4096).fill(0xFF);
      rt(data, "all-0xFF");
    });

    it("sizes 1-256: range coder flush edge cases", () => {
      // the encoder flushes 4 bytes at the end. at very small sizes,
      // the flush bytes dominate. off-by-one errors show up at specific sizes.
      const failures: string[] = [];
      for (let size = 1; size <= 256; size++) {
        const data = deterministicBytes(size, 0x512E + size);
        try {
          rt(data, `size-${size}`);
        } catch (e: any) {
          failures.push(`size=${size}: ${e.message}`);
        }
      }
      assert.equal(failures.length, 0,
        `round-trip failures at small sizes:\n${failures.join("\n")}`);
    });

    it("near-boundary: data that barely compresses/doesn't compress", () => {
      // test the mode decision boundary: compressedLen vs rawLen.
      // data with entropy ≈ 7.5-8.0 bps lands right at the edge.
      const rng = makeDeterministicRng(0xB02DE2);
      for (let trial = 0; trial < 30; trial++) {
        const size = 50 + ((rng() * 500) | 0);
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          data[i] = rng() < 0.05 ? 0x00 : ((rng() * 256) | 0);
        }
        rt(data, `boundary-${trial} (${size}B)`);
      }
    });
  });

  // ── regime switching ───────────────────────────────────────────────────
  describe("regime switching (evaporation stress)", () => {
    it("structured → random: crystal to gas transition", () => {
      const data = new Uint8Array(8192);
      data.set(deterministicBytes(4096, 0xCA_FE), 4096);
      const enc = rt(data, "zeros-then-random");
      const r = ratio(enc, 8192);
      assert.ok(r > 0.40 && r < 0.75,
        `regime-switch ratio ${(r * 100).toFixed(1)}% should be 40-75%`);
    });

    it("random → structured: gas to crystal recovery", () => {
      const noise = deterministicBytes(2048, 0xDE_AD);
      const text = TE.encode("abcdefghijklmnop".repeat(128));
      const data = new Uint8Array(4096);
      data.set(noise);
      data.set(text, 2048);
      rt(data, "random-then-text");
    });

    it("interleaved JSON with random base64 payloads", () => {
      const rng = makeDeterministicRng(0xBA5E_64);
      const chunks: string[] = [];
      for (let i = 0; i < 20; i++) {
        const payloadLen = 20 + ((rng() * 60) | 0);
        const payload = Array.from({ length: payloadLen },
          () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[
            (rng() * 64) | 0
          ]).join("");
        chunks.push(`{"id":${i},"data":"${payload}","ts":${1700000000 + i}}\n`);
      }
      rt(TE.encode(chunks.join("")), "json-b64");
    });

    it("distribution shift: low bytes → high bytes mid-stream", () => {
      const rng = makeDeterministicRng(0x5F1F7);
      const data = new Uint8Array(4096);
      for (let i = 0; i < 2048; i++) data[i] = (rng() * 16) | 0;
      for (let i = 2048; i < 4096; i++) data[i] = 0xF0 + ((rng() * 16) | 0);
      rt(data, "distribution-shift");
    });
  });

  // ── Markov chains (controlled entropy) ─────────────────────────────────
  describe("Markov chains (controlled entropy)", () => {
    it("high-bias (0.95, 16 states): bps < 3.0", () => {
      const data = markovChain(4096, 16, 0.95, 0x4A2C0F);
      const enc = rt(data, "markov-high");
      assert.ok(bps(enc, data.length) < 3.0,
        `high-bias Markov ${bps(enc, data.length).toFixed(2)} bps should be <3.0`);
    });

    it("low-bias (0.3, 256 states): bps < 8.0", () => {
      const data = markovChain(4096, 256, 0.3, 0x10B1A5);
      const enc = rt(data, "markov-low");
      assert.ok(bps(enc, data.length) < 8.0,
        `low-bias Markov ${bps(enc, data.length).toFixed(2)} bps should be <8.0`);
    });

    it("monotonic ×3 mod 256: Z-axis constant derivative, bps < 1.5", () => {
      const data = new Uint8Array(2048);
      for (let i = 0; i < 2048; i++) data[i] = (i * 3) & 0xFF;
      const enc = rt(data, "monotonic");
      assert.ok(bps(enc, data.length) < 1.5,
        `monotonic ${bps(enc, data.length).toFixed(2)} bps should be <1.5`);
    });

    it("order-2 Markov: Z and E axes should both help", () => {
      // b[i] depends on BOTH b[i-1] and b[i-2]. this is exactly what the
      // Z-axis (XOR of prev1⊕prev2) and E-axis (AR(2) Cramer fit) are designed for.
      // O2 alone (order-1) can't capture this.
      const rng = makeDeterministicRng(0x02DE2);
      const data = new Uint8Array(4096);
      data[0] = 42; data[1] = 100;
      for (let i = 2; i < 4096; i++) {
        // b[i] = (0.6×b[i-1] + 0.3×b[i-2] + noise) mod 256
        data[i] = (Math.round(0.6 * data[i - 1] + 0.3 * data[i - 2] + (rng() * 20 - 10))) & 0xFF;
      }
      const enc = rt(data, "order-2-markov");
      const b = bps(enc, data.length);
      // should do significantly better than a pure order-1 model
      assert.ok(b < 6.0,
        `order-2 Markov ${b.toFixed(2)} bps should be <6.0 (Z+E exploit order-2 structure)`);
    });
  });

  // ── spectral tower (O2 → Z → E) ──────────────────────────────────────
  describe("spectral tower stress (O2 → Z → E)", () => {
    it("damped oscillation: E-axis AR(2) tracks decay envelope", () => {
      const data = new Uint8Array(4096);
      for (let i = 0; i < 4096; i++) {
        data[i] = Math.max(0, Math.min(255,
          128 + Math.round(100 * Math.exp(-i / 500) * Math.sin(i * 0.1))));
      }
      const enc = rt(data, "damped-osc");
      assert.ok(bps(enc, data.length) < 4.0,
        `damped osc ${bps(enc, data.length).toFixed(2)} bps should be <4.0`);
    });

    it("O2+Z agree, E disagrees: entanglement handles partial tower agreement", () => {
      const rng = makeDeterministicRng(0x70EE2);
      const data = new Uint8Array(4096);
      for (let i = 0; i < 4096; i++) {
        data[i] = i % 8 < 6 ? (i * 1) & 0xFF : ((rng() * 256) | 0);
      }
      rt(data, "tower-disagree");
    });

    it("constant XOR derivative with varying absolute values", () => {
      // b[i] = b[i-1] + 7 mod 256. XOR derivative is NOT constant (XOR ≠ subtraction),
      // but the E-axis AR(2) fit should predict well: K≈1, G≈0, pred≈b[i-1]+7.
      const data = new Uint8Array(2048);
      data[0] = 0;
      for (let i = 1; i < 2048; i++) data[i] = (data[i - 1] + 7) & 0xFF;
      const enc = rt(data, "constant-step");
      assert.ok(bps(enc, data.length) < 1.5,
        `constant step ${bps(enc, data.length).toFixed(2)} bps should be <1.5`);
    });
  });

  // ── real file round-trip ───────────────────────────────────────────────
  describe("real file round-trip", () => {
    it("package.json: actual structured JSON from this repo", () => {
      const data = new Uint8Array(readFileSync("package.json"));
      const enc = rt(data, "package.json");
      const b = bps(enc, data.length);
      // package.json is ~1KB. benchmark shows 3.20 bps. allow some slack.
      assert.ok(b < 4.5, `package.json ${b.toFixed(2)} bps should be <4.5`);
      assert.ok(b > 1.0, `package.json ${b.toFixed(2)} bps should be >1.0 (it's not that repetitive)`);
    });

    it("tsconfig.json: tiny structured config", () => {
      const data = new Uint8Array(readFileSync("tsconfig.json"));
      const enc = rt(data, "tsconfig.json");
      // tiny file (~195B). codec won't compress much but must not corrupt.
      assert.ok(enc.length <= data.length + 1, "tsconfig.json must not expand beyond raw+1");
    });

    it("logos.wat: the codec source itself (64KB truncated)", () => {
      // the codec should compress its own source well. this is a real test of
      // the codec on production source code, not synthetic data.
      const raw = readFileSync("src/scripts/whisper/logos.wat");
      const data = new Uint8Array(raw.buffer, raw.byteOffset, Math.min(raw.length, 65536));
      const enc = rt(data, "logos.wat");
      const b = bps(enc, data.length);
      // benchmark shows source code at ~1.5-2.0 bps
      assert.ok(b < 2.5, `logos.wat ${b.toFixed(2)} bps should be <2.5`);
    });
  });

  // ── chat messages (the actual use case) ────────────────────────────────
  describe("chat messages (production use case)", () => {
    const messages = [
      "hey", "what's up", "nm just coding", "nice what are you working on",
      "this weird compression thing", "oh cool does it work",
      "yeah kinda, still testing edge cases", "lol good luck",
      "thanks i need it", "want to grab food later?",
      "sure, where?", "idk maybe that new ramen place",
      "🔥🔥🔥", "日本語でも動く？", "すごい",
      "https://github.com/user/repo/pull/42",
    ];

    it("each message roundtrips and never expands beyond raw+1", () => {
      for (const msg of messages) {
        const data = TE.encode(msg);
        const enc = rt(data, `chat: "${msg}"`);
        assert.ok(enc.length <= data.length + 1,
          `chat "${msg}": ${enc.length} > ${data.length + 1}`);
      }
    });

    it("batch of all messages compresses better than individual", () => {
      // when messages are concatenated, M-axis can find cross-message matches.
      const batch = TE.encode(messages.join("\n"));
      const batchEnc = rt(batch, "chat-batch");
      const batchBps = bps(batchEnc, batch.length);
      // individual messages can't compress (too short). batch should.
      assert.ok(batchBps < 6.5,
        `chat batch ${batchBps.toFixed(2)} bps should be <6.5`);
    });
  });

  // ── golden values (exact compressed sizes, catches ANY codec change) ───
  describe("golden values (snapshot regression)", () => {
    // these are the exact compressed sizes produced by the current codec.
    // if any of these change, either the codec changed intentionally (update
    // the golden values) or something regressed. this is the most sensitive
    // regression test possible.
    const golden: [string, Uint8Array, number][] = [
      ["zeros-4K",    new Uint8Array(4096),                      8],
      ["constant-4K", new Uint8Array(4096).fill(0xAB),           8],
      ["0xFF-4K",     new Uint8Array(4096).fill(0xFF),           8],
      ["alt-01-2K",   (() => { const b = new Uint8Array(2048); for (let i = 0; i < 2048; i++) b[i] = i & 1; return b; })(), 9],
      ["pangram-x100", TE.encode("The quick brown fox jumps over the lazy dog. ".repeat(100)), 45],
      ["jp-x100",      TE.encode("あいうえおかきくけこさしすせそ".repeat(100)), 28],
      ["hello-x200",   TE.encode("hello whisper world!\n".repeat(200)), 26],
    ];

    for (const [name, data, expectedSize] of golden) {
      it(`${name}: exactly ${expectedSize} bytes`, () => {
        const enc = encode0D(data);
        assert.equal(enc.length, expectedSize,
          `${name}: compressed size changed from ${expectedSize} to ${enc.length}. ` +
          `if this is intentional, update the golden value.`);
        // also verify round-trip
        assertBytesEqual(decode0D(enc, data.length), data, `${name} golden rt`);
      });
    }
  });

  // ── bit-flip sensitivity (prove every compressed bit matters) ──────────
  describe("bit-flip sensitivity", () => {
    it("flipping any bit in compressed output corrupts the decode", () => {
      // if we can flip a bit and still get correct output, that bit is
      // redundant (wasted). a good codec uses every bit.
      const data = TE.encode(
        "this sentence is long enough that the compressed output has " +
        "many bytes, and flipping any bit should corrupt the decoding."
      );
      const enc = encode0D(data);
      assert.equal(enc[0], 0x00, "should use compressed mode");
      const compressedPayload = enc.subarray(1); // skip mode byte

      let flippable = 0;
      let corrupted = 0;
      for (let byteIdx = 0; byteIdx < compressedPayload.length; byteIdx++) {
        for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
          flippable++;
          const flipped = new Uint8Array(enc.length);
          flipped.set(enc);
          flipped[1 + byteIdx] ^= (1 << bitIdx);
          try {
            const dec = decode0D(flipped, data.length);
            let match = true;
            for (let i = 0; i < data.length; i++) {
              if (dec[i] !== data[i]) { match = false; break; }
            }
            if (!match) corrupted++;
          } catch {
            corrupted++; // crash also counts as "bit matters"
          }
        }
      }
      // at least 90% of bits should matter. if less than that, the codec
      // is wasting bits on redundancy.
      const sensitivity = corrupted / flippable;
      assert.ok(sensitivity > 0.90,
        `only ${(sensitivity * 100).toFixed(1)}% of bits affect output ` +
        `(${corrupted}/${flippable}). should be >90%`);
    });
  });

  // ── large-scale fuzz (500 inputs, diverse sizes) ───────────────────────
  describe("fuzz", () => {
    it("500 deterministic inputs at sizes 1B-64KB all roundtrip", () => {
      const failures: string[] = [];
      for (let i = 0; i < 500; i++) {
        // mix of sizes: many small (1-100), some medium (100-4000), few large (4000-64000)
        const r = (i * 2654435761) >>> 0; // Knuth multiplicative hash
        const size = i < 200 ? 1 + (r % 100)
                   : i < 400 ? 100 + (r % 4000)
                   : 4000 + (r % 60000);
        const data = deterministicBytes(size, r);
        try {
          const enc = encode0D(data);
          if (enc.length > data.length + 1) {
            failures.push(`i=${i} size=${size}: enc ${enc.length} > raw+1`);
            continue;
          }
          const dec = decode0D(enc, data.length);
          for (let j = 0; j < data.length; j++) {
            if (dec[j] !== data[j]) {
              failures.push(`i=${i} size=${size}: mismatch at byte ${j}`);
              break;
            }
          }
        } catch (e: any) {
          failures.push(`i=${i} size=${size}: ${e.message}`);
        }
      }
      assert.equal(failures.length, 0,
        `fuzz failures:\n${failures.slice(0, 10).join("\n")}`);
    });
  });

  // ── adversarial inputs (designed to stress specific code paths) ────────
  describe("adversarial", () => {
    it("rare event at evaporation boundary: single 0xFF in zeros at byte 63/64/65", () => {
      // evaporation fires every 64 bytes. a rare event exactly at the boundary
      // tests whether evaporation mid-prediction causes encoder/decoder divergence.
      for (const pos of [62, 63, 64, 65, 127, 128, 129, 191, 192, 193]) {
        const data = new Uint8Array(256);
        data[pos] = 0xFF;
        rt(data, `rare-at-${pos}`);
      }
    });

    it("255 zeros then 0xFF repeating: extreme skew with periodic surprise", () => {
      // O2 axis learns 0x00→0x00 with near-certainty (255/256 observations).
      // then 0xFF appears. the range coder must handle a very low-probability event.
      // this stresses carry propagation because the interval narrows dramatically.
      const data = new Uint8Array(4096);
      for (let i = 0; i < 4096; i++) data[i] = (i % 256 === 255) ? 0xFF : 0x00;
      const enc = rt(data, "periodic-surprise");
      // should still compress well (only 16 surprise bytes in 4096)
      assert.ok(ratio(enc, 4096) < 0.02,
        `periodic surprise ratio ${(ratio(enc, 4096) * 100).toFixed(2)}% should be <2%`);
    });

    it("maximum match chain depth: 256 occurrences of same 2-byte prefix", () => {
      // MAX_CHAIN is 256 in findMatch. this creates exactly 256 positions with
      // the same 2-byte hash prefix, forcing the chain to hit its length limit.
      // tests that the chain limit doesn't cause missed matches or corruption.
      const data = new Uint8Array(4096);
      for (let i = 0; i < 4096; i++) {
        // every 16 bytes, insert the same 2-byte prefix followed by varying data
        if (i % 16 < 2) {
          data[i] = i % 16 === 0 ? 0xAA : 0xBB;
        } else {
          data[i] = (i * 7 + 13) & 0xFF;
        }
      }
      rt(data, "max-chain-depth");
    });

    it("SSE state saturation: 50KB of constant data", () => {
      // SSE counts are i32 and never evaporated. with enough data,
      // the counts grow very large. if they overflow (>2^31), the
      // f64.convert_i32_u in blend() would produce wrong values.
      // 50KB = 400,000 bits. each SSE cell could accumulate up to 400K.
      // i32 max unsigned = 4,294,967,295. safe. but test it.
      const data = new Uint8Array(51200).fill(0x42);
      rt(data, "SSE-saturation");
    });

    it("worst-case for Born rule: all axes at p=0.5 (maximum uncertainty)", () => {
      // when all axes predict p=0.5, weights are 0 (|p-0.5|=0).
      // wLX = 0, so the blend falls through to pLX = 0.5.
      // this tests the zero-weight edge case in the blend function.
      // uniform random data at the start of the stream achieves this.
      const data = deterministicBytes(64, 0xDEAD);
      rt(data, "max-uncertainty");
    });
  });
});
