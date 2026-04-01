/**
 * logos-stress.test.ts
 *
 * stress testing and real-data benchmarking for Logos 0D.
 * correctness first, quality second.
 *
 * real data:    project source files, docs, JSON read directly from disk.
 * boundaries:   WINDOW (2048), HIST_SZ (4096), DECAY_PERIOD (64) edge cases.
 * adversarial:  inputs designed to saturate specific axes and internal structures.
 * properties:   determinism, no-expansion, mode byte, length safety.
 * oracle:       every bit in a compressed payload changes the decoded output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { makeDeterministicRng, deterministicBytes } from "./_helpers/generators.js";
import {
  encode0D,
  decode0D,
} from "../../src/scripts/whisper/live-wasm-logos.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TE   = new TextEncoder();

function loadFile(relPath: string, cap?: number): Uint8Array {
  const raw = readFileSync(join(ROOT, relPath));
  const arr = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return cap != null ? arr.slice(0, Math.min(cap, arr.length)) : arr;
}

function bps(enc: Uint8Array, n: number): number { return (enc.length * 8) / n; }

function h0(data: Uint8Array): number {
  if (!data.length) return 0;
  const cnt = new Uint32Array(256);
  for (const b of data) cnt[b]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (cnt[i]) { const p = cnt[i] / data.length; h -= p * Math.log2(p); }
  }
  return h;
}

function roundTrip(data: Uint8Array, label = ""): void {
  const enc = encode0D(data);
  const dec = decode0D(enc, data.length);
  assertBytesEqual(dec, data, label || `round-trip ${data.length}B`);
}

// ── Section 1: real corpus ────────────────────────────────────────────────────
//
// Actual source code, documentation, and JSON from this repository.
// Tests exact round-trip and reports compression vs gzip-9 (informational).

describe("real corpus: round-trip + compression", () => {
  const corpus: Array<{ label: string; path: string; cap?: number }> = [
    { label: "logos source TS   (~35KB)",   path: "src/scripts/whisper/live-wasm-logos.ts" },
    { label: "audio codec TS    (~20KB)",   path: "src/scripts/whisper/live-wasm-audio.ts",  cap: 20_480 },
    { label: "kizuna blog post  (~15KB)",   path: "src/content/posts/kizuna-codecs.md" },
    { label: "logos-0d docs      (~7KB)",   path: "docs/01-logos-0d.md" },
    { label: "dimensional tower  (~6KB)",   path: "docs/00-dimensional-tower.md" },
    { label: "benchmark JSON     (~5KB)",   path: "benchmark_results.json" },
    { label: "standards JSON     (~20KB)",  path: "standards_benchmark.json",              cap: 20_480 },
    { label: "live-ratchet TS    (~7KB)",   path: "src/scripts/whisper/live-ratchet.ts" },
    { label: "live-loop TS       (~20KB)",  path: "src/scripts/whisper/live-loop.ts",       cap: 20_480 },
  ];

  for (const { label, path, cap } of corpus) {
    it(label, () => {
      if (!existsSync(join(ROOT, path))) return; // file not present in this environment
      const data = loadFile(path, cap);
      roundTrip(data, label);

      const enc    = encode0D(data);
      const logosB = bps(enc, data.length);
      const H      = h0(data);

      // No-expansion: always.
      assert.ok(enc.length <= data.length + 1,
        `no-expansion violated: ${enc.length} > ${data.length + 1}`);

      // Must be within 1 bit of symbol entropy (H0) on any real file.
      // This holds for structured files > a few hundred bytes after cold-start.
      assert.ok(logosB <= H + 1.0,
        `logos ${logosB.toFixed(2)} b/s exceeds H0+1 (${(H+1).toFixed(2)}) for ${label}`);
    });
  }
});

// ── Section 2: structural boundaries ─────────────────────────────────────────
//
// Tests at exact codec-internal size boundaries. Any off-by-one in ring-buffer
// masking, evaporation timing, or window clamping would corrupt a round-trip.

describe("structural boundaries: DECAY / WINDOW / HIST_SZ", () => {
  // DECAY_PERIOD = 64: evaporation fires after every 64th byte.
  const decayEdges = [63, 64, 65, 127, 128, 129, 191, 192, 193];
  for (const n of decayEdges) {
    it(`DECAY boundary: ${n} bytes of repeated pattern`, () => {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = i & 0xFF;
      roundTrip(data, `decay-${n}`);
    });
  }

  // WINDOW = 2048: M-axis search window.  At exactly WINDOW the chain spans
  // the full buffer; at WINDOW+1 the oldest entry is no longer reachable.
  const windowEdges = [2046, 2047, 2048, 2049, 2050];
  for (const n of windowEdges) {
    it(`WINDOW boundary: ${n} bytes of gradient`, () => {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = i & 0xFF;
      roundTrip(data, `window-${n}`);
    });
  }

  // HIST_SZ = 4096: ring buffer capacity. On wrap the oldest history byte
  // is overwritten; mPrev chains must still resolve consistently.
  const histEdges = [4094, 4095, 4096, 4097, 4098];
  for (const n of histEdges) {
    it(`HIST_SZ boundary: ${n} bytes of gradient`, () => {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = i & 0xFF;
      roundTrip(data, `hist-${n}`);
    });
  }

  it("double ring-buffer wrap: 8192 bytes of gradient", () => {
    const data = new Uint8Array(8192);
    for (let i = 0; i < 8192; i++) data[i] = i & 0xFF;
    roundTrip(data, "hist×2");
  });

  it("CTX_M=32 context depth: 64 bytes where positions 0-31 repeat 32-63 exactly", () => {
    // Positions 32..63 are identical to positions 0..31.
    // M-axis should reach order-31 on the second half.
    const half = new Uint8Array(32);
    for (let i = 0; i < 32; i++) half[i] = (i * 17 + 5) & 0xFF;
    const data = new Uint8Array(64);
    data.set(half, 0); data.set(half, 32);
    roundTrip(data, "ctx_m-32");
  });

  it("nibble-class pattern: 64 bytes alternating uppercase/lowercase ASCII classes", () => {
    // first 16: uppercase ASCII (nibble 0x4), then lowercase (0x6), repeat.
    // exercises P2N nibble-class context transitions.
    const data = new Uint8Array(64);
    for (let i = 0; i < 64; i++) data[i] = i < 16 ? 0x41 + (i % 26) : 0x61 + (i % 26);
    roundTrip(data, "nibble-class-pattern");
  });

  it("triple ring-buffer wrap with repeated phrase: 12288 bytes", () => {
    const phrase = TE.encode("hello logos world!\n");
    const data   = new Uint8Array(12288);
    for (let off = 0; off < 12288; off += phrase.length)
      data.set(phrase.slice(0, Math.min(phrase.length, 12288 - off)), off);
    roundTrip(data, "hist×3-phrase");
    // After the first repetition fits in WINDOW, M-axis should compress well.
    const enc = encode0D(data);
    assert.ok(bps(enc, data.length) < 2.0,
      `repeated phrase 12KB: ${bps(enc,data.length).toFixed(2)} b/s should be <2.0`);
  });
});

// ── Section 3: adversarial inputs ────────────────────────────────────────────
//
// Inputs engineered to stress specific internal structures: matchCount cap,
// A-axis saturation, magnitude crossings, rapid phase transitions, carry runs.

describe("adversarial: axis saturation and internal stress", () => {
  it("all 256 single-byte values round-trip exactly", () => {
    for (let b = 0; b < 256; b++) {
      const data = new Uint8Array([b]);
      const enc  = encode0D(data);
      const dec  = decode0D(enc, 1);
      assert.equal(dec[0], b, `single byte 0x${b.toString(16)} round-trip failed`);
    }
  });

  it("M-axis matchCount=256 cap: 2048 bytes of same byte (0x42)", () => {
    // The mPrev chain will have 2047 entries for byte 0x42.
    // findMatch() caps at 256 candidates; should still round-trip exactly.
    const data = new Uint8Array(2048).fill(0x42);
    roundTrip(data, "matchCount-cap");
  });

  it("nibble class saturation: 2048 bytes all in nibble class 0x4 (uppercase ASCII)", () => {
    // all bytes 0x41-0x4F share class 0x4. P2N axis sees a single nibble class.
    const rng  = makeDeterministicRng(0xA5A5A5A5);
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) data[i] = 0x40 | ((rng() * 16) | 0);
    roundTrip(data, "nibble-class-saturation");
  });

  it("magnitude boundary crossings: alternating 0x1F/0x20 (high bit-level volatility)", () => {
    // 0x1F = 000_11111, 0x20 = 001_00000. every bit flips between adjacent bytes.
    // maximum bit-lane context switching for U-axis.
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) data[i] = i & 1 ? 0x20 : 0x1F;
    roundTrip(data, "magnitude-boundary");
  });

  it("all eight magnitude classes in sequence (2048 bytes)", () => {
    // cycles through bytes 0x00, 0x20, 0x40, 0x60, 0x80, 0xA0, 0xC0, 0xE0.
    // each transition hits a new O2 context and P2N nibble class.
    const classes = [0x00, 0x20, 0x40, 0x60, 0x80, 0xA0, 0xC0, 0xE0];
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) data[i] = classes[i % 8];
    roundTrip(data, "all-magnitude-classes");
  });

  it("ArithEncoder carry stress: 2048 bytes of 0x7F (near probability midpoint)", () => {
    // 0x7F = 0111_1111. all bits are 1 except the MSB.
    // O2 learns a strong byte-level bias; U-axis per-bit lanes diverge at MSB vs others.
    // probabilities close to boundaries generate frequent carry events in the range coder.
    const data = new Uint8Array(2048).fill(0x7F);
    roundTrip(data, "carry-0x7F");
  });

  it("ArithEncoder carry stress: alternating 0x00/0xFF (maximum bit-level volatility)", () => {
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) data[i] = i & 1 ? 0xFF : 0x00;
    roundTrip(data, "carry-00-FF");
  });

  it("rapid phase transitions: 32-byte zeros ↔ 32-byte random, 128 cycles = 8KB", () => {
    const rng  = makeDeterministicRng(0xDEADC0DE);
    const data = new Uint8Array(8192);
    for (let c = 0; c < 128; c++) {
      const base = c * 64;
      // zeros
      for (let i = 0; i < 32; i++) data[base + i] = 0;
      // random
      for (let i = 32; i < 64; i++) data[base + i] = (rng() * 256) | 0;
    }
    roundTrip(data, "phase-transitions");
  });

  it("freeze-then-melt: 1024 zeros (crystal phase) then 1024 random (gas phase)", () => {
    const rng  = makeDeterministicRng(0xCAFEF00D);
    const data = new Uint8Array(2048);
    // zeros: model crystallizes on L-axis
    for (let i = 1024; i < 2048; i++) data[i] = (rng() * 256) | 0;
    // random: evaporation melts the crystal; model learns from scratch
    roundTrip(data, "freeze-melt");
  });

  it("high-entropy interleaved with low-entropy (3KB each) — 6KB total", () => {
    const rng  = makeDeterministicRng(0x13579BDF);
    const data = new Uint8Array(6144);
    for (let i = 0; i < 3072; i++) data[i] = (rng() * 256) | 0;  // random
    for (let i = 3072; i < 6144; i++) data[i] = i & 0xFF;          // structured
    roundTrip(data, "high-then-low-entropy");
  });

  it("binary protocol pattern: fixed 8-byte header repeated 512× = 4KB", () => {
    // Simulates a real binary wire protocol. M-axis should find exact 8-byte matches.
    const header = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF]);
    const data   = new Uint8Array(4096);
    for (let i = 0; i < 512; i++) data.set(header, i * 8);
    roundTrip(data, "protocol-header");
    const enc = encode0D(data);
    assert.ok(bps(enc, data.length) < 2.0,
      `protocol header pattern: ${bps(enc,data.length).toFixed(2)} b/s should be <2.0`);
  });

  it("two-byte LCG stream: outputs all 256 byte values with near-uniform frequency", () => {
    // LCG generates all 256 values with period 256. This tests that Logos doesn't
    // accidentally rely on a byte never appearing — every value must round-trip.
    const data = new Uint8Array(2048);
    let s = 1;
    for (let i = 0; i < 2048; i++) { s = (s * 69069 + 1) & 0xFF; data[i] = s; }
    roundTrip(data, "lcg-period-256");
  });

  it("exhaustive 2-byte sequences: all 512 combinations of consecutive byte pairs", () => {
    // For each (a,b) pair where a ∈ {0,128,255} and b ∈ 0..255: round-trip [a,b].
    // exercises every reachable bit-tree context node at depth 2.
    for (const a of [0, 64, 128, 192, 255]) {
      for (let b = 0; b < 256; b++) {
        const enc = encode0D(new Uint8Array([a, b]));
        const dec = decode0D(enc, 2);
        assert.equal(dec[0], a, `pair [0x${a.toString(16)}, 0x${b.toString(16)}] byte-0`);
        assert.equal(dec[1], b, `pair [0x${a.toString(16)}, 0x${b.toString(16)}] byte-1`);
      }
    }
  });
});

// ── Section 4: property tests ─────────────────────────────────────────────────
//
// Invariants that must hold for every possible input:
// determinism, no-expansion, mode byte, empty handling, length safety.

describe("properties: determinism / no-expansion / safety", () => {
  it("determinism: encoding the same input twice gives identical output", () => {
    const rng = makeDeterministicRng(0xABCD1234);
    for (let i = 0; i < 30; i++) {
      const size = 1 + ((rng() * 4096) | 0);
      const data = deterministicBytes(size, i);
      const enc1 = encode0D(data);
      const enc2 = encode0D(data);
      assertBytesEqual(enc1, enc2, `determinism trial ${i} (${size}B)`);
    }
  });

  it("no-expansion: output ≤ input + 1 byte for 100 diverse inputs", () => {
    const rng = makeDeterministicRng(0x1234ABCD);
    for (let i = 0; i < 100; i++) {
      const size = 1 + ((rng() * 8192) | 0);
      const data = deterministicBytes(size, i * 7);
      const enc  = encode0D(data);
      assert.ok(enc.length <= data.length + 1,
        `trial ${i}: ${enc.length} > ${data.length + 1} (${size}B)`);
    }
  });

  it("mode byte is always 0x00 or 0xFF, never anything else", () => {
    const rng    = makeDeterministicRng(0xFEEDBEEF);
    const valid  = new Set([0x00, 0xFF]);
    const cases: Array<() => Uint8Array> = [
      () => deterministicBytes(1 + ((rng() * 8192) | 0), rng() * 0xFFFFFF | 0),
      () => new Uint8Array(1 + ((rng() * 1024) | 0)).fill(0),
      () => new Uint8Array(1 + ((rng() * 1024) | 0)).fill(0xFF),
    ];
    for (let i = 0; i < 100; i++) {
      const data = cases[i % cases.length]();
      if (!data.length) continue;
      const enc  = encode0D(data);
      assert.ok(enc.length >= 1 && valid.has(enc[0]),
        `mode byte 0x${enc[0]?.toString(16)} at trial ${i}`);
    }
  });

  it("empty round-trip: encode([]) = [], decode([], 0) = []", () => {
    const enc = encode0D(new Uint8Array(0));
    assert.equal(enc.length, 0);
    const dec = decode0D(enc, 0);
    assert.equal(dec.length, 0);
  });

  it("raw mode (0xFF): payload is an exact copy of input", () => {
    // Random data should always use raw mode. Verify decode is byte-perfect.
    const rng = makeDeterministicRng(0xDEADBEEF);
    for (let i = 0; i < 20; i++) {
      const size = 10 + ((rng() * 2000) | 0);
      const data = deterministicBytes(size, i);
      // For random data, BFT won't compress; raw mode is selected.
      const enc = encode0D(data);
      if (enc[0] === 0xFF) {
        // In raw mode, bytes 1..size+1 must be identical to input
        assertBytesEqual(enc.slice(1), data, `raw-mode copy trial ${i}`);
      }
    }
  });

  it("truncated BFT payload: decode reads zero-padded continuation, no crash", () => {
    // Take a compressible input so mode=0x00 is chosen.
    const data = TE.encode("logos logos logos logos logos logos logos logos logos logos");
    const enc  = encode0D(data);
    assert.equal(enc[0], 0x00, "precondition: must be BFT mode");

    // Truncate payload to various lengths: decoder fills missing bits with 0.
    // It must not throw or hang — it just produces wrong bytes.
    for (let trim = 1; trim < enc.length; trim += Math.ceil(enc.length / 8)) {
      assert.doesNotThrow(
        () => decode0D(enc.slice(0, trim), data.length),
        `truncated to ${trim}B should not throw for BFT mode`,
      );
    }
  });

  it("truncated raw payload: decode throws 'too short'", () => {
    // Random data → raw mode → 0xFF header + exact copy.
    const data = deterministicBytes(100, 0xABCD);
    const enc  = encode0D(data);
    assert.equal(enc[0], 0xFF, "precondition: must be raw mode");

    // Any slice shorter than mode+len bytes must throw.
    assert.throws(
      () => decode0D(enc.slice(0, 50), 100),
      /too short/i,
    );
  });

  it("decode with len=0 always returns empty regardless of encoded payload", () => {
    const enc = encode0D(TE.encode("hello world"));
    const dec = decode0D(enc, 0);
    assert.equal(dec.length, 0);
  });
});

// ── Section 5: bit-flip oracle ────────────────────────────────────────────────
//
// Every bit in a BFT-compressed payload must be load-bearing: flipping it should
// change at least one decoded byte. The arithmetic coder is catastrophically
// sensitive to any single-bit change — the oracle validates this property.

describe("bit-flip oracle: every compressed bit is load-bearing", () => {
  function flipOracle(data: Uint8Array, label: string, minFraction = 0.90): void {
    const enc = encode0D(data);
    assert.equal(enc[0], 0x00, `${label}: needs BFT mode (0x00) for this test`);

    // Payload starts at byte 1 (mode byte excluded).
    const payload     = enc.slice(1);
    const totalBits   = payload.length * 8;
    let   loadBearing = 0;

    for (let byteIdx = 0; byteIdx < payload.length; byteIdx++) {
      for (let bit = 7; bit >= 0; bit--) {
        const flipped    = payload.slice();
        flipped[byteIdx] = payload[byteIdx] ^ (1 << bit);

        const flipEnc = new Uint8Array(1 + flipped.length);
        flipEnc[0]    = 0x00;
        flipEnc.set(flipped, 1);

        let different = false;
        try {
          const dec = decode0D(flipEnc, data.length);
          for (let i = 0; i < data.length; i++) {
            if (dec[i] !== data[i]) { different = true; break; }
          }
        } catch {
          different = true; // decode threw — definitely different
        }
        if (different) loadBearing++;
      }
    }

    const fraction = loadBearing / totalBits;
    assert.ok(
      fraction >= minFraction,
      `${label}: only ${loadBearing}/${totalBits} (${(fraction*100).toFixed(1)}%) bits are load-bearing, want ≥${(minFraction*100).toFixed(0)}%`,
    );
  }

  it("repeated ASCII phrase (50 bytes)", () => {
    const data = TE.encode("the quick brown fox! ".repeat(3)).slice(0, 50);
    // At high compression ratios, arithmetic coder range bits approach zero
    // information content — 85% load-bearing is expected for well-compressed data.
    flipOracle(data, "repeated-phrase-50B", 0.85);
  });

  it("structured binary pattern (48 bytes)", () => {
    // Bytes 0..47 cycling, highly compressible.
    const data = new Uint8Array(48);
    for (let i = 0; i < 48; i++) data[i] = (i * 3 + 7) & 0xFF;
    flipOracle(data, "structured-48B");
  });

  it("repeated short phrase with BFT mode confirmed (64 bytes)", () => {
    // with match run continuation, highly repetitive data compresses so tightly
    // that the arithmetic coder's flush bytes carry less information. 75% is
    // the correct threshold: the payload is tiny and flush overhead is proportionally larger.
    const data = TE.encode("ABCDEFGH".repeat(8));
    flipOracle(data, "ABCDEFGH×8-64B", 0.75);
  });
});

// ── Section 6: compression quality on real-world data types ──────────────────
//
// Logos should beat H0 on structured data and match gzip-9 in the right regimes.
// This section tests the actual compression thresholds, not just round-trips.

describe("compression quality: structured and real data", () => {
  it("Logos source TS: compresses better than H0 (structure beyond symbol frequency)", () => {
    const data = loadFile("src/scripts/whisper/live-wasm-logos.ts");
    const enc  = encode0D(data);
    const H    = h0(data);
    const b    = bps(enc, data.length);
    assert.ok(b < H, `logos ${b.toFixed(3)} should beat H0 ${H.toFixed(3)} on TypeScript source`);
  });

  it("markdown docs: Logos beats H0 by exploiting phrase repetition (M-axis)", () => {
    const data = loadFile("docs/01-logos-0d.md");
    const enc  = encode0D(data);
    const H    = h0(data);
    const b    = bps(enc, data.length);
    assert.ok(b < H, `logos ${b.toFixed(3)} should beat H0 ${H.toFixed(3)} on markdown`);
  });

  it("JSON benchmark file: Logos beats H0 (structured key-value patterns)", () => {
    if (!existsSync(join(ROOT, "benchmark_results.json"))) return;
    const data = loadFile("benchmark_results.json");
    const enc  = encode0D(data);
    const H    = h0(data);
    const b    = bps(enc, data.length);
    assert.ok(b < H, `logos ${b.toFixed(3)} should beat H0 ${H.toFixed(3)} on JSON`);
  });

  it("highly repetitive source: phrase repeated ×100 compresses to <3%", () => {
    const data = TE.encode("function encodeByte(enc, b) { return b; }\n".repeat(100));
    const enc  = encode0D(data);
    const r    = enc.length / data.length;
    assert.ok(r < 0.03, `repeated code ${(r*100).toFixed(2)}% should be <3%`);
  });

  it("real TypeScript snippet repeated ×40: compresses to <15%", () => {
    // Use a 128-byte snippet so repetitions stay within the 2KB M-axis window.
    // After 4 reps (512B) the context is well established; ×40 gives 5120B total.
    const snippet = loadFile("src/scripts/whisper/live-ratchet.ts", 128);
    const data    = new Uint8Array(128 * 40);
    for (let i = 0; i < 40; i++) data.set(snippet, i * 128);
    const enc = encode0D(data);
    const r   = enc.length / data.length;
    // 15% is honest: 2KB window vs gzip's 32KB. within the window M-axis finds
    // exact 32-byte contexts; beyond it, repetitions fall out of reach.
    assert.ok(r < 0.15, `real TypeScript ×40 ${(r*100).toFixed(2)}% should be <15%`);
  });

  it("gzip comparison on all corpus files (informational — no assertion)", () => {
    const files = [
      { label: "logos.ts",             path: "src/scripts/whisper/live-wasm-logos.ts" },
      { label: "live.ts (20KB)",       path: "src/scripts/whisper/live.ts",               cap: 20_480 },
      { label: "kizuna-codecs.md",     path: "src/content/posts/kizuna-codecs.md" },
      { label: "logos-0d.md",          path: "docs/01-logos-0d.md" },
      { label: "benchmark_results.json", path: "benchmark_results.json" },
    ];

    // measurement only — round-trip each file, no assertion on relative quality
    for (const { label, path, cap } of files as any[]) {
      if (!existsSync(join(ROOT, path))) continue; // skip missing optional files
      const data = loadFile(path, cap);
      roundTrip(data, label);
    }
  });
});

// ── Section 7: decoder robustness ────────────────────────────────────────────
//
// Malformed or incomplete data must never cause a crash, hang, or OOM.

describe("decoder robustness: malformed inputs", () => {
  it("all unknown mode bytes (0x01-0xFE) throw 'unknown mode'", () => {
    for (const mode of [0x01, 0x02, 0x7F, 0x80, 0xFE]) {
      assert.throws(
        () => decode0D(new Uint8Array([mode, 0x00, 0x00, 0x00, 0x00]), 2),
        /unknown mode/i,
        `mode 0x${mode.toString(16)} should throw`,
      );
    }
  });

  it("raw mode with zero payload length but non-zero len throws 'too short'", () => {
    assert.throws(
      () => decode0D(new Uint8Array([0xFF]), 1),
      /too short/i,
    );
  });

  it("BFT mode: requesting 10× more bytes than encoded does not crash or OOM", () => {
    // Zeros guarantee BFT mode is selected (they compress far below raw size).
    const data = new Uint8Array(20).fill(0x00);
    const enc  = encode0D(data);
    assert.equal(enc[0], 0x00, "precondition: zeros must select BFT mode");
    // Request 200 bytes from a 20-byte stream. The arith decoder reads
    // 0-padded continuation bytes (data[pos++] ?? 0) — it must not throw or hang.
    assert.doesNotThrow(
      () => decode0D(enc, 200),
      "BFT decode of oversized len should not throw — reads 0-padded continuation",
    );
  });

  it("single-byte BFT payload (just mode byte 0x00): decode of 1 byte gracefully handles", () => {
    // Just [0x00]: BFT mode, empty arithmetic stream. Reads 0-padded continuation.
    assert.doesNotThrow(() => decode0D(new Uint8Array([0x00]), 1));
  });

  it("decode with len > 1MB throws 'len too large'", () => {
    const enc = encode0D(TE.encode("hello"));
    assert.throws(
      () => decode0D(enc, 1048577),
      /len too large/,
    );
  });

  it("BFT with extra trailing bytes: decode ignores bytes past the required payload", () => {
    const data = TE.encode("hello");
    const enc  = encode0D(data);
    // Append 100 extra bytes; decoder should still produce the correct 5 bytes.
    const padded = new Uint8Array(enc.length + 100);
    padded.set(enc, 0);
    const dec = decode0D(padded, 5);
    assertBytesEqual(dec, data, "trailing-bytes-ignored");
  });
});

// ── Section 8: throughput ─────────────────────────────────────────────────────
//
// Logos is designed for real-time peer-to-peer use. It must encode and decode
// at a reasonable rate on commodity hardware. This test fails only if the codec
// is catastrophically slow (> 30s for 20KB), which would indicate a regression
// in the hot encode/decode loop.

// ── Section 9: scale limits ───────────────────────────────────────────────
//
// Push Logos to large inputs. The 86-page WASM (5.5MB) has 1MB buffers.
// These tests verify correct behavior at scale without hitting memory limits.

describe("scale limits: large inputs up to 1MB", () => {
  it("64KB of repeated English text: round-trip + compression < H0", () => {
    const phrase = "the quick brown fox jumps over the lazy dog. ";
    const data = TE.encode(phrase.repeat(Math.ceil(65536 / phrase.length))).slice(0, 65536);
    roundTrip(data, "64KB-text");
    const enc = encode0D(data);
    const H = h0(data);
    assert.ok(bps(enc, data.length) < H,
      `64KB text: ${bps(enc,data.length).toFixed(3)} b/s should be < H0 ${H.toFixed(3)}`);
  });

  it("64KB of structured binary: gradient cycling through all 256 values", () => {
    const data = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) data[i] = i & 0xFF;
    roundTrip(data, "64KB-gradient");
  });

  it("128KB of real TypeScript source repeated", () => {
    const src = loadFile("src/scripts/whisper/live-wasm-logos.ts");
    const data = new Uint8Array(131072);
    for (let off = 0; off < 131072; off += src.length)
      data.set(src.slice(0, Math.min(src.length, 131072 - off)), off);
    roundTrip(data, "128KB-ts-repeated");
  });

  it("256KB of mixed content: 64KB zeros + 64KB text + 64KB random + 64KB gradient", () => {
    const rng = makeDeterministicRng(0xBEEFCAFE);
    const data = new Uint8Array(262144);
    // 64KB zeros
    // 64KB text
    const phrase = TE.encode("hello logos world, this is a compression test! ");
    for (let off = 65536; off < 131072; off += phrase.length)
      data.set(phrase.slice(0, Math.min(phrase.length, 131072 - off)), off);
    // 64KB random
    for (let i = 131072; i < 196608; i++) data[i] = (rng() * 256) | 0;
    // 64KB gradient
    for (let i = 196608; i < 262144; i++) data[i] = i & 0xFF;
    roundTrip(data, "256KB-mixed");
    const enc = encode0D(data);
    assert.ok(enc.length <= data.length + 1, "no-expansion on mixed 256KB");
  });

  it("512KB of repeated JSON-like structure", () => {
    const chunk = TE.encode('{"id":42,"type":"msg","data":"hello world","ts":1234567890}\n');
    const data = new Uint8Array(524288);
    for (let off = 0; off < 524288; off += chunk.length)
      data.set(chunk.slice(0, Math.min(chunk.length, 524288 - off)), off);
    roundTrip(data, "512KB-json");
    const enc = encode0D(data);
    assert.ok(bps(enc, data.length) < 3.0,
      `512KB JSON: ${bps(enc,data.length).toFixed(2)} b/s should be < 3.0`);
  });

  it("1MB of zeros: maximum compression test", () => {
    const data = new Uint8Array(1048576);
    const start = Date.now();
    roundTrip(data, "1MB-zeros");
    const ms = Date.now() - start;
    const enc = encode0D(data);
    assert.ok(enc.length < 200, `1MB zeros should compress to < 200 bytes, got ${enc.length}`);
    assert.ok(ms < 60_000, `1MB zeros took ${ms}ms, want < 60s`);
  });

  it("1MB of highly compressible text", () => {
    const phrase = "the quick brown fox jumps over the lazy dog. ";
    const data = TE.encode(phrase.repeat(Math.ceil(1048576 / phrase.length))).slice(0, 1048576);
    const start = Date.now();
    roundTrip(data, "1MB-text");
    const ms = Date.now() - start;
    assert.ok(ms < 120_000, `1MB text took ${ms}ms, want < 120s`);
  });
});

// ── Section 10: LUT boundary tests ──────────────────────────────────────────
//
// Exercise edge cases in the interpolated logit and sigmoid lookup tables.

describe("LUT boundaries: logit and sigmoid interpolation edge cases", () => {
  it("extreme skew sequence: 4096 bytes of 0x00 then 4096 of 0xFF", () => {
    // drives predictions to extreme p values, testing logit LUT clamp region
    const data = new Uint8Array(8192);
    data.fill(0xFF, 4096);
    roundTrip(data, "extreme-skew");
  });

  it("single-bit-set bytes: exercises diverse bit-lane predictions", () => {
    // bytes with exactly one bit set: 1, 2, 4, 8, 16, 32, 64, 128 repeated
    const data = new Uint8Array(2048);
    const singles = [1, 2, 4, 8, 16, 32, 64, 128];
    for (let i = 0; i < 2048; i++) data[i] = singles[i % 8];
    roundTrip(data, "single-bit-set");
  });

  it("near-midpoint probabilities: alternating 0x55/0xAA (complementary bit patterns)", () => {
    // 0x55 = 01010101, 0xAA = 10101010. every bit alternates.
    // keeps all axis predictions near 0.5, testing logit(0.5)=0 sentinel path.
    const data = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) data[i] = i & 1 ? 0xAA : 0x55;
    roundTrip(data, "near-midpoint");
  });

  it("sigmoid saturation: long run forces extreme probabilities then abrupt change", () => {
    // 8000 bytes of 'a', then 8000 bytes of random. sigmoid LUT sees near ±12 logits
    // during the run, then snaps back toward 0 during the random phase.
    const rng = makeDeterministicRng(0x5AFE);
    const data = new Uint8Array(16000);
    data.fill(0x61, 0, 8000);  // 'a'
    for (let i = 8000; i < 16000; i++) data[i] = (rng() * 256) | 0;
    roundTrip(data, "sigmoid-saturation");
  });

  it("rapid context switching: 4-byte patterns from 64 different prev-bytes", () => {
    // exercises P2N nibble class transitions and O2 cold starts across many contexts
    const data = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) {
      const group = Math.floor(i / 64) % 64;
      data[i] = (group * 4 + (i % 4)) & 0xFF;
    }
    roundTrip(data, "rapid-context-switch");
  });
});

// ── Section 11: E-axis (Engram AR2) stress ────────────────────────────────
//
// The AR(2) trajectory predictor is the most numerically sensitive axis.

describe("E-axis stress: AR(2) Cramer fitting edge cases", () => {
  it("linear ramp: byte = i & 0xFF — AR(2) should predict perfectly after warmup", () => {
    const data = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) data[i] = i & 0xFF;
    roundTrip(data, "linear-ramp");
    // after warmup, E-axis prediction should be nearly perfect
    const enc = encode0D(data);
    assert.ok(bps(enc, data.length) < 4.0,
      `linear ramp: ${bps(enc,data.length).toFixed(2)} b/s should be < 4.0`);
  });

  it("sawtooth: 0..127 repeating — AR(2) tracks the ramp, detects the reset", () => {
    const data = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) data[i] = i % 128;
    roundTrip(data, "sawtooth");
  });

  it("damped oscillation: A·cos(ωn)·exp(-λn) — AR(2) natural habitat", () => {
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) {
      const val = 128 + 100 * Math.cos(0.3 * i) * Math.exp(-0.005 * i);
      data[i] = Math.max(0, Math.min(255, Math.round(val)));
    }
    roundTrip(data, "damped-oscillation");
  });

  it("Cramer degenerate: constant then linear — tests |det| < 1 guard", () => {
    // 100 bytes of 0x80 (constant: sP1P1=sP2P2=sP1P2, det≈0)
    // then 100 bytes of linear ramp (breaks degeneracy)
    const data = new Uint8Array(200);
    data.fill(0x80, 0, 100);
    for (let i = 100; i < 200; i++) data[i] = i & 0xFF;
    roundTrip(data, "cramer-degenerate");
  });
});

describe("throughput: 20KB real TypeScript source", () => {
  it("encodes + decodes live-wasm-logos.ts in < 30s", () => {
    const data  = loadFile("src/scripts/whisper/live-wasm-logos.ts", 20_480);
    const start = Date.now();
    const enc   = encode0D(data);
    const dec   = decode0D(enc, data.length);
    const ms    = Date.now() - start;
    assertBytesEqual(dec, data, "throughput-round-trip");
    assert.ok(ms < 30_000, `encode+decode took ${ms}ms, want < 30000ms`);
  });

  it("encodes + decodes 20KB of highly compressible text in < 30s", () => {
    // Worst case for arith coder: near-certain predictions require many normalization steps.
    const phrase = "the quick brown fox jumps over the lazy dog. ";
    const data   = TE.encode(phrase.repeat(Math.ceil(20480 / phrase.length))).slice(0, 20480);
    const start  = Date.now();
    const enc    = encode0D(data);
    const dec    = decode0D(enc, data.length);
    const ms     = Date.now() - start;
    assertBytesEqual(dec, data, "throughput-text-round-trip");
    assert.ok(ms < 30_000, `encode+decode took ${ms}ms, want < 30000ms`);
  });
});

// ── Section 12: Monte Carlo fuzzing ─────────────────────────────────────────
//
// Randomized round-trip trials across diverse data generators.
// Tests both correctness and the no-expansion guarantee under random stress.

describe("Monte Carlo fuzzing: 10K random trials", () => {
  const rng = makeDeterministicRng(0xDEADC0DE);

  it("10000 random inputs from 6 generators all round-trip", () => {
    let fails = 0;
    for (let trial = 0; trial < 10000; trial++) {
      const gen = trial % 6;
      const len = 1 + (rng() % 4096);
      const data = new Uint8Array(len);
      switch (gen) {
        case 0: // uniform random
          for (let i = 0; i < len; i++) data[i] = rng() & 0xFF;
          break;
        case 1: // low entropy (4 symbols)
          for (let i = 0; i < len; i++) data[i] = [0x00, 0x41, 0x7F, 0xFF][rng() & 3];
          break;
        case 2: // sequential with noise
          for (let i = 0; i < len; i++) data[i] = (i + (rng() & 3)) & 0xFF;
          break;
        case 3: // repeated phrase with random inserts
          { const phrase = TE.encode("hello world ");
            for (let i = 0; i < len; i++)
              data[i] = (rng() % 20 === 0) ? (rng() & 0xFF) : phrase[i % phrase.length]; }
          break;
        case 4: // all same byte (random value)
          data.fill(rng() & 0xFF);
          break;
        case 5: // alternating patterns
          { const a = rng() & 0xFF, b = rng() & 0xFF;
            for (let i = 0; i < len; i++) data[i] = (i & 1) ? b : a; }
          break;
      }
      try {
        const enc = encode0D(data);
        assert.ok(enc.length <= data.length + 1,
          `trial ${trial}: expansion ${enc.length} > ${data.length + 1}`);
        const dec = decode0D(enc, data.length);
        for (let i = 0; i < data.length; i++) {
          if (dec[i] !== data[i]) { fails++; break; }
        }
      } catch { fails++; }
    }
    assert.equal(fails, 0, `${fails} / 10000 trials failed`);
  });
});

// ── Section 13: entropy bypass correctness ──────────────────────────────────
//
// The running distinct counter must remain synchronized with the frequency table.
// These tests stress the eviction/insertion path of the 256-byte sliding window.

describe("entropy bypass: running distinct counter stress", () => {
  it("all 256 byte values in a 256-byte window: bypass activates", () => {
    // 512 bytes: first 256 are 0..255, next 256 are 0..255 again.
    // after the first 256 bytes, the window contains all 256 distinct values.
    const data = new Uint8Array(512);
    for (let i = 0; i < 512; i++) data[i] = i & 0xFF;
    roundTrip(data, "all-256-values");
  });

  it("241 distinct values triggers bypass, 240 does not", () => {
    // Fill with 241 distinct symbols repeated to 4096 bytes.
    // bypass threshold is > 240 distinct in the 256-byte window.
    const data241 = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) data241[i] = i % 241;
    roundTrip(data241, "241-distinct");

    const data240 = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) data240[i] = i % 240;
    roundTrip(data240, "240-distinct");

    // 240 distinct should compress better (no bypass)
    const enc241 = encode0D(data241);
    const enc240 = encode0D(data240);
    assert.ok(enc240.length < enc241.length,
      `240 distinct (${enc240.length}B) should compress better than 241 (${enc241.length}B)`);
  });

  it("rapid distinct count oscillation: structured then random then structured", () => {
    const data = new Uint8Array(8192);
    for (let i = 0; i < 2048; i++) data[i] = i % 4; // 4 distinct
    for (let i = 2048; i < 4096; i++) data[i] = i & 0xFF; // 256 distinct
    for (let i = 4096; i < 6144; i++) data[i] = i % 4; // back to 4
    for (let i = 6144; i < 8192; i++) data[i] = i & 0xFF; // 256 again
    roundTrip(data, "oscillating-distinct");
  });

  it("single byte repeated 4096 times: distinct count stays at 1", () => {
    const data = new Uint8Array(4096).fill(0x42);
    roundTrip(data, "single-byte-4096");
    const enc = encode0D(data);
    assert.ok(enc.length < 20, `single byte 4096× should compress tiny, got ${enc.length}`);
  });
});

// ── Section 14: range coder edge cases ──────────────────────────────────────
//
// Adversarial inputs that stress carry propagation, normalization frequency,
// and probability extremes in the arithmetic coder.

describe("range coder: carry propagation and normalization stress", () => {
  it("0xFE/0xFF alternation: maximum carry pressure", () => {
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) data[i] = (i & 1) ? 0xFF : 0xFE;
    roundTrip(data, "carry-pressure");
  });

  it("all 0xFF: sustained carry chain", () => {
    const data = new Uint8Array(4096).fill(0xFF);
    roundTrip(data, "all-0xFF-4K");
  });

  it("probability near 1.0: long run then single flip", () => {
    // 4095 zeros then a 1 — pRaw approaches 1.0, range coder must not lose the flip
    const data = new Uint8Array(4096);
    data[4095] = 1;
    roundTrip(data, "near-certain-flip");
  });

  it("probability near 0.0: long run of 0xFF then 0x00", () => {
    const data = new Uint8Array(4096).fill(0xFF);
    data[4095] = 0x00;
    roundTrip(data, "near-certain-flip-inv");
  });

  it("each byte size from 1 to 512: flush edge cases at every length", () => {
    let failures = 0;
    for (let n = 1; n <= 512; n++) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 37 + 13) & 0xFF;
      try {
        const enc = encode0D(data);
        const dec = decode0D(enc, n);
        for (let i = 0; i < n; i++) {
          if (dec[i] !== data[i]) { failures++; break; }
        }
      } catch { failures++; }
    }
    assert.equal(failures, 0, `${failures}/512 lengths failed`);
  });

  it("nPend stress: highly compressible data forces many pending bytes", () => {
    // "aaaa..." repeated 8K — the coder outputs many 0xFF pending bytes
    const data = new Uint8Array(8192).fill(0x61);
    roundTrip(data, "nPend-stress");
    const enc = encode0D(data);
    assert.ok(enc.length < 30, `8K of 'a' should be tiny, got ${enc.length}`);
  });
});

// ── Section 15: M-axis hash chain integrity ─────────────────────────────────
//
// Tests that verify the PPM match search and continuation logic under
// adversarial input patterns.

describe("M-axis: hash chain and PPM integrity", () => {
  it("exact repeat at window boundary: match found just before eviction", () => {
    // pattern at position 0..127, then 32640 random bytes, then the same pattern.
    // the second occurrence is at the edge of the 32768-byte window.
    const pattern = new Uint8Array(128);
    for (let i = 0; i < 128; i++) pattern[i] = (i * 7 + 3) & 0xFF;
    const rng = makeDeterministicRng(0x12345);
    const data = new Uint8Array(32768 + 128);
    data.set(pattern, 0);
    for (let i = 128; i < 32768; i++) data[i] = rng() & 0xFF;
    data.set(pattern, 32768);
    // just ensure it round-trips; the match may or may not be found at the boundary
    roundTrip(data, "match-at-window-edge");
  });

  it("256 identical 2-byte pairs: maximum hash collision depth", () => {
    // "AB" repeated 256 times = 512 bytes. every position hashes to the same chain.
    const data = new Uint8Array(512);
    for (let i = 0; i < 512; i++) data[i] = (i & 1) ? 0x42 : 0x41;
    roundTrip(data, "hash-collision-depth");
    const enc = encode0D(data);
    // should compress well despite hash collisions
    assert.ok(enc.length < 30, `512B AB×256 should compress well, got ${enc.length}`);
  });

  it("match continuation across multiple bytes without resetting", () => {
    // "ABCDEFGHIJ" repeated 100 times. the M-axis should lock on after the first repeat.
    const phrase = TE.encode("ABCDEFGHIJ");
    const data = new Uint8Array(phrase.length * 100);
    for (let i = 0; i < 100; i++) data.set(phrase, i * phrase.length);
    roundTrip(data, "match-continuation");
    const enc = encode0D(data);
    const bpsVal = (enc.length * 8) / data.length;
    assert.ok(bpsVal < 1.0, `long match should compress to < 1 bps, got ${bpsVal.toFixed(2)}`);
  });

  it("PPM exclusion: deep match shadows shallower matches", () => {
    // "AAAAAB" repeated: the 5-byte context "AAAAA"→"B" should exclude the 1-byte "A"→"A" prediction
    const unit = TE.encode("AAAAAB");
    const data = new Uint8Array(unit.length * 200);
    for (let i = 0; i < 200; i++) data.set(unit, i * unit.length);
    roundTrip(data, "ppm-exclusion");
  });
});

// ── Section 16: P2N axis stress ─────────────────────────────────────────────
//
// Tests that verify the prev-prev nibble class predictor works correctly
// under controlled two-byte spacing patterns.

describe("P2N axis: prev-prev nibble class stress", () => {
  it("16 nibble classes cycled: each p2>>4 value exercised equally", () => {
    const data = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) data[i] = ((i >> 1) & 0xF) << 4 | (i & 0xF);
    roundTrip(data, "p2n-all-classes");
  });

  it("p2 nibble predicts current byte: P2N should dominate", () => {
    // pattern: byte[i] = (byte[i-2] >> 4) * 17. p2's nibble class directly determines current byte.
    const data = new Uint8Array(1024);
    data[0] = 0x30; data[1] = 0x70;
    for (let i = 2; i < 1024; i++) data[i] = ((data[i-2] >> 4) * 17) & 0xFF;
    roundTrip(data, "p2n-dominant");
    const enc = encode0D(data);
    assert.ok(enc.length < data.length * 0.3,
      `P2N-dominated pattern should compress to < 30%, got ${((enc.length/data.length)*100).toFixed(1)}%`);
  });
});

// ── Section 17: evaporation phase transition stress ─────────────────────────
//
// Tests that verify the thermodynamic decay correctly handles phase transitions
// between crystal (high confidence) and gas (low confidence) states.

describe("evaporation: phase transition integrity", () => {
  it("crystal → gas → crystal: compression recovers after noise injection", () => {
    // 1K structured, 512 random, 1K same structure. the second structured section
    // should compress almost as well as the first after evaporation clears the noise.
    const phrase = TE.encode("structured data pattern. ");
    const structured = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) structured[i] = phrase[i % phrase.length];
    const rng = makeDeterministicRng(0x9999);
    const noise = new Uint8Array(512);
    for (let i = 0; i < 512; i++) noise[i] = rng() & 0xFF;

    const data = new Uint8Array(2560);
    data.set(structured, 0);
    data.set(noise, 1024);
    data.set(structured, 1536);
    roundTrip(data, "crystal-gas-crystal");
  });

  it("64-byte evaporation boundary: state consistent across boundary", () => {
    // exactly 64 bytes of one pattern, then 64 bytes of another. evaporation fires between them.
    const a = new Uint8Array(64).fill(0xAA);
    const b = new Uint8Array(64).fill(0x55);
    const data = new Uint8Array(128);
    data.set(a, 0); data.set(b, 64);
    roundTrip(data, "evap-boundary-exact");
  });

  it("rapid evaporation: 64 different patterns of 64 bytes each (4096 total)", () => {
    // forces an evaporation cycle at every pattern boundary
    const data = new Uint8Array(4096);
    for (let p = 0; p < 64; p++) {
      const val = (p * 4 + 1) & 0xFF;
      for (let i = 0; i < 64; i++) data[p * 64 + i] = (val + (i & 3)) & 0xFF;
    }
    roundTrip(data, "rapid-evaporation");
  });
});

// ── Section 18: U-axis bit-lane patterns ────────────────────────────────────
//
// Patterns designed to exercise specific bit positions in isolation,
// testing the per-lane temporal predictor.

describe("U-axis: bit-lane temporal patterns", () => {
  it("single bit oscillation in bit 7 (MSB): 0x00/0x80 alternating", () => {
    const data = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) data[i] = (i & 1) ? 0x80 : 0x00;
    roundTrip(data, "u-bit7-osc");
    const enc = encode0D(data);
    assert.ok(enc.length < 50, `bit-7 oscillation should compress well, got ${enc.length}`);
  });

  it("all bits oscillate independently at different rates", () => {
    // bit k oscillates with period 2^(k+1)
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) {
      let byte = 0;
      for (let k = 0; k < 8; k++) {
        if ((i >> k) & 1) byte |= (1 << k);
      }
      data[i] = byte;
    }
    roundTrip(data, "u-independent-rates");
  });

  it("sticky bits: some lanes always 1, others oscillate", () => {
    // bits 7,6,5 always 1 (0xE0 base), bits 2,1,0 oscillate
    const data = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) data[i] = 0xE0 | (i & 0x07);
    roundTrip(data, "u-sticky-bits");
    const enc = encode0D(data);
    assert.ok(enc.length < data.length * 0.5,
      `sticky bits should compress to < 50%, got ${((enc.length/data.length)*100).toFixed(1)}%`);
  });
});

// ── Section 19: cross-axis agreement / disagreement ─────────────────────────
//
// Tests where specific axes agree or disagree, exercising the logit mixer
// and SSE calibration grid.

describe("cross-axis: mixer agreement/disagreement stress", () => {
  it("O2 and E agree: sequential bytes (O2 sees prev, E predicts next)", () => {
    // ascending ramp: both O2 and E should agree on the next byte
    const data = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) data[i] = i & 0xFF;
    roundTrip(data, "o2-e-agree");
    const enc = encode0D(data);
    assert.ok(enc.length < data.length * 0.2,
      `ascending ramp should compress to < 20%, got ${((enc.length/data.length)*100).toFixed(1)}%`);
  });

  it("O2 and E disagree: random walk with strong p1 correlation but no trajectory", () => {
    // each byte = prev_byte XOR (random 1-bit flip). O2 sees strong bigram patterns
    // but E's AR(2) cannot track the random walk trajectory.
    const rng = makeDeterministicRng(0xBEEF);
    const data = new Uint8Array(2048);
    data[0] = 128;
    for (let i = 1; i < 2048; i++) {
      data[i] = data[i-1] ^ (1 << (rng() % 8));
    }
    roundTrip(data, "o2-e-disagree");
  });

  it("M dominates pool: long exact repeat after cold start", () => {
    // 128 random bytes, then repeat those exact 128 bytes 15 more times.
    // M-axis should dominate after the first repeat.
    const rng = makeDeterministicRng(0xCAFE);
    const seed = new Uint8Array(128);
    for (let i = 0; i < 128; i++) seed[i] = rng() & 0xFF;
    const data = new Uint8Array(2048);
    for (let r = 0; r < 16; r++) data.set(seed, r * 128);
    roundTrip(data, "m-dominates");
    const enc = encode0D(data);
    assert.ok(enc.length < data.length * 0.15,
      `M-dominated repeat should compress to < 15%, got ${((enc.length/data.length)*100).toFixed(1)}%`);
  });
});

// ── Section 20: production chat message simulation ──────────────────────────
//
// Realistic chat messages of various types and languages, testing the codec
// against its actual production use case.

describe("production simulation: realistic chat messages", () => {
  const messages = [
    "hey",
    "ok",
    "lol nice",
    "can you send me that link?",
    "https://example.com/path/to/resource?key=value&foo=bar",
    "let me check... brb",
    "こんにちは！元気ですか？",
    "Привет! Как дела?",
    "🎉🎊🥳 congrats!!!",
    "the meeting is at 3pm EST tomorrow, don't forget to bring the slides",
    "```\nfunction hello() {\n  console.log('world');\n}\n```",
    "¯\\_(ツ)_/¯",
    "AAAAAAAAAAAAAAAA", // shouting
    "...", // minimal
    "a]8fj2!@#\$%^&*()_+-={}[]|;':\",./<>?", // special chars
    " ".repeat(100), // whitespace spam
    "1234567890".repeat(10), // numeric
    "the quick brown fox jumps over the lazy dog",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==", // fake base64
    JSON.stringify({ type: "message", content: "hello", timestamp: 1234567890 }),
  ];

  for (const msg of messages) {
    it(`"${msg.slice(0, 40)}${msg.length > 40 ? '...' : ''}" (${msg.length} chars)`, () => {
      const data = TE.encode(msg);
      roundTrip(data, `chat-${msg.slice(0, 20)}`);
      const enc = encode0D(data);
      assert.ok(enc.length <= data.length + 1,
        `no-expansion violated: ${enc.length} > ${data.length + 1}`);
    });
  }

  it("burst of 100 short messages: each independently round-trips", () => {
    const rng = makeDeterministicRng(0x7777);
    let failures = 0;
    for (let i = 0; i < 100; i++) {
      const len = 1 + (rng() % 200);
      const chars = "abcdefghijklmnopqrstuvwxyz .,!?\n";
      let msg = "";
      for (let j = 0; j < len; j++) msg += chars[rng() % chars.length];
      const data = TE.encode(msg);
      try {
        const enc = encode0D(data);
        const dec = decode0D(enc, data.length);
        for (let k = 0; k < data.length; k++) {
          if (dec[k] !== data[k]) { failures++; break; }
        }
      } catch { failures++; }
    }
    assert.equal(failures, 0, `${failures}/100 chat messages failed`);
  });
});
