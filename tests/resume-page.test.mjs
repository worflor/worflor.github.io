import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const resumePage = resolve(root, "src", "pages", "resume.astro");

test("dummy deployment resume is fictional, private by design, and printable", () => {
  assert.ok(existsSync(resumePage), "src/pages/resume.astro should exist");

  const source = readFileSync(resumePage, "utf8");
  assert.match(source, /DUMMY DEPLOYMENT TEST/);
  assert.match(source, /AVERY EXAMPLE/);
  assert.match(source, /noindex:\s*true/);
  assert.match(source, /import ActionBar from "\.\.\/components\/ActionBar\.astro"/);
  assert.match(source, /label="Dummy resume actions"/);
  assert.doesNotMatch(source, /\.resume-actions\s*\{\s*position\s*:\s*sticky/);
  assert.match(source, /href="\/resume\.pdf"/);
  assert.match(source, /window\.print\(\)/);
  assert.match(source, /@media print/);
  assert.match(source, /--resume-bg:#fff/);
  assert.match(source, /\.resume-actions,footer \{ display:none !important; \}/);
  assert.doesNotMatch(source, /Michael Bickford|wofloemail@gmail\.com|Tim Hortons/i);
});
