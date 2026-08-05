// invariants for the resume pipeline. each assertion names its mutant: the
// concrete change that would make it fire. run standalone with
//   node --test tests/resume-page.test.mjs
// and in the deploy workflow after render-resume-pdf.mjs, where the built
// artifact checks are live rather than skipped.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (...p) => readFileSync(resolve(root, ...p), "utf8");

test("resume page carries the real content and stays out of search", () => {
  const source = read("src", "pages", "resume.astro");
  assert.match(source, /MICHAEL BICKFORD/);
  assert.match(source, /noindex:\s*true/);
  // mutant: the old dummy deployment fixture coming back
  assert.doesNotMatch(source, /DUMMY DEPLOYMENT TEST|AVERY EXAMPLE/);
  // location stays at province level. mutant: a city landing in the header
  assert.match(source, /Ontario, Canada/);
});

test("resume prose carries no em dashes", () => {
  // mutant: an em dash pasted into new copy
  assert.doesNotMatch(read("src", "pages", "resume.astro"), /—/);
});

test("print stylesheet keeps the full resume", () => {
  const source = read("src", "pages", "resume.astro");
  const print = source.slice(source.indexOf("@media print"));
  assert.ok(print.length > 200, "print block should exist");
  // mutant: hiding the rail again, which made save-as-pdf lose the
  // capabilities column that the official pdf carries
  assert.doesNotMatch(print, /\.rail\s*\{[^}]*display\s*:\s*none/);
  assert.doesNotMatch(print, /\.rail\s*\{\s*display\s*:\s*none/);
});

test("the pdf is generated, never committed", () => {
  // mutant: a hand-made resume.pdf dropped back into public/, restoring the
  // stale-copy drift this pipeline exists to kill
  assert.ok(
    !existsSync(resolve(root, "public", "resume.pdf")),
    "public/resume.pdf must not exist; dist/resume.pdf is rendered at deploy time",
  );
  assert.ok(existsSync(resolve(root, "scripts", "render-resume-pdf.mjs")));
  // mutant: the render or test step falling out of the deploy, which would
  // 404 the /resume.pdf link that config.ts publishes
  const workflow = read(".github", "workflows", "deploy.yml");
  assert.match(workflow, /render-resume-pdf\.mjs/);
  assert.match(read("src", "config.ts"), /\/resume\.pdf/);
});

test("generated pdf is well formed", () => {
  const pdfPath = resolve(root, "dist", "resume.pdf");
  if (!existsSync(pdfPath)) {
    // in ci the render step has already run, so a missing artifact there is
    // the exact failure this test exists to catch. locally, before a build,
    // there is nothing to check yet.
    assert.ok(
      !process.env.CI,
      "dist/resume.pdf missing in CI: the render step did not run before the tests",
    );
    return;
  }
  const pdf = readFileSync(pdfPath);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-", "missing pdf magic");
  const counts = [...pdf.toString("latin1").matchAll(/\/Count (\d+)/g)].map((m) => +m[1]);
  // mutant: content growth silently spilling onto a third page, or a render
  // failure producing a blank single page
  assert.equal(Math.max(0, ...counts), 2, "resume pdf should be exactly two pages");
  assert.ok(pdf.length > 20_000 && pdf.length < 5_000_000, `implausible size ${pdf.length}`);
});
