/**
 * Test data generators for Whisper test suite.
 * All generators are deterministic when seeded, random otherwise.
 */

import { randomBytes as cryptoRandomBytes } from "node:crypto";

export function randomBytes(n: number): Uint8Array {
  return new Uint8Array(cryptoRandomBytes(n));
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

/** Fake uncompressed P-256 public key (65 bytes, starts with 0x04). */
export function fakeP256PubKey(): Uint8Array {
  const buf = randomBytes(65);
  buf[0] = 0x04;
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
