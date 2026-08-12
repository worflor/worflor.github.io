import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const component = resolve(root, "src", "components", "FreelanceBrief.astro");
const contact = resolve(root, "src", "pages", "contact.astro");
const about = resolve(root, "src", "pages", "about.astro");
const home = resolve(root, "src", "pages", "index.astro");
const projects = resolve(root, "src", "pages", "projects.astro");

test("freelance brief preserves a visitor's words through the existing contact flow", () => {
  assert.ok(existsSync(component), "the shared freelance brief component should exist");
  const source = readFileSync(component, "utf8");

  const copy = readFileSync(resolve(root, "src", "config.ts"), "utf8");
  assert.match(copy, /Have a strange idea, a broken workflow, or a system that ought to exist\?/);
  assert.match(copy, /I build useful things from unclear beginnings\./);
  const config = readFileSync(resolve(root, "src", "config.ts"), "utf8");
  assert.match(config, /placeholder: "explain away"/);

  const contactSource = readFileSync(contact, "utf8");
  assert.match(contactSource, /sessionStorage\.getItem\(/, "contact should restore the stored brief");
  assert.match(contactSource, /announce\("brief"/, "contact should acknowledge where the brief began");

  assert.match(readFileSync(about, "utf8"), /FreelanceBrief/, "about should offer the entry point");
});

test("the composer lives in exactly one place", () => {
  // two copies of the same call to action does not double the chances, it reads
  // as a site that keeps asking. one canonical home, and every other surface
  // already has a better, more specific route to /contact.
  for (const page of [home, projects]) {
    assert.doesNotMatch(readFileSync(page, "utf8"), /FreelanceBrief/, `${page} should not duplicate the composer`);
  }
});

test("the visitor's sentence never reaches a url, a log or a referrer header", () => {
  const source = readFileSync(component, "utf8");

  assert.match(source, /sessionStorage\.setItem\(/, "brief text should travel in session storage");
  assert.doesNotMatch(source, /name=["']brief["']/, "the brief must not leak through GET parameters");

  // a named control inside the composer would be serialized into the query
  // string on any fallback submit, which is exactly the leak sessionStorage
  // exists to avoid. the textarea must stay anonymous.
  const composer = source.slice(source.indexOf("<form"), source.indexOf("</form>"));
  assert.doesNotMatch(composer, /<textarea[^>]*\sname=/, "the composer textarea must have no name");
  assert.doesNotMatch(composer, /method=["']get["']/i, "no GET submit should carry the field");
});

test("a blank-looking brief never navigates the visitor away empty-handed", () => {
  const source = readFileSync(component, "utf8");

  // `required` rejects "" but accepts "   ". without an explicit preventDefault
  // on the trimmed-empty path the form submits for real, landing the visitor on
  // a blank contact page with no message and nothing said about why.
  const handler = source.slice(source.indexOf('addEventListener("submit"'));
  const guard = handler.slice(0, handler.indexOf("sessionStorage.setItem"));
  assert.match(guard, /if \(!brief\) \{[\s\S]*event\.preventDefault\(\)/, "the empty path must stop the submit");
  assert.match(guard, /reportValidity\(\)/, "and must say why rather than failing silently");
});

test("one banner owns every way a visitor arrives at contact carrying context", () => {
  const contactSource = readFileSync(contact, "utf8");

  // two banners that "must agree" always drift. the project inquiry and the
  // freelance brief light the same element through the same function.
  const banners = contactSource.match(/class="(project|brief)-context"/g) ?? [];
  assert.equal(banners.length, 1, "there should be exactly one arrival banner element");
  assert.doesNotMatch(contactSource, /\.brief-context\s*\{/, "a second banner style would drift from the first");

  // the subject line is derived from the banner text rather than written twice.
  assert.match(contactSource, /function announce\(kind, name\)/);
  assert.match(contactSource, /announce\("inquiry", label\)/);
});

test("a carried brief is not silently eaten by the spam gate", () => {
  const contactSource = readFileSync(contact, "utf8");

  // the gate blocks a send that happens too soon after page load. a visitor who
  // typed their brief on the previous page would trip it with no feedback at
  // all, so arriving with a brief has to count as the interaction it was.
  assert.match(contactSource, /briefCarried/, "the brief arrival should be flagged for the spam gate");
  assert.match(
    contactSource,
    /elapsed < MIN_TIME_MS && !carriedBrief/,
    "the minimum-time gate must exempt a carried brief"
  );
});

test("one boolean opens and closes the slot everywhere at once", () => {
  const source = readFileSync(component, "utf8");
  const config = readFileSync(resolve(root, "src", "config.ts"), "utf8");
  const types = readFileSync(resolve(root, "src", "types", "config.ts"), "utf8");

  assert.match(config, /export const freelanceBriefContent/, "the switch should live with the rest of the content");
  assert.match(config, /enabled: (true|false)/);
  assert.match(types, /enabled: boolean/, "the switch should be typed, not a loose literal");

  // the component gates itself. a page that forgets to guard its own call is
  // the failure mode this avoids, so the check must not live at the call site.
  assert.match(source, /\{enabled && \(/, "the component should render nothing when the slot is closed");
  assert.match(source, /freelanceBriefContent/, "the component should read the one switch");

  // and the spacing belongs to the component, or a closed slot leaves a hole
  // where the composer used to separate the heading from the links below it.
  assert.match(source, /\.freelance-brief \{[^}]*margin: calc\(var\(--space-xl\) \* 1\.5\) 0 0/, "the component owns the gap above it");

  // no call-site wrapper may contribute spacing of its own, or switching the
  // slot off leaves that spacing behind with nothing inside it.
  const aboutSource = readFileSync(about, "utf8");
  const before = aboutSource.slice(0, aboutSource.indexOf("<FreelanceBrief"));
  const enclosing = before.slice(before.lastIndexOf("<"));
  assert.doesNotMatch(enclosing, /m[tby]?-\[/, "about should not wrap the composer in margin");
});

test("all composer copy is reachable from config, not frozen in the markup", () => {
  const source = readFileSync(component, "utf8");

  for (const key of ["kicker", "status", "heading", "subtitle", "placeholder", "submitLabel"]) {
    assert.match(source, new RegExp(`\\{${key}\\}`), `${key} should render from config`);
  }
});

test("availability is stated, not signalled by a coloured light", () => {
  const source = readFileSync(component, "utf8");

  // a pulsing status bead is decoration wearing the costume of data. the state
  // is a word at the end of a leader rule, so it can say something a dot never
  // could and it survives being read aloud.
  assert.doesNotMatch(source, /brief-live|brief-pulse/, "the status bead should be gone");
  assert.doesNotMatch(source, /tool-status-success/, "no status colour should remain here");
  assert.match(source, /\{status\}/, "the state should render as text");
});

test("the composer field is labelled and uniquely identified per source", () => {
  const source = readFileSync(component, "utf8");

  assert.match(source, /<label[^>]*for=\{fieldId\}/, "the textarea needs a real label, not just a placeholder");
  assert.match(source, /id=\{fieldId\}/);
  // ids are derived from the source string, so two instances on one page cannot
  // collide and break the label association.
  assert.match(source, /replace\(\/\[\^a-z0-9\]\+\/g, "-"\)/);
});
