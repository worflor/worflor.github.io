// prism-scribe.ts — Scribe module: markdown to styled, print-ready HTML.

import { marked } from "marked";
import { readFileAsUint8Array, type FileInfo } from "./engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScribeConfig {
  pageSize: "a4" | "letter";
  margins: "normal" | "narrow" | "wide";
  fontFamily: "serif" | "sans-serif" | "mono";
  fontSize: number;
  syntaxHighlight: boolean;
}

export interface ScribeModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): DocumentBuildResult | null;
  getConfig(): ScribeConfig;
  setConfig(config: unknown): void;
  setFile(file: File): void;
  reset(): void;
}

export interface DocumentBuildResult {
  pipeline: "document";
  outputName: string;
  execute: () => Promise<Uint8Array>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function createSelect(id: string, options: { value: string; label: string }[], selected?: string): HTMLSelectElement {
  const select = el("select", "prism-select") as HTMLSelectElement;
  select.id = id;
  for (const opt of options) {
    const o = el("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === selected) o.selected = true;
    select.appendChild(o);
  }
  return select;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── Standalone HTML Builder ─────────────────────────────────────────────────

const MARGIN_MAP: Record<ScribeConfig["margins"], string> = {
  normal: "2.54cm",
  narrow: "1.27cm",
  wide: "3.81cm",
};

const FONT_MAP: Record<ScribeConfig["fontFamily"], string> = {
  "serif": "'Georgia', 'Times New Roman', serif",
  "sans-serif": "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  "mono": "'Consolas', 'Courier New', monospace",
};

function buildStandaloneHtml(markdown: string, config: ScribeConfig, title: string): string {
  const rendered = marked.parse(markdown, { gfm: true, breaks: true, async: false });
  const pageSize = config.pageSize === "letter" ? "letter" : "A4";
  const margin = MARGIN_MAP[config.margins];
  const fontFamily = FONT_MAP[config.fontFamily];
  const fontSize = config.fontSize;

  const syntaxCss = config.syntaxHighlight
    ? `
    code { background: #f4f4f5; padding: 0.15em 0.35em; border-radius: 3px; font-size: 0.9em; }
    pre code { background: none; padding: 0; border-radius: 0; }
    pre { background: #f4f4f5; padding: 1em; border-radius: 6px; overflow-x: auto; font-size: 0.88em; }`
    : `
    code { background: #f4f4f5; padding: 0.15em 0.35em; border-radius: 3px; font-size: 0.9em; }
    pre code { background: none; padding: 0; }
    pre { background: #f4f4f5; padding: 1em; border-radius: 6px; overflow-x: auto; font-size: 0.88em; }`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: ${pageSize}; margin: ${margin}; }
  * { box-sizing: border-box; }
  body {
    font-family: ${fontFamily};
    font-size: ${fontSize}pt;
    line-height: 1.7;
    color: #1a1a1a;
    max-width: 48em;
    margin: 0 auto;
    padding: 2em 1em;
  }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.4em; margin-bottom: 0.6em; line-height: 1.3; }
  h1 { font-size: 2em; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.2em; }
  h3 { font-size: 1.25em; }
  p { margin: 0.8em 0; }
  blockquote {
    margin: 1em 0;
    padding: 0.5em 1em;
    border-left: 4px solid #d0d0d0;
    color: #555;
    background: #fafafa;
  }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d0d0d0; padding: 0.5em 0.75em; text-align: left; }
  th { background: #f4f4f5; font-weight: 600; }
  a { color: #1a6bc4; text-decoration: none; }
  a:hover { text-decoration: underline; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 2em 0; }
  ul, ol { padding-left: 1.8em; }
  li { margin: 0.3em 0; }
  ${syntaxCss}
  @media print {
    body { color: #000; padding: 0; max-width: none; }
    a { color: #000; }
    pre, table, blockquote { page-break-inside: avoid; }
  }
</style>
</head><body>
${rendered}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Module Factory ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ScribeConfig = {
  pageSize: "a4",
  margins: "normal",
  fontFamily: "sans-serif",
  fontSize: 12,
  syntaxHighlight: true,
};

const FONT_SIZE_OPTIONS = [10, 11, 12, 14, 16];

export function createScribe(): ScribeModule {
  let currentFile: FileInfo | null = null;
  let rawFile: File | null = null;
  let container: HTMLElement | null = null;
  let previewFrame: HTMLIFrameElement | null = null;
  let cachedMarkdown: string | null = null;

  const config: ScribeConfig = { ...DEFAULT_CONFIG };

  function updatePreview(): void {
    if (!previewFrame || !cachedMarkdown) return;
    const title = currentFile?.name.replace(/\.(md|markdown)$/i, "") ?? "Document";
    previewFrame.srcdoc = buildStandaloneHtml(cachedMarkdown, config, title);
  }

  async function loadMarkdown(): Promise<void> {
    if (!rawFile) return;
    const bytes = await readFileAsUint8Array(rawFile);
    cachedMarkdown = new TextDecoder().decode(bytes);
    updatePreview();
  }

  function renderControls(): void {
    if (!container) return;
    container.innerHTML = "";

    const panel = el("div", "scr-panel");

    // Page Size
    const pageSizeField = el("div", "scr-field");
    pageSizeField.appendChild(el("label", "scr-label", "Page Size"));
    const pageSizeSelect = createSelect("scr-page-size", [
      { value: "a4", label: "A4" },
      { value: "letter", label: "Letter" },
    ], config.pageSize);
    pageSizeSelect.addEventListener("change", () => {
      config.pageSize = pageSizeSelect.value as ScribeConfig["pageSize"];
      updatePreview();
    });
    pageSizeField.appendChild(pageSizeSelect);
    panel.appendChild(pageSizeField);

    // Margins
    const marginsField = el("div", "scr-field");
    marginsField.appendChild(el("label", "scr-label", "Margins"));
    const marginsSelect = createSelect("scr-margins", [
      { value: "normal", label: "Normal" },
      { value: "narrow", label: "Narrow" },
      { value: "wide", label: "Wide" },
    ], config.margins);
    marginsSelect.addEventListener("change", () => {
      config.margins = marginsSelect.value as ScribeConfig["margins"];
      updatePreview();
    });
    marginsField.appendChild(marginsSelect);
    panel.appendChild(marginsField);

    // Font Family
    const fontField = el("div", "scr-field");
    fontField.appendChild(el("label", "scr-label", "Font"));
    const fontSelect = createSelect("scr-font", [
      { value: "serif", label: "Serif" },
      { value: "sans-serif", label: "Sans-serif" },
      { value: "mono", label: "Monospace" },
    ], config.fontFamily);
    fontSelect.addEventListener("change", () => {
      config.fontFamily = fontSelect.value as ScribeConfig["fontFamily"];
      updatePreview();
    });
    fontField.appendChild(fontSelect);
    panel.appendChild(fontField);

    // Font Size
    const sizeField = el("div", "scr-field");
    sizeField.appendChild(el("label", "scr-label", "Font Size"));
    const sizeSelect = createSelect(
      "scr-font-size",
      FONT_SIZE_OPTIONS.map((s) => ({ value: String(s), label: `${s}pt` })),
      String(config.fontSize),
    );
    sizeSelect.addEventListener("change", () => {
      config.fontSize = Number(sizeSelect.value);
      updatePreview();
    });
    sizeField.appendChild(sizeSelect);
    panel.appendChild(sizeField);

    // Syntax Highlight
    const syntaxField = el("div", "scr-field scr-field--row");
    const syntaxLabel = el("label", "scr-toggle-label");
    const syntaxCheck = document.createElement("input");
    syntaxCheck.type = "checkbox";
    syntaxCheck.id = "scr-syntax";
    syntaxCheck.checked = config.syntaxHighlight;
    syntaxCheck.addEventListener("change", () => {
      config.syntaxHighlight = syntaxCheck.checked;
      updatePreview();
    });
    syntaxLabel.appendChild(syntaxCheck);
    syntaxLabel.appendChild(document.createTextNode(" Syntax Highlighting"));
    syntaxField.appendChild(syntaxLabel);
    panel.appendChild(syntaxField);

    container.appendChild(panel);

    // Live Preview
    const iframe = document.createElement("iframe");
    iframe.className = "scr-preview-frame";
    iframe.sandbox.add("allow-same-origin");
    iframe.title = "Scribe preview";
    previewFrame = iframe;
    container.appendChild(iframe);

    if (cachedMarkdown) {
      updatePreview();
    } else {
      void loadMarkdown();
    }
  }

  return {
    render(c: HTMLElement): void {
      container = c;
      renderControls();
    },

    configure(file: FileInfo): void {
      currentFile = file;
      rawFile = null;
      cachedMarkdown = null;
      if (container) renderControls();
    },

    setFile(file: File): void {
      rawFile = file;
      cachedMarkdown = null;
      if (container) void loadMarkdown();
    },

    build(): DocumentBuildResult | null {
      if (!rawFile || !currentFile) return null;
      const baseName = currentFile.name.replace(/\.(md|markdown)$/i, "");
      const outputName = `${baseName}_scribe.html`;
      const cfgSnapshot = { ...config };
      const file = rawFile;
      const title = baseName;

      return {
        pipeline: "document",
        outputName,
        execute: async () => {
          const bytes = await readFileAsUint8Array(file);
          const text = new TextDecoder().decode(bytes);
          const html = buildStandaloneHtml(text, cfgSnapshot, title);
          return new TextEncoder().encode(html);
        },
      };
    },

    getConfig(): ScribeConfig {
      return { ...config };
    },

    setConfig(incoming: unknown): void {
      if (!isRecord(incoming)) return;
      if (incoming.pageSize === "a4" || incoming.pageSize === "letter") config.pageSize = incoming.pageSize;
      if (incoming.margins === "normal" || incoming.margins === "narrow" || incoming.margins === "wide") config.margins = incoming.margins;
      if (incoming.fontFamily === "serif" || incoming.fontFamily === "sans-serif" || incoming.fontFamily === "mono") config.fontFamily = incoming.fontFamily;
      if (typeof incoming.fontSize === "number" && FONT_SIZE_OPTIONS.includes(incoming.fontSize)) config.fontSize = incoming.fontSize;
      if (typeof incoming.syntaxHighlight === "boolean") config.syntaxHighlight = incoming.syntaxHighlight;
      if (container) renderControls();
    },

    reset(): void {
      Object.assign(config, DEFAULT_CONFIG);
      currentFile = null;
      rawFile = null;
      cachedMarkdown = null;
      if (container) renderControls();
    },
  };
}
