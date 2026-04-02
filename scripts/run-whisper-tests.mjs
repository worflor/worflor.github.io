import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const WHISPER_TEST_ROOT = resolve(ROOT, "tests", "whisper");
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");

const VERBOSE = process.env.WHISPER_TEST_VERBOSE === "1";
const REPORTER = process.env.WHISPER_TEST_REPORTER ?? (VERBOSE ? "spec" : "dot");

function collectWhisperTests(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectWhisperTests(fullPath, out);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(relative(ROOT, fullPath));
    }
  }
}

const testFiles = [];
collectWhisperTests(WHISPER_TEST_ROOT, testFiles);
testFiles.sort((a, b) => a.localeCompare(b));

if (testFiles.length === 0) {
  console.error("No Whisper test files found under tests/whisper");
  process.exit(1);
}

console.log(`Running ${testFiles.length} Whisper test files with reporter '${REPORTER}'.`);
if (!VERBOSE) {
  console.log("Set WHISPER_TEST_VERBOSE=1 for verbose per-test output.");
}

const args = [TSX_CLI, "--test", "--test-reporter", REPORTER, ...testFiles];
const result = spawnSync(process.execPath, args, {
  cwd: ROOT,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
