import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runVideoCodecStressTest } from "./_helpers/video-codec-harness.ts";

describe("video codec harness", () => {
  it("passes the standalone video codec stress suite", async () => {
    const summary = await runVideoCodecStressTest();
    assert.equal(summary.fail, 0);
    assert.ok(summary.pass > 0);
  });
});