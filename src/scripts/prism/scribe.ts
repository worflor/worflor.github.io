// prism-scribe.ts — Scribe module: document assembly from markdown + images.
// Merges multiple files in queue order into a single styled, print-ready HTML.

import { marked } from "marked";
import type { FileInfo } from "./engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScribeConfig {
  pageSize: "a4" | "letter";
  margins: "normal" | "narrow" | "wide";
  fontFamily: string;
  fontSize: number;
  lineSpacing: "single" | "1.15" | "1.5" | "double";
  syntaxHighlight: boolean;
  tableOfContents: boolean;
  coverPage: boolean;
  pageNumbers: boolean;
  pageBreaks: boolean;
  lineNumbers: boolean;
  wordWrap: boolean;
  headerRow: boolean;
}

export interface ScribeModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): DocumentBuildResult | null;
  getConfig(): ScribeConfig;
  setConfig(config: unknown): void;
  setFile(file: File): void;
  setFileQueue(queue: { file: File; info: FileInfo }[]): void;
  reset(): void;
}

export interface DocumentBuildResult {
  pipeline: "document";
  outputName: string;
  execute: () => Promise<Uint8Array>;
}

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── UI Controls ─────────────────────────────────────────────────────────────

function createSegments(
  options: { value: string; label: string }[],
  selected: string,
  onChange: (v: string) => void,
): HTMLElement {
  const group = el("div", "scr-seg-group");
  for (const opt of options) {
    const btn = el("button", `scr-seg${opt.value === selected ? " scr-seg--on" : ""}`, opt.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      group.querySelectorAll(".scr-seg").forEach(s => s.classList.remove("scr-seg--on"));
      btn.classList.add("scr-seg--on");
      onChange(opt.value);
    });
    group.appendChild(btn);
  }
  return group;
}

function createStepper(
  values: number[],
  current: number,
  format: (v: number) => string,
  onChange: (v: number) => void,
): HTMLElement {
  const wrap = el("div", "scr-stepper");
  let idx = values.indexOf(current);
  if (idx < 0) idx = 2;

  const minus = el("button", "scr-stepper-btn", "\u2212");
  const display = el("span", "scr-stepper-val", format(values[idx]));
  const plus = el("button", "scr-stepper-btn", "+");
  minus.type = "button";
  plus.type = "button";

  function sync() {
    display.textContent = format(values[idx]);
    minus.disabled = idx === 0;
    plus.disabled = idx === values.length - 1;
    onChange(values[idx]);
  }
  minus.disabled = idx === 0;
  plus.disabled = idx === values.length - 1;
  minus.addEventListener("click", () => { if (idx > 0) { idx--; sync(); } });
  plus.addEventListener("click", () => { if (idx < values.length - 1) { idx++; sync(); } });

  wrap.append(minus, display, plus);
  return wrap;
}

function createToggle(
  label: string, checked: boolean, onChange: (v: boolean) => void,
): HTMLElement {
  const row = el("div", "scr-feat-row");
  row.appendChild(el("span", "scr-feat-label", label));
  const sw = el("button", `scr-switch${checked ? " scr-switch--on" : ""}`);
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(checked));
  sw.addEventListener("click", () => {
    const next = !sw.classList.contains("scr-switch--on");
    sw.classList.toggle("scr-switch--on", next);
    sw.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  row.appendChild(sw);
  return row;
}

// ─── Font Discovery ─────────────────────────────────────────────────────────

/** Common fonts across Windows, macOS, Linux — probed at runtime for availability. */
const PROBE_FONTS = [
  // Sans-serif
  "Arial", "Helvetica", "Helvetica Neue", "Segoe UI", "Roboto", "Inter",
  "San Francisco", "SF Pro", "Noto Sans", "Open Sans", "Lato", "Montserrat",
  "Verdana", "Tahoma", "Trebuchet MS", "Calibri", "Candara", "Gill Sans",
  "Optima", "Futura", "Century Gothic", "Franklin Gothic Medium",
  "Lucida Sans", "Lucida Grande", "Ubuntu", "DejaVu Sans", "Liberation Sans",
  "Cantarell", "Fira Sans", "Source Sans Pro", "IBM Plex Sans",
  // Serif
  "Times New Roman", "Georgia", "Garamond", "Palatino", "Palatino Linotype",
  "Book Antiqua", "Cambria", "Constantia", "Didot", "Baskerville",
  "Big Caslon", "Bodoni MT", "Cochin", "Hoefler Text",
  "Noto Serif", "DejaVu Serif", "Liberation Serif",
  "Source Serif Pro", "IBM Plex Serif", "Merriweather",
  // Monospace
  "Consolas", "Courier New", "Courier", "Monaco", "Menlo",
  "SF Mono", "Fira Code", "Fira Mono", "JetBrains Mono",
  "Source Code Pro", "IBM Plex Mono", "Cascadia Code", "Cascadia Mono",
  "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono",
  "Inconsolata", "Hack", "Iosevka", "Victor Mono",
  // Display / Handwriting / Fun
  "Impact", "Comic Sans MS", "Brush Script MT", "Papyrus",
  "Copperplate", "Rockwell", "Luminari", "Trattatello",
  "Segoe Print", "Segoe Script", "Ink Free",
];

let cachedAvailable: string[] | null = null;
let discoveryPromise: Promise<string[]> | null = null;

function discoverFonts(): Promise<string[]> {
  if (cachedAvailable) return Promise.resolve(cachedAvailable);
  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = (async () => {
    // Try Local Font Access API (Chrome/Edge 103+)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fonts: any[] = await (navigator as any).fonts.query();
      const families = new Set<string>();
      for (const f of fonts) families.add(f.family);
      cachedAvailable = [...families].sort((a, b) => a.localeCompare(b));
      return cachedAvailable;
    } catch { /* not available */ }

    // Fallback: canvas-based font probe
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) { cachedAvailable = []; return []; }

    const testStr = "mmmmmmmmlli1|WQ@#";
    const size = "48px";
    const baselines = new Map<string, number>();

    // Measure with generic fallbacks
    for (const base of ["monospace", "sans-serif", "serif"]) {
      ctx.font = `${size} ${base}`;
      baselines.set(base, ctx.measureText(testStr).width);
    }

    const available: string[] = [];
    for (const name of PROBE_FONTS) {
      let detected = false;
      for (const base of ["monospace", "sans-serif", "serif"]) {
        ctx.font = `${size} '${name}', ${base}`;
        if (ctx.measureText(testStr).width !== baselines.get(base)!) {
          detected = true;
          break;
        }
      }
      if (detected) available.push(name);
    }
    cachedAvailable = available;
    return cachedAvailable;
  })();

  return discoveryPromise;
}

// ─── File I/O ────────────────────────────────────────────────────────────────

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

type SourceKind = "markdown" | "code" | "data" | "image";

interface CachedEntry {
  name: string;
  category: FileInfo["category"];
  /** Original source kind before conversion (e.g. "code" for .json even though category becomes "markdown") */
  source: SourceKind;
  text?: string;
  dataUrl?: string;
}

const EXT_LANG: Record<string, string> = {
  json: "json", xml: "xml", yaml: "yaml", yml: "yaml",
  toml: "toml", log: "", ini: "ini", cfg: "ini", conf: "ini",
};

/** Parse a single CSV/TSV line respecting RFC 4180 quoted fields. */
function parseCsvLine(line: string, sep: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(""); break; }
    if (line[i] === '"') {
      // Quoted field: collect until closing quote (doubled quotes = literal)
      let val = "";
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          val += line[i++];
        }
      }
      fields.push(val);
      if (i < line.length && line[i] === sep) i++; // skip separator after quoted field
    } else {
      // Unquoted field: collect until separator or EOL
      const next = line.indexOf(sep, i);
      if (next === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, next));
      i = next + 1;
    }
  }
  return fields;
}

/** Escape pipe characters so they don't break markdown table cell boundaries. */
function escPipe(s: string): string {
  return s.replace(/\|/g, "\\|").trim();
}

function csvToMarkdownTable(raw: string, sep: string, headerRow: boolean): string {
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return "";
  const rows = lines.map(l => parseCsvLine(l, sep));
  const cols = Math.max(...rows.map(r => r.length));
  const pad = (r: string[]) => { while (r.length < cols) r.push(""); return r; };
  const fmt = (r: string[]) => "| " + r.map(escPipe).join(" | ") + " |";

  let header: string[];
  let body: string[][];
  if (headerRow) {
    header = pad(rows[0]);
    body = rows.slice(1).map(r => pad(r));
  } else {
    // Auto-generate column headers (A, B, C, …)
    header = Array.from({ length: cols }, (_, i) =>
      i < 26 ? String.fromCharCode(65 + i) : `Col ${i + 1}`,
    );
    body = rows.map(r => pad(r));
  }

  const divider = header.map(() => "---");
  return [fmt(header), fmt(divider), ...body.map(fmt)].join("\n");
}

const DATA_EXTS = new Set(["csv", "tsv"]);

async function readQueueEntries(
  entries: { file: File; info: FileInfo }[],
  headerRow: boolean,
): Promise<CachedEntry[]> {
  return Promise.all(entries.map(async ({ file, info }) => {
    if (info.category === "markdown") {
      return { name: file.name, category: info.category, source: "markdown" as SourceKind, text: await file.text() };
    } else if (info.category === "image") {
      return { name: file.name, category: info.category, source: "image" as SourceKind, dataUrl: await fileToDataUrl(file) };
    } else if (info.category === "text") {
      const raw = await file.text();
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      let text: string;
      let source: SourceKind;
      if (DATA_EXTS.has(ext)) {
        text = csvToMarkdownTable(raw, ext === "tsv" ? "\t" : ",", headerRow);
        source = "data";
      } else {
        const lang = EXT_LANG[ext] ?? "";
        text = "```" + lang + "\n" + raw + "\n```";
        source = "code";
      }
      return { name: file.name, category: "markdown" as FileInfo["category"], source, text };
    }
    return { name: file.name, category: info.category, source: "markdown" as SourceKind };
  }));
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

interface Frontmatter { title?: string; author?: string; date?: string; subtitle?: string }

function parseFrontmatter(text: string): { meta: Frontmatter; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (key === "title") meta.title = val;
    else if (key === "author") meta.author = val;
    else if (key === "date") meta.date = val;
    else if (key === "subtitle") meta.subtitle = val;
  }
  return { meta, body: match[2] };
}

// ─── Image Resolution ────────────────────────────────────────────────────────

function resolveImageRefs(
  markdown: string, images: CachedEntry[],
): { text: string; usedNames: Set<string> } {
  const usedNames = new Set<string>();
  const imageMap = new Map<string, string>();
  for (const img of images) { if (img.dataUrl) imageMap.set(img.name, img.dataUrl); }

  const resolved = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt: string, src: string) => {
    let dataUrl = imageMap.get(src);
    if (dataUrl) { usedNames.add(src); return `![${alt}](${dataUrl})`; }
    const basename = src.split("/").pop() || "";
    dataUrl = imageMap.get(basename);
    if (dataUrl) { usedNames.add(basename); return `![${alt}](${dataUrl})`; }
    return match;
  });
  return { text: resolved, usedNames };
}

// ─── Heading Extraction ──────────────────────────────────────────────────────

interface Heading { level: number; text: string; id: string }

function addHeadingIds(html: string, offset: number): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  let idx = offset;
  const processed = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h[1-6]>/gi, (_m, lv, attrs, content) => {
    const id = `s${idx++}`;
    headings.push({ level: parseInt(lv), text: content.replace(/<[^>]*>/g, "").trim(), id });
    return `<h${lv}${attrs} id="${id}">${content}</h${lv}>`;
  });
  return { html: processed, headings };
}

function buildTocHtml(headings: Heading[]): string {
  if (headings.length === 0) return "";
  // Find the minimum heading level to normalize indentation
  const minLevel = Math.min(...headings.map(h => h.level));
  let html = '<nav class="scribe-toc"><h2 class="scribe-toc-title">Contents</h2><ol class="scribe-toc-list">';
  for (const h of headings) {
    const depth = h.level - minLevel;
    html += `<li class="scribe-toc-item scribe-toc-d${depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`;
  }
  return html + "</ol></nav>";
}

function buildCoverHtml(meta: Frontmatter, fallbackTitle: string): string {
  const title = meta.title || fallbackTitle;
  let html = '<div class="scribe-cover">';
  html += `<h1 class="scribe-cover-title">${escapeHtml(title)}</h1>`;
  if (meta.subtitle) html += `<p class="scribe-cover-subtitle">${escapeHtml(meta.subtitle)}</p>`;
  if (meta.author) html += `<p class="scribe-cover-author">${escapeHtml(meta.author)}</p>`;
  if (meta.date) html += `<p class="scribe-cover-date">${escapeHtml(meta.date)}</p>`;
  return html + "</div>";
}

// ─── Document Builder ────────────────────────────────────────────────────────

const MARGIN_MAP: Record<ScribeConfig["margins"], string> = { normal: "2.54cm", narrow: "1.27cm", wide: "3.81cm" };
/** Screen-preview padding that mirrors the print margin so users can see the difference. */
const MARGIN_PREVIEW_MAP: Record<ScribeConfig["margins"], string> = { normal: "2em 2.5em", narrow: "1.5em 1em", wide: "2.5em 5em" };
const LINE_SPACING_MAP: Record<ScribeConfig["lineSpacing"], number> = { "single": 1.4, "1.15": 1.65, "1.5": 1.9, "double": 2.2 };
const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace"]);
const FONT_PRESETS: { value: string; label: string; css: string }[] = [
  { value: "serif",      label: "Serif", css: "serif" },
  { value: "sans-serif", label: "Sans",  css: "sans-serif" },
  { value: "mono",       label: "Mono",  css: "monospace" },
];

/** Build a CSS font-family string from user input, always ending with a generic fallback. */
function cssFontFamily(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || GENERIC_FAMILIES.has(trimmed)) return trimmed || "sans-serif";
  // If user typed "mono" shorthand, map it
  if (trimmed === "mono") return "monospace";
  // Already includes a generic at the end? Use as-is.
  for (const g of GENERIC_FAMILIES) {
    if (trimmed.endsWith(g)) return trimmed;
  }
  // Append sans-serif as a safe fallback
  return `${trimmed}, sans-serif`;
}

/** Wrap each line inside <pre><code> blocks in a span for CSS line-number counters. */
function addCodeLineSpans(html: string): string {
  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/gi,
    (_m, attrs, content) => {
      const lines = content.split("\n");
      // marked adds a trailing newline — drop the empty last line
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const wrapped = lines.map((line: string) => `<span class="scribe-ln">${line}</span>`).join("\n");
      return `<pre class="scribe-pre-ln"><code${attrs}>${wrapped}</code></pre>`;
    },
  );
}

function buildDocument(entries: CachedEntry[], config: ScribeConfig, title: string): string {
  const imageEntries = entries.filter(e => e.category === "image" && e.dataUrl);
  const usedImageNames = new Set<string>();
  const sections: { type: "markdown" | "image"; html: string; name: string; fm?: Frontmatter }[] = [];
  let headingOffset = 0;
  const allHeadings: Heading[] = [];
  let firstFm: Frontmatter = {};

  for (const entry of entries) {
    if (entry.category === "markdown" && entry.text != null) {
      const { meta, body } = parseFrontmatter(entry.text);
      if (sections.filter(s => s.type === "markdown").length === 0) firstFm = meta;
      const { text: resolved, usedNames } = resolveImageRefs(body, imageEntries);
      for (const n of usedNames) usedImageNames.add(n);
      const raw = marked.parse(resolved, { gfm: true, breaks: true, async: false }) as string;
      let { html, headings } = addHeadingIds(raw, headingOffset);
      if (config.lineNumbers) html = addCodeLineSpans(html);
      headingOffset += headings.length;
      allHeadings.push(...headings);
      sections.push({ type: "markdown", html, name: entry.name, fm: meta });
    } else if (entry.category === "image" && entry.dataUrl) {
      sections.push({ type: "image", html: entry.dataUrl, name: entry.name });
    }
  }

  const parts: string[] = [];
  if (config.coverPage) parts.push(buildCoverHtml(firstFm, title));
  if (config.tableOfContents && allHeadings.length > 0) parts.push(buildTocHtml(allHeadings));

  let mdIndex = 0;
  for (const section of sections) {
    if (section.type === "markdown") {
      const cls = mdIndex > 0 && config.pageBreaks ? ' class="scribe-page-break"' : "";
      parts.push(`<section${cls}>${section.html}</section>`);
      mdIndex++;
    } else if (section.type === "image" && !usedImageNames.has(section.name)) {
      parts.push(`<div class="scribe-img-page"><img src="${section.html}" alt="${escapeHtml(section.name)}"></div>`);
    }
  }
  return wrapHtml(parts.join("\n"), config, title);
}

function wrapHtml(body: string, config: ScribeConfig, title: string): string {
  const pageSize = config.pageSize === "letter" ? "letter" : "A4";
  const margin = MARGIN_MAP[config.margins];
  const fontFamily = cssFontFamily(config.fontFamily);
  const fontSize = config.fontSize;
  const lineHeight = LINE_SPACING_MAP[config.lineSpacing] ?? 1.65;
  const codeHighlight = config.syntaxHighlight;
  const codeBg = codeHighlight ? "#f6f8fa" : "#f6f6f6";

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  /*
   * Scribe print stylesheet
   *
   * Page break heuristics informed by:
   *   - Knuth & Plass, "Breaking paragraphs into lines" (1981) — penalty model
   *   - Butterick, "Practical Typography" — keep-with-next on all headings
   *   - LaTeX widow/club penalties (default 150, recommended 300+)
   *   - W3C CSS Fragmentation spec — orphans/widows/break-* properties
   *   - HTML5 Boilerplate print rules — orphans:3, widows:3, heading avoid
   */

  /* ── Page ─────────────────────────────────────────── */
  /*
   * CSS Paged Media @page margin boxes (W3C spec, supported in Firefox & Chrome 131+).
   * Defining margin boxes explicitly overrides all browser-injected chrome
   * (title, URL, date). content:none suppresses a position entirely.
   */
  @page {
    size: ${pageSize};
    margin: ${margin};
${config.pageNumbers ? `    @bottom-center {
      content: counter(page);
      font-size: 8.5pt;
      color: #999;
      font-family: ${fontFamily};
    }` : "    @bottom-center { content: none; }"}
    @top-left { content: none; }
    @top-right { content: none; }
    @bottom-left { content: none; }
    @bottom-right { content: none; }
  }

  /* ── Base ─────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  body {
    font-family: ${fontFamily};
    font-size: ${fontSize}pt;
    line-height: ${lineHeight};
    color: #222;
    max-width: 46em;
    margin: 0 auto;
    padding: ${MARGIN_PREVIEW_MAP[config.margins]};
    transition: padding 0.3s ease;
    /*
     * Orphans/widows: minimum lines kept together at page boundary.
     * Research (LaTeX lua-widow-control, Butterick) recommends 4 —
     * 3 is the baseline, 4 catches the marginal cases where a 3-line
     * fragment still looks visually detached from its paragraph.
     */
    orphans: 4;
    widows: 4;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ── Headings ────────────────────────────────────── */
  /*
   * Butterick: "Always use keep-with-next on headings."
   * break-after:avoid prevents a heading from stranding at page bottom.
   * break-inside:avoid prevents multi-line headings from splitting.
   * The h* + * rule (below) binds the first element after any heading
   * to the heading — CSS equivalent of Word's "keep with next paragraph."
   */
  h1, h2, h3, h4, h5, h6 {
    margin-top: 1.6em;
    margin-bottom: 0.5em;
    line-height: 1.25;
    page-break-after: avoid;
    break-after: avoid;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  /* Keep-with-next: bind heading to following content (Butterick's #1 rule) */
  h1 + *, h2 + *, h3 + *, h4 + *, h5 + *, h6 + * {
    page-break-before: avoid;
    break-before: avoid;
  }
  h1 { font-size: 1.85em; border-bottom: 1px solid #ddd; padding-bottom: 0.35em; margin-top: 0; }
  h2 { font-size: 1.4em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
  h3 { font-size: 1.2em; }
  h4 { font-size: 1.05em; }
  h5, h6 { font-size: 1em; color: #555; }

  /* ── Body Text ───────────────────────────────────── */
  p { margin: 0.75em 0; }
  strong { font-weight: 650; }
  em { font-style: italic; }

  /* ── Links ───────────────────────────────────────── */
  a { color: #1a6bc4; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ── Lists ───────────────────────────────────────── */
  ul, ol { padding-left: 1.7em; margin: 0.6em 0; }
  /*
   * List items: avoid splitting a single bullet point across pages.
   * This is the CSS analog of LaTeX's \\interlinepenalty inside list
   * environments. Each item stays atomic unless it's very long.
   */
  li {
    margin: 0.25em 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  li > p { margin: 0.3em 0; }
  li > ul, li > ol { margin: 0.15em 0; }

  /* ── Blockquotes ─────────────────────────────────── */
  blockquote {
    margin: 1em 0;
    padding: 0.6em 1.2em;
    border-left: 3px solid #d0d0d0;
    color: #444;
    background: #fafafa;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  blockquote p:first-child { margin-top: 0; }
  blockquote p:last-child { margin-bottom: 0; }

  /* ── Code ─────────────────────────────────────────── */
  code {
    background: ${codeBg};
    padding: 0.15em 0.35em;
    border-radius: 3px;
    font-size: 0.88em;
    font-family: monospace;
  }
  pre {
    background: ${codeBg};
    padding: 0.9em 1.1em;
    border-radius: 5px;
    ${config.wordWrap ? "white-space: pre-wrap;\n    overflow-wrap: break-word;" : "overflow-x: auto;"}
    font-size: 0.85em;
    line-height: 1.5;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: inherit;
  }

  /* ── Line Numbers ──────────────────────────────────── */
  .scribe-pre-ln { counter-reset: scribe-line; }
  .scribe-ln {
    display: block;
    counter-increment: scribe-line;
  }
  .scribe-ln::before {
    content: counter(scribe-line);
    display: inline-block;
    width: 2.5em;
    margin-right: 1em;
    text-align: right;
    color: #999;
    -webkit-user-select: none;
    user-select: none;
  }

  /* ── Tables ──────────────────────────────────────── */
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    font-size: 0.92em;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  th, td { border: 1px solid #d8d8d8; padding: 0.45em 0.7em; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  /* Individual rows stay whole — prevents a row's content from splitting */
  tr {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  tr:nth-child(even) { background: #fafbfc; }

  /* ── Horizontal Rules ────────────────────────────── */
  /*
   * HRs should not appear alone at page top or bottom.
   * break-after:avoid binds the HR to the content that follows it,
   * preventing a bare line at the end of a page.
   */
  hr {
    border: none;
    border-top: 1px solid #e8e8e8;
    margin: 1.8em 0;
    page-break-after: avoid;
    break-after: avoid;
  }

  /* ── Images ──────────────────────────────────────── */
  img {
    max-width: 100%;
    height: auto;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  /* Bind caption to its figure */
  figure {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  figcaption {
    page-break-before: avoid;
    break-before: avoid;
  }

  /* ── Scribe Components ───────────────────────────── */
  .scribe-cover {
    page-break-after: always; break-after: page;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 80vh; text-align: center;
  }
  .scribe-cover-title { font-size: 2.4em; margin-bottom: 0.3em; border: none; padding: 0; line-height: 1.2; }
  .scribe-cover-subtitle { font-size: 1.15em; color: #555; margin: 0.3em 0; font-style: italic; }
  .scribe-cover-author { font-size: 1.15em; color: #444; margin: 1em 0 0.2em; }
  .scribe-cover-date { font-size: 0.95em; color: #888; }

  .scribe-toc {
    page-break-after: always; break-after: page;
    padding: 2em 0;
  }
  .scribe-toc-title {
    font-size: 1.6em; font-weight: 700; margin: 0 0 1.2em;
    border: none; padding: 0; letter-spacing: -0.01em;
  }
  .scribe-toc-list {
    list-style: none; padding: 0; margin: 0;
    border-top: 1px solid #e0e0e0;
  }
  .scribe-toc-item {
    border-bottom: 1px solid #f0f0f0;
    page-break-inside: avoid; break-inside: avoid;
  }
  .scribe-toc-item a {
    display: block; padding: 0.45em 0; color: #222;
    text-decoration: none; transition: color 0.15s;
  }
  .scribe-toc-item a:hover { color: #1a6bc4; }
  .scribe-toc-d0 a { font-weight: 600; font-size: 1.05em; }
  .scribe-toc-d1 a { padding-left: 1.5em; }
  .scribe-toc-d2 a { padding-left: 3em; font-size: 0.95em; color: #444; }
  .scribe-toc-d3 a { padding-left: 4.5em; font-size: 0.92em; color: #555; }
  .scribe-toc-d4 a { padding-left: 6em; font-size: 0.9em; color: #666; }
  .scribe-toc-d5 a { padding-left: 7.5em; font-size: 0.88em; color: #666; }

  .scribe-page-break { page-break-before: always; break-before: page; }
  .scribe-img-page {
    page-break-before: always; break-before: page;
    page-break-after: always; break-after: page;
    display: flex; align-items: center; justify-content: center;
    min-height: 85vh;
  }
  .scribe-img-page img { max-width: 100%; max-height: 88vh; object-fit: contain; }

  /* ── Print Overrides ─────────────────────────────── */
  @media print {
    body {
      color: #000;
      max-width: none;
      padding: 0;
      transition: none;
    }
    a { color: #000; text-decoration: none; }
    .scribe-toc-list { border-top-color: #ccc; }
    .scribe-toc-item { border-bottom-color: #e0e0e0; }
    .scribe-toc-item a { color: #000; }
    h1 { border-bottom-color: #ccc; }
    h2 { border-bottom-color: #ddd; }
    hr { border-top-color: #ddd; }
    blockquote { background: none; border-left-color: #aaa; }
    code { background: #eee; }
    pre { background: #f4f4f4; border: 1px solid #e0e0e0; }
    th { background: #f0f0f0; }
    tr:nth-child(even) { background: #f8f8f8; }
  }
</style>
</head><body>
${body}
</body></html>`;
}

// ─── Module Factory ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ScribeConfig = {
  pageSize: "a4", margins: "normal", fontFamily: "sans-serif", fontSize: 12, lineSpacing: "1.15",
  syntaxHighlight: true, tableOfContents: false, coverPage: false, pageNumbers: true, pageBreaks: true,
  lineNumbers: false, wordWrap: true, headerRow: true,
};
const FONT_SIZE_OPTIONS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32];

export function createScribe(): ScribeModule {
  let currentFile: FileInfo | null = null;
  let rawFile: File | null = null;
  let container: HTMLElement | null = null;
  let previewFrame: HTMLIFrameElement | null = null;
  let previewDebounce: ReturnType<typeof setTimeout> | null = null;
  let queue: { file: File; info: FileInfo }[] = [];
  let cached: CachedEntry[] = [];
  let readGen = 0;
  const config: ScribeConfig = { ...DEFAULT_CONFIG };

  function counts() {
    const md = cached.filter(e => e.category === "markdown").length;
    const img = cached.filter(e => e.category === "image").length;
    const code = cached.filter(e => e.source === "code").length;
    const data = cached.filter(e => e.source === "data").length;
    return { md, img, code, data, total: md + img };
  }

  /** Re-read queue entries with current config (used when headerRow changes). */
  function rereadQueue(): void {
    if (queue.length === 0 && rawFile && currentFile) {
      const gen = ++readGen;
      readQueueEntries([{ file: rawFile, info: { category: currentFile.category } as FileInfo }], config.headerRow).then((entries) => {
        if (gen !== readGen) return;
        cached = entries;
        if (container) renderControls();
      }).catch(() => {});
      return;
    }
    if (queue.length === 0) return;
    const gen = ++readGen;
    readQueueEntries(queue, config.headerRow).then((entries) => {
      if (gen !== readGen) return;
      cached = entries;
      if (container) renderControls();
    }).catch(() => {});
  }

  // Track what last preview was built from, so we can patch style-only changes live
  let lastContentKey = "";
  let needsFullRebuild = true;

  function contentKey(): string {
    // Content-affecting config: tableOfContents, coverPage, pageBreaks, syntaxHighlight
    return `${cached.map(e => e.name).join("|")}|${config.tableOfContents}|${config.coverPage}|${config.pageBreaks}|${config.syntaxHighlight}|${config.lineNumbers}|${config.wordWrap}|${config.headerRow}`;
  }

  function schedulePreview(forceRebuild?: boolean): void {
    if (forceRebuild) needsFullRebuild = true;
    if (previewDebounce) clearTimeout(previewDebounce);
    previewDebounce = setTimeout(updatePreview, 80);
  }

  function updatePreview(): void {
    if (!previewFrame || cached.length === 0) return;

    const ck = contentKey();
    const iframeDoc = previewFrame.contentDocument;

    // Try to patch style in-place for style-only changes (margins, font, fontSize)
    if (!needsFullRebuild && ck === lastContentKey && iframeDoc?.body) {
      const body = iframeDoc.body;
      const fontFamily = cssFontFamily(config.fontFamily);
      body.style.fontFamily = fontFamily;
      body.style.fontSize = `${config.fontSize}pt`;
      body.style.lineHeight = `${LINE_SPACING_MAP[config.lineSpacing] ?? 1.65}`;
      body.style.padding = MARGIN_PREVIEW_MAP[config.margins];

      // Update @page rule for print accuracy
      const sheets = iframeDoc.styleSheets;
      for (let i = 0; i < sheets.length; i++) {
        try {
          const rules = sheets[i].cssRules;
          for (let j = 0; j < rules.length; j++) {
            if (rules[j] instanceof CSSPageRule) {
              (rules[j] as CSSPageRule).style.margin = MARGIN_MAP[config.margins];
            }
          }
        } catch { /* cross-origin or security error, skip */ }
      }
      return;
    }

    // Full rebuild
    needsFullRebuild = false;
    lastContentKey = ck;
    previewFrame.srcdoc = buildDocument(cached, config, docTitle());

    // After srcdoc loads, intercept anchor clicks so #hash links scroll
    // within the iframe instead of navigating the parent page.
    previewFrame.addEventListener("load", function onLoad() {
      previewFrame!.removeEventListener("load", onLoad);
      const doc = previewFrame!.contentDocument;
      if (!doc) return;
      doc.addEventListener("click", (e) => {
        const anchor = (e.target as Element).closest?.("a[href^='#']") as HTMLAnchorElement | null;
        if (!anchor) return;
        e.preventDefault();
        e.stopPropagation();
        const id = anchor.getAttribute("href")!.slice(1);
        const target = doc.getElementById(id);
        if (target) {
          // Use scrollTo on the iframe's own window to avoid scrolling the parent page
          const win = previewFrame!.contentWindow;
          if (win) {
            const top = target.getBoundingClientRect().top + win.scrollY;
            win.scrollTo({ top, behavior: "smooth" });
          }
        }
      });
    });
  }

  function docTitle(): string {
    for (const entry of cached) {
      if (entry.category === "markdown" && entry.text) {
        const { meta } = parseFrontmatter(entry.text);
        if (meta.title) return meta.title;
      }
    }
    if (currentFile) return currentFile.name.replace(/\.(md|markdown|txt|json|xml|ya?ml|toml|csv|tsv|log|ini|cfg|conf|png|jpe?g|gif|webp|svg|bmp|tiff?)$/i, "");
    return "Document";
  }

  // ── Render ──────────────────────────────────────────────────────────────

  function renderControls(): void {
    if (!container) return;
    container.innerHTML = "";
    const { md, img, code, data, total } = counts();

    // ── Preview (hero) ──────────────────────────────────────────────────
    previewFrame = el("iframe", "scr-preview-frame") as HTMLIFrameElement;
    previewFrame.sandbox.add("allow-same-origin");
    previewFrame.title = "Live preview";
    container.appendChild(previewFrame);

    // ── Controls ────────────────────────────────────────────────────────
    const controls = el("div", "scr-controls");

    // Queue badge (multi-file only)
    if (total > 1) {
      const parts: string[] = [];
      const mdOnly = md - code - data;
      if (mdOnly > 0) parts.push(`${mdOnly} markdown`);
      if (code > 0) parts.push(`${code} code`);
      if (data > 0) parts.push(`${data} table${data !== 1 ? "s" : ""}`);
      if (img > 0) parts.push(`${img} image${img !== 1 ? "s" : ""}`);
      controls.appendChild(el("p", "scr-queue-summary", parts.join(" + ")));
    }

    // ── Style section ───────────────────────────────────────────────────
    const style = el("div", "scr-section");

    // Page size
    const pageRow = el("div", "scr-row");
    pageRow.appendChild(el("span", "scr-row-label", "Page"));
    pageRow.appendChild(createSegments(
      [{ value: "a4", label: "A4" }, { value: "letter", label: "Letter" }],
      config.pageSize,
      (v) => { config.pageSize = v as ScribeConfig["pageSize"]; schedulePreview(true); },
    ));
    style.appendChild(pageRow);

    // Margins
    const marginsRow = el("div", "scr-row");
    marginsRow.appendChild(el("span", "scr-row-label", "Margins"));
    marginsRow.appendChild(createSegments(
      [{ value: "narrow", label: "Narrow" }, { value: "normal", label: "Normal" }, { value: "wide", label: "Wide" }],
      config.margins,
      (v) => { config.margins = v as ScribeConfig["margins"]; schedulePreview(); },
    ));
    style.appendChild(marginsRow);

    // Font + size (markdown only)
    if (md > 0) {
      const fontRow = el("div", "scr-row");
      fontRow.appendChild(el("span", "scr-row-label", "Font"));
      const fontRight = el("div", "scr-row-right");

      // Unified pill: presets + inline input with autocomplete
      const isPreset = FONT_PRESETS.some(p => p.value === config.fontFamily);
      const segGroup = el("div", "scr-seg-group scr-font-pill");
      const segBtns: HTMLButtonElement[] = [];
      for (const preset of FONT_PRESETS) {
        const btn = el("button", `scr-seg${preset.value === config.fontFamily ? " scr-seg--on" : ""}`, preset.label);
        btn.type = "button";
        segBtns.push(btn);
        segGroup.appendChild(btn);
      }

      // Inline input with dropdown wrapper
      const inputWrap = el("div", "scr-font-wrap");
      const fontInput = document.createElement("input");
      fontInput.type = "text";
      fontInput.className = "scr-font-inline";
      fontInput.placeholder = "Custom\u2026";
      fontInput.spellcheck = false;
      fontInput.autocomplete = "off";
      if (!isPreset) {
        fontInput.value = config.fontFamily;
        fontInput.classList.add("scr-font-inline--active");
      }
      inputWrap.appendChild(fontInput);

      // Autocomplete dropdown
      const dropdown = el("div", "scr-font-dropdown");
      dropdown.setAttribute("role", "listbox");
      inputWrap.appendChild(dropdown);
      segGroup.appendChild(inputWrap);
      fontRight.appendChild(segGroup);

      let availableFonts: string[] = [];
      let highlightIdx = -1;

      // Kick off font discovery immediately
      discoverFonts().then(fonts => { availableFonts = fonts; });

      function applyFont(name: string): void {
        segBtns.forEach(b => b.classList.remove("scr-seg--on"));
        fontInput.classList.add("scr-font-inline--active");
        fontInput.value = name;
        config.fontFamily = name;
        schedulePreview();
      }

      function showDropdown(query: string): void {
        dropdown.innerHTML = "";
        highlightIdx = -1;
        const q = query.toLowerCase();
        if (!q || availableFonts.length === 0) { dropdown.classList.remove("scr-font-dropdown--open"); return; }

        // Score: starts-with first, then contains
        const startsWith: string[] = [];
        const contains: string[] = [];
        for (const f of availableFonts) {
          const fl = f.toLowerCase();
          if (fl.startsWith(q)) startsWith.push(f);
          else if (fl.includes(q)) contains.push(f);
        }
        const matches = [...startsWith, ...contains].slice(0, 8);
        if (matches.length === 0) { dropdown.classList.remove("scr-font-dropdown--open"); return; }

        for (let i = 0; i < matches.length; i++) {
          const item = el("div", "scr-font-option");
          item.setAttribute("role", "option");
          item.textContent = matches[i];
          item.style.fontFamily = `'${matches[i]}', sans-serif`;
          item.addEventListener("mousedown", (e) => {
            e.preventDefault(); // keep focus in input
            applyFont(matches[i]);
            dropdown.classList.remove("scr-font-dropdown--open");
          });
          dropdown.appendChild(item);
        }
        dropdown.classList.add("scr-font-dropdown--open");
      }

      function updateHighlight(): void {
        const items = dropdown.querySelectorAll(".scr-font-option");
        items.forEach((it, i) => it.classList.toggle("scr-font-option--hl", i === highlightIdx));
        if (highlightIdx >= 0 && highlightIdx < items.length) {
          items[highlightIdx].scrollIntoView({ block: "nearest" });
        }
      }

      // Wire preset clicks
      for (let i = 0; i < FONT_PRESETS.length; i++) {
        segBtns[i].addEventListener("click", () => {
          segBtns.forEach(b => b.classList.remove("scr-seg--on"));
          segBtns[i].classList.add("scr-seg--on");
          fontInput.value = "";
          fontInput.classList.remove("scr-font-inline--active");
          dropdown.classList.remove("scr-font-dropdown--open");
          config.fontFamily = FONT_PRESETS[i].value;
          schedulePreview();
        });
      }

      // Wire input
      let inputDebounce: ReturnType<typeof setTimeout> | null = null;
      fontInput.addEventListener("input", () => {
        const val = fontInput.value.trim();
        if (val) {
          segBtns.forEach(b => b.classList.remove("scr-seg--on"));
          fontInput.classList.add("scr-font-inline--active");
          config.fontFamily = val;
          showDropdown(val);
        } else {
          fontInput.classList.remove("scr-font-inline--active");
          segBtns.forEach(b => b.classList.remove("scr-seg--on"));
          segBtns[1].classList.add("scr-seg--on");
          config.fontFamily = "sans-serif";
          dropdown.classList.remove("scr-font-dropdown--open");
        }
        if (inputDebounce) clearTimeout(inputDebounce);
        inputDebounce = setTimeout(schedulePreview, 200);
      });

      // Keyboard nav in dropdown
      fontInput.addEventListener("keydown", (e) => {
        const items = dropdown.querySelectorAll(".scr-font-option");
        if (!items.length || !dropdown.classList.contains("scr-font-dropdown--open")) return;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
          updateHighlight();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightIdx = Math.max(highlightIdx - 1, 0);
          updateHighlight();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (highlightIdx >= 0 && highlightIdx < items.length) {
            applyFont(items[highlightIdx].textContent!);
          }
          dropdown.classList.remove("scr-font-dropdown--open");
        } else if (e.key === "Escape") {
          dropdown.classList.remove("scr-font-dropdown--open");
        }
      });

      // Show all fonts on focus if input is empty
      fontInput.addEventListener("focus", () => {
        if (fontInput.value.trim()) {
          showDropdown(fontInput.value.trim());
        }
      });

      fontInput.addEventListener("blur", () => {
        // Delay so mousedown on option fires first
        setTimeout(() => dropdown.classList.remove("scr-font-dropdown--open"), 150);
      });

      // Size stepper
      fontRight.appendChild(createStepper(
        FONT_SIZE_OPTIONS, config.fontSize,
        (v) => `${v}`,
        (v) => { config.fontSize = v; schedulePreview(); },
      ));
      fontRow.appendChild(fontRight);
      style.appendChild(fontRow);

      // Line spacing
      const spacingRow = el("div", "scr-row");
      spacingRow.appendChild(el("span", "scr-row-label", "Spacing"));
      spacingRow.appendChild(createSegments(
        [
          { value: "single", label: "1" },
          { value: "1.15", label: "1.15" },
          { value: "1.5", label: "1.5" },
          { value: "double", label: "2" },
        ],
        config.lineSpacing,
        (v) => { config.lineSpacing = v as ScribeConfig["lineSpacing"]; schedulePreview(); },
      ));
      style.appendChild(spacingRow);
    }

    controls.appendChild(style);

    // ── Features section ────────────────────────────────────────────────
    const feat = el("div", "scr-section");

    if (md > 0) {
      feat.appendChild(createToggle("Contents", config.tableOfContents,
        (v) => { config.tableOfContents = v; schedulePreview(true); }));
      feat.appendChild(createToggle("Cover Page", config.coverPage,
        (v) => { config.coverPage = v; schedulePreview(true); }));
      feat.appendChild(createToggle("Syntax Highlighting", config.syntaxHighlight,
        (v) => { config.syntaxHighlight = v; schedulePreview(true); }));
    }
    feat.appendChild(createToggle("Page Numbers", config.pageNumbers,
      (v) => { config.pageNumbers = v; schedulePreview(true); }));
    if (md > 1) {
      feat.appendChild(createToggle("Page Breaks", config.pageBreaks,
        (v) => { config.pageBreaks = v; schedulePreview(true); }));
    }
    if (code > 0) {
      feat.appendChild(createToggle("Line Numbers", config.lineNumbers,
        (v) => { config.lineNumbers = v; schedulePreview(true); }));
      feat.appendChild(createToggle("Word Wrap", config.wordWrap,
        (v) => { config.wordWrap = v; schedulePreview(true); }));
    }
    if (data > 0) {
      feat.appendChild(createToggle("Header Row", config.headerRow,
        (v) => { config.headerRow = v; rereadQueue(); }));
    }

    controls.appendChild(feat);
    container.appendChild(controls);

    if (cached.length > 0) updatePreview();
  }

  // ── Module interface ────────────────────────────────────────────────────

  return {
    render(c: HTMLElement): void { container = c; renderControls(); },

    configure(file: FileInfo): void {
      currentFile = file;
      if (container) renderControls();
    },

    setFile(file: File): void {
      rawFile = file;
      if (queue.length <= 1) {
        const cat = currentFile?.category ?? "markdown";
        const gen = ++readGen;
        readQueueEntries([{ file, info: { category: cat } as FileInfo }], config.headerRow).then((entries) => {
          if (gen !== readGen) return;
          cached = entries;
          if (previewFrame) schedulePreview(true);
        }).catch(() => {});
      }
    },

    setFileQueue(incoming: { file: File; info: FileInfo }[]): void {
      queue = incoming.filter(e => e.info.category === "markdown" || e.info.category === "image" || e.info.category === "text");
      if (queue.length === 0) { cached = []; if (container) renderControls(); return; }
      const gen = ++readGen;
      readQueueEntries(queue, config.headerRow).then((entries) => {
        if (gen !== readGen) return;
        cached = entries;
        if (container) renderControls();
      }).catch(() => {});
    },

    build(): DocumentBuildResult | null {
      if (queue.length === 0 && !rawFile) return null;
      if (!currentFile) return null;
      const title = docTitle();
      const baseName = title.replace(/[<>:"/\\|?*]/g, "_");
      const outputName = `${baseName}_scribe.html`;
      const cfgSnapshot = { ...config };
      const buildQueue = queue.length > 0 ? [...queue] : (rawFile ? [{ file: rawFile, info: currentFile }] : []);

      return {
        pipeline: "document", outputName,
        execute: async () => {
          const entries = await readQueueEntries(buildQueue, cfgSnapshot.headerRow);
          return new TextEncoder().encode(buildDocument(entries, cfgSnapshot, title));
        },
      };
    },

    getConfig(): ScribeConfig { return { ...config }; },

    setConfig(incoming: unknown): void {
      if (!isRecord(incoming)) return;
      if (incoming.pageSize === "a4" || incoming.pageSize === "letter") config.pageSize = incoming.pageSize;
      if (incoming.margins === "normal" || incoming.margins === "narrow" || incoming.margins === "wide") config.margins = incoming.margins;
      if (typeof incoming.fontFamily === "string" && incoming.fontFamily.trim()) config.fontFamily = incoming.fontFamily.trim();
      if (typeof incoming.fontSize === "number" && FONT_SIZE_OPTIONS.includes(incoming.fontSize)) config.fontSize = incoming.fontSize;
      const validSpacings = ["single", "1.15", "1.5", "double"];
      if (typeof incoming.lineSpacing === "string" && validSpacings.includes(incoming.lineSpacing)) config.lineSpacing = incoming.lineSpacing as ScribeConfig["lineSpacing"];
      if (typeof incoming.syntaxHighlight === "boolean") config.syntaxHighlight = incoming.syntaxHighlight;
      if (typeof incoming.tableOfContents === "boolean") config.tableOfContents = incoming.tableOfContents;
      if (typeof incoming.coverPage === "boolean") config.coverPage = incoming.coverPage;
      if (typeof incoming.pageNumbers === "boolean") config.pageNumbers = incoming.pageNumbers;
      if (typeof incoming.pageBreaks === "boolean") config.pageBreaks = incoming.pageBreaks;
      if (typeof incoming.lineNumbers === "boolean") config.lineNumbers = incoming.lineNumbers;
      if (typeof incoming.wordWrap === "boolean") config.wordWrap = incoming.wordWrap;
      if (typeof incoming.headerRow === "boolean") config.headerRow = incoming.headerRow;
      if (container) renderControls();
    },

    reset(): void {
      Object.assign(config, DEFAULT_CONFIG);
      currentFile = null; rawFile = null; queue = []; cached = []; readGen++;
      previewFrame = null;
      if (previewDebounce) { clearTimeout(previewDebounce); previewDebounce = null; }
      if (container) renderControls();
    },
  };
}
