/**
 * Seed corpus generator for the membrane fuzz targets.
 *
 * A coverage-guided fuzzer starting from random bytes spends its whole budget
 * failing the first byte check. Seeding it with REAL encoder output puts it
 * inside the valid-frame region immediately, so mutation explores the decoder's
 * actual branches instead of its entry guard.
 *
 * Run: npx tsx tests/whisper/fuzz/make-corpus.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loopInit, loopEncode } from "../../../src/scripts/whisper/live-loop.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "corpus", "loop-decode");
mkdirSync(outDir, { recursive: true });

function baseBlock(): Uint8Array {
  const block = new Uint8Array(65536);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff;
  return block;
}

// spread across the shapes the coder actually branches on: empty, single byte,
// highly repetitive (compresses hard), incompressible, multi-byte utf8, and one
// large enough to cross the RAW threshold.
const samples: string[] = [
  "",
  "a",
  "hello world",
  "the quick brown fox jumps over the lazy dog",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  JSON.stringify({ a: 1, b: [1, 2, 3], c: "nested" }),
  "line1\nline2\nline3\n",
  "unicode: ÿ 中文 🙂🙃",
  "x".repeat(300),
  "y".repeat(4096),
];

const TE = new TextEncoder();
let n = 0;
for (const s of samples) {
  const state = loopInit(baseBlock());
  const plaintext = TE.encode(s);
  const { encoded, raw } = loopEncode(state, plaintext);
  const framed = raw ? Uint8Array.from([0xFF, ...encoded]) : encoded;

  // fuzz input layout: [4B declared length LE][framed coder payload]
  const out = new Uint8Array(4 + framed.length);
  const len = plaintext.length;
  out[0] = len & 0xff;
  out[1] = (len >>> 8) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 24) & 0xff;
  out.set(framed, 4);
  writeFileSync(join(outDir, `seed-${n++}.bin`), out);

  // and a deliberately DISHONEST twin: same payload, inflated declared length.
  // the length disagreeing with the payload is the shape that produced the RAW
  // truncation bug, so it belongs in the seed set rather than being left to luck.
  const lying = out.slice();
  lying[0] = 0xff;
  lying[1] = 0xff;
  writeFileSync(join(outDir, `seed-${n++}-lying.bin`), lying);
}

console.log(`wrote ${n} seeds to ${outDir}`);
