// lens-ui.ts — Rendering, interaction, and file handling for The Lens page.
// Consumes data from lens-exif.ts. No module-level mutable state — all
// state is scoped inside initLens() so Astro lifecycle produces a clean tear-down.

import { parseFile, LENS_CATEGORY_ORDER, type ExifCategory, type ExifField, type LensData } from "./exif";
import { isPrismSupportedFile } from "../prism/engine";
import { parsePrismDraftSnapshot } from "../prism/draft";
import {
  buildPrismHandoffUrl,
  clearHandoffTokenFromCurrentUrl,
  consumeFileHandoffWithRetry,
  createFileHandoff,
  getHandoffTokenFromCurrentUrl,
  supportsFileHandoff,
} from "../shared/file-handoff";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface LensUIOptions {
  container: HTMLElement;
  uploadZone: HTMLElement;
  fileInput: HTMLInputElement;
  previewSection: HTMLElement;
  previewImg: HTMLImageElement;
  previewAudio: HTMLAudioElement;
  previewVideo: HTMLVideoElement;
  previewText: HTMLPreElement;
  summarySection: HTMLElement;
  summaryFields: HTMLElement;
  summaryDynamic: HTMLElement;
  actionsBar: HTMLElement;
  actionCopyBtn: HTMLButtonElement;
  actionPrismBtn: HTMLButtonElement;
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
  previewAudio: "lens-preview-audio",
  previewVideo: "lens-preview-video",
  previewText: "lens-preview-text",
  summarySection: "lens-summary-section",
  summaryFields: "lens-summary-fields",
  summaryDynamic: "lens-summary-dynamic",
  actionsBar: "lens-actions",
  actionCopyBtn: "lens-action-copy",
  actionPrismBtn: "lens-action-prism",
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

function queryAudioById(root: ParentNode, id: string): HTMLAudioElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLAudioElement ? node : null;
}

function queryVideoById(root: ParentNode, id: string): HTMLVideoElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLVideoElement ? node : null;
}

function queryPreById(root: ParentNode, id: string): HTMLPreElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLPreElement ? node : null;
}

export function resolveLensUIOptions(root: ParentNode = document): LensUIOptions | null {
  const container = queryById(root, LENS_UI_IDS.container);
  const uploadZone = queryById(root, LENS_UI_IDS.uploadZone);
  const fileInput = queryInputById(root, LENS_UI_IDS.fileInput);
  const previewSection = queryById(root, LENS_UI_IDS.previewSection);
  const previewImg = queryImgById(root, LENS_UI_IDS.previewImg);
  const previewAudio = queryAudioById(root, LENS_UI_IDS.previewAudio);
  const previewVideo = queryVideoById(root, LENS_UI_IDS.previewVideo);
  const previewText = queryPreById(root, LENS_UI_IDS.previewText);
  const summarySection = queryById(root, LENS_UI_IDS.summarySection);
  const summaryFields = queryById(root, LENS_UI_IDS.summaryFields);
  const summaryDynamic = queryById(root, LENS_UI_IDS.summaryDynamic);
  const actionsBar = queryById(root, LENS_UI_IDS.actionsBar);
  const actionCopyBtn = queryButtonById(root, LENS_UI_IDS.actionCopyBtn);
  const actionPrismBtn = queryButtonById(root, LENS_UI_IDS.actionPrismBtn);
  const actionUploadBtn = queryButtonById(root, LENS_UI_IDS.actionUploadBtn);
  const loadingIndicator = queryById(root, LENS_UI_IDS.loadingIndicator);
  const emptyState = queryById(root, LENS_UI_IDS.emptyState);

  if (
    !container || !uploadZone || !fileInput || !previewSection ||
    !previewImg || !previewAudio || !previewVideo || !previewText ||
    !summarySection || !summaryFields || !summaryDynamic ||
    !actionsBar || !actionCopyBtn ||
    !actionPrismBtn ||
    !actionUploadBtn || !loadingIndicator || !emptyState
  ) {
    return null;
  }

  return {
    container, uploadZone, fileInput, previewSection,
    previewImg, previewAudio, previewVideo, previewText,
    summarySection, summaryFields, summaryDynamic,
    actionsBar, actionCopyBtn, actionPrismBtn, actionUploadBtn,
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

function readHandoffSource(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).source;
  if (typeof value !== "string") return null;
  const source = value.trim().toLowerCase();
  return source.length > 0 ? source : null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EXPANSION_STATE_KEY = "theLens.categoryExpansion.v1";
const LENS_REFRESH_FILE_KEY = "theLens.refreshFileToken.v1";
const CATEGORY_REVEAL_OFFSET_PX = 8;
const ACTION_BAR_FADE_MS = 300;
const TOAST_VISIBLE_MS = 2200;
const TOAST_EXIT_MS = 300;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initLens(opts: LensUIOptions): () => void {
  let destroyed = false;
  let currentData: LensData | null = null;
  let currentInputFile: File | null = null;
  let currentObjectUrl: string | null = null;
  let expansionState = loadExpansionState();
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let actionBarTimer: ReturnType<typeof setTimeout> | null = null;
  const categoryRevealTimers = new Set<ReturnType<typeof setTimeout>>();
  let generation = 0; // monotonic counter to discard stale async results
  let prismHandoffInFlight = false;
  let handoffSupported = true;
  let prismDraftMetadata: unknown | null = null;
  let bootRestorePending = false;
  const cleanups: Array<() => void> = [];

  function saveRefreshFileToken(token: string): void {
    try {
      window.localStorage.setItem(LENS_REFRESH_FILE_KEY, token);
    } catch {
      // Ignore persistence errors.
    }
  }

  function loadRefreshFileToken(): string | null {
    try {
      const token = window.localStorage.getItem(LENS_REFRESH_FILE_KEY);
      return token && token.trim().length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  function clearRefreshFileToken(): void {
    try {
      window.localStorage.removeItem(LENS_REFRESH_FILE_KEY);
    } catch {
      // Ignore persistence errors.
    }
  }

  async function persistCurrentFileForRefresh(file: File, metadata: unknown | null): Promise<void> {
    try {
      if (!(await supportsFileHandoff())) return;
      const token = await createFileHandoff(file, metadata === null ? undefined : metadata);
      saveRefreshFileToken(token);
    } catch {
      // Ignore persistence errors.
    }
  }

  function on<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    event: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler as EventListener, options);
    cleanups.push(() => target.removeEventListener(event, handler as EventListener, options));
  }

  function clearCategoryRevealTimers(): void {
    for (const timer of categoryRevealTimers) {
      clearTimeout(timer);
    }
    categoryRevealTimers.clear();
  }

  function isEditablePasteTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) {
      const type = target.type.toLowerCase();
      const nonTextual = new Set([
        "button",
        "checkbox",
        "color",
        "date",
        "datetime-local",
        "file",
        "hidden",
        "image",
        "month",
        "number",
        "radio",
        "range",
        "reset",
        "submit",
        "time",
        "week",
      ]);
      return !nonTextual.has(type);
    }
    if ((target as HTMLElement).isContentEditable) return true;
    return Boolean(target.closest("[contenteditable='true']"));
  }

  function shouldHandleClipboardFilePaste(event: ClipboardEvent): boolean {
    if (isEditablePasteTarget(event.target)) return false;

    const lensRoot = opts.uploadZone.closest(".lens-page");
    if (!lensRoot) return true;

    const target = event.target;
    if (target instanceof Node && lensRoot.contains(target)) return true;

    const active = document.activeElement;
    if (active instanceof Node && lensRoot.contains(active)) return true;

    return false;
  }

  // ── Preview management ────────────────────────────────

  function hideAllPreviews(): void {
    // Clear img event handlers to prevent stale callbacks
    opts.previewImg.onload = null;
    opts.previewImg.onerror = null;
    opts.previewImg.style.display = "none";
    opts.previewImg.style.opacity = "0";
    opts.previewAudio.style.display = "none";
    opts.previewAudio.pause();
    opts.previewAudio.removeAttribute("src");
    opts.previewVideo.style.display = "none";
    opts.previewVideo.pause();
    opts.previewVideo.removeAttribute("src");
    opts.previewText.style.display = "none";
    opts.previewText.textContent = "";
  }

  function showPreview(data: LensData, objectUrl: string): void {
    hideAllPreviews();

    switch (data.previewType) {
      case "image": {
        opts.previewImg.src = objectUrl;
        opts.previewImg.alt = `Preview of ${data.fileName}`;
        opts.previewImg.style.display = "";
        opts.previewImg.style.opacity = "0";
        opts.previewSection.style.display = "";

        opts.previewImg.onload = () => {
          requestAnimationFrame(() => {
            opts.previewImg.style.opacity = "1";
          });
        };
        opts.previewImg.onerror = () => {
          opts.previewImg.style.display = "none";
          // If no other preview is visible, hide the section
          opts.previewSection.style.display = "none";
        };
        break;
      }

      case "audio": {
        opts.previewAudio.src = objectUrl;
        opts.previewAudio.style.display = "";
        opts.previewSection.style.display = "";
        break;
      }

      case "video": {
        opts.previewVideo.src = objectUrl;
        opts.previewVideo.style.display = "";
        opts.previewSection.style.display = "";
        break;
      }

      case "text": {
        if (data.textPreview) {
          opts.previewText.textContent = data.textPreview;
          opts.previewText.style.display = "";
          opts.previewSection.style.display = "";
        }
        break;
      }

      case "none":
      default:
        opts.previewSection.style.display = "none";
        break;
    }
  }

  function isPrismHandoffEligible(): boolean {
    if (!currentInputFile) return false;
    return isPrismSupportedFile(currentInputFile);
  }

  function updateHandoffButtons(): void {
    const isEligible = isPrismHandoffEligible();
    const prismVisible = handoffSupported && isEligible;
    opts.actionPrismBtn.style.display = prismVisible ? "" : "none";
    opts.actionPrismBtn.disabled = !prismVisible || prismHandoffInFlight;
    opts.actionPrismBtn.setAttribute("aria-busy", prismHandoffInFlight ? "true" : "false");
  }

  // ── Summary rendering ─────────────────────────────────

  function renderSummary(data: LensData): void {
    opts.summaryFields.textContent = String(data.populatedFields);

    // Clear dynamic summary
    opts.summaryDynamic.innerHTML = "";

    const items = data.summaryItems;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Separator before each dynamic item
      const sep = el("span", "summary-separator");
      sep.textContent = "\u00B7";
      opts.summaryDynamic.appendChild(sep);

      const stat = el("div", "summary-stat");

      const value = el("span", "summary-value");
      value.textContent = item.value;

      // Apply GPS-specific styling for backward compatibility
      if (item.label === "GPS") {
        const isGps = item.value === "yes";
        value.classList.toggle("lens-gps-yes", isGps);
        value.classList.toggle("lens-gps-no", !isGps);
      }

      const label = el("span", "summary-label");
      label.textContent = item.label;

      stat.append(value, " ", label);
      opts.summaryDynamic.appendChild(stat);
    }

    opts.summarySection.style.display = "";
  }

  // ── File handling ─────────────────────────────────────

  async function processFile(
    file: File,
    options?: {
      preservePrismDraft?: boolean;
      prismDraftMetadata?: unknown | null;
      suppressLoadingIndicator?: boolean;
    },
  ): Promise<void> {
    if (destroyed) return;
    if (file.size === 0) {
      showToast("empty file");
      return;
    }
    if (options?.preservePrismDraft) {
      prismDraftMetadata = options.prismDraftMetadata ?? null;
    } else {
      prismDraftMetadata = null;
    }
    currentInputFile = file;

    // If already processing, cancel the old run by bumping generation
    const thisGen = ++generation;

    // Hide upload zone, show loading
    opts.uploadZone.style.display = "none";
    opts.emptyState.style.display = "none";
    opts.loadingIndicator.style.display = options?.suppressLoadingIndicator ? "none" : "";

    // Clear currently rendered result so new file always replaces old cleanly.
    clearCategoryRevealTimers();
    hideAllPreviews();
    opts.previewSection.style.display = "none";
    opts.summarySection.style.display = "none";
    opts.summaryDynamic.innerHTML = "";
    opts.container.innerHTML = "";
    opts.actionsBar.style.display = "none";
    opts.actionsBar.style.opacity = "0";
    if (actionBarTimer) {
      clearTimeout(actionBarTimer);
      actionBarTimer = null;
    }

    // Create object URL for previews
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);

    // Parse file
    let data: LensData;
    try {
      data = await parseFile(file);
    } catch {
      // Only act if we're still the active generation
      if (thisGen !== generation) return;
      showToast("failed to parse file");
      opts.loadingIndicator.style.display = "none";

      resetToUpload();
      return;
    }

    // Stale check: if a newer file was submitted while we were parsing, discard
    if (destroyed || thisGen !== generation) return;

    opts.loadingIndicator.style.display = "none";
    currentData = data;

    // Set up preview based on detected format
    showPreview(data, currentObjectUrl);

    // Update summary
    renderSummary(data);

    // Check if we have meaningful metadata beyond file info
    if (!data.hasExif) {
      opts.emptyState.style.display = "";
    }

    // Render categories
    renderCategories(data);

    void persistCurrentFileForRefresh(file, prismDraftMetadata);

    // Show action bar
    updateHandoffButtons();
    opts.actionsBar.style.display = "";
    requestAnimationFrame(() => {
      opts.actionsBar.style.opacity = "1";
    });
  }

  function resetToUpload(): void {
    clearCategoryRevealTimers();

    // Stop all previews and clear sources first (before revoking URL)
    hideAllPreviews();
    opts.previewSection.style.display = "none";

    // Now safe to revoke — no element is still loading from this URL
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    currentInputFile = null;
    currentData = null;
    prismDraftMetadata = null;
    clearRefreshFileToken();
    updateHandoffButtons();
    opts.summarySection.style.display = "none";
    opts.summaryDynamic.innerHTML = "";
    opts.emptyState.style.display = "none";
    opts.container.innerHTML = "";
    opts.actionsBar.style.opacity = "0";
    opts.loadingIndicator.style.display = "none";
    if (actionBarTimer) clearTimeout(actionBarTimer);
    actionBarTimer = setTimeout(() => {
      if (!destroyed) opts.actionsBar.style.display = "none";
      actionBarTimer = null;
    }, ACTION_BAR_FADE_MS);
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
    const dt = (e as DragEvent).dataTransfer;
    if (dt && dt.files.length > 0) processFile(dt.files[0]);
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
    if (!shouldHandleClipboardFilePaste(e as ClipboardEvent)) return;

    const clipboard = (e as ClipboardEvent).clipboardData;
    if (!clipboard) return;
    const items = clipboard.items;
    for (let i = 0; i < items.length; i++) {
      const file = items[i].getAsFile();
      if (file) {
        e.preventDefault();
        processFile(file);
        return;
      }
    }
  });

  // ── Category rendering ────────────────────────────────

  function renderCategories(data: LensData): void {
    clearCategoryRevealTimers();
    const fragment = document.createDocumentFragment();

    data.categories.forEach((cat) => {
      const section = renderCategory(cat);
      fragment.appendChild(section);
    });

    opts.container.replaceChildren(fragment);
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
        valueEl.removeEventListener("keydown", handleKeydown);
        valueEl.textContent = f.displayValue;
        valueEl.classList.remove("dp-masked");
        valueEl.removeAttribute("role");
        valueEl.removeAttribute("tabindex");
        valueEl.removeAttribute("aria-label");
      };
      valueEl.addEventListener("click", reveal, { once: true });
      const handleKeydown = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          reveal();
          valueEl.removeEventListener("keydown", handleKeydown);
        }
      };
      valueEl.addEventListener("keydown", handleKeydown);
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

  // ── Open in Prism ────────────────────────────────────────────────

  on(opts.actionPrismBtn, "click", async () => {
    if (prismHandoffInFlight || !handoffSupported || !currentData || !currentInputFile || !isPrismHandoffEligible()) {
      return;
    }

    prismHandoffInFlight = true;
    updateHandoffButtons();
    try {
      let token: string;
      try {
        token = await createFileHandoff(
          currentInputFile,
          prismDraftMetadata === null ? undefined : prismDraftMetadata,
        );
      } catch {
        token = await createFileHandoff(currentInputFile);
      }
      window.location.href = buildPrismHandoffUrl(token);
    } catch {
      showToast("could not handoff file to prism");
    } finally {
      prismHandoffInFlight = false;
      if (!destroyed) updateHandoffButtons();
    }
  });

  // ── Upload new ────────────────────────────────────────

  on(opts.actionUploadBtn, "click", () => {
    // Just open the file picker — keep current results visible until a new file is chosen
    opts.fileInput.value = "";
    opts.fileInput.click();
  });

  updateHandoffButtons();

  async function initPrismHandoffSupport(): Promise<void> {
    handoffSupported = await supportsFileHandoff();
    if (destroyed) return;
    updateHandoffButtons();
  }

  void initPrismHandoffSupport();

  async function consumePrismHandoffIfPresent(): Promise<void> {
    const token = getHandoffTokenFromCurrentUrl();
    if (!token) return;
    clearHandoffTokenFromCurrentUrl();

    try {
      const payload = await consumeFileHandoffWithRetry(token);
      if (!payload) {
        if (!destroyed) showToast("handoff expired or already used");
        return;
      }
      if (destroyed) return;
      const hadMetadata = payload.metadata !== null;
      const handoffSource = hadMetadata ? readHandoffSource(payload.metadata) : null;
      const shouldParsePrismDraft = hadMetadata && (handoffSource === null || handoffSource === "prism");
      const draftSnapshot = shouldParsePrismDraft ? parsePrismDraftSnapshot(payload.metadata) : null;
      await processFile(payload.file, {
        preservePrismDraft: true,
        prismDraftMetadata: draftSnapshot,
        suppressLoadingIndicator: true,
      });
      if (!destroyed && shouldParsePrismDraft && !draftSnapshot) {
        showToast("loaded file. prism draft could not be restored");
      }
    } catch {
      if (!destroyed) showToast("could not load handoff file");
    }
  }

  async function restoreRefreshFileIfPresent(): Promise<void> {
    if (currentInputFile) return;
    const token = loadRefreshFileToken();
    if (!token) return;

    try {
      const payload = await consumeFileHandoffWithRetry(token);
      if (!payload) {
        clearRefreshFileToken();
        return;
      }
      if (destroyed || currentInputFile) return;
      const handoffSource = payload.metadata === null ? null : readHandoffSource(payload.metadata);
      const shouldParsePrismDraft = payload.metadata !== null && (handoffSource === null || handoffSource === "prism");
      const draftSnapshot = shouldParsePrismDraft ? parsePrismDraftSnapshot(payload.metadata) : null;
      await processFile(payload.file, {
        preservePrismDraft: true,
        prismDraftMetadata: draftSnapshot,
        suppressLoadingIndicator: true,
      });
    } catch {
      // Ignore restore failures silently.
    }
  }

  bootRestorePending = Boolean(getHandoffTokenFromCurrentUrl() || loadRefreshFileToken());
  if (bootRestorePending) {
    opts.uploadZone.style.display = "none";
    opts.emptyState.style.display = "none";
    opts.loadingIndicator.style.display = "none";
  }

  void (async () => {
    try {
      await consumePrismHandoffIfPresent();
      await restoreRefreshFileIfPresent();
    } finally {
      bootRestorePending = false;
      if (destroyed || currentInputFile) return;
      opts.loadingIndicator.style.display = "none";
      opts.uploadZone.style.display = "";
      opts.emptyState.style.display = "none";
    }
  })();

  // ── Toast ─────────────────────────────────────────────

  function showToast(message: string): void {
    if (destroyed) return;
    // Remove existing toast
    const existing = document.querySelector(".lens-toast");
    if (existing) existing.remove();
    if (toastTimer) clearTimeout(toastTimer);

    const toast = el("div", "lens-toast", message);
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
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
    clearCategoryRevealTimers();
    // Clean up media elements
    opts.previewAudio.pause();
    opts.previewAudio.removeAttribute("src");
    opts.previewVideo.pause();
    opts.previewVideo.removeAttribute("src");
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    if (toastTimer) clearTimeout(toastTimer);
    if (actionBarTimer) clearTimeout(actionBarTimer);
    const toast = document.querySelector(".lens-toast");
    if (toast) toast.remove();
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  };
}
