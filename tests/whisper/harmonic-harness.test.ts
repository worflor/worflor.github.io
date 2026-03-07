import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHarmonicStressTest } from "./_helpers/harmonic-harness.ts";

describe("harmonic harness", () => {
  it("passes the standalone harmonic stress suite", async () => {
    const summary = await runHarmonicStressTest();
    assert.equal(summary.failCount, 0);
    assert.equal(summary.passCount, summary.totalTests);
  });
});