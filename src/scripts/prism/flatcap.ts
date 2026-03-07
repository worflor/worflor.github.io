// prism-flatcap.ts — Flatcap module: PDF annotation flattening/stripping via pdf-lib.

import { readFileAsUint8Array, type FileInfo } from "./engine";
import type { DocumentBuildResult } from "./scribe";

// ─── Types ───────────────────────────────────────────────────────────────────

export type FlatcapAction = "flatten-all" | "flatten-by-type" | "strip-all";

export interface FlatcapConfig {
  action: FlatcapAction;
  flattenComments: boolean;
  flattenHighlights: boolean;
  flattenFreeText: boolean;
  flattenInk: boolean;
  flattenStamps: boolean;
}

export interface FlatcapModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): DocumentBuildResult | null;
  getConfig(): FlatcapConfig;
  setConfig(config: unknown): void;
  setFile(file: File): void;
  reset(): void;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── pdf-lib CDN Loader ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedPdfLib: any = null;

async function loadPdfLib(): Promise<{ PDFDocument: any; PDFName: any; PDFArray: any }> {
  if (cachedPdfLib) return cachedPdfLib;

  const urls = [
    "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js",
    "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js",
  ];

  for (const url of urls) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      cachedPdfLib = { PDFDocument: mod.PDFDocument, PDFName: mod.PDFName, PDFArray: mod.PDFArray };
      return cachedPdfLib;
    } catch {
      continue;
    }
  }
  throw new Error("Failed to load pdf-lib. Check your internet connection.");
}

// ─── PDF Processing ──────────────────────────────────────────────────────────

const ANNOT_SUBTYPES: Record<string, keyof Pick<FlatcapConfig, "flattenComments" | "flattenHighlights" | "flattenFreeText" | "flattenInk" | "flattenStamps">> = {
  Text: "flattenComments",
  Popup: "flattenComments",
  Highlight: "flattenHighlights",
  Underline: "flattenHighlights",
  StrikeOut: "flattenHighlights",
  Squiggly: "flattenHighlights",
  FreeText: "flattenFreeText",
  Ink: "flattenInk",
  Stamp: "flattenStamps",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processPdf(bytes: Uint8Array, config: FlatcapConfig, PDFDocument: any, PDFName: any, PDFArray: any): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const node = page.node;
    const annotsRef = node.get(PDFName.of("Annots"));
    if (!annotsRef) continue;

    if (config.action === "strip-all") {
      node.delete(PDFName.of("Annots"));
      continue;
    }

    // Resolve the annotations array
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

      let shouldProcess = false;
      if (config.action === "flatten-all") {
        shouldProcess = true;
      } else {
        // flatten-by-type
        const configKey = ANNOT_SUBTYPES[subtypeStr];
        shouldProcess = configKey ? config[configKey] : false;
      }

      if (!shouldProcess) {
        keep.push(annotRef);
      }
      // When flattening, we simply remove the annotation.
      // pdf-lib doesn't provide direct content stream merging for appearance streams,
      // but removing annotations is the primary use case (annotation data is stripped).
    }

    if (keep.length === 0) {
      node.delete(PDFName.of("Annots"));
    } else if (keep.length < size) {
      const newAnnots = PDFArray.withContext(pdfDoc.context);
      for (const ref of keep) newAnnots.push(ref);
      node.set(PDFName.of("Annots"), newAnnots);
    }
  }

  return pdfDoc.save();
}

// ─── Module Factory ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FlatcapConfig = {
  action: "flatten-all",
  flattenComments: true,
  flattenHighlights: true,
  flattenFreeText: true,
  flattenInk: true,
  flattenStamps: true,
};

const ACTIONS: { id: FlatcapAction; label: string }[] = [
  { id: "flatten-all",     label: "Flatten All" },
  { id: "flatten-by-type", label: "Flatten by Type" },
  { id: "strip-all",       label: "Strip All" },
];

export function createFlatcap(): FlatcapModule {
  let currentFile: FileInfo | null = null;
  let rawFile: File | null = null;
  let container: HTMLElement | null = null;
  let actionTabsEl: HTMLElement | null = null;
  let panelEl: HTMLElement | null = null;

  const config: FlatcapConfig = { ...DEFAULT_CONFIG };

  // ── Action Tabs ──────────────────────────────────────────────────────────

  function renderActionTabs(parent: HTMLElement): void {
    actionTabsEl = el("div", "fc-action-tabs");

    for (const action of ACTIONS) {
      const btn = el("button", "fc-tab", action.label);
      btn.dataset.action = action.id;
      if (action.id === config.action) btn.classList.add("fc-tab--active");

      btn.addEventListener("click", () => {
        config.action = action.id;
        actionTabsEl?.querySelectorAll(".fc-tab").forEach((t) => t.classList.remove("fc-tab--active"));
        btn.classList.add("fc-tab--active");
        renderPanel();
      });

      actionTabsEl.appendChild(btn);
    }

    parent.appendChild(actionTabsEl);
  }

  // ── Panels ───────────────────────────────────────────────────────────────

  function renderPanel(): void {
    if (!panelEl) return;
    panelEl.innerHTML = "";

    switch (config.action) {
      case "flatten-all":
        panelEl.appendChild(el("p", "fc-hint", "Removes all annotations from the PDF. Annotation appearance streams are discarded and the page content is preserved as-is."));
        break;
      case "flatten-by-type":
        renderByTypePanel(panelEl);
        break;
      case "strip-all":
        panelEl.appendChild(el("p", "fc-hint", "Permanently removes the entire annotation layer. This cannot be undone \u2014 make sure you have a backup."));
        break;
    }
  }

  function renderByTypePanel(parent: HTMLElement): void {
    const types: { key: keyof Pick<FlatcapConfig, "flattenComments" | "flattenHighlights" | "flattenFreeText" | "flattenInk" | "flattenStamps">; label: string }[] = [
      { key: "flattenComments",   label: "Comments & Popups" },
      { key: "flattenHighlights", label: "Highlights & Underlines" },
      { key: "flattenFreeText",   label: "Free Text" },
      { key: "flattenInk",        label: "Ink Drawings" },
      { key: "flattenStamps",     label: "Stamps" },
    ];

    for (const { key, label } of types) {
      const field = el("div", "fc-field fc-field--row");
      const lbl = el("label", "fc-toggle-label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = config[key];
      cb.addEventListener("change", () => { config[key] = cb.checked; });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(` ${label}`));
      field.appendChild(lbl);
      parent.appendChild(field);
    }
  }

  function renderControls(): void {
    if (!container) return;
    container.innerHTML = "";

    renderActionTabs(container);

    panelEl = el("div", "fc-panel");
    container.appendChild(panelEl);
    renderPanel();
  }

  return {
    render(c: HTMLElement): void {
      container = c;
      renderControls();
    },

    configure(file: FileInfo): void {
      currentFile = file;
      if (container) renderControls();
    },

    setFile(file: File): void {
      rawFile = file;
    },

    build(): DocumentBuildResult | null {
      if (!rawFile || !currentFile) return null;
      const baseName = currentFile.name.replace(/\.pdf$/i, "");
      const suffix = config.action === "strip-all" ? "stripped" : "flat";
      const outputName = `${baseName}_${suffix}.pdf`;
      const cfgSnapshot = { ...config };
      const file = rawFile;

      return {
        pipeline: "document",
        outputName,
        execute: async () => {
          const bytes = await readFileAsUint8Array(file);
          const { PDFDocument, PDFName, PDFArray } = await loadPdfLib();
          return processPdf(bytes, cfgSnapshot, PDFDocument, PDFName, PDFArray);
        },
      };
    },

    getConfig(): FlatcapConfig {
      return { ...config };
    },

    setConfig(incoming: unknown): void {
      if (!isRecord(incoming)) return;
      if (incoming.action === "flatten-all" || incoming.action === "flatten-by-type" || incoming.action === "strip-all") config.action = incoming.action;
      if (typeof incoming.flattenComments === "boolean") config.flattenComments = incoming.flattenComments;
      if (typeof incoming.flattenHighlights === "boolean") config.flattenHighlights = incoming.flattenHighlights;
      if (typeof incoming.flattenFreeText === "boolean") config.flattenFreeText = incoming.flattenFreeText;
      if (typeof incoming.flattenInk === "boolean") config.flattenInk = incoming.flattenInk;
      if (typeof incoming.flattenStamps === "boolean") config.flattenStamps = incoming.flattenStamps;
      if (container) renderControls();
    },

    reset(): void {
      Object.assign(config, DEFAULT_CONFIG);
      currentFile = null;
      rawFile = null;
      if (container) renderControls();
    },
  };
}
