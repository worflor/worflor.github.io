import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DRAW_STREAM_VERSION,
  encodeDrawStreamEvent,
  decodeDrawStreamEvent,
  DrawStreamTracker,
  type DrawStreamEvent,
} from "../../src/scripts/whisper/live-draw-stream.js";
import {
  GlyphCodec,
  GlyphMode,
  GlyphStreamEncoder,
  GlyphStreamDecoder,
  GLYPH_BLOCK_SIZE,
  GLYPH_CHANNELS,
  GLYPH_CHANNEL_NAMES,
} from "../../src/scripts/whisper/live-wasm-glyph.js";

const CH = GLYPH_CHANNELS;

// build a seed array from x, y, p (remaining channels zero)
function seed(x: number, y: number, p: number): number[] {
  const s = new Array(CH).fill(0);
  s[0] = Math.round(x * 32767);
  s[1] = Math.round(y * 32767);
  s[2] = Math.round(p * 32767);
  return s;
}

// build a DrawNormPoint from x, y, p (remaining channels zero)
function normPoint(x: number, y: number, p: number): Record<string, number> {
  const pt: Record<string, number> = {};
  for (const ch of GLYPH_CHANNEL_NAMES) pt[ch] = 0;
  pt.x = x; pt.y = y; pt.p = p;
  return pt;
}

describe("live-draw-stream", () => {
  it("round-trips begin/glyph/end frames", () => {
    const begin: DrawStreamEvent = {
      kind: "begin",
      seq: 10,
      strokeId: 7,
      tool: "pen",
      color: "#44aaee",
      width: 3.5,
      start: normPoint(0.2, 0.4, 0.6) as any,
    };

    const sp = seed(0.2, 0.4, 0.6);
    const enc = new GlyphStreamEncoder(sp);
    let glyphData: Uint8Array | null = null;
    for (let i = 0; i < GLYPH_BLOCK_SIZE; i++) {
      const pt = seed(0.2 + i * 0.01, 0.4 + i * 0.01, 0.6);
      const result = enc.push(pt);
      if (result) glyphData = result;
    }
    assert.ok(glyphData !== null, "encoder should have emitted a block after GLYPH_BLOCK_SIZE pushes");

    const glyph: DrawStreamEvent = {
      kind: "glyph",
      seq: 11,
      strokeId: 7,
      data: glyphData!,
    };
    const end: DrawStreamEvent = { kind: "end", seq: 12, strokeId: 7 };

    const b1 = encodeDrawStreamEvent(begin);
    const b2 = encodeDrawStreamEvent(glyph);
    const b3 = encodeDrawStreamEvent(end);

    assert.equal(b1[0], DRAW_STREAM_VERSION);
    assert.equal(decodeDrawStreamEvent(b1)?.kind, "begin");
    assert.equal(decodeDrawStreamEvent(b2)?.kind, "glyph");
    assert.equal(decodeDrawStreamEvent(b3)?.kind, "end");

    const decodedBegin = decodeDrawStreamEvent(b1);
    assert.ok(decodedBegin && decodedBegin.kind === "begin");
    assert.equal(decodedBegin.strokeId, begin.strokeId);
    assert.equal(decodedBegin.tool, begin.tool);
    assert.equal(decodedBegin.color, begin.color);

    const decodedGlyph = decodeDrawStreamEvent(b2);
    assert.ok(decodedGlyph && decodedGlyph.kind === "glyph");
    assert.equal(decodedGlyph.strokeId, 7);
    assert.ok(decodedGlyph.data instanceof Uint8Array);
  });

  it("GlyphStreamEncoder emits blocks every GLYPH_BLOCK_SIZE points and decoder round-trips", () => {
    const start = seed(0.1, 0.1, 0.5);
    const enc = new GlyphStreamEncoder(start);
    const dec = new GlyphStreamDecoder(start);

    const inputPoints = Array.from({ length: GLYPH_BLOCK_SIZE * 2 }, (_, i) =>
      seed(0.1 + i * 0.005, 0.1 + i * 0.003, 0.5)
    );

    const blocks: Uint8Array[] = [];
    for (const pt of inputPoints) {
      const block = enc.push(pt);
      if (block) blocks.push(block);
    }

    assert.equal(blocks.length, 2);

    let decoded: number[] = [];
    for (const block of blocks) {
      const raw = dec.decode(block);
      for (let i = 0; i < raw.length; i += CH) {
        decoded.push(raw[i], raw[i + 1], raw[i + 2]);
      }
    }

    assert.equal(decoded.length, inputPoints.length * 3);
    for (let i = 0; i < inputPoints.length; i++) {
      const dx = Math.abs(decoded[i * 3] - inputPoints[i][0]);
      const dy = Math.abs(decoded[i * 3 + 1] - inputPoints[i][1]);
      const dp = Math.abs(decoded[i * 3 + 2] - inputPoints[i][2]);
      assert.ok(dx <= 2, `x round-trip error too large at index ${i}: ${dx}`);
      assert.ok(dy <= 2, `y round-trip error too large at index ${i}: ${dy}`);
      assert.ok(dp <= 2, `p round-trip error too large at index ${i}: ${dp}`);
    }
  });

  it("GlyphCodec exact round-trip under long multi-block stress", () => {
    const lcg = (seed: number) => {
      let state = seed | 0;
      return () => {
        state = (Math.imul(1664525, state) + 1013904223) | 0;
        return (state >>> 0) / 4294967296;
      };
    };

    const randInt = (next: () => number, min: number, max: number) =>
      (min + Math.floor(next() * (max - min + 1))) | 0;

    for (let trial = 0; trial < 40; trial++) {
      const rnd = lcg(9001 + trial * 17);
      const pointCount = 2 + GLYPH_BLOCK_SIZE * 80;
      const points = new Int32Array(pointCount * CH);

      for (let ch = 0; ch < CH; ch++) {
        points[ch] = randInt(rnd, -32767, 32767);
        points[CH + ch] = randInt(rnd, -32767, 32767);
      }

      for (let i = 2; i < pointCount; i++) {
        for (let ch = 0; ch < CH; ch++) {
          const predicted = (points[(i - 1) * CH + ch] << 1) - points[(i - 2) * CH + ch] + randInt(rnd, -8, 8);
          points[i * CH + ch] = Math.max(-32767, Math.min(32767, predicted));
        }
      }

      const blocks = GlyphCodec.encode(points);
      const packed = GlyphCodec.pack(blocks);
      const unpacked = GlyphCodec.unpack(packed);
      const s1 = Array.from(points.subarray(CH, CH * 2));
      const s0 = Array.from(points.subarray(0, CH));
      const decoded = GlyphCodec.decode(unpacked, s1, s0);

      assert.equal(decoded.length, points.length, `decoded length mismatch on trial ${trial}`);
      for (let i = 0; i < points.length; i++) {
        assert.equal(decoded[i], points[i], `exact mismatch at trial ${trial}, idx ${i}`);
      }
    }
  });

  it("GlyphCodec prefers linear mode on perfectly linear trajectories", () => {
    const pointCount = 2 + GLYPH_BLOCK_SIZE * 3;
    const points = new Int32Array(pointCount * CH);

    // seed point 0 and 1
    const init = [1200, 2400, 28000];
    const delta = [50, 60, -80];
    for (let ch = 0; ch < CH; ch++) {
      points[ch] = init[ch] ?? 0;
      points[CH + ch] = (init[ch] ?? 0) + (delta[ch] ?? 0);
    }

    for (let i = 2; i < pointCount; i++) {
      for (let ch = 0; ch < CH; ch++) {
        points[i * CH + ch] = Math.max(-32767, Math.min(32767,
          (points[(i - 1) * CH + ch] << 1) - points[(i - 2) * CH + ch]));
      }
    }

    const blocks = GlyphCodec.encode(points);
    assert.ok(blocks.length > 0);
    for (const b of blocks) {
      assert.equal(b.mode, GlyphMode.LINEAR, "linear trajectory should choose LINEAR mode");
    }
  });

  it("GlyphStreamDecoder handles empty/malformed payload safely", () => {
    const start = new Array(CH).fill(0);
    const dec = new GlyphStreamDecoder(start);
    const out = dec.decode(new Uint8Array(0));
    assert.equal(out.length, 0);
  });

  it("GlyphStreamDecoder rejects oversized malformed block counts", () => {
    const start = new Array(CH).fill(0);
    const dec = new GlyphStreamDecoder(start);
    const malformed = new Uint8Array([0x00, 0x1f]);
    const out = dec.decode(malformed);
    assert.equal(out.length, 0);
  });

  it("GlyphCodec.unpack drops truncated harmonic blocks", () => {
    const truncated = new Uint8Array([0x00, 0x00]);
    const blocks = GlyphCodec.unpack(truncated);
    assert.equal(blocks.length, 0);
  });

  it("tracks peer draw state with sequence guards", () => {
    const tracker = new DrawStreamTracker();

    const sp = seed(0.3, 0.5, 0.8);
    const enc2 = new GlyphStreamEncoder(sp);
    let glyphData2: Uint8Array | null = null;
    for (let i = 0; i < GLYPH_BLOCK_SIZE; i++) {
      const pt = seed(0.3 + i * 0.002, 0.5, 0.8);
      const result = enc2.push(pt);
      if (result) glyphData2 = result;
    }
    assert.ok(glyphData2 !== null);

    const begin: DrawStreamEvent = {
      kind: "begin",
      seq: 1,
      strokeId: 42,
      tool: "eraser",
      color: "#ffffff",
      width: 6,
      start: normPoint(0.3, 0.5, 0.8) as any,
    };
    const glyph: DrawStreamEvent = {
      kind: "glyph",
      seq: 2,
      strokeId: 42,
      data: glyphData2!,
    };
    const end: DrawStreamEvent = { kind: "end", seq: 3, strokeId: 42 };

    assert.equal(tracker.apply(begin).applied, true);
    assert.equal(tracker.apply(glyph).applied, true);
    assert.equal(tracker.snapshot().peerActive, true);
    assert.equal(tracker.snapshot().activeStrokeId, 42);

    const stale = tracker.apply({ ...glyph, seq: 2 });
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, "stale-seq");

    assert.equal(tracker.apply(end).applied, true);
    assert.equal(tracker.snapshot().peerActive, false);
    assert.equal(tracker.snapshot().activeStrokeId, null);
  });

  it("round-trips base snapshot events and tracker accepts ordered chunks", () => {
    const tracker = new DrawStreamTracker();
    const start: DrawStreamEvent = {
      kind: "base-start",
      seq: 20,
      snapshotId: 9,
      width: 640,
      height: 360,
      mime: "image/webp",
      chunkCount: 2,
    };
    const chunkA: DrawStreamEvent = {
      kind: "base-chunk",
      seq: 21,
      snapshotId: 9,
      chunkIndex: 0,
      data: new Uint8Array([1, 2, 3, 4]),
    };
    const chunkB: DrawStreamEvent = {
      kind: "base-chunk",
      seq: 22,
      snapshotId: 9,
      chunkIndex: 1,
      data: new Uint8Array([5, 6]),
    };
    const endBase: DrawStreamEvent = {
      kind: "base-end",
      seq: 23,
      snapshotId: 9,
    };

    for (const evt of [start, chunkA, chunkB, endBase]) {
      const encoded = encodeDrawStreamEvent(evt);
      const decoded = decodeDrawStreamEvent(encoded);
      assert.ok(decoded, `round-trip failed for ${evt.kind}`);
      assert.equal(decoded.kind, evt.kind);
    }

    assert.equal(tracker.apply(start).applied, true);
    assert.equal(tracker.apply(chunkA).applied, true);
    assert.equal(tracker.apply(chunkB).applied, true);
    assert.equal(tracker.apply(endBase).applied, true);
  });
});
