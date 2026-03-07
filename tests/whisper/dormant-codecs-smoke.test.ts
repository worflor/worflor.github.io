import { describe, it } from "node:test";

describe("dormant codec module smoke tests", () => {
  it("imports the higher-dimensional codec modules without running their manual benchmarks", async () => {
    await import("../../src/scripts/whisper/live-wasm-spatial.ts");
    await import("../../src/scripts/whisper/live-wasm-akasha.ts");
    await import("../../src/scripts/whisper/live-wasm-ku.ts");
    await import("../../src/scripts/whisper/live-wasm-loup.ts");
  });
});