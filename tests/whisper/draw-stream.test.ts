import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DRAW_STREAM_VERSION,
  encodeDrawStreamEvent,
  decodeDrawStreamEvent,
  chunkDrawPoints,
  DrawStreamTracker,
  type DrawStreamEvent,
} from "../../src/scripts/whisper/live-draw-stream.js";

describe("live-draw-stream", () => {
  it("round-trips begin/points/end frames", () => {
    const begin: DrawStreamEvent = {
      kind: "begin",
      seq: 10,
      strokeId: 7,
      tool: "pen",
      color: "#44aaee",
      width: 3.5,
      start: { x: 0.2, y: 0.4, p: 0.6 },
    };
    const points: DrawStreamEvent = {
      kind: "points",
      seq: 11,
      strokeId: 7,
      points: [
        { x: 0.21, y: 0.41, p: 0.61 },
        { x: 0.23, y: 0.44, p: 0.55 },
        { x: 0.26, y: 0.46, p: 0.70 },
      ],
    };
    const end: DrawStreamEvent = { kind: "end", seq: 12, strokeId: 7 };

    const b1 = encodeDrawStreamEvent(begin);
    const b2 = encodeDrawStreamEvent(points);
    const b3 = encodeDrawStreamEvent(end);

    assert.equal(b1[0], DRAW_STREAM_VERSION);
    assert.equal(decodeDrawStreamEvent(b1)?.kind, "begin");
    assert.equal(decodeDrawStreamEvent(b2)?.kind, "points");
    assert.equal(decodeDrawStreamEvent(b3)?.kind, "end");

    const decodedBegin = decodeDrawStreamEvent(b1);
    assert.ok(decodedBegin && decodedBegin.kind === "begin");
    assert.equal(decodedBegin.strokeId, begin.strokeId);
    assert.equal(decodedBegin.tool, begin.tool);
    assert.equal(decodedBegin.color, begin.color);

    const decodedPoints = decodeDrawStreamEvent(b2);
    assert.ok(decodedPoints && decodedPoints.kind === "points");
    assert.equal(decodedPoints.points.length, 3);
  });

  it("chunks points into bounded-size frames", () => {
    const points = Array.from({ length: 53 }, (_, i) => ({
      x: (i % 10) / 10,
      y: (i % 8) / 8,
      p: 0.5,
    }));

    const frames = chunkDrawPoints(9, 200, points, 24);
    assert.equal(frames.length, 3);
    assert.equal(frames[0].seq, 200);
    assert.equal(frames[1].seq, 201);
    assert.equal(frames[2].seq, 202);
    assert.equal(frames[0].points.length, 24);
    assert.equal(frames[1].points.length, 24);
    assert.equal(frames[2].points.length, 5);

    for (const frame of frames) {
      const payload = encodeDrawStreamEvent(frame);
      assert.ok(payload.length <= 255);
      const decoded = decodeDrawStreamEvent(payload);
      assert.ok(decoded && decoded.kind === "points");
    }
  });

  it("tracks peer draw state with sequence guards", () => {
    const tracker = new DrawStreamTracker();

    const begin: DrawStreamEvent = {
      kind: "begin",
      seq: 1,
      strokeId: 42,
      tool: "eraser",
      color: "#ffffff",
      width: 6,
      start: { x: 0.3, y: 0.5, p: 0.8 },
    };
    const points: DrawStreamEvent = {
      kind: "points",
      seq: 2,
      strokeId: 42,
      points: [{ x: 0.31, y: 0.5, p: 0.8 }],
    };
    const end: DrawStreamEvent = { kind: "end", seq: 3, strokeId: 42 };

    assert.equal(tracker.apply(begin).applied, true);
    assert.equal(tracker.apply(points).applied, true);
    assert.equal(tracker.snapshot().peerActive, true);
    assert.equal(tracker.snapshot().activeStrokeId, 42);

    const stale = tracker.apply({ ...points, seq: 2 });
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, "stale-seq");

    assert.equal(tracker.apply(end).applied, true);
    assert.equal(tracker.snapshot().peerActive, false);
    assert.equal(tracker.snapshot().activeStrokeId, null);
  });
});
