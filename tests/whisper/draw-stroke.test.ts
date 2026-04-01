import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStrokeSampler, sampleStrokePoint } from "../../src/scripts/whisper/live-draw-stroke.js";

interface Pt {
  x: number;
  y: number;
  p: number;
  t: number;
  tilt: number;
  azimuth: number;
}

const LOGICAL_W = 1000;
const LOGICAL_H = 700;
const LEGACY_MIN_DIST_SQ = 2.25;

function keepLegacy(points: Pt[]): number {
  if (points.length === 0) return 0;
  let kept = 1;
  let last = points[0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const dx = (p.x - last.x) * LOGICAL_W;
    const dy = (p.y - last.y) * LOGICAL_H;
    if (dx * dx + dy * dy < LEGACY_MIN_DIST_SQ) continue;
    kept++;
    last = p;
  }
  return kept;
}

function keepAdaptive(points: Pt[]): number {
  if (points.length === 0) return 0;
  let kept = 1;
  const sampler = createStrokeSampler(points[0]);
  for (let i = 1; i < points.length; i++) {
    const r = sampleStrokePoint(sampler, points[i], LOGICAL_W, LOGICAL_H);
    if (r.keep) kept++;
  }
  return kept;
}

function genLine(samples: number, dtMs: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < samples; i++) {
    out.push({
      x: 0.08 + i * 0.002,
      y: 0.28,
      p: 0.5,
      t: i * dtMs,
      tilt: 0,
      azimuth: 0,
    });
  }
  return out;
}

function genCurve(samples: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    out.push({
      x: 0.12 + u * 0.72,
      y: 0.3 + Math.sin(u * Math.PI * 2) * 0.07,
      p: 0.55 + Math.sin(u * 5) * 0.08,
      t: i * 16,
      tilt: 0,
      azimuth: 0,
    });
  }
  return out;
}

function genSlowJitterLine(samples: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < samples; i++) {
    const jitter = Math.sin(i * 2.8) * 0.0009 + Math.sin(i * 0.37) * 0.00025;
    out.push({
      x: 0.15 + i * 0.0008,
      y: 0.34 + jitter,
      p: 0.5,
      t: i * 16,
      tilt: 0,
      azimuth: 0,
    });
  }
  return out;
}

describe("live-draw-stroke", () => {
  it("keeps fewer points at high speed than low speed", () => {
    const logicalW = 1000;
    const logicalH = 800;

    const slow = createStrokeSampler({ x: 0.1, y: 0.2, p: 0.5, t: 0, tilt: 0, azimuth: 0 });
    let slowKept = 1;
    for (let i = 1; i <= 120; i++) {
      const r = sampleStrokePoint(slow, { x: 0.1 + i * 0.0016, y: 0.2, p: 0.5, t: i * 16, tilt: 0, azimuth: 0 }, logicalW, logicalH);
      if (r.keep) slowKept++;
    }

    const fast = createStrokeSampler({ x: 0.1, y: 0.2, p: 0.5, t: 0, tilt: 0, azimuth: 0 });
    let fastKept = 1;
    for (let i = 1; i <= 120; i++) {
      const r = sampleStrokePoint(fast, { x: 0.1 + i * 0.0016, y: 0.2, p: 0.5, t: i, tilt: 0, azimuth: 0 }, logicalW, logicalH);
      if (r.keep) fastKept++;
    }

    assert.ok(fastKept < slowKept, `expected fastKept (${fastKept}) < slowKept (${slowKept})`);
  });

  it("preserves sharp turn points", () => {
    const logicalW = 1200;
    const logicalH = 900;
    const sampler = createStrokeSampler({ x: 0.2, y: 0.2, p: 0.5, t: 0, tilt: 0, azimuth: 0 });

    const p1 = sampleStrokePoint(sampler, { x: 0.23, y: 0.2, p: 0.5, t: 16, tilt: 0, azimuth: 0 }, logicalW, logicalH);
    assert.equal(p1.keep, true);

    // Tight direction change: mostly vertical after horizontal segment.
    const p2 = sampleStrokePoint(sampler, { x: 0.2315, y: 0.225, p: 0.5, t: 32, tilt: 0, azimuth: 0 }, logicalW, logicalH);
    assert.equal(p2.keep, true);
  });

  it("smooths pressure jitter into a stable sequence", () => {
    const logicalW = 1000;
    const logicalH = 700;
    const sampler = createStrokeSampler({ x: 0.4, y: 0.4, p: 0.5, t: 0, tilt: 0, azimuth: 0 });

    const inputs = [0.1, 0.9, 0.12, 0.88, 0.15, 0.85];
    const outputs: number[] = [];
    let x = 0.4;

    for (let i = 0; i < inputs.length; i++) {
      x += 0.01;
      const r = sampleStrokePoint(sampler, { x, y: 0.4, p: inputs[i], t: (i + 1) * 8, tilt: 0, azimuth: 0 }, logicalW, logicalH);
      outputs.push(r.point.p);
    }

    // Smoothed values should avoid raw extremes while remaining responsive.
    assert.ok(outputs.every(v => v > 0.12 && v < 0.88));
  });

  it("quantizes points to 1/16-pixel grid deterministically", () => {
    const logicalW = 640;
    const logicalH = 480;
    const sampler = createStrokeSampler({ x: 0.1, y: 0.1, p: 0.5, t: 0, tilt: 0, azimuth: 0 });

    const r = sampleStrokePoint(sampler, { x: 0.123456, y: 0.234567, p: 0.5, t: 16, tilt: 0, azimuth: 0 }, logicalW, logicalH);
    const pxX16 = Math.round(r.point.x * logicalW * 16);
    const pxY16 = Math.round(r.point.y * logicalH * 16);

    assert.equal(Math.abs(r.point.x * logicalW * 16 - pxX16) < 1e-8, true);
    assert.equal(Math.abs(r.point.y * logicalH * 16 - pxY16) < 1e-8, true);
  });

  it("adaptive sampler beats legacy density on fast strokes", () => {
    const fast = genLine(220, 1);
    const legacy = keepLegacy(fast);
    const adaptive = keepAdaptive(fast);
    assert.ok(adaptive < legacy, `adaptive (${adaptive}) should be < legacy (${legacy})`);
  });

  it("adaptive sampler matches legacy density on slow detail strokes", () => {
    const slow = genCurve(220);
    const legacy = keepLegacy(slow);
    const adaptive = keepAdaptive(slow);
    const ratio = adaptive / Math.max(1, legacy);
    assert.ok(ratio > 0.8 && ratio < 1.2, `adaptive/legacy ratio out of range: ${ratio}`);
  });

  it("suppresses slow mouse jitter while preserving endpoint responsiveness", () => {
    const raw = genSlowJitterLine(240);
    const sampler = createStrokeSampler(raw[0]);
    const kept: Pt[] = [raw[0]];

    for (let i = 1; i < raw.length; i++) {
      const r = sampleStrokePoint(sampler, raw[i], LOGICAL_W, LOGICAL_H);
      if (r.keep) kept.push({ x: r.point.x, y: r.point.y, p: r.point.p, t: raw[i].t, tilt: 0, azimuth: 0 });
    }

    const baseY = 0.34;
    const rawMeanAbs = raw.reduce((sum, p) => sum + Math.abs(p.y - baseY), 0) / raw.length;
    const keptMeanAbs = kept.reduce((sum, p) => sum + Math.abs(p.y - baseY), 0) / kept.length;
    assert.ok(
      keptMeanAbs < rawMeanAbs * 0.75,
      `expected filtered jitter (${keptMeanAbs}) < raw jitter (${rawMeanAbs})`,
    );

    const rawEndX = raw[raw.length - 1]!.x;
    const keptEndX = kept[kept.length - 1]!.x;
    assert.ok(
      Math.abs(rawEndX - keptEndX) < 0.004,
      `endpoint lag too high: raw=${rawEndX}, kept=${keptEndX}`,
    );
  });
});
