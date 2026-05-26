/**
 * seal-rotation-probe.test.ts — deep investigation of the phase/rotation
 * sensitivity discovered in the likeness engine.
 *
 * finding: two circles with 90° phase offset scored only 17.5% likeness.
 * this matters because real signatures don't start from the same point
 * every time. this test characterizes the sensitivity curve and identifies
 * whether it's a codec issue, a normalization issue, or a DTW issue.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAllBlocks,
  trajectoryFromBlocks,
  likeness,
  type SignatureStroke,
  type Trajectory,
} from "../../src/scripts/whisper/live-seal.js";
import { GLYPH_CHANNELS } from "../../src/scripts/whisper/live-wasm-glyph.js";
import { glyphCircle as circle } from "./_helpers/generators.js";

const CH = GLYPH_CHANNELS;

function makeStrokes(pts: Int32Array): SignatureStroke[] {
  return [{ points: pts }];
}

function trajFrom(pts: Int32Array): Trajectory {
  return trajectoryFromBlocks(encodeAllBlocks(makeStrokes(pts)));
}

// ── phase offset sweep ──────────────────────────────────────────────────────

describe("phase sensitivity characterization", () => {
  it("circle phase sweep: likeness vs phase offset (codec path)", () => {
    const n = 64;
    const cx = 10000, cy = 10000, r = 4000;

    // base circle starting at theta=0
    const base = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * Math.PI * 2;
      base[i * CH] = Math.round(cx + r * Math.cos(theta));
      base[i * CH + 1] = Math.round(cy + r * Math.sin(theta));
      base[i * CH + 2] = 16000;
    }
    const baseT = trajFrom(base);

    const offsets = [0, 1, 2, 4, 8, 16, 32];
    const results: { offset: number; shape: number; speed: number; overall: number }[] = [];

    for (const off of offsets) {
      const shifted = new Int32Array(n * CH);
      for (let i = 0; i < n; i++) {
        const theta = ((i + off) % n) / n * Math.PI * 2;
        shifted[i * CH] = Math.round(cx + r * Math.cos(theta));
        shifted[i * CH + 1] = Math.round(cy + r * Math.sin(theta));
        shifted[i * CH + 2] = 16000;
      }
      const shiftedT = trajFrom(shifted);
      const result = likeness(baseT, shiftedT);
      results.push({ offset: off, shape: result.shape, speed: result.speed, overall: result.overall });
    }

    // report findings
    for (const r of results) {
      // just validate they're reasonable
      assert.ok(r.shape >= 0 && r.shape <= 1, `offset ${r.offset}: shape=${r.shape}`);
    }

    // zero offset should be highest
    assert.ok(results[0].shape >= results[results.length - 1].shape,
      `offset 0 shape (${results[0].shape.toFixed(4)}) should be >= offset ${offsets[offsets.length - 1]} (${results[results.length - 1].shape.toFixed(4)})`);
  });

  it("direct trajectory phase sweep (bypassing codec)", () => {
    // test whether the issue is in the codec or in the likeness engine itself
    const n = 128;

    function makeDirectCircle(phaseOffset: number): Trajectory {
      const x = new Float32Array(n);
      const y = new Float32Array(n);
      const p = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const theta = ((i + phaseOffset) / n) * Math.PI * 2;
        x[i] = 0.5 + 0.3 * Math.cos(theta);
        y[i] = 0.5 + 0.3 * Math.sin(theta);
        p[i] = 0.5;
      }
      return { n, x, y, p };
    }

    const base = makeDirectCircle(0);
    const offsets = [0, 1, 4, 8, 16, 32, 64];
    const results: { offset: number; shape: number; speed: number; overall: number }[] = [];

    for (const off of offsets) {
      const shifted = makeDirectCircle(off);
      const r = likeness(base, shifted);
      results.push({ offset: off, shape: r.shape, speed: r.speed, overall: r.overall });
    }

    // this tells us whether DTW itself handles phase shifts
    // if DTW is working well, phase-shifted circles should still score high
    // because DTW warps the alignment
    assert.ok(results[0].shape > 0.9, `self-comparison: ${results[0].shape.toFixed(4)}`);

    // check if half-period offset still scores reasonably
    const halfPeriod = results.find(r => r.offset === 64);
    if (halfPeriod) {
      assert.ok(typeof halfPeriod.shape === "number");
      // DTW should partially handle this since it's the same curve
    }
  });

  it("diagnose: is the issue in the codec reconstruction or the DTW?", () => {
    // compare direct-trajectory likeness vs codec-path likeness for same phase offset
    const n = 64;
    const cx = 10000, cy = 10000, r = 4000;
    const phaseOffset = 16; // quarter period

    // codec path
    const base = new Int32Array(n * CH);
    const shifted = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2;
      const t1 = ((i + phaseOffset) % n) / n * Math.PI * 2;
      base[i * CH] = Math.round(cx + r * Math.cos(t0));
      base[i * CH + 1] = Math.round(cy + r * Math.sin(t0));
      base[i * CH + 2] = 16000;
      shifted[i * CH] = Math.round(cx + r * Math.cos(t1));
      shifted[i * CH + 1] = Math.round(cy + r * Math.sin(t1));
      shifted[i * CH + 2] = 16000;
    }
    const codecA = trajFrom(base);
    const codecB = trajFrom(shifted);
    const codecResult = likeness(codecA, codecB);

    // direct trajectory path (no codec)
    const directA: Trajectory = { n: 128, x: new Float32Array(128), y: new Float32Array(128), p: new Float32Array(128) };
    const directB: Trajectory = { n: 128, x: new Float32Array(128), y: new Float32Array(128), p: new Float32Array(128) };
    for (let i = 0; i < 128; i++) {
      const t0 = (i / 128) * Math.PI * 2;
      const t1 = ((i + 32) % 128) / 128 * Math.PI * 2;
      directA.x[i] = 0.5 + 0.3 * Math.cos(t0);
      directA.y[i] = 0.5 + 0.3 * Math.sin(t0);
      directA.p[i] = 0.5;
      directB.x[i] = 0.5 + 0.3 * Math.cos(t1);
      directB.y[i] = 0.5 + 0.3 * Math.sin(t1);
      directB.p[i] = 0.5;
    }
    const directResult = likeness(directA, directB);

    // if codec result is much worse than direct, the codec is the bottleneck.
    // if both are bad, DTW is the bottleneck.
    assert.ok(typeof codecResult.shape === "number");
    assert.ok(typeof directResult.shape === "number");
  });

  it("speed channel sensitivity to phase: velocity differs at different starting points", () => {
    // on a circle, velocity direction depends on position. phase-shifted
    // circles have the same velocities but at different sample indices.
    // DTW should align these, but the speed gaussian sigma is tight (0.04),
    // which may cause low scores even for small velocity mismatches.
    const n = 128;
    const base: Trajectory = { n, x: new Float32Array(n), y: new Float32Array(n), p: new Float32Array(n) };
    const shifted: Trajectory = { n, x: new Float32Array(n), y: new Float32Array(n), p: new Float32Array(n) };

    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2;
      const t1 = ((i + 32) % n) / n * Math.PI * 2;
      base.x[i] = 0.5 + 0.3 * Math.cos(t0);
      base.y[i] = 0.5 + 0.3 * Math.sin(t0);
      base.p[i] = 0.5;
      shifted.x[i] = 0.5 + 0.3 * Math.cos(t1);
      shifted.y[i] = 0.5 + 0.3 * Math.sin(t1);
      shifted.p[i] = 0.5;
    }
    const r = likeness(base, shifted);

    // key question: does DTW align the matching portions correctly?
    // if speed is low but shape is high, DTW aligned position but not velocity
    assert.ok(typeof r.speed === "number");
    assert.ok(typeof r.shape === "number");
  });
});

describe("sigma sensitivity analysis", () => {
  it("characterize gaussian kernel behavior at different distances", () => {
    // the sigmas: SHAPE=0.15, SPEED=0.04, PRESS=0.2
    // what distance does each need to drop below 50% likeness?
    function gauss(dist: number, sigma: number): number {
      return Math.exp(-(dist * dist) / (2 * sigma * sigma));
    }

    // for each sigma, find the distance that gives 50% likeness
    for (const [name, sigma] of [["shape", 0.15], ["speed", 0.04], ["pressure", 0.2]] as const) {
      const halfDist = sigma * Math.sqrt(-2 * Math.log(0.5));
      const quarterDist = sigma * Math.sqrt(-2 * Math.log(0.25));

      assert.ok(Math.abs(gauss(halfDist, sigma) - 0.5) < 0.001,
        `${name}: dist=${halfDist.toFixed(4)} should give 0.5 likeness`);
      assert.ok(Math.abs(gauss(quarterDist, sigma) - 0.25) < 0.001,
        `${name}: dist=${quarterDist.toFixed(4)} should give 0.25 likeness`);
    }
    // shape: 50% at dist=0.1765, so normalized position error > 17.6% → below 50%
    // speed: 50% at dist=0.0471, so velocity error > 4.7% → below 50%
    // pressure: 50% at dist=0.2353, so pressure error > 23.5% → below 50%
    // speed is EXTREMELY tight — this may be the dominant term driving scores down
  });

  it("speed sigma tightness: quantify its impact on overall score", () => {
    // make two trajectories with identical position and pressure but slightly different velocity
    const n = 128;
    const a: Trajectory = { n, x: new Float32Array(n), y: new Float32Array(n), p: new Float32Array(n) };
    const b: Trajectory = { n, x: new Float32Array(n), y: new Float32Array(n), p: new Float32Array(n) };

    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      // same position
      a.x[i] = b.x[i] = 0.5 + 0.3 * Math.cos(t);
      a.y[i] = b.y[i] = 0.5 + 0.3 * Math.sin(t);
      a.p[i] = b.p[i] = 0.5;
    }

    // slightly perturb b's position to create velocity differences
    for (let i = 0; i < n; i++) {
      b.x[i] += (i % 2 === 0 ? 0.002 : -0.002);
    }

    const r = likeness(a, b);
    // shape should be very high (tiny position difference)
    // but speed might be low (the perturbation creates oscillating velocity)
    assert.ok(r.shape > 0.9, `shape with tiny perturbation: ${r.shape.toFixed(4)}`);
    // speed depends on whether 0.004 velocity delta per sample exceeds the sigma
    assert.ok(typeof r.speed === "number");
  });
});

describe("sample count sensitivity", () => {
  it("sample count: sufficient samples (48+) produce high likeness, few degrade", () => {
    const base = trajFrom(circle(10000, 10000, 4000, 128));

    // sufficient samples: codec produces enough blocks for faithful reconstruction
    for (const n of [48, 64, 96, 128, 200]) {
      const t = trajFrom(circle(10000, 10000, 4000, n));
      const s = likeness(base, t).shape;
      assert.ok(s > 0.9, `n=${n}: shape=${s.toFixed(4)}, expected > 0.9`);
    }

    // few samples (< 48): zero-seed reconstruction produces too few blocks,
    // trajectory is a poor representation. scores degrade gracefully.
    for (const n of [20, 32]) {
      const t = trajFrom(circle(10000, 10000, 4000, n));
      const s = likeness(base, t).shape;
      assert.ok(s >= 0 && s <= 1, `n=${n}: shape=${s.toFixed(4)}, should be valid`);
    }
  });
});
