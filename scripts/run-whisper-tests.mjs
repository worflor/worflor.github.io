import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const WHISPER_TEST_ROOT = resolve(ROOT, "tests", "whisper");
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");

function collectWhisperTests(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectWhisperTests(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(relative(ROOT, fullPath));
  }
}

const testFiles = [];
collectWhisperTests(WHISPER_TEST_ROOT, testFiles);
testFiles.sort((a, b) => a.localeCompare(b));

if (testFiles.length === 0) {
  console.error("No Whisper test files found under tests/whisper");
  process.exit(1);
}

const result = spawnSync(process.execPath, [TSX_CLI, "--test", ...testFiles], { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
