/**
 * L3 (regression) — replays saved fuzzer crash artifacts through the parsers as
 * ordinary node:test cases, so every discovered crash becomes a permanent CI
 * regression. Drop any Jazzer crash-* artifact into tests/whisper/fuzz/regressions/
 * (commit it) and this file will assert the parsers stay total on it forever.
 *
 * With no artifacts present this is a no-op that still asserts the totality
 * contract on a small built-in seed set, so the harness is exercised in CI even
 * before the first crash is ever found.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHeader, decodeFilePlaintext, decodeFilePartPlaintext } from "../../src/scripts/whisper/live-wire.js";
import { loopInit, loopDecode, loopFingerprint } from "../../src/scripts/whisper/live-loop.js";
import {
  decodeCtrl,
  decodeSeenPayload,
  decodeReactPayload,
  decodeVotePayload,
  decodeStreamState,
  decodeFileCancelPayload,
  decodeCallAudio,
} from "../../src/scripts/whisper/live-ctrl.js";

const here = dirname(fileURLToPath(import.meta.url));
const regressionsDir = join(here, "fuzz", "regressions");

// parsers that may throw ONLY a plain validation Error (never TypeError/RangeError)
const plainErrorParsers: Array<(b: Uint8Array) => unknown> = [parseHeader, decodeFilePlaintext, decodeFilePartPlaintext];
// decoders that must NEVER throw (they return null on bad input)
const neverThrowDecoders: Array<(b: Uint8Array) => unknown> = [
  decodeCtrl,
  decodeSeenPayload,
  decodeReactPayload,
  decodeVotePayload,
  decodeStreamState,
  decodeFileCancelPayload,
  decodeCallAudio,
];

function assertTotal(bytes: Uint8Array, label: string): void {
  for (const p of plainErrorParsers) {
    try {
      p(bytes);
    } catch (e) {
      assert.ok(e instanceof Error && e.constructor === Error, `${label}: ${p.name} threw ${(e as Error)?.constructor?.name}`);
    }
  }
  for (const d of neverThrowDecoders) {
    try {
      d(bytes);
    } catch (e) {
      assert.fail(`${label}: ${d.name} threw instead of returning null: ${e}`);
    }
  }
}

describe("L3 — fuzz crash regressions", () => {
  it("built-in adversarial seeds stay total", () => {
    const seeds: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0x08]), // compact flag, truncated
      new Uint8Array([0x00]), // full flag, truncated
      Uint8Array.from({ length: 46 }, () => 0xff), // all-ones full header
      Uint8Array.from({ length: 13 }, (_, i) => (i === 0 ? 0x08 : 0xff)), // compact all-ones
      new Uint8Array([0x81, 0xff, 0x01]), // ctrl length-lie
    ];
    for (let i = 0; i < seeds.length; i++) assertTotal(seeds[i], `seed[${i}]`);
  });

  it("replays committed crash artifacts (if any)", () => {
    if (!existsSync(regressionsDir)) {
      return; // no crashes discovered yet — nothing to replay
    }
    const files = readdirSync(regressionsDir).filter((f) => !f.startsWith("."));
    for (const f of files) {
      const bytes = new Uint8Array(readFileSync(join(regressionsDir, f)));
      assertTotal(bytes, `regression ${f}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Membrane decoder regressions.
//
// The artifacts here came from loop-decode-hostile.fuzz.cjs, which drives
// loopDecode with an attacker-chosen declared length and payload — the surface
// a seated member reaches AFTER the AEAD tag verifies. Replaying them here means
// the findings stay pinned in ordinary CI, with no jazzer dependency.
//
// Fuzz-input layout: [4B declared length LE][framed coder payload].
// ─────────────────────────────────────────────────────────────────────────────
describe("L3 regression — membrane decoder artifacts", () => {
  function baseBlock(): Uint8Array {
    const block = new Uint8Array(65536);
    for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff;
    return block;
  }

  const artifacts = existsSync(regressionsDir)
    ? readdirSync(regressionsDir).filter((f) => f.startsWith("loop-decode"))
    : [];

  it("loopDecode stays total and length-honest on every saved artifact", () => {
    for (const name of artifacts) {
      const bytes = new Uint8Array(readFileSync(join(regressionsDir, name)));
      if (bytes.length < 5) continue;
      const declared = ((bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0) % 4096;
      const payload = bytes.subarray(4);
      const state = loopInit(baseBlock());
      const before = loopFingerprint(state);

      let result;
      try {
        result = loopDecode(state, payload, declared);
      } catch (e) {
        assert.ok(
          e instanceof Error && e.constructor === Error,
          `${name}: loopDecode threw a non-plain error (${(e as Error)?.constructor?.name})`,
        );
        assert.equal(loopFingerprint(state), before, `${name}: state moved on a throw`);
        continue;
      }
      // THE bug this artifact records: a RAW frame claiming more bytes than it
      // carries used to return a short buffer under a valid tag, desyncing both
      // sides' count models.
      assert.equal(
        result.decoded.length, declared,
        `${name}: declared ${declared} but returned ${result.decoded.length}`,
      );
      assert.equal(loopFingerprint(state), before, `${name}: state moved on success`);
    }
  });

  it("the artifact set is actually present (a silent empty run proves nothing)", () => {
    assert.ok(artifacts.length > 0, "no loop-decode artifacts found in fuzz/regressions");
  });
});
