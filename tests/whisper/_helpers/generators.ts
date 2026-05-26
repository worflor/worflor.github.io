/**
 * Test data generators for Whisper test suite.
 * Random generators use crypto entropy. Deterministic helpers are provided
 * for reproducible stress/property tests.
 */

import { randomBytes as cryptoRandomBytes } from "node:crypto";

export function randomBytes(n: number): Uint8Array {
  return new Uint8Array(cryptoRandomBytes(n));
}

export function makeDeterministicRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 0x100000000;
  };
}

export function deterministicBytes(n: number, seed: number): Uint8Array {
  const rng = makeDeterministicRng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 256) | 0;
  return out;
}

export function deterministicUint16Array(n: number, seed: number): Uint16Array {
  const rng = makeDeterministicRng(seed);
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 65536) | 0;
  return out;
}

export function randomUint32(): number {
  return new DataView(cryptoRandomBytes(4).buffer).getUint32(0, true);
}

export function randomKey(): Uint8Array {
  return randomBytes(32);
}

export function randomNonce(): Uint8Array {
  return randomBytes(12);
}

export function randomPeerId(): Uint8Array {
  return randomBytes(16);
}

export function randomMsgId(): Uint8Array {
  return randomBytes(32);
}

/** Fake compressed P-256 public key (33 bytes, starts with 0x02 or 0x03). */
export function fakeP256PubKey(): Uint8Array {
  const buf = randomBytes(33);
  buf[0] = (buf[0] & 1) ? 0x03 : 0x02;
  return buf;
}

export function generateTestData(size: number, kind: "random" | "zeros" | "pattern" | "text"): Uint8Array {
  switch (kind) {
    case "random":
      return randomBytes(size);
    case "zeros":
      return new Uint8Array(size);
    case "pattern": {
      const buf = new Uint8Array(size);
      for (let i = 0; i < size; i++) buf[i] = i & 0xff;
      return buf;
    }
    case "text": {
      const te = new TextEncoder();
      const base = "The quick brown fox jumps over the lazy dog. ";
      let s = "";
      while (s.length < size) s += base;
      return te.encode(s.slice(0, size));
    }
  }
}

/** Generate a sine wave as Float32Array. */
export function sineWave(samples: number, freq: number, sampleRate: number): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return out;
}

/** Edge-case emoji for testing. */
export const TEST_EMOJIS = [
  "😀",            // basic
  "👍🏽",           // skin tone modifier
  "👨‍👩‍👧‍👦",  // ZWJ family
  "🏳️‍🌈",        // flag + ZWJ
  "🇯🇵",          // regional indicator (flag)
  "❤️",            // text presentation + VS16
  "🧑‍💻",         // ZWJ occupation
  "1️⃣",            // keycap
];

// ── glyph geometry generators ───────────────────────────────────────────────
// each produces Int32Array in [x, y, p, tilt, azimuth, ...] layout.

const GLYPH_CH = 5;

export function glyphCircle(cx: number, cy: number, r: number, n: number, pressure = 16000): Int32Array {
  const pts = new Int32Array(n * GLYPH_CH);
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    pts[i * GLYPH_CH] = Math.round(cx + r * Math.cos(theta));
    pts[i * GLYPH_CH + 1] = Math.round(cy + r * Math.sin(theta));
    pts[i * GLYPH_CH + 2] = pressure;
  }
  return pts;
}

export function glyphLine(x0: number, y0: number, dx: number, dy: number, n: number, pressure = 16000): Int32Array {
  const pts = new Int32Array(n * GLYPH_CH);
  for (let i = 0; i < n; i++) {
    pts[i * GLYPH_CH] = Math.round(x0 + dx * i);
    pts[i * GLYPH_CH + 1] = Math.round(y0 + dy * i);
    pts[i * GLYPH_CH + 2] = pressure;
  }
  return pts;
}

export function glyphEllipse(cx: number, cy: number, a: number, b: number, n: number, pressure = 16000): Int32Array {
  const pts = new Int32Array(n * GLYPH_CH);
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    pts[i * GLYPH_CH] = Math.round(cx + a * Math.cos(theta));
    pts[i * GLYPH_CH + 1] = Math.round(cy + b * Math.sin(theta));
    pts[i * GLYPH_CH + 2] = pressure;
  }
  return pts;
}

export function glyphSpiral(cx: number, cy: number, r0: number, growth: number, n: number): Int32Array {
  const pts = new Int32Array(n * GLYPH_CH);
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 4;
    const r = r0 + growth * i;
    pts[i * GLYPH_CH] = Math.round(cx + r * Math.cos(theta));
    pts[i * GLYPH_CH + 1] = Math.round(cy + r * Math.sin(theta));
    pts[i * GLYPH_CH + 2] = 16000;
  }
  return pts;
}

export function glyphLissajous(cx: number, cy: number, a: number, b: number, freqX: number, freqY: number, n: number): Int32Array {
  const pts = new Int32Array(n * GLYPH_CH);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts[i * GLYPH_CH] = Math.round(cx + a * Math.sin(freqX * t));
    pts[i * GLYPH_CH + 1] = Math.round(cy + b * Math.sin(freqY * t));
    pts[i * GLYPH_CH + 2] = 16000;
  }
  return pts;
}

export function glyphNoisyCircle(cx: number, cy: number, r: number, n: number, jitter: number, seed: number): Int32Array {
  let s = seed | 0;
  function rng() { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 0x100000000; }
  const pts = new Int32Array(n * GLYPH_CH);
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    pts[i * GLYPH_CH] = Math.round(cx + r * Math.cos(theta) + (rng() - 0.5) * jitter);
    pts[i * GLYPH_CH + 1] = Math.round(cy + r * Math.sin(theta) + (rng() - 0.5) * jitter);
    pts[i * GLYPH_CH + 2] = 16000;
  }
  return pts;
}

export function glyphZigzag(n: number, amplitude: number): Int32Array {
  const pts = new Int32Array(n * GLYPH_CH);
  for (let i = 0; i < n; i++) {
    pts[i * GLYPH_CH] = i * 200;
    pts[i * GLYPH_CH + 1] = (i % 2 === 0) ? amplitude : -amplitude;
    pts[i * GLYPH_CH + 2] = 16000;
  }
  return pts;
}

/** Edge-case filenames for testing. */
export const TEST_FILENAMES = [
  "normal.txt",
  "日本語ファイル.pdf",
  "file with spaces.doc",
  "CON",           // Windows reserved
  "PRN.txt",       // Windows reserved with ext
  "AUX",           // Windows reserved
  "NUL",           // Windows reserved
  "COM1",          // Windows reserved
  "LPT1",         // Windows reserved
  "../../../etc/passwd",  // path traversal
  "file\x00name",  // null byte
  "file\nname",    // newline
  ".hidden",
  "trailing. ",
  "dots...",
];
