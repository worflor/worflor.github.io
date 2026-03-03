import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFilePlaintext, HEADER_SIZE } from "../../src/scripts/whisper/live-wire.js";
import { chunkMessagePrefixed } from "../../src/scripts/whisper/live-chunking.js";
import { loopExpand, loopInit, loopStep, loopEncode, type LoopState } from "../../src/scripts/whisper/live-loop.js";

type PayloadKind = "flat" | "structured" | "photo" | "ui";

interface CorpusCase {
  id: string;
  kind: PayloadKind;
  payloadSize: number;
  seed: number;
}

interface StageSizes {
  s1Webp: number;
  s2FilePlaintext: number;
  s3CompressedPayload: number;
  s4EncryptedWire: number;
  s5ChunkedWire: number;
  chunks: number;
}

interface CaseResult {
  id: string;
  kind: PayloadKind;
  payloadSize: number;
  sizes: StageSizes;
}

interface BenchmarkResult {
  cases: CaseResult[];
}

function xorshift32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

function payloadFlat(size: number, seed: number): Uint8Array {
  const rnd = xorshift32(seed);
  const out = new Uint8Array(size);
  const base = 0x90 + (rnd() % 16);
  for (let i = 0; i < size; i++) {
    // Very low entropy with tiny jitter: resembles flat/solid regions.
    out[i] = (base + ((i % 97 === 0) ? (rnd() % 3) : 0)) & 0xff;
  }
  return out;
}

function payloadStructured(size: number, seed: number): Uint8Array {
  const rnd = xorshift32(seed);
  const out = new Uint8Array(size);
  // Small dictionary + run-length feel: resembles line art + UI edges.
  const dict = [0x00, 0x10, 0x40, 0x80, 0x90, 0xb0, 0xd0, 0xf0];
  let i = 0;
  while (i < size) {
    const value = dict[rnd() % dict.length];
    const run = 8 + (rnd() % 72);
    const end = Math.min(size, i + run);
    for (; i < end; i++) out[i] = value;
  }
  // Inject periodic boundaries to mimic edge transitions.
  for (let j = 31; j < size; j += 137) out[j] ^= 0x1f;
  return out;
}

function payloadPhoto(size: number, seed: number): Uint8Array {
  const rnd = xorshift32(seed);
  const out = new Uint8Array(size);
  // Correlated but high entropy-ish stream.
  let prev = rnd() & 0xff;
  for (let i = 0; i < size; i++) {
    const delta = ((rnd() >>> 24) & 0x1f) - 16;
    prev = (prev + delta + (i & 1 ? 3 : -2)) & 0xff;
    out[i] = prev;
  }
  return out;
}

function payloadUi(size: number, seed: number): Uint8Array {
  const rnd = xorshift32(seed);
  const out = new Uint8Array(size);
  // Checker/stripe motifs with occasional noise spikes.
  for (let i = 0; i < size; i++) {
    const x = i & 63;
    const y = (i >>> 6) & 63;
    const cell = ((x >>> 3) ^ (y >>> 3)) & 1;
    let v = cell ? 0xe8 : 0x18;
    if ((i % 211) === 0) v ^= rnd() & 0x7f;
    out[i] = v;
  }
  return out;
}

function makePayload(kind: PayloadKind, size: number, seed: number): Uint8Array {
  switch (kind) {
    case "flat": return payloadFlat(size, seed);
    case "structured": return payloadStructured(size, seed);
    case "photo": return payloadPhoto(size, seed);
    case "ui": return payloadUi(size, seed);
  }
}

function sumChunkBytes(chunks: Uint8Array[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  return total;
}

async function prepareLoopState(seed: number): Promise<LoopState> {
  const key = new Uint8Array(32);
  const rnd = xorshift32(seed);
  for (let i = 0; i < 32; i++) key[i] = rnd() & 0xff;
  const sharedBlock = await loopExpand(key);
  key.fill(0);
  return loopInit(sharedBlock);
}

async function runBenchmark(corpus: CorpusCase[]): Promise<BenchmarkResult> {
  let sendState = await prepareLoopState(0x5eedc0de);
  const cases: CaseResult[] = [];

  for (const c of corpus) {
    const webpBytes = makePayload(c.kind, c.payloadSize, c.seed);
    const plaintext = encodeFilePlaintext(`${c.id}.webp`, "image/webp", webpBytes);

    const stepped = await loopStep(sendState);
    const encoded = loopEncode(stepped.next, plaintext);
    sendState = encoded.next;

    const s1Webp = webpBytes.length;
    const s2FilePlaintext = plaintext.length;
    const s3CompressedPayload = 4 + encoded.encoded.length; // decodedLen + loop payload

    // live.ts builds wire as [header(86)][ciphertext], where ciphertext len = payload + GCM tag(16)
    const ciphertextLen = s3CompressedPayload + 16;
    const s4EncryptedWire = HEADER_SIZE + ciphertextLen;

    const wireMessage = new Uint8Array(s4EncryptedWire);
    const chunks = chunkMessagePrefixed(wireMessage, 0x20);
    const s5ChunkedWire = sumChunkBytes(chunks);

    cases.push({
      id: c.id,
      kind: c.kind,
      payloadSize: c.payloadSize,
      sizes: {
        s1Webp,
        s2FilePlaintext,
        s3CompressedPayload,
        s4EncryptedWire,
        s5ChunkedWire,
        chunks: chunks.length,
      },
    });
  }

  return { cases };
}

function findCase(result: BenchmarkResult, id: string): CaseResult {
  const hit = result.cases.find(c => c.id === id);
  if (!hit) throw new Error(`missing case: ${id}`);
  return hit;
}

function transportOverheadRatio(s: StageSizes): number {
  // Chunk framing + per-chunk prefix/type overhead relative to encrypted wire bytes.
  return (s.s5ChunkedWire - s.s4EncryptedWire) / Math.max(1, s.s4EncryptedWire);
}

function compressionRatio(s: StageSizes): number {
  // Loop payload ratio after file envelope (smaller is better).
  return s.s3CompressedPayload / Math.max(1, s.s2FilePlaintext);
}

function netWireExpansionFromWebp(s: StageSizes): number {
  // How much wire expands relative to source payload.
  return s.s5ChunkedWire / Math.max(1, s.s1Webp);
}

describe("pictocanvas size benchmark harness", () => {
  const corpus: CorpusCase[] = [
    { id: "blank-light", kind: "flat", payloadSize: 18_000, seed: 0x11111111 },
    { id: "blank-medium", kind: "structured", payloadSize: 36_000, seed: 0x22222222 },
    { id: "blank-heavy", kind: "structured", payloadSize: 72_000, seed: 0x33333333 },
    { id: "annotate-photo", kind: "photo", payloadSize: 36_000, seed: 0x44444444 },
    { id: "annotate-ui", kind: "ui", payloadSize: 36_000, seed: 0x55555555 },
    { id: "pathological", kind: "photo", payloadSize: 96_000, seed: 0x66666666 },
  ];

  it("is deterministic across repeated runs", async () => {
    const a = await runBenchmark(corpus);
    const b = await runBenchmark(corpus);
    assert.deepEqual(a, b);
  });

  it("reports monotonic stage sizing and transport overhead", async () => {
    const r = await runBenchmark(corpus);
    for (const c of r.cases) {
      const s = c.sizes;
      assert.equal(s.s1Webp, c.payloadSize, `${c.id}: S1 must match payload size`);
      assert.ok(s.s2FilePlaintext > s.s1Webp, `${c.id}: S2 should include file metadata overhead`);
      assert.ok(s.s3CompressedPayload >= 5, `${c.id}: S3 must include len prefix + mode/payload`);
      assert.ok(s.s4EncryptedWire > s.s3CompressedPayload, `${c.id}: S4 should include header + tag`);
      assert.ok(s.s5ChunkedWire >= s.s4EncryptedWire, `${c.id}: S5 should include chunk framing overhead`);
      assert.ok(s.chunks >= 1, `${c.id}: chunk count must be >= 1`);
    }
  });

  it("captures expected entropy behavior (structured compresses better than photo at equal size)", async () => {
    const r = await runBenchmark(corpus);
    const structured = findCase(r, "blank-medium");
    const photo = findCase(r, "annotate-photo");

    assert.equal(structured.payloadSize, photo.payloadSize, "test pair must have same S1 size");

    const structuredRatio = structured.sizes.s3CompressedPayload / structured.sizes.s2FilePlaintext;
    const photoRatio = photo.sizes.s3CompressedPayload / photo.sizes.s2FilePlaintext;

    assert.ok(
      structuredRatio < photoRatio,
      `expected structured ratio (${structuredRatio.toFixed(4)}) < photo ratio (${photoRatio.toFixed(4)})`,
    );
  });

  it("shows chunking growth for large payloads", async () => {
    const r = await runBenchmark(corpus);
    const small = findCase(r, "blank-light");
    const large = findCase(r, "pathological");

    assert.ok(large.sizes.chunks > small.sizes.chunks, "large payload should produce more chunks");
    assert.ok(
      large.sizes.s5ChunkedWire - large.sizes.s4EncryptedWire >= small.sizes.s5ChunkedWire - small.sizes.s4EncryptedWire,
      "large payload should have at least as much chunk framing overhead as small payload",
    );
  });

  it("transport overhead ratio remains within stable CI envelope", async () => {
    const r = await runBenchmark(corpus);
    for (const c of r.cases) {
      const ratio = transportOverheadRatio(c.sizes);
      // CI envelope: chunk framing should be small vs encrypted wire payload.
      assert.ok(ratio >= 0 && ratio < 0.02, `${c.id}: transport overhead ratio out of range (${ratio.toFixed(4)})`);
    }
  });

  it("compression ordering remains sensible across payload classes", async () => {
    const r = await runBenchmark(corpus);
    const flat = findCase(r, "blank-light");
    const structured = findCase(r, "blank-medium");
    const photo = findCase(r, "annotate-photo");

    const flatCr = compressionRatio(flat.sizes);
    const structuredCr = compressionRatio(structured.sizes);
    const photoCr = compressionRatio(photo.sizes);

    // Structured/flat should compress at least as well as photo-like payloads.
    assert.ok(structuredCr < photoCr, `structured CR (${structuredCr.toFixed(4)}) should be < photo CR (${photoCr.toFixed(4)})`);
    assert.ok(flatCr <= photoCr, `flat CR (${flatCr.toFixed(4)}) should be <= photo CR (${photoCr.toFixed(4)})`);
  });

  it("end-to-end wire efficiency stays ordered and regression-resistant", async () => {
    const r = await runBenchmark(corpus);
    const light = findCase(r, "blank-light");
    const medium = findCase(r, "blank-medium");
    const photo = findCase(r, "annotate-photo");
    const heavy = findCase(r, "blank-heavy");

    const lightExp = netWireExpansionFromWebp(light.sizes);
    const mediumExp = netWireExpansionFromWebp(medium.sizes);
    const photoExp = netWireExpansionFromWebp(photo.sizes);
    const heavyExp = netWireExpansionFromWebp(heavy.sizes);

    // Efficient synthetic payloads can shrink below source bytes, but ordering should hold.
    assert.ok(lightExp <= photoExp, `blank-light expansion (${lightExp.toFixed(4)}) should be <= photo (${photoExp.toFixed(4)})`);
    assert.ok(mediumExp <= photoExp, `blank-medium expansion (${mediumExp.toFixed(4)}) should be <= photo (${photoExp.toFixed(4)})`);
    assert.ok(heavyExp <= photoExp * 1.2, `blank-heavy expansion (${heavyExp.toFixed(4)}) unexpectedly high vs photo (${photoExp.toFixed(4)})`);

    // Guard against transport blow-up relative to encrypted wire payload.
    for (const c of r.cases) {
      const transportRatio = transportOverheadRatio(c.sizes);
      assert.ok(transportRatio < 0.02, `${c.id}: transport ratio too high (${transportRatio.toFixed(4)})`);
    }
  });
});
