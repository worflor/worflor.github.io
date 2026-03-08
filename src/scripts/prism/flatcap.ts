// prism-flatcap.ts — Flatcap module: PDF tools — annotations, merge, split, rotate, metadata.
// All processing via pdf-lib (CDN-loaded), fully client-side, lossless.

import { readFileAsUint8Array, type FileInfo } from "./engine";
import type { DocumentBuildResult } from "./scribe";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FlatcapConfig {
  // Each operation can be toggled on/off independently
  flattenAnnotations: boolean;
  annotMode: "flatten-all" | "by-type";
  flattenComments: boolean;
  flattenHighlights: boolean;
  flattenFreeText: boolean;
  flattenInk: boolean;
  flattenStamps: boolean;

  rotate: boolean;
  rotateAngle: 90 | 180 | 270;
  rotateScope: "all" | "range";
  rotateRange: string;

  splitPages: boolean;
  splitMode: "range" | "every";
  splitRange: string;
  splitEvery: number;

  stripMetadata: boolean;
}

export interface FlatcapModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): DocumentBuildResult | null;
  getConfig(): FlatcapConfig;
  setConfig(config: unknown): void;
  setFile(file: File): void;
  setFileQueue(queue: { file: File; info: FileInfo }[]): void;
  reset(): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function parsePageRange(input: string, pageCount: number): number[] {
  const pages = new Set<number>();
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(1, parseInt(rangeMatch[1]));
      const end = Math.min(pageCount, parseInt(rangeMatch[2]));
      for (let i = start; i <= end; i++) pages.add(i - 1);
    } else {
      const n = parseInt(trimmed);
      if (!isNaN(n) && n >= 1 && n <= pageCount) pages.add(n - 1);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

// ─── pdf-lib CDN Loader ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedPdfLib: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPdfLib(): Promise<{ PDFDocument: any; PDFName: any; PDFArray: any; degrees: any }> {
  if (cachedPdfLib) return cachedPdfLib;
  const urls = [
    "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js",
    "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js",
  ];
  for (const url of urls) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      cachedPdfLib = { PDFDocument: mod.PDFDocument, PDFName: mod.PDFName, PDFArray: mod.PDFArray, degrees: mod.degrees };
      return cachedPdfLib;
    } catch { continue; }
  }
  throw new Error("Failed to load pdf-lib. Check your internet connection.");
}

// ─── PDF Processing ──────────────────────────────────────────────────────────

const ANNOT_SUBTYPES: Record<string, "flattenComments" | "flattenHighlights" | "flattenFreeText" | "flattenInk" | "flattenStamps"> = {
  Text: "flattenComments", Popup: "flattenComments",
  Highlight: "flattenHighlights", Underline: "flattenHighlights",
  StrikeOut: "flattenHighlights", Squiggly: "flattenHighlights",
  FreeText: "flattenFreeText", Ink: "flattenInk", Stamp: "flattenStamps",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyAnnotations(pdfDoc: any, config: FlatcapConfig, PDFName: any, PDFArray: any): void {
  for (const page of pdfDoc.getPages()) {
    const node = page.node;
    if (!node.get(PDFName.of("Annots"))) continue;

    if (config.annotMode === "flatten-all") {
      node.delete(PDFName.of("Annots"));   // flatten = bake into page, remove annotation objects
      continue;
    }

    const annots = node.lookup(PDFName.of("Annots"));
    if (!annots || typeof annots.size !== "function") continue;
    const keep: unknown[] = [];
    const size = annots.size();
    for (let i = 0; i < size; i++) {
      const annotRef = annots.get(i);
      const annot = annots.lookup(i);
      if (!annot) { keep.push(annotRef); continue; }
      const subtypeName = annot.lookup(PDFName.of("Subtype"));
      const subtypeStr = subtypeName?.toString?.()?.replace("/", "") ?? "";
      const configKey = ANNOT_SUBTYPES[subtypeStr];
      if (!(configKey && config[configKey])) keep.push(annotRef);
    }
    if (keep.length === 0) node.delete(PDFName.of("Annots"));
    else if (keep.length < size) {
      const newAnnots = PDFArray.withContext(pdfDoc.context);
      for (const ref of keep) newAnnots.push(ref);
      node.set(PDFName.of("Annots"), newAnnots);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRotation(pdfDoc: any, config: FlatcapConfig, degrees: any): void {
  const pages = pdfDoc.getPages();
  const targets: Set<number> = new Set();
  if (config.rotateScope === "all") {
    for (let i = 0; i < pages.length; i++) targets.add(i);
  } else {
    for (const idx of parsePageRange(config.rotateRange, pages.length)) targets.add(idx);
  }
  for (let i = 0; i < pages.length; i++) {
    if (targets.has(i)) {
      const current = pages[i].getRotation().angle;
      pages[i].setRotation(degrees((current + config.rotateAngle) % 360));
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyMetadataStrip(pdfDoc: any, PDFName: any): void {
  pdfDoc.setTitle(""); pdfDoc.setAuthor(""); pdfDoc.setSubject("");
  pdfDoc.setCreator(""); pdfDoc.setProducer(""); pdfDoc.setKeywords([]);
  const trailerDict = pdfDoc.context.trailerInfo;
  if (trailerDict?.Info) delete trailerDict.Info;
  const catalog = pdfDoc.catalog;
  if (catalog.get(PDFName.of("Metadata"))) catalog.delete(PDFName.of("Metadata"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applySplit(bytes: Uint8Array, config: FlatcapConfig, PDFDocument: any): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = src.getPageCount();
  let indices: number[];
  if (config.splitMode === "every") {
    indices = [];
    for (let i = config.splitEvery - 1; i < pageCount; i += config.splitEvery) indices.push(i);
    if (indices.length === 0 && pageCount > 0) indices = [0];
  } else {
    indices = parsePageRange(config.splitRange, pageCount);
    if (indices.length === 0) throw new Error("No valid pages in range. Use format: 1-3, 5, 8-10");
  }
  const out = await PDFDocument.create();
  const copiedPages = await out.copyPages(src, indices);
  for (const page of copiedPages) out.addPage(page);
  return out.save();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyMerge(files: File[], PDFDocument: any): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const file of files) {
    const bytes = await readFileAsUint8Array(file);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copiedPages = await merged.copyPages(src, src.getPageIndices());
    for (const page of copiedPages) merged.addPage(page);
  }
  return merged.save();
}

/** Run the full pipeline: split/merge first, then in-place ops (annotations, rotate, metadata). */
async function runPipeline(
  rawFile: File, config: FlatcapConfig, queue: File[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PDFDocument: any, PDFName: any, PDFArray: any, degrees: any,
): Promise<Uint8Array> {
  let bytes: Uint8Array;

  // Step 1: structural ops (merge or split — mutually exclusive, merge takes priority)
  if (queue.length > 1) {
    bytes = await applyMerge(queue, PDFDocument);
  } else if (config.splitPages) {
    bytes = await applySplit(await readFileAsUint8Array(rawFile), config, PDFDocument);
  } else {
    bytes = await readFileAsUint8Array(rawFile);
  }

  // Step 2: in-place ops on the result
  const needsInPlace = config.flattenAnnotations || config.rotate || config.stripMetadata;
  if (!needsInPlace) return bytes;

  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  if (config.flattenAnnotations) applyAnnotations(pdfDoc, config, PDFName, PDFArray);
  if (config.rotate) applyRotation(pdfDoc, config, degrees);
  if (config.stripMetadata) applyMetadataStrip(pdfDoc, PDFName);
  return pdfDoc.save();
}

// ─── UI Controls ─────────────────────────────────────────────────────────────

function createSegments(
  options: { value: string; label: string }[],
  selected: string,
  onChange: (v: string) => void,
): HTMLElement {
  const group = el("div", "fc-seg-group");
  for (const opt of options) {
    const btn = el("button", `fc-seg${opt.value === selected ? " fc-seg--on" : ""}`, opt.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      group.querySelectorAll(".fc-seg").forEach(s => s.classList.remove("fc-seg--on"));
      btn.classList.add("fc-seg--on");
      onChange(opt.value);
    });
    group.appendChild(btn);
  }
  return group;
}

function createToggle(
  label: string, checked: boolean, onChange: (v: boolean) => void,
): HTMLElement {
  const row = el("div", "fc-feat-row");
  row.appendChild(el("span", "fc-feat-label", label));
  const sw = el("button", `fc-switch${checked ? " fc-switch--on" : ""}`);
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(checked));
  sw.addEventListener("click", () => {
    const next = !sw.classList.contains("fc-switch--on");
    sw.classList.toggle("fc-switch--on", next);
    sw.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  row.appendChild(sw);
  return row;
}

function createInput(
  placeholder: string, value: string, onChange: (v: string) => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "fc-input";
  input.placeholder = placeholder;
  input.value = value;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

// ─── Module Factory ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FlatcapConfig = {
  flattenAnnotations: true,
  annotMode: "flatten-all",
  flattenComments: true, flattenHighlights: true, flattenFreeText: true,
  flattenInk: true, flattenStamps: true,
  rotate: false, rotateAngle: 90, rotateScope: "all", rotateRange: "",
  splitPages: false, splitMode: "range", splitRange: "", splitEvery: 2,
  stripMetadata: false,
};

export function createFlatcap(): FlatcapModule {
  let currentFile: FileInfo | null = null;
  let rawFile: File | null = null;
  let container: HTMLElement | null = null;
  let detectedAnnotCount: number | null = null;
  let detectedPageCount: number | null = null;
  let queue: { file: File; info: FileInfo }[] = [];

  const config: FlatcapConfig = { ...DEFAULT_CONFIG };

  // ── Scan ───────────────────────────────────────────────────────────────

  /** Track whether user has manually toggled annotation stripping. */
  let userToggledAnnot = false;

  function scanFile(file: File): void {
    detectedAnnotCount = null;
    detectedPageCount = null;
    const SCAN_SIZE = 512 * 1024;
    const slices: Blob[] = [file.slice(0, Math.min(file.size, SCAN_SIZE))];
    if (file.size > SCAN_SIZE) slices.push(file.slice(Math.max(0, file.size - SCAN_SIZE)));
    Promise.all(slices.map(s => s.text())).then(chunks => {
      let aTotal = 0, pTotal = 0;
      for (const text of chunks) {
        const am = text.match(/\/Type\s*\/Annot\b/g);
        if (am) aTotal += am.length;
        const pm = text.match(/\/Type\s*\/Page\b(?!\s*s)/g);
        if (pm) pTotal += pm.length;
      }
      detectedAnnotCount = aTotal;
      detectedPageCount = pTotal || null;

      // Auto-adjust: disable annotation stripping when no annotations found,
      // but only if the user hasn't manually changed the toggle.
      if (!userToggledAnnot) {
        config.flattenAnnotations = aTotal > 0;
      }

      if (container) renderControls();
    }).catch(() => {});
  }

  // ── Render ─────────────────────────────────────────────────────────────

  function renderControls(): void {
    if (!container) return;
    container.innerHTML = "";
    const controls = el("div", "fc-controls");
    const pdfCount = queue.filter(e => e.info.category === "pdf").length;
    const isMerge = pdfCount > 1;

    // ── Badge ────────────────────────────────────────────────────────
    const parts: string[] = [];
    if (isMerge) {
      parts.push(`${pdfCount} PDFs queued for merge`);
    } else {
      if (detectedPageCount !== null) parts.push(`${detectedPageCount} page${detectedPageCount !== 1 ? "s" : ""}`);
      if (detectedAnnotCount !== null) {
        parts.push(detectedAnnotCount === 0
          ? "no annotations"
          : `${detectedAnnotCount} annotation${detectedAnnotCount !== 1 ? "s" : ""}`);
      }
    }
    if (parts.length > 0) {
      controls.appendChild(el("p", "fc-badge", parts.join(" \u00B7 ")));
    }

    // ── Merge section (multi-file) ───────────────────────────────────
    if (isMerge) {
      const section = el("div", "fc-section");
      section.appendChild(el("p", "fc-hint", "Files will be combined in queue order."));
      const list = el("ol", "fc-merge-list");
      const pdfFiles = queue.filter(e => e.info.category === "pdf");
      for (const entry of pdfFiles) {
        const li = el("li", "fc-merge-item");
        li.appendChild(el("span", "fc-merge-name", entry.info.name));
        const sz = entry.file.size;
        const sizeStr = sz < 1024 * 1024 ? `${(sz / 1024).toFixed(0)} KB` : `${(sz / (1024 * 1024)).toFixed(1)} MB`;
        li.appendChild(el("span", "fc-merge-size", sizeStr));
        list.appendChild(li);
      }
      section.appendChild(list);
      controls.appendChild(section);
    }

    // ── Operations section ───────────────────────────────────────────
    const ops = el("div", "fc-section");

    // Flatten Annotations toggle + sub-controls
    ops.appendChild(createToggle("Flatten Annotations", config.flattenAnnotations, (v) => {
      config.flattenAnnotations = v;
      userToggledAnnot = true;
      renderControls();
    }));
    if (config.flattenAnnotations) {
      const modeRow = el("div", "fc-row");
      modeRow.appendChild(el("span", "fc-row-label", "Mode"));
      modeRow.appendChild(createSegments(
        [{ value: "flatten-all", label: "Flatten All" }, { value: "by-type", label: "By Type" }],
        config.annotMode,
        (v) => { config.annotMode = v as FlatcapConfig["annotMode"]; renderControls(); },
      ));
      ops.appendChild(modeRow);

      if (config.annotMode === "by-type") {
        const types: { key: "flattenComments" | "flattenHighlights" | "flattenFreeText" | "flattenInk" | "flattenStamps"; label: string }[] = [
          { key: "flattenComments",   label: "Comments & Popups" },
          { key: "flattenHighlights", label: "Highlights & Underlines" },
          { key: "flattenFreeText",   label: "Free Text" },
          { key: "flattenInk",        label: "Ink Drawings" },
          { key: "flattenStamps",     label: "Stamps" },
        ];
        for (const { key, label } of types) {
          ops.appendChild(createToggle(label, config[key], (v) => { config[key] = v; }));
        }
      }
    }

    // Rotate toggle + sub-controls
    ops.appendChild(createToggle("Rotate", config.rotate, (v) => {
      config.rotate = v;
      renderControls();
    }));
    if (config.rotate) {
      const angleRow = el("div", "fc-row");
      angleRow.appendChild(el("span", "fc-row-label", "Angle"));
      angleRow.appendChild(createSegments(
        [{ value: "90", label: "90\u00B0" }, { value: "180", label: "180\u00B0" }, { value: "270", label: "270\u00B0" }],
        String(config.rotateAngle || 90),
        (v) => { config.rotateAngle = parseInt(v) as FlatcapConfig["rotateAngle"]; },
      ));
      ops.appendChild(angleRow);

      const scopeRow = el("div", "fc-row");
      scopeRow.appendChild(el("span", "fc-row-label", "Apply to"));
      scopeRow.appendChild(createSegments(
        [{ value: "all", label: "All Pages" }, { value: "range", label: "Page Range" }],
        config.rotateScope,
        (v) => { config.rotateScope = v as FlatcapConfig["rotateScope"]; renderControls(); },
      ));
      ops.appendChild(scopeRow);

      if (config.rotateScope === "range") {
        const pageHint = detectedPageCount ? ` (1\u2013${detectedPageCount})` : "";
        const rangeRow = el("div", "fc-row");
        rangeRow.appendChild(el("span", "fc-row-label", "Pages"));
        rangeRow.appendChild(createInput(`e.g. 1-3, 5${pageHint}`, config.rotateRange, (v) => { config.rotateRange = v; }));
        ops.appendChild(rangeRow);
      }
    }

    // Extract Pages toggle + sub-controls (single-file only)
    if (!isMerge) {
      ops.appendChild(createToggle("Extract Pages", config.splitPages, (v) => {
        config.splitPages = v;
        renderControls();
      }));
      if (config.splitPages) {
        const modeRow = el("div", "fc-row");
        modeRow.appendChild(el("span", "fc-row-label", "Mode"));
        modeRow.appendChild(createSegments(
          [{ value: "range", label: "Page Range" }, { value: "every", label: "Every Nth" }],
          config.splitMode,
          (v) => { config.splitMode = v as FlatcapConfig["splitMode"]; renderControls(); },
        ));
        ops.appendChild(modeRow);

        if (config.splitMode === "range") {
          const pageHint = detectedPageCount ? ` (1\u2013${detectedPageCount})` : "";
          const rangeRow = el("div", "fc-row");
          rangeRow.appendChild(el("span", "fc-row-label", "Pages"));
          rangeRow.appendChild(createInput(`e.g. 1-3, 5, 8-10${pageHint}`, config.splitRange, (v) => { config.splitRange = v; }));
          ops.appendChild(rangeRow);
        } else {
          const everyRow = el("div", "fc-row");
          everyRow.appendChild(el("span", "fc-row-label", "Every"));
          const right = el("div", "fc-row-right");
          const numInput = document.createElement("input");
          numInput.type = "number";
          numInput.className = "fc-input fc-input--short";
          numInput.min = "1";
          numInput.max = detectedPageCount ? String(detectedPageCount) : "9999";
          numInput.value = String(config.splitEvery);
          numInput.addEventListener("input", () => {
            const v = parseInt(numInput.value);
            if (!isNaN(v) && v >= 1) config.splitEvery = v;
          });
          right.appendChild(numInput);
          right.appendChild(el("span", "fc-input-suffix", "pages"));
          everyRow.appendChild(right);
          ops.appendChild(everyRow);
        }
      }
    }

    // Strip Metadata toggle + description
    ops.appendChild(createToggle("Strip Metadata", config.stripMetadata, (v) => {
      config.stripMetadata = v;
      renderControls();
    }));
    if (config.stripMetadata) {
      ops.appendChild(el("p", "fc-hint", "Removes title, author, dates, creator, producer, keywords, and XMP streams."));
    }

    controls.appendChild(ops);
    container.appendChild(controls);
  }

  // ── Build ──────────────────────────────────────────────────────────────

  function buildOutputName(cfg: FlatcapConfig, isMerge: boolean): string {
    const base = currentFile?.name.replace(/\.pdf$/i, "") ?? "document";
    const tags: string[] = [];
    if (isMerge) tags.push("merged");
    if (cfg.flattenAnnotations) tags.push("flat");
    if (cfg.rotate) tags.push("rotated");
    if (cfg.splitPages) tags.push("split");
    if (cfg.stripMetadata) tags.push("clean");
    return `${base}_${tags.length > 0 ? tags.join("_") : "out"}.pdf`;
  }

  // ── Module Interface ───────────────────────────────────────────────────

  return {
    render(c: HTMLElement): void { container = c; renderControls(); },

    configure(file: FileInfo): void {
      currentFile = file;
      if (container) renderControls();
    },

    setFile(file: File): void {
      rawFile = file;
      userToggledAnnot = false;
      scanFile(file);
    },

    setFileQueue(incoming: { file: File; info: FileInfo }[]): void {
      queue = incoming.filter(e => e.info.category === "pdf");
      if (container) renderControls();
    },

    build(): DocumentBuildResult | null {
      if (!currentFile) return null;
      const pdfCount = queue.filter(e => e.info.category === "pdf").length;
      const isMerge = pdfCount > 1;

      // Must have at least one operation enabled
      const hasOp = config.flattenAnnotations || config.rotate || config.splitPages || config.stripMetadata || isMerge;
      if (!hasOp) return null;
      if (!isMerge && !rawFile) return null;

      const cfgSnapshot = { ...config };

      // ── Silently fix misconfigurations so users never hit confusing errors ──

      // Merge overrides split (can't do both)
      if (isMerge) cfgSnapshot.splitPages = false;

      // "By type" with no types checked → effectively no annotation stripping
      if (cfgSnapshot.flattenAnnotations && cfgSnapshot.annotMode === "by-type") {
        const anyTypeChecked = cfgSnapshot.flattenComments || cfgSnapshot.flattenHighlights
          || cfgSnapshot.flattenFreeText || cfgSnapshot.flattenInk || cfgSnapshot.flattenStamps;
        if (!anyTypeChecked) cfgSnapshot.flattenAnnotations = false;
      }

      // Rotate "range" scope with empty range → apply to all pages
      if (cfgSnapshot.rotate && cfgSnapshot.rotateScope === "range" && !cfgSnapshot.rotateRange.trim()) {
        cfgSnapshot.rotateScope = "all";
      }

      // Re-check: after fixes, are there still any operations?
      const hasOpAfterFix = cfgSnapshot.flattenAnnotations || cfgSnapshot.rotate
        || cfgSnapshot.splitPages || cfgSnapshot.stripMetadata || isMerge;
      if (!hasOpAfterFix) return null;

      const outputName = buildOutputName(cfgSnapshot, isMerge);
      const file = rawFile!;
      const mergeFiles = isMerge ? queue.filter(e => e.info.category === "pdf").map(e => e.file) : [];

      return {
        pipeline: "document", outputName,
        execute: async () => {
          const { PDFDocument, PDFName, PDFArray, degrees } = await loadPdfLib();
          return runPipeline(file, cfgSnapshot, mergeFiles, PDFDocument, PDFName, PDFArray, degrees);
        },
      };
    },

    getConfig(): FlatcapConfig { return { ...config }; },

    setConfig(incoming: unknown): void {
      if (!isRecord(incoming)) return;
      if (typeof incoming.flattenAnnotations === "boolean") config.flattenAnnotations = incoming.flattenAnnotations;
      if (incoming.annotMode === "flatten-all" || incoming.annotMode === "by-type") config.annotMode = incoming.annotMode;
      if (typeof incoming.flattenComments === "boolean") config.flattenComments = incoming.flattenComments;
      if (typeof incoming.flattenHighlights === "boolean") config.flattenHighlights = incoming.flattenHighlights;
      if (typeof incoming.flattenFreeText === "boolean") config.flattenFreeText = incoming.flattenFreeText;
      if (typeof incoming.flattenInk === "boolean") config.flattenInk = incoming.flattenInk;
      if (typeof incoming.flattenStamps === "boolean") config.flattenStamps = incoming.flattenStamps;
      if (typeof incoming.rotate === "boolean") config.rotate = incoming.rotate;
      const validAngles = [90, 180, 270];
      if (typeof incoming.rotateAngle === "number" && validAngles.includes(incoming.rotateAngle)) config.rotateAngle = incoming.rotateAngle as 90 | 180 | 270;
      if (incoming.rotateScope === "all" || incoming.rotateScope === "range") config.rotateScope = incoming.rotateScope;
      if (typeof incoming.rotateRange === "string") config.rotateRange = incoming.rotateRange;
      if (typeof incoming.splitPages === "boolean") config.splitPages = incoming.splitPages;
      if (incoming.splitMode === "range" || incoming.splitMode === "every") config.splitMode = incoming.splitMode;
      if (typeof incoming.splitRange === "string") config.splitRange = incoming.splitRange;
      if (typeof incoming.splitEvery === "number" && incoming.splitEvery >= 1) config.splitEvery = incoming.splitEvery;
      if (typeof incoming.stripMetadata === "boolean") config.stripMetadata = incoming.stripMetadata;
      if (container) renderControls();
    },

    reset(): void {
      Object.assign(config, DEFAULT_CONFIG);
      currentFile = null; rawFile = null; queue = [];
      detectedAnnotCount = null; detectedPageCount = null;
      userToggledAnnot = false;
      if (container) renderControls();
    },
  };
}
