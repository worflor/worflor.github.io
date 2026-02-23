// lens-ui.ts — Rendering, interaction, and file handling for The Lens page.
// Consumes data from lens-exif.ts. No module-level mutable state — all
// state is scoped inside initLens() so Astro lifecycle produces a clean tear-down.

import { parseImageFile, LENS_CATEGORY_ORDER, type ExifCategory, type ExifField, type LensData } from "./lens-exif";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface LensUIOptions {
  container: HTMLElement;
  uploadZone: HTMLElement;
  fileInput: HTMLInputElement;
  previewSection: HTMLElement;
  previewImg: HTMLImageElement;
  summarySection: HTMLElement;
  summaryFields: HTMLElement;
  summaryCamera: HTMLElement;
  summaryGps: HTMLElement;
  actionsBar: HTMLElement;
  actionCopyBtn: HTMLButtonElement;
  actionUploadBtn: HTMLButtonElement;
  loadingIndicator: HTMLElement;
  emptyState: HTMLElement;
}

type LensUIIdMap = { [K in keyof LensUIOptions]: string };

export const LENS_UI_IDS: LensUIIdMap = {
  container: "lens-categories",
  uploadZone: "lens-upload-zone",
  fileInput: "lens-file-input",
  previewSection: "lens-preview-section",
  previewImg: "lens-preview-img",
  summarySection: "lens-summary-section",
  summaryFields: "lens-summary-fields",
  summaryCamera: "lens-summary-camera",
  summaryGps: "lens-summary-gps",
  actionsBar: "lens-actions",
  actionCopyBtn: "lens-action-copy",
  actionUploadBtn: "lens-action-upload",
  loadingIndicator: "lens-loading",
  emptyState: "lens-empty-state",
};

function queryById(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

function queryButtonById(root: ParentNode, id: string): HTMLButtonElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLButtonElement ? node : null;
}

function queryInputById(root: ParentNode, id: string): HTMLInputElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLInputElement ? node : null;
}

function queryImgById(root: ParentNode, id: string): HTMLImageElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLImageElement ? node : null;
}

export function resolveLensUIOptions(root: ParentNode = document): LensUIOptions | null {
  const container = queryById(root, LENS_UI_IDS.container);
  const uploadZone = queryById(root, LENS_UI_IDS.uploadZone);
  const fileInput = queryInputById(root, LENS_UI_IDS.fileInput);
  const previewSection = queryById(root, LENS_UI_IDS.previewSection);
  const previewImg = queryImgById(root, LENS_UI_IDS.previewImg);
  const summarySection = queryById(root, LENS_UI_IDS.summarySection);
  const summaryFields = queryById(root, LENS_UI_IDS.summaryFields);
  const summaryCamera = queryById(root, LENS_UI_IDS.summaryCamera);
  const summaryGps = queryById(root, LENS_UI_IDS.summaryGps);
  const actionsBar = queryById(root, LENS_UI_IDS.actionsBar);
  const actionCopyBtn = queryButtonById(root, LENS_UI_IDS.actionCopyBtn);
  const actionUploadBtn = queryButtonById(root, LENS_UI_IDS.actionUploadBtn);
  const loadingIndicator = queryById(root, LENS_UI_IDS.loadingIndicator);
  const emptyState = queryById(root, LENS_UI_IDS.emptyState);

  if (
    !container || !uploadZone || !fileInput || !previewSection ||
    !previewImg || !summarySection || !summaryFields || !summaryCamera ||
    !summaryGps || !actionsBar || !actionCopyBtn ||
    !actionUploadBtn || !loadingIndicator || !emptyState
  ) {
    return null;
  }

  return {
    container, uploadZone, fileInput, previewSection, previewImg,
    summarySection, summaryFields, summaryCamera, summaryGps,
    actionsBar, actionCopyBtn, actionUploadBtn,
    loadingIndicator, emptyState,
  };
}

// ─── DOM helper ───────────────────────────────────────────────────────────────

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

// ─── Constants ────────────────────────────────────────────────────────────────

const EXPANSION_STATE_KEY = "theLens.categoryExpansion.v1";
const CATEGORY_STAGGER_MS = 80;
const CATEGORY_REVEAL_MS = 300;
const CATEGORY_REVEAL_OFFSET_PX = 8;
const TOAST_VISIBLE_MS = 2200;
const TOAST_EXIT_MS = 300;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initLens(opts: LensUIOptions): () => void {
  let destroyed = false;
  let currentData: LensData | null = null;
  let currentObjectUrl: string | null = null;
  let expansionState = loadExpansionState();
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;
  const cleanups: Array<() => void> = [];

  function on<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    event: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler as EventListener, options);
    cleanups.push(() => target.removeEventListener(event, handler as EventListener, options));
  }

  // ── File handling ─────────────────────────────────────

  async function processFile(file: File): Promise<void> {
    if (destroyed || processing) return;
    if (file.size === 0) {
      showToast("empty file");
      return;
    }

    processing = true;

    // Hide upload zone, show loading
    opts.uploadZone.style.display = "none";
    opts.emptyState.style.display = "none";
    opts.loadingIndicator.style.display = "";

    // Set up preview — try to render it, hide if browser can't
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);
    opts.previewImg.src = currentObjectUrl;
    opts.previewImg.alt = `Preview of ${file.name}`;

    opts.previewImg.style.opacity = "0";
    opts.previewSection.style.display = "";
    opts.previewImg.onload = () => {
      requestAnimationFrame(() => {
        opts.previewImg.style.opacity = "1";
      });
    };
    opts.previewImg.onerror = () => {
      // Browser can't render this format — hide the preview entirely
      opts.previewSection.style.display = "none";
    };

    // Parse EXIF
    let data: LensData;
    try {
      data = await parseImageFile(file);
    } catch {
      showToast("failed to parse file");
      opts.loadingIndicator.style.display = "none";
      processing = false;
      resetToUpload();
      return;
    }

    if (destroyed) { processing = false; return; }

    opts.loadingIndicator.style.display = "none";
    currentData = data;

    // Update summary
    opts.summaryFields.textContent = String(data.populatedFields);
    opts.summaryCamera.textContent = data.cameraName ?? "unknown";
    opts.summaryGps.textContent = data.hasGps ? "yes" : "no";
    opts.summaryGps.classList.toggle("lens-gps-yes", data.hasGps);
    opts.summaryGps.classList.toggle("lens-gps-no", !data.hasGps);
    opts.summarySection.style.display = "";

    // Check if we have meaningful EXIF data beyond file metadata
    if (!data.hasExif) {
      opts.emptyState.style.display = "";
    }

    // Render categories
    renderCategories(data);

    // Show action bar
    opts.actionsBar.style.display = "";
    requestAnimationFrame(() => {
      opts.actionsBar.style.opacity = "1";
    });

    processing = false;
  }

  function resetToUpload(): void {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    currentData = null;
    opts.previewSection.style.display = "none";
    opts.previewImg.src = "";
    opts.previewImg.style.opacity = "0";
    opts.summarySection.style.display = "none";
    opts.emptyState.style.display = "none";
    opts.container.innerHTML = "";
    opts.actionsBar.style.opacity = "0";
    opts.loadingIndicator.style.display = "none";
    setTimeout(() => {
      if (!destroyed) opts.actionsBar.style.display = "none";
    }, 300);
    opts.uploadZone.style.display = "";
    opts.fileInput.value = "";
  }

  // ── Drag-and-drop ─────────────────────────────────────

  let dragCounter = 0;

  on(opts.uploadZone, "dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    opts.uploadZone.classList.add("lens-drop-active");
  });

  on(opts.uploadZone, "dragover", (e) => {
    e.preventDefault();
  });

  on(opts.uploadZone, "dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      opts.uploadZone.classList.remove("lens-drop-active");
    }
  });

  on(opts.uploadZone, "drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    opts.uploadZone.classList.remove("lens-drop-active");
    const file = (e as DragEvent).dataTransfer?.files[0];
    if (file) processFile(file);
  });

  // Click-to-upload
  on(opts.uploadZone, "click", () => {
    opts.fileInput.click();
  });

  // Keyboard on upload zone
  on(opts.uploadZone, "keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      opts.fileInput.click();
    }
  });

  on(opts.fileInput, "change", () => {
    const file = opts.fileInput.files?.[0];
    if (file) processFile(file);
  });

  // ── Clipboard paste ─────────────────────────────────────

  on(document, "paste", (e) => {
    const items = (e as ClipboardEvent).clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) processFile(file);
        return;
      }
    }
  });

  // ── Category rendering ────────────────────────────────

  function renderCategories(data: LensData): void {
    opts.container.innerHTML = "";
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    data.categories.forEach((cat, index) => {
      const section = renderCategory(cat);

      if (!prefersReducedMotion) {
        section.style.opacity = "0";
        section.style.transform = `translateY(${CATEGORY_REVEAL_OFFSET_PX}px)`;
        setTimeout(() => {
          if (destroyed) return;
          section.style.transition = `opacity ${CATEGORY_REVEAL_MS}ms ease, transform ${CATEGORY_REVEAL_MS}ms ease`;
          section.style.opacity = "1";
          section.style.transform = "translateY(0)";
        }, CATEGORY_STAGGER_MS * index);
      }

      opts.container.appendChild(section);
    });
  }

  function renderCategory(cat: ExifCategory): HTMLElement {
    const section = el("div", "cat-section");
    section.dataset.cat = cat.id;

    // Toggle button
    const toggle = el("button", "cat-toggle");
    const arrow = el("span", "cat-arrow", "\u25B6");
    const title = el("span", "cat-title", cat.title);
    const count = el("span", "cat-count", String(cat.fields.length));

    toggle.append(arrow, title, count);
    section.appendChild(toggle);

    // Body
    const body = el("div", "cat-body");
    for (const f of cat.fields) {
      body.appendChild(renderField(f));
    }
    section.appendChild(body);

    // Determine initial expansion state (localStorage overrides data default)
    const savedState = expansionState.get(cat.id);
    const isExpanded = savedState !== undefined ? savedState : cat.expanded;
    toggle.setAttribute("aria-expanded", String(isExpanded));

    if (!isExpanded) {
      body.style.display = "none";
      arrow.style.transform = "rotate(0deg)";
    } else {
      arrow.style.transform = "rotate(90deg)";
    }

    toggle.addEventListener("click", () => {
      const expanded = body.style.display !== "none";
      if (expanded) {
        body.style.display = "none";
        arrow.style.transform = "rotate(0deg)";
        toggle.setAttribute("aria-expanded", "false");
      } else {
        body.style.display = "";
        arrow.style.transform = "rotate(90deg)";
        toggle.setAttribute("aria-expanded", "true");
      }
      expansionState.set(cat.id, !expanded);
      saveExpansionState(expansionState);
    });

    return section;
  }

  function renderField(f: ExifField): HTMLElement {
    const row = el("div", "dp-row");
    row.dataset.id = f.id;

    const header = el("div", "dp-header");
    const label = el("span", "dp-label", f.label);
    const valueEl = el("span", "dp-value");

    // GPS warning gets special styling
    if (f.id === "gps.warning") {
      row.classList.add("lens-gps-warning");
      valueEl.textContent = f.displayValue;
    } else if (f.sensitive) {
      // Sensitive fields: click-to-reveal
      row.classList.add("dp-sensitive");
      valueEl.textContent = "\u2022\u2022\u2022\u2022\u2022\u2022";
      valueEl.classList.add("dp-masked");
      valueEl.setAttribute("role", "button");
      valueEl.setAttribute("tabindex", "0");
      valueEl.setAttribute("aria-label", `Reveal ${f.label}`);
      const reveal = () => {
        valueEl.textContent = f.displayValue;
        valueEl.classList.remove("dp-masked");
        valueEl.removeAttribute("role");
        valueEl.removeAttribute("tabindex");
        valueEl.removeAttribute("aria-label");
      };
      valueEl.addEventListener("click", reveal, { once: true });
      valueEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reveal(); }
      }, { once: true });
    } else if (f.value === null) {
      valueEl.classList.add("dp-na");
      valueEl.textContent = "-";
    } else {
      valueEl.textContent = f.displayValue;
    }

    header.append(label, valueEl);
    row.appendChild(header);

    if (f.explanation) {
      row.appendChild(el("div", "dp-explain", f.explanation));
    }

    return row;
  }

  // ── Copy all ──────────────────────────────────────────

  on(opts.actionCopyBtn, "click", async () => {
    if (!currentData) return;

    const lines: string[] = [
      `The Lens \u2014 ${currentData.fileName}`,
      `Parsed: ${new Date(currentData.parsedAt).toLocaleString()}`,
      `Fields: ${currentData.populatedFields}`,
      "",
    ];

    for (const cat of currentData.categories) {
      lines.push(`\u2500\u2500 ${cat.title} \u2500\u2500`);
      for (const f of cat.fields) {
        if (f.id === "gps.warning") continue;
        lines.push(`  ${f.label}: ${f.displayValue}`);
      }
      lines.push("");
    }

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      showToast("copied to clipboard");
    } catch {
      showToast("failed to copy");
    }
  });

  // ── Upload new ────────────────────────────────────────

  on(opts.actionUploadBtn, "click", () => {
    // Just open the file picker — keep current results visible until a new file is chosen
    opts.fileInput.value = "";
    opts.fileInput.click();
  });

  // ── Toast ─────────────────────────────────────────────

  function showToast(message: string): void {
    // Remove existing toast
    const existing = document.querySelector(".lens-toast");
    if (existing) existing.remove();
    if (toastTimer) clearTimeout(toastTimer);

    const toast = el("div", "lens-toast", message);
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(-50%) translateY(0)";
    });

    toastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = `translateX(-50%) translateY(${CATEGORY_REVEAL_OFFSET_PX}px)`;
      setTimeout(() => toast.remove(), TOAST_EXIT_MS);
    }, TOAST_VISIBLE_MS);
  }

  // ── Expansion state persistence ───────────────────────

  function loadExpansionState(): Map<string, boolean> {
    const state = new Map<string, boolean>();
    const validIds = new Set<string>(LENS_CATEGORY_ORDER.map((c) => c.id));
    try {
      const raw = window.localStorage.getItem(EXPANSION_STATE_KEY);
      if (!raw) return state;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return state;
      for (const [id, expanded] of Object.entries(parsed as Record<string, unknown>)) {
        if (validIds.has(id) && typeof expanded === "boolean") {
          state.set(id, expanded);
        }
      }
    } catch {
      // Ignore
    }
    return state;
  }

  function saveExpansionState(state: Map<string, boolean>): void {
    try {
      const serializable: Record<string, boolean> = {};
      for (const [id, expanded] of state) {
        serializable[id] = expanded;
      }
      window.localStorage.setItem(EXPANSION_STATE_KEY, JSON.stringify(serializable));
    } catch {
      // Ignore
    }
  }

  // ── Cleanup ───────────────────────────────────────────

  return () => {
    destroyed = true;
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    if (toastTimer) clearTimeout(toastTimer);
    const toast = document.querySelector(".lens-toast");
    if (toast) toast.remove();
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  };
}
