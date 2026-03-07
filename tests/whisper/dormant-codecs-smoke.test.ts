import { access } from "node:fs/promises";
import { describe, it } from "node:test";

const DORMANT_CODEC_MODULES = [
  "../../src/scripts/whisper/live-wasm-spatial.ts",
  "../../src/scripts/whisper/live-wasm-akasha.ts",
  "../../src/scripts/whisper/live-wasm-ku.ts",
  "../../src/scripts/whisper/live-wasm-loup.ts",
] as const;

async function fileExists(modulePath: string): Promise<boolean> {
  try {
    await access(new URL(modulePath, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

describe("dormant codec module smoke tests", () => {
  it("imports the higher-dimensional codec modules without running their manual benchmarks", async () => {
    const availableModules = [] as string[];

    for (const modulePath of DORMANT_CODEC_MODULES) {
      if (await fileExists(modulePath)) {
        availableModules.push(modulePath);
      }
    }

    for (const modulePath of availableModules) {
      await import(modulePath);
    }
  });
});