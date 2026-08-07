/**
 * L1 — property + structure-aware tests for the binary wire format (live-wire).
 *
 * Three ideas the example-based wire.test.ts can't express:
 *  - Structured arbitraries generate valid frames (correct flags / plausible
 *    fields) so fast-check's budget lands deep past the parser gate, plus a
 *    channel of mutated-valid frames to probe the hostile paths.
 *  - Canonical re-encode: parse(x) then re-serialize must reproduce the header
 *    region byte-for-byte. This is the format-ambiguity / malleability detector
 *    (two encodings of one frame, flag/body disagreement, redundant-field drift).
 *  - Totality: on ANY input, a parser returns a value or throws a PLAIN Error —
 *    never a RangeError/TypeError from an out-of-bounds DataView/subarray. Any
 *    such accidental throw is a finding.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { assertBytesEqual } from "./_helpers/assertions.js";
import {
  HEADER_SIZE,
  HEADER_SIZE_COMPACT,
  LIVE_FLAG_SAME_KEY,
  buildHeader,
  parseHeader,
  encodeFilePlaintext,
  decodeFilePlaintext,
  encodeFilePartPlaintext,
  decodeFilePartPlaintext,
} from "../../src/scripts/whisper/live-wire.js";

// ── totality helper ─────────────────────────────────────────────────────────
// runs a parser and classifies the outcome. A thrown value is a FINDING unless
// it is a *plain* Error (constructor === Error) — TypeError/RangeError signal an
// accidental out-of-bounds access rather than deliberate validation.
type Outcome<T> = { ok: true; value: T } | { ok: false; err: Error };
function total<T>(fn: () => T): Outcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (!(e instanceof Error)) assert.fail(`threw a non-Error value: ${String(e)}`);
    assert.equal(
      (e as Error).constructor,
      Error,
      `parser threw ${(e as Error).constructor.name} (accidental OOB?), not a plain validation Error: ${(e as Error).message}`,
    );
    return { ok: false, err: e as Error };
  }
}

// boundary-biased uint32 — the values that actually break length/counter logic.
const boundaryU32 = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 2, 255, 256, 65535, 65536, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 2 ** 32 - 1 }) },
);

const pubkeyArb = fc.uint8Array({ minLength: 33, maxLength: 33 });
const saltArb = fc.uint8Array({ minLength: 4, maxLength: 4 });
// full or compact, with extra flag bits set (only bit3 = SAME_KEY is structural)
const headerModelArb = fc.record({
  sameKey: fc.boolean(),
  extraFlags: fc.nat(255).map((f) => f & ~LIVE_FLAG_SAME_KEY),
  pubkey: pubkeyArb,
  counter: boundaryU32,
  prevChainLen: boundaryU32,
  salt: saltArb,
  ciphertext: fc.uint8Array({ minLength: 0, maxLength: 400 }),
});

// the installed fast-check does not export `Infer`; derive the model type from
// the arbitrary directly so this stays in step with headerModelArb by definition
// rather than by a second hand-maintained interface.
type HeaderModel = typeof headerModelArb extends fc.Arbitrary<infer T> ? T : never;

function serializeModel(m: HeaderModel): { packet: Uint8Array; headerLen: number; flags: number } {
  const flags = m.sameKey ? m.extraFlags | LIVE_FLAG_SAME_KEY : m.extraFlags;
  const header = buildHeader(flags, m.sameKey ? new Uint8Array(0) : m.pubkey, m.counter, m.prevChainLen, m.salt);
  const packet = new Uint8Array(header.length + m.ciphertext.length);
  packet.set(header, 0);
  packet.set(m.ciphertext, header.length);
  return { packet, headerLen: header.length, flags };
}

describe("live-wire — L1 property/structure-aware", () => {
  // ── build → parse round-trip over structured frames ──
  it("header round-trip: every field survives build → parse (full + compact, boundary values)", () => {
    fc.assert(
      fc.property(headerModelArb, (m) => {
        const { packet, flags } = serializeModel(m);
        const p = parseHeader(packet);
        assert.equal(p.flags, flags, "flags");
        assert.equal(p.counter, m.counter, "counter");
        assert.equal(p.prevChainLen, m.prevChainLen, "prevChainLen");
        assertBytesEqual(p.salt, m.salt, "salt");
        assertBytesEqual(p.ciphertext, m.ciphertext, "ciphertext");
        if (m.sameKey) {
          assert.equal(p.pubKey, null, "compact header has null pubKey");
        } else {
          assert.ok(p.pubKey, "full header has pubKey");
          assertBytesEqual(p.pubKey!, m.pubkey, "pubKey");
        }
      }),
      { numRuns: 400 },
    );
  });

  // ── canonical re-encode (ambiguity/malleability detector) ──
  it("canonical re-encode: buildHeader(parse(x)) reproduces the header region byte-for-byte", () => {
    fc.assert(
      fc.property(headerModelArb, (m) => {
        const { packet, headerLen } = serializeModel(m);
        const p = parseHeader(packet);
        const rebuilt = buildHeader(p.flags, p.pubKey ?? new Uint8Array(0), p.counter, p.prevChainLen, p.salt);
        assert.equal(rebuilt.length, headerLen, "re-encoded header length matches");
        assertBytesEqual(rebuilt, packet.subarray(0, headerLen), "header region is canonical");
      }),
      { numRuns: 400 },
    );
  });

  // ── nonzero-offset parse (parser-level aliasing) ──
  it("parse tolerates a packet at a nonzero byteOffset (DataView offset correctness)", () => {
    fc.assert(
      fc.property(headerModelArb, fc.nat(64), (m, pre) => {
        const { packet, flags } = serializeModel(m);
        const backing = new Uint8Array(pre + packet.length + 13);
        backing.fill(0x5a);
        backing.set(packet, pre);
        const view = backing.subarray(pre, pre + packet.length);
        const p = parseHeader(view);
        assert.equal(p.flags, flags, "flags at offset");
        assert.equal(p.counter, m.counter, "counter at offset");
        assert.equal(p.prevChainLen, m.prevChainLen, "prevChainLen at offset");
        assertBytesEqual(p.salt, m.salt, "salt at offset");
        assertBytesEqual(p.ciphertext, m.ciphertext, "ciphertext at offset");
      }),
      { numRuns: 300 },
    );
  });

  // ── totality on fully arbitrary bytes ──
  it("totality: parseHeader on ANY bytes returns or throws a plain Error (never OOB)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 200 }), (bytes) => {
        total(() => parseHeader(bytes));
      }),
      { numRuns: 1000 },
    );
  });

  // ── totality on mutated-valid frames (one edit from passing the gate) ──
  it("totality: mutated valid frames never crash the parser", () => {
    const mutate = fc.record({
      model: headerModelArb,
      flips: fc.array(fc.tuple(fc.nat(), fc.nat(255)), { maxLength: 4 }),
      truncateTo: fc.option(fc.nat(), { nil: undefined }),
    });
    fc.assert(
      fc.property(mutate, ({ model, flips, truncateTo }) => {
        let { packet } = serializeModel(model);
        packet = packet.slice();
        for (const [pos, val] of flips) if (packet.length) packet[pos % packet.length] = val;
        if (truncateTo !== undefined && packet.length) packet = packet.subarray(0, truncateTo % (packet.length + 1));
        total(() => parseHeader(packet));
      }),
      { numRuns: 800 },
    );
  });

  // ── file plaintext: round-trip + hostile view + totality ──
  const fileNameArb = fc.oneof(
    fc.constantFrom("hello.txt", "日本語ファイル.pdf", "photo.jpg", ".hidden", "a".repeat(200) + ".dat"),
    fc.string({ maxLength: 60 }),
    fc.fullUnicodeString({ maxLength: 40 }),
  );
  it("file plaintext: encode → decode round-trips fileType and bytes (Unicode names)", () => {
    fc.assert(
      fc.property(fileNameArb, fc.string({ maxLength: 40 }), fc.uint8Array({ maxLength: 3000 }), (name, type, bytes) => {
        const enc = encodeFilePlaintext(name, type, bytes);
        const dec = decodeFilePlaintext(enc);
        assert.equal(dec.fileType, type, "fileType");
        assertBytesEqual(dec.fileBytes, bytes, "fileBytes");
      }),
      { numRuns: 300 },
    );
  });
  it("totality: decodeFilePlaintext on ANY bytes returns or throws a plain Error", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), (bytes) => {
        total(() => decodeFilePlaintext(bytes));
      }),
      { numRuns: 800 },
    );
  });
  it("allocation guard: a nameLen field of 0xFFFFFFFF is rejected fast, no huge allocation", () => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setUint32(0, 0xffffffff, true);
    const t0 = performance.now();
    const r = total(() => decodeFilePlaintext(buf));
    assert.equal(r.ok, false, "must reject");
    assert.ok(performance.now() - t0 < 50, "must reject without a large allocation");
  });

  // ── FILE_PART: round-trip + validation totality ──
  it("file part chunk 0: round-trips all fields including name/type", () => {
    fc.assert(
      fc.property(
        fc.record({
          transferId: boundaryU32,
          totalChunks: fc.integer({ min: 1, max: 2 ** 20 }),
          totalFileSize: fc.integer({ min: 0, max: 2 ** 40 }),
          name: fileNameArb,
          type: fc.string({ maxLength: 30 }),
          data: fc.uint8Array({ maxLength: 2000 }),
        }),
        (m) => {
          const enc = encodeFilePartPlaintext(m.transferId, 0, m.totalChunks, m.totalFileSize, m.data, m.name, m.type);
          const dec = decodeFilePartPlaintext(enc);
          assert.equal(dec.transferId, m.transferId, "transferId");
          assert.equal(dec.chunkIndex, 0, "chunkIndex");
          assert.equal(dec.totalChunks, m.totalChunks, "totalChunks");
          assert.equal(dec.totalFileSize, m.totalFileSize, "totalFileSize");
          assert.equal(dec.fileType, m.type, "fileType");
          assertBytesEqual(dec.chunkData, m.data, "chunkData");
        },
      ),
      { numRuns: 250 },
    );
  });
  it("file part chunk N: round-trips without name/type", () => {
    fc.assert(
      fc.property(
        fc.record({
          transferId: boundaryU32,
          idx: fc.integer({ min: 1, max: 1000 }),
          extra: fc.integer({ min: 0, max: 1000 }),
          totalFileSize: fc.integer({ min: 0, max: 2 ** 40 }),
          data: fc.uint8Array({ maxLength: 2000 }),
        }),
        ({ transferId, idx, extra, totalFileSize, data }) => {
          const totalChunks = idx + 1 + extra;
          const enc = encodeFilePartPlaintext(transferId, idx, totalChunks, totalFileSize, data);
          const dec = decodeFilePartPlaintext(enc);
          assert.equal(dec.chunkIndex, idx, "chunkIndex");
          assert.equal(dec.fileName, undefined, "no name on chunk N");
          assertBytesEqual(dec.chunkData, data, "chunkData");
        },
      ),
      { numRuns: 250 },
    );
  });
  it("totality: decodeFilePartPlaintext on ANY bytes returns or throws a plain Error", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), (bytes) => {
        total(() => decodeFilePartPlaintext(bytes));
      }),
      { numRuns: 1000 },
    );
  });
});
