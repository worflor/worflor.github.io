import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDrawExportPlan } from "../../src/scripts/whisper/live-draw-export.js";

describe("live-draw-export", () => {
  it("returns bounded qualities with fallback <= primary", () => {
    const plan = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 640 * 480,
      strokeCount: 80,
      pointCount: 2200,
      coverageRatio: 0.24,
      uniquePenColors: 2,
      inkEntropyProxy: 0.35,
    });

    assert.ok(plan.primaryQuality >= 0.76 && plan.primaryQuality <= 0.93);
    assert.ok(plan.fallbackQuality >= 0.70 && plan.fallbackQuality <= 0.89);
    assert.ok(plan.fallbackQuality <= plan.primaryQuality);
    assert.ok(plan.fallbackSavingsRatio >= 0.01 && plan.fallbackSavingsRatio <= 0.10);
  });

  it("dense blank scribbles do not receive higher quality than sparse blanks", () => {
    const sparse = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 800 * 600,
      strokeCount: 10,
      pointCount: 180,
      coverageRatio: 0.04,
      uniquePenColors: 1,
      inkEntropyProxy: 0.08,
    });
    const dense = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 800 * 600,
      strokeCount: 140,
      pointCount: 7000,
      coverageRatio: 0.58,
      uniquePenColors: 1,
      inkEntropyProxy: 0.72,
    });

    assert.ok(dense.primaryQuality <= sparse.primaryQuality);
  });

  it("annotate mode preserves higher quality than blank under similar stats", () => {
    const blank = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 900 * 700,
      strokeCount: 70,
      pointCount: 2400,
      coverageRatio: 0.20,
      uniquePenColors: 2,
      inkEntropyProxy: 0.30,
    });
    const annotate = buildDrawExportPlan({
      mode: "annotate",
      logicalPixels: 900 * 700,
      strokeCount: 70,
      pointCount: 2400,
      coverageRatio: 0.20,
      uniquePenColors: 2,
      inkEntropyProxy: 0.30,
    });

    assert.ok(annotate.primaryQuality >= blank.primaryQuality);
  });

  it("larger resolutions trigger lower quality pressure", () => {
    const small = buildDrawExportPlan({
      mode: "annotate",
      logicalPixels: 320 * 240,
      strokeCount: 50,
      pointCount: 1600,
      coverageRatio: 0.18,
      uniquePenColors: 2,
      inkEntropyProxy: 0.25,
    });
    const large = buildDrawExportPlan({
      mode: "annotate",
      logicalPixels: 1280 * 900,
      strokeCount: 50,
      pointCount: 1600,
      coverageRatio: 0.18,
      uniquePenColors: 2,
      inkEntropyProxy: 0.25,
    });

    assert.ok(large.primaryQuality <= small.primaryQuality);
  });

  it("enables fallback probing for high-size-risk cases", () => {
    const risky = buildDrawExportPlan({
      mode: "annotate",
      logicalPixels: 1200 * 900,
      strokeCount: 30,
      pointCount: 500,
      coverageRatio: 0.08,
      uniquePenColors: 1,
      inkEntropyProxy: 0.20,
    });
    const mild = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 300 * 220,
      strokeCount: 6,
      pointCount: 70,
      coverageRatio: 0.30,
      uniquePenColors: 1,
      inkEntropyProxy: 0.08,
    });

    assert.equal(risky.tryFallback, true);
    assert.equal(mild.tryFallback, false);
  });

  it("multicolor blank scribbles bias lower quality and accept smaller fallback gains", () => {
    const mono = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 900 * 700,
      strokeCount: 120,
      pointCount: 4200,
      coverageRatio: 0.22,
      uniquePenColors: 1,
      inkEntropyProxy: 0.38,
    });
    const multi = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 900 * 700,
      strokeCount: 120,
      pointCount: 4200,
      coverageRatio: 0.22,
      uniquePenColors: 5,
      inkEntropyProxy: 0.66,
    });

    assert.ok(multi.primaryQuality < mono.primaryQuality);
    assert.ok(multi.fallbackQuality <= mono.fallbackQuality);
    assert.ok(multi.fallbackSavingsRatio <= mono.fallbackSavingsRatio);
  });

  it("higher entropy proxy lowers blank-mode quality and fallback threshold", () => {
    const lowEntropy = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 900 * 700,
      strokeCount: 90,
      pointCount: 2600,
      coverageRatio: 0.20,
      uniquePenColors: 2,
      inkEntropyProxy: 0.12,
    });
    const highEntropy = buildDrawExportPlan({
      mode: "blank",
      logicalPixels: 900 * 700,
      strokeCount: 90,
      pointCount: 2600,
      coverageRatio: 0.20,
      uniquePenColors: 2,
      inkEntropyProxy: 0.84,
    });

    assert.ok(highEntropy.primaryQuality < lowEntropy.primaryQuality);
    assert.ok(highEntropy.fallbackQuality <= lowEntropy.fallbackQuality);
    assert.ok(highEntropy.fallbackSavingsRatio <= lowEntropy.fallbackSavingsRatio);
  });
});
