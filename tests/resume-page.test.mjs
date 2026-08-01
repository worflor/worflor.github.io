import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const resumePage = resolve(root, "src", "pages", "resume.astro");
const dummyPdf = resolve(root, "public", "resume.pdf");

test("dummy deployment résumé is fictional, private by design, and directly downloadable", () => {
  assert.ok(existsSync(resumePage), "src/pages/resume.astro should exist");

  const source = readFileSync(resumePage, "utf8");
  assert.match(source, /DUMMY DEPLOYMENT TEST/);
  assert.match(source, /AVERY EXAMPLE/);
  assert.match(source, /noindex:\s*true/);
  assert.match(source, /import ActionBar from "\.\.\/components\/ActionBar\.astro"/);
  assert.match(source, /label="Dummy resume actions"/);
  assert.doesNotMatch(source, /\.resume-actions\s*\{\s*position\s*:\s*sticky/);
  assert.ok(existsSync(dummyPdf), "public/resume.pdf should remain a deployed fixture asset");
  assert.match(source, /href="\/resume\.pdf"[^>]*download="dummy-resume-deployment-test\.pdf"/, "the fixture PDF should be a direct-download action");
  assert.doesNotMatch(source, /window\.print\(\)/, "the primary UX should not invoke the browser print dialog");

  assert.doesNotMatch(source, /Michael Bickford|wofloemail@gmail\.com|Tim Hortons/i);
});
