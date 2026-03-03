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
  GlyphStreamEncoder,
  GlyphStreamDecoder,
  GLYPH_BLOCK_SIZE,
} from "../../src/scripts/whisper/live-wasm-glyph.js";

describe("live-draw-stream", () => {
  it("round-trips begin/glyph/end frames", () => {
    const begin: DrawStreamEvent = {
      kind: "begin",
      seq: 10,
      strokeId: 7,
      tool: "pen",
      color: "#44aaee",
      width: 3.5,
      start: { x: 0.2, y: 0.4, p: 0.6 },
    };

    // Build a glyph block by pushing GLYPH_BLOCK_SIZE points into an encoder
    const sp: [number, number, number] = [
      Math.round(0.2 * 32767),
      Math.round(0.4 * 32767),
      Math.round(0.6 * 32767),
    ];
    const enc = new GlyphStreamEncoder(sp, sp);
    let glyphData: Uint8Array | null = null;
    for (let i = 0; i < GLYPH_BLOCK_SIZE; i++) {
      const result = enc.push(
        Math.round((0.2 + i * 0.01) * 32767),
        Math.round((0.4 + i * 0.01) * 32767),
        Math.round(0.6 * 32767),
      );
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
    const start: [number, number, number] = [Math.round(0.1 * 32767), Math.round(0.1 * 32767), Math.round(0.5 * 32767)];
    const enc = new GlyphStreamEncoder(start, start);
    const dec = new GlyphStreamDecoder(start, start);

    const inputPoints: Array<[number, number, number]> = Array.from({ length: GLYPH_BLOCK_SIZE * 2 }, (_, i) => [
      Math.round((0.1 + i * 0.005) * 32767),
      Math.round((0.1 + i * 0.003) * 32767),
      Math.round(0.5 * 32767),
    ]);

    const blocks: Uint8Array[] = [];
    for (const [x, y, p] of inputPoints) {
      const block = enc.push(x, y, p);
      if (block) blocks.push(block);
    }

    // Exactly 2 blocks for 2 × GLYPH_BLOCK_SIZE points
    assert.equal(blocks.length, 2);

    // Decode each block and verify the points round-trip within quantisation error
    let decoded: number[] = [];
    for (const block of blocks) {
      const raw = dec.decode(block);
      for (let i = 0; i < raw.length; i += 3) {
        decoded.push(raw[i], raw[i + 1], raw[i + 2]);
      }
    }

    assert.equal(decoded.length, inputPoints.length * 3);
    for (let i = 0; i < inputPoints.length; i++) {
      const [ex, ey, ep] = inputPoints[i];
      const dx = Math.abs(decoded[i * 3] - ex);
      const dy = Math.abs(decoded[i * 3 + 1] - ey);
      const dp = Math.abs(decoded[i * 3 + 2] - ep);
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
      const points = new Int32Array(pointCount * 3);

      points[0] = randInt(rnd, -32767, 32767);
      points[1] = randInt(rnd, -32767, 32767);
      points[2] = randInt(rnd, 0, 32767);
      points[3] = randInt(rnd, -32767, 32767);
      points[4] = randInt(rnd, -32767, 32767);
      points[5] = randInt(rnd, 0, 32767);

      for (let i = 2; i < pointCount; i++) {
        const idx = i * 3;
        const prev = (i - 1) * 3;
        const prev2 = (i - 2) * 3;
        const px = (points[prev] << 1) - points[prev2] + randInt(rnd, -8, 8);
        const py = (points[prev + 1] << 1) - points[prev2 + 1] + randInt(rnd, -8, 8);
        const pp = (points[prev + 2] << 1) - points[prev2 + 2] + randInt(rnd, -4, 4);
        points[idx] = Math.max(-32767, Math.min(32767, px));
        points[idx + 1] = Math.max(-32767, Math.min(32767, py));
        points[idx + 2] = Math.max(0, Math.min(32767, pp));
      }

      const blocks = GlyphCodec.encode(points);
      const packed = GlyphCodec.pack(blocks);
      const unpacked = GlyphCodec.unpack(packed);
      const decoded = GlyphCodec.decode(unpacked, [points[3], points[4], points[5]], [points[0], points[1], points[2]]);

      assert.equal(decoded.length, points.length, `decoded length mismatch on trial ${trial}`);
      for (let i = 0; i < points.length; i++) {
        assert.equal(decoded[i], points[i], `exact mismatch at trial ${trial}, idx ${i}`);
      }
    }
  });

  it("GlyphStreamDecoder handles empty/malformed payload safely", () => {
    const start: [number, number, number] = [0, 0, 0];
    const dec = new GlyphStreamDecoder(start, start);
    const out = dec.decode(new Uint8Array(0));
    assert.equal(out.length, 0);
  });

  it("tracks peer draw state with sequence guards", () => {
    const tracker = new DrawStreamTracker();

    // Build a glyph block for the tracker test
    const sp: [number, number, number] = [Math.round(0.3 * 32767), Math.round(0.5 * 32767), Math.round(0.8 * 32767)];
    const enc2 = new GlyphStreamEncoder(sp, sp);
    let glyphData2: Uint8Array | null = null;
    for (let i = 0; i < GLYPH_BLOCK_SIZE; i++) {
      const result = enc2.push(
        Math.round((0.3 + i * 0.002) * 32767),
        Math.round(0.5 * 32767),
        Math.round(0.8 * 32767),
      );
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
      start: { x: 0.3, y: 0.5, p: 0.8 },
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
});
