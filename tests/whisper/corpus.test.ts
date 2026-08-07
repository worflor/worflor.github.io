/**
 * L5 — real-data corpus tests.
 *
 * Feeds the vendored UCI SMS Spam Collection sample (real human SMS text, CC BY
 * 4.0 — see tests/whisper/corpus/LICENSE-DATA.md) through both the membrane and
 * the Double Ratchet channel. Real text has different byte-entropy and Unicode
 * structure than random bytes, exercising the adaptive coders' Bit1/BitX
 * (inter-byte / transition) models and the UTF-8 paths that synthetic random
 * data never reaches.
 *
 * If the corpus sample is absent (vendoring skipped), these tests no-op rather
 * than fail, so the suite stays green in a fresh checkout.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { loopInit, loopEncode, loopDecode, loopFingerprint } from "../../src/scripts/whisper/live-loop.js";
import { establishChannel, encrypt, decrypt } from "./_harness/channel.js";
import { randomBytes } from "./_helpers/generators.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, "corpus", "sms-sample.txt");
const TE = new TextEncoder();

function loadCorpus(): Uint8Array[] {
  if (!existsSync(corpusPath)) return [];
  const text = readFileSync(corpusPath, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => TE.encode(line));
}

function freshBlock(seed: number): Uint8Array {
  const b = new Uint8Array(65536);
  let s = seed >>> 0;
  for (let i = 0; i < b.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    b[i] = (s >>> 16) & 0xff;
  }
  return b;
}

const corpus = loadCorpus();

describe("L5 — real SMS corpus", () => {
  it("corpus is present and non-trivial", () => {
    if (corpus.length === 0) {
      console.log("  (corpus sample absent — L5 skipped)");
      return;
    }
    assert.ok(corpus.length >= 50, `expected >=50 messages, got ${corpus.length}`);
    const hasUnicode = corpus.some((m) => m.some((b) => b >= 0x80));
    assert.ok(hasUnicode, "corpus should contain non-ASCII bytes (real text)");
  });

  it("membrane: real text round-trips in lockstep across the whole corpus", () => {
    if (corpus.length === 0) return;
    const block = freshBlock(0x5a5a5a5a & 0x7fffffff);
    let enc = loopInit(new Uint8Array(block));
    let dec = loopInit(new Uint8Array(block));
    let origBytes = 0;
    let wireBytes = 0;

    for (let i = 0; i < corpus.length; i++) {
      const msg = corpus[i];
      const e = loopEncode(enc, msg);
      const wire = e.raw ? Uint8Array.of(0xff, ...e.encoded) : e.encoded;
      const d = loopDecode(dec, wire, msg.length);
      assertBytesEqual(d.decoded, msg, `corpus msg ${i} round-trip`);
      assert.equal(loopFingerprint(e.next), loopFingerprint(d.next), `corpus msg ${i} lockstep`);
      enc = e.next;
      dec = d.next;
      origBytes += msg.length;
      wireBytes += wire.length;
    }
    console.log(
      `  membrane over ${corpus.length} real SMS: ${origBytes}B plaintext -> ${wireBytes}B wire ` +
        `(${((100 * wireBytes) / origBytes).toFixed(1)}% of original)`,
    );
  });

  it("ratchet channel: real text encrypts and decrypts bidirectionally", async () => {
    if (corpus.length === 0) return;
    const ch = await establishChannel(randomBytes(32));
    // alternate directions so DH ratchets fire on real-text traffic
    for (let i = 0; i < Math.min(corpus.length, 120); i++) {
      const msg = corpus[i];
      const from = i % 2 === 0 ? ch.offerer : ch.answerer;
      const to = i % 2 === 0 ? ch.answerer : ch.offerer;
      const wire = await encrypt(from, msg, randomBytes(4));
      const res = await decrypt(to, wire, from.sendDirBit);
      assert.equal(res.status, "accept", `corpus msg ${i} decrypts`);
      if (res.status === "accept") assertBytesEqual(res.plaintext, msg, `corpus msg ${i} plaintext`);
    }
  });
});
