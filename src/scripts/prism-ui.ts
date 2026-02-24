// prism-ui.ts — UI orchestration, state machine, DOM binding for The Prism.
// All state is scoped inside initPrism() for clean Astro lifecycle teardown.

import {
  createEngine,
  readFileAsUint8Array,
  checkFileSize,
  isMobileDevice,
  mimeForExtension,
  formatSize,
  type PrismEngine,
  type FileInfo,
  type EngineState,
  type EngineCallbacks,
  type ProgressEvent,
  type LoadProgressEvent,
  type EngineError,
} from "./prism-engine";
import {
  buildLensHandoffUrl,
  clearHandoffTokenFromCurrentUrl,
  consumeFileHandoffWithRetry,
  consumePrismQueueSessionWithRetry,
  createFileHandoff,
  createPrismQueueSession,
  getHandoffTokenFromCurrentUrl,
  supportsFileHandoff,
} from "./file-handoff";
import {
  createPrismFileSignature,
  createPrismDraftSnapshot,
  parsePrismDraftSnapshot,
  sanitizePrismDraftValue,
  samePrismFileSignature,
  type PrismDraftQueueRef,
  type PrismDraftModuleId,
  type PrismDraftSnapshot,
} from "./prism-draft";

import { createWorkbench, type WorkbenchModule } from "./prism-workbench";
import { createShrubber } from "./prism-shrubber";
import { createAudioLab } from "./prism-audio";
import { createSubtitles } from "./prism-subtitles";
import { createTransparency } from "./prism-transparency";
import type { MetadataDiffResult } from "./prism-metadata-diff";

// ─── Module Type ──────────────────────────────────────────────────────────────

type ModuleId = "workbench" | "shrubber" | "audio" | "subtitles" | "transparency";

interface PrismModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): { args: string[]; outputName: string; prepare?: (engine: PrismEngine) => Promise<void> } | null;
  getConfig(): unknown;
  setConfig?(config: unknown): void;
  reset(): void;
}

const MODULE_VISIBILITY: Record<ModuleId, FileInfo["category"][]> = {
  workbench: ["video", "audio", "image"],
  shrubber: ["video", "audio", "image"],
  audio: ["video", "audio"],
  subtitles: ["video", "subtitle"],
  transparency: ["video"],
};

// ─── Options ─────────────────────────────────────────────────────────────────

export interface PrismUIOptions {
  page: HTMLElement;
  uploadZone: HTMLElement;
  fileInput: HTMLInputElement;
  inputPreview: HTMLElement;
  inputVideo: HTMLVideoElement;
  inputAudio: HTMLAudioElement;
  inputImg: HTMLImageElement;
  inputGlyph: HTMLElement;
  sourceName: HTMLElement;
  sourceSize: HTMLElement;
  sourceType: HTMLElement;
  fileQueue: HTMLElement;
  fileQueueList: HTMLElement;
  moduleBar: HTMLElement;
  modulePanel: HTMLElement;
  previewSection: HTMLElement;
  previewVideo: HTMLVideoElement;
  previewAudio: HTMLAudioElement;
  previewImg: HTMLImageElement;
  previewText: HTMLPreElement;
  terminalSection: HTMLElement;
  terminalToggle: HTMLButtonElement;
  terminalBody: HTMLElement;
  terminalLog: HTMLPreElement;
  progressSection: HTMLElement;
  progressBar: HTMLElement;
  progressFill: HTMLElement;
  progressText: HTMLElement;
  engineStatus: HTMLElement;
  actionBar: HTMLElement;
  btnRun: HTMLButtonElement;
  btnCancel: HTMLButtonElement;
  btnLens: HTMLButtonElement;
  alphaBadge: HTMLElement;
  btnUpload: HTMLButtonElement;
  btnClear: HTMLButtonElement;
  sizeWarning: HTMLElement;
  outputSummary: HTMLElement;
  terminalCopy: HTMLButtonElement;
}

type PrismUIIdMap = { [K in keyof PrismUIOptions]: string };

export const PRISM_UI_IDS: PrismUIIdMap = {
  page: "prism-page",
  uploadZone: "prism-upload-zone",
  fileInput: "prism-file-input",
  inputPreview: "prism-input-preview",
  inputVideo: "prism-input-video",
  inputAudio: "prism-input-audio",
  inputImg: "prism-input-img",
  inputGlyph: "prism-input-glyph",
  sourceName: "prism-source-name",
  sourceSize: "prism-source-size",
  sourceType: "prism-source-type",
  fileQueue: "prism-file-queue",
  fileQueueList: "prism-file-queue-list",
  moduleBar: "prism-module-bar",
  modulePanel: "prism-module-panel",
  previewSection: "prism-preview-section",
  previewVideo: "prism-preview-video",
  previewAudio: "prism-preview-audio",
  previewImg: "prism-preview-img",
  previewText: "prism-preview-text",
  terminalSection: "prism-terminal-section",
  terminalToggle: "prism-terminal-toggle",
  terminalBody: "prism-terminal-body",
  terminalLog: "prism-terminal-log",
  progressSection: "prism-progress-section",
  progressBar: "prism-progress-bar",
  progressFill: "prism-progress-fill",
  progressText: "prism-progress-text",
  engineStatus: "prism-engine-status",
  actionBar: "prism-actions",
  btnRun: "prism-btn-run",
  btnCancel: "prism-btn-cancel",
  btnLens: "prism-btn-lens",
  alphaBadge: "prism-alpha-badge",
  btnUpload: "prism-btn-upload",
  btnClear: "prism-btn-clear",
  sizeWarning: "prism-size-warning",
  outputSummary: "prism-output-summary",
  terminalCopy: "prism-terminal-copy",
};

// ─── ID resolution ───────────────────────────────────────────────────────────

function q(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

export function resolvePrismUIOptions(root: ParentNode): PrismUIOptions | null {
  const page = q(root, PRISM_UI_IDS.page);
  const uploadZone = q(root, PRISM_UI_IDS.uploadZone);
  const fileInput = q(root, PRISM_UI_IDS.fileInput);
  const inputPreview = q(root, PRISM_UI_IDS.inputPreview);
  const inputVideo = q(root, PRISM_UI_IDS.inputVideo);
  const inputAudio = q(root, PRISM_UI_IDS.inputAudio);
  const inputImg = q(root, PRISM_UI_IDS.inputImg);
  const inputGlyph = q(root, PRISM_UI_IDS.inputGlyph);
  const sourceName = q(root, PRISM_UI_IDS.sourceName);
  const sourceSize = q(root, PRISM_UI_IDS.sourceSize);
  const sourceType = q(root, PRISM_UI_IDS.sourceType);
  const fileQueue = q(root, PRISM_UI_IDS.fileQueue);
  const fileQueueList = q(root, PRISM_UI_IDS.fileQueueList);
  const moduleBar = q(root, PRISM_UI_IDS.moduleBar);
  const modulePanel = q(root, PRISM_UI_IDS.modulePanel);
  const previewSection = q(root, PRISM_UI_IDS.previewSection);
  const previewVideo = q(root, PRISM_UI_IDS.previewVideo);
  const previewAudio = q(root, PRISM_UI_IDS.previewAudio);
  const previewImg = q(root, PRISM_UI_IDS.previewImg);
  const previewText = q(root, PRISM_UI_IDS.previewText);
  const terminalSection = q(root, PRISM_UI_IDS.terminalSection);
  const terminalToggle = q(root, PRISM_UI_IDS.terminalToggle);
  const terminalBody = q(root, PRISM_UI_IDS.terminalBody);
  const terminalLog = q(root, PRISM_UI_IDS.terminalLog);
  const progressSection = q(root, PRISM_UI_IDS.progressSection);
  const progressBar = q(root, PRISM_UI_IDS.progressBar);
  const progressFill = q(root, PRISM_UI_IDS.progressFill);
  const progressText = q(root, PRISM_UI_IDS.progressText);
  const engineStatus = q(root, PRISM_UI_IDS.engineStatus);
  const actionBar = q(root, PRISM_UI_IDS.actionBar);
  const btnRun = q(root, PRISM_UI_IDS.btnRun);
  const btnCancel = q(root, PRISM_UI_IDS.btnCancel);
  const btnLens = q(root, PRISM_UI_IDS.btnLens);
  const alphaBadge = q(root, PRISM_UI_IDS.alphaBadge);
  const btnUpload = q(root, PRISM_UI_IDS.btnUpload);
  const btnClear = q(root, PRISM_UI_IDS.btnClear);
  const sizeWarning = q(root, PRISM_UI_IDS.sizeWarning);
  const outputSummary = q(root, PRISM_UI_IDS.outputSummary);
  const terminalCopy = q(root, PRISM_UI_IDS.terminalCopy);

  if (!page || !uploadZone || !fileInput || !inputPreview || !inputVideo ||
    !inputAudio || !inputImg || !inputGlyph || !sourceName || !sourceSize || !sourceType ||
    !fileQueue || !fileQueueList ||
    !moduleBar || !modulePanel || !previewSection || !previewVideo ||
    !previewAudio || !previewImg || !previewText || !terminalSection ||
    !terminalToggle || !terminalBody || !terminalLog || !progressSection ||
    !progressBar || !progressFill || !progressText || !engineStatus ||
    !actionBar || !btnRun || !btnCancel || !btnLens || !alphaBadge || !btnUpload ||
    !btnClear || !sizeWarning || !outputSummary || !terminalCopy) {
    return null;
  }

  return {
    page,
    uploadZone,
    fileInput: fileInput as HTMLInputElement,
    inputPreview,
    inputVideo: inputVideo as HTMLVideoElement,
    inputAudio: inputAudio as HTMLAudioElement,
    inputImg: inputImg as HTMLImageElement,
    inputGlyph,
    sourceName,
    sourceSize,
    sourceType,
    fileQueue,
    fileQueueList,
    moduleBar,
    modulePanel,
    previewSection,
    previewVideo: previewVideo as HTMLVideoElement,
    previewAudio: previewAudio as HTMLAudioElement,
    previewImg: previewImg as HTMLImageElement,
    previewText: previewText as HTMLPreElement,
    terminalSection,
    terminalToggle: terminalToggle as HTMLButtonElement,
    terminalBody,
    terminalLog: terminalLog as HTMLPreElement,
    progressSection,
    progressBar,
    progressFill,
    progressText,
    engineStatus,
    actionBar,
    btnRun: btnRun as HTMLButtonElement,
    btnCancel: btnCancel as HTMLButtonElement,
    btnLens: btnLens as HTMLButtonElement,
    alphaBadge,
    btnUpload: btnUpload as HTMLButtonElement,
    btnClear: btnClear as HTMLButtonElement,
    sizeWarning,
    outputSummary,
    terminalCopy: terminalCopy as HTMLButtonElement,
  };
}

// ─── State Machine ───────────────────────────────────────────────────────────

type PrismState = "idle" | "files_loaded" | "configured" | "processing" | "complete" | "error";

function isLoadableState(state: PrismState): state is "files_loaded" | "configured" {
  return state === "files_loaded" || state === "configured";
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ACTION_BAR_FADE_MS = 350;
const TOAST_VISIBLE_MS = 2500;
const TOAST_EXIT_MS = 300;
const RUN_ACK_MS = 1200;
const PRISM_WARM_ENGINE_KEY = "__prismWarmEngine";
const PRISM_REFRESH_FILE_KEY = "prism.refreshFileToken.v1";

type PrismWarmWindow = Window & {
  [PRISM_WARM_ENGINE_KEY]?: PrismEngine;
};

// ─── Init ────────────────────────────────────────────────────────────────────

export function initPrism(opts: PrismUIOptions): () => void {
  let destroyed = false;
  let prismState: PrismState = "idle";
  let engine: PrismEngine | null = null;
  let fileQueue: { file: File; info: FileInfo }[] = [];
  let primaryIndex: number = 0;
  let outputData: Uint8Array | null = null;
  let outputName: string = "";
  let outputUrl: string | null = null;
  let previewUrl: string | null = null;
  let downloadUrl: string | null = null;
  let terminalOpen = false;
  let dragCounter = 0;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let runAckTimer: ReturnType<typeof setTimeout> | null = null;
  let runAckActive = false;
  let lensHandoffInFlight = false;
  let handoffSupported = true;
  const queueThumbUrls = new Set<string>();
  const cleanups: Array<() => void> = [];

  function saveRefreshFileToken(token: string): void {
    try {
      window.localStorage.setItem(PRISM_REFRESH_FILE_KEY, token);
    } catch {
      // Ignore persistence errors.
    }
  }

  function loadRefreshFileToken(): string | null {
    try {
      const token = window.localStorage.getItem(PRISM_REFRESH_FILE_KEY);
      return token && token.trim().length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  function clearRefreshFileToken(): void {
    try {
      window.localStorage.removeItem(PRISM_REFRESH_FILE_KEY);
    } catch {
      // Ignore persistence errors.
    }
  }

  async function persistCurrentFileForRefresh(file: File): Promise<void> {
    try {
      if (!(await supportsFileHandoff())) return;
      const token = await createFileHandoff(file);
      saveRefreshFileToken(token);
    } catch {
      // Ignore persistence errors.
    }
  }

  // ── File Queue Accessors ───────────────────────────────────────────────

  function getCurrentFile(): File | null {
    return fileQueue.length > 0 ? fileQueue[primaryIndex].file : null;
  }

  function getCurrentFileInfo(): FileInfo | null {
    return fileQueue.length > 0 ? fileQueue[primaryIndex].info : null;
  }

  // ── Module Registry ─────────────────────────────────────────────────────

  const modules: Record<ModuleId, PrismModule> = {
    workbench: createWorkbench(),
    shrubber: createShrubber(),
    audio: createAudioLab(),
    subtitles: createSubtitles(),
    transparency: createTransparency(),
  };

  let activeModuleId: ModuleId = "workbench";

  function setEngineStatusClass(state: EngineState): void {
    opts.engineStatus.classList.remove(
      "prism-status--idle",
      "prism-status--loading",
      "prism-status--running",
      "prism-status--ready",
      "prism-status--error",
    );

    if (state === "ready") {
      opts.engineStatus.classList.add("prism-status--ready");
      return;
    }
    if (state === "loading") {
      opts.engineStatus.classList.add("prism-status--loading");
      return;
    }
    if (state === "running") {
      opts.engineStatus.classList.add("prism-status--running");
      return;
    }
    if (state === "error") {
      opts.engineStatus.classList.add("prism-status--error");
      return;
    }
    opts.engineStatus.classList.add("prism-status--idle");
  }

  function createEngineCallbacks(): EngineCallbacks {
    return {
      onStateChange: (s: EngineState) => {
        if (destroyed) return;
        opts.engineStatus.textContent = s === "ready" ? "engine ready" : s === "loading" ? "loading engine..." : s === "running" ? "processing..." : s;
        setEngineStatusClass(s);
        if (s === "loading") {
          opts.btnRun.style.setProperty("--prism-load-ratio", "0");
        } else {
          opts.btnRun.style.removeProperty("--prism-load-ratio");
        }
        updateUI();
      },
      onLoadProgress: (p: LoadProgressEvent) => {
        if (destroyed) return;
        opts.btnRun.style.setProperty("--prism-load-ratio", String(Math.min(Math.max(p.ratio, 0), 1)));
      },
      onProgress: (p: ProgressEvent) => {
        if (destroyed) return;
        if (p.ratio === -1) {
          // Indeterminate: unknown duration (images, etc.)
          opts.progressFill.classList.add("prism-progress-fill--indeterminate");
          opts.progressFill.style.width = "";
          opts.progressText.textContent = "Processing…";
          return;
        }
        opts.progressFill.classList.remove("prism-progress-fill--indeterminate");
        const pct = Math.round(p.ratio * 100);
        opts.progressFill.style.width = `${pct}%`;
        let text = `${pct}%`;
        if (p.speed !== null) text += ` · ${p.speed}x`;
        if (p.eta !== null) text += ` · ~${p.eta}s left`;
        opts.progressText.textContent = text;
      },
      onLog: (msg: string) => {
        if (destroyed) return;
        opts.terminalLog.textContent += msg + "\n";
        opts.terminalLog.scrollTop = opts.terminalLog.scrollHeight;
      },
      onError: (err: EngineError) => {
        if (destroyed) return;
        if (err.code === "cancelled") {
          showToast("Cancelled.");
          setState("files_loaded");
          return;
        }
        showToast(err.message);
        if (!terminalOpen) toggleTerminal();
        setState("error");
      },
    };
  }

  async function collectDraftSnapshotForHandoff(): Promise<PrismDraftSnapshot | null> {
    const currentFile = getCurrentFile();
    if (!currentFile) return null;

    const moduleConfigs: Partial<Record<PrismDraftModuleId, unknown>> = {};
    for (const [id, module] of Object.entries(modules) as [ModuleId, PrismModule][]) {
      try {
        const sanitized = sanitizePrismDraftValue(module.getConfig());
        if (sanitized !== undefined) {
          moduleConfigs[id as PrismDraftModuleId] = sanitized;
        }
      } catch {
        // Ignore non-serializable module state; keep restore best-effort.
      }
    }

    let queueRef: PrismDraftQueueRef | undefined;
    if (fileQueue.length > 1) {
      try {
        const queueSessionId = await createPrismQueueSession(
          fileQueue.map((entry) => entry.file),
          primaryIndex,
        );
        queueRef = {
          sessionId: queueSessionId,
          primaryIndex,
          signatures: fileQueue.map((entry) => createPrismFileSignature(entry.file)),
        };
      } catch {
        showToast("full queue continuity unavailable. handing off current file only");
      }
    }

    return createPrismDraftSnapshot(
      currentFile,
      activeModuleId as PrismDraftModuleId,
      moduleConfigs,
      queueRef ? { queueRef } : undefined,
    );
  }

  function applyPrimaryFileContext(): void {
    const currentFile = getCurrentFile();
    const currentFileInfo = getCurrentFileInfo();
    if (!currentFile || !currentFileInfo) return;

    const warning = checkFileSize(currentFile.size, isMobileDevice());
    if (warning === "warning") {
      setSizeWarning("This file is very large for browser processing. It may fail on some devices.");
    } else if (warning === "caution") {
      setSizeWarning("Large file - processing may take a moment.");
    } else {
      hide(opts.sizeWarning);
    }

    hideInputPreview();
    updateModuleTabVisibility(currentFileInfo.category);

    for (const [id, mod] of Object.entries(modules) as [ModuleId, PrismModule][]) {
      if (!MODULE_VISIBILITY[id].includes(currentFileInfo.category)) continue;
      mod.configure(currentFileInfo);
    }

    const requestedModule = MODULE_VISIBILITY[activeModuleId].includes(currentFileInfo.category)
      ? activeModuleId
      : (Object.keys(MODULE_VISIBILITY) as ModuleId[]).find(
        (id) => MODULE_VISIBILITY[id].includes(currentFileInfo.category),
      ) ?? "workbench";
    switchModule(requestedModule);
    renderFileQueue();
    (modules.workbench as WorkbenchModule).setFileQueue(fileQueue);
    void persistCurrentFileForRefresh(currentFile);
  }

  async function restoreQueueFromSnapshot(snapshot: PrismDraftSnapshot): Promise<boolean> {
    const queueRef = snapshot.queueRef;
    if (!queueRef) return false;

    const session = await consumePrismQueueSessionWithRetry(queueRef.sessionId);
    if (!session || session.files.length === 0) return false;
    if (session.files.length !== queueRef.signatures.length) return false;
    if (
      !session.files.every((file, index) =>
        samePrismFileSignature(file, queueRef.signatures[index]))
    ) {
      return false;
    }

    clearAll();
    for (const file of session.files) {
      await processFile(file);
      if (destroyed) return false;
    }

    if (fileQueue.length === 0) return false;
    primaryIndex = Math.min(
      Math.max(0, Math.floor(session.primaryIndex)),
      fileQueue.length - 1,
    );
    applyPrimaryFileContext();
    setState("files_loaded");
    return true;
  }

  function restoreDraftSnapshot(snapshot: PrismDraftSnapshot, file: File): boolean {
    if (!samePrismFileSignature(file, snapshot.file)) return false;
    const currentFileInfo = getCurrentFileInfo();
    if (!currentFileInfo) return false;

    for (const [id, module] of Object.entries(modules) as [ModuleId, PrismModule][]) {
      if (!MODULE_VISIBILITY[id].includes(currentFileInfo.category)) continue;
      const savedConfig = snapshot.modules[id as PrismDraftModuleId];
      if (savedConfig === undefined || typeof module.setConfig !== "function") continue;
      try {
        module.setConfig(savedConfig);
      } catch {
        // Keep restore resilient even if one module rejects stale config.
      }
    }

    const requestedModule = snapshot.activeModuleId as ModuleId;
    if (MODULE_VISIBILITY[requestedModule].includes(currentFileInfo.category)) {
      switchModule(requestedModule);
      return true;
    }

    const fallback = (Object.keys(MODULE_VISIBILITY) as ModuleId[]).find(
      (id) => MODULE_VISIBILITY[id].includes(currentFileInfo.category),
    );
    if (fallback) {
      switchModule(fallback);
    }
    return true;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function on<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    event: K | string,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler as EventListener, options);
    cleanups.push(() => target.removeEventListener(event, handler as EventListener, options));
  }

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

  function show(element: HTMLElement): void {
    element.style.display = "";
  }

  function hide(element: HTMLElement): void {
    element.style.display = "none";
  }

  // ── Module Switching ──────────────────────────────────────────────────

  function switchModule(id: ModuleId): void {
    activeModuleId = id;

    // Update tab styling
    const tabs = opts.moduleBar.querySelectorAll<HTMLButtonElement>("[data-module]");
    tabs.forEach((tab) => {
      if (tab.dataset.module === id) {
        tab.classList.add("prism-tab--active");
        tab.setAttribute("aria-selected", "true");
      } else {
        tab.classList.remove("prism-tab--active");
        tab.setAttribute("aria-selected", "false");
      }
    });

    // Clear and re-render module panel
    opts.modulePanel.innerHTML = "";
    modules[id].render(opts.modulePanel);
  }

  function updateModuleTabVisibility(category: FileInfo["category"]): void {
    const tabs = opts.moduleBar.querySelectorAll<HTMLButtonElement>("[data-module]");
    let activeStillVisible = false;

    tabs.forEach((tab) => {
      const modId = tab.dataset.module as ModuleId;
      if (!modId || !MODULE_VISIBILITY[modId]) return;

      const visible = MODULE_VISIBILITY[modId].includes(category);
      tab.style.display = visible ? "" : "none";
      tab.disabled = !visible;

      if (modId === activeModuleId && visible) {
        activeStillVisible = true;
      }
    });

    // If active module is now hidden, fall back to workbench (or first visible)
    if (!activeStillVisible) {
      const firstVisible = (Object.keys(MODULE_VISIBILITY) as ModuleId[]).find(
        (id) => MODULE_VISIBILITY[id].includes(category),
      );
      if (firstVisible) {
        switchModule(firstVisible);
      }
    }
  }

  // ── beforeunload guard ────────────────────────────────────────────────

  function beforeUnloadHandler(e: BeforeUnloadEvent): void {
    e.preventDefault();
  }

  function setBeforeUnload(active: boolean): void {
    if (active) {
      window.addEventListener("beforeunload", beforeUnloadHandler);
    } else {
      window.removeEventListener("beforeunload", beforeUnloadHandler);
    }
  }

  // ── Size Warning ──────────────────────────────────────────────────────

  function setSizeWarning(text: string): void {
    // Target the inner .prism-warning div, not the section itself
    const inner = opts.sizeWarning.querySelector(".prism-warning");
    if (inner) {
      inner.textContent = text;
    } else {
      opts.sizeWarning.textContent = text;
    }
    show(opts.sizeWarning);
  }

  // ── Queue Status ──────────────────────────────────────────────────────

  function updateQueueStatus(status: "ready" | "processing" | "complete" | "error", label?: string): void {
    const statusEl = opts.fileQueueList.querySelector(".prism-queue-status");
    if (!statusEl) return;

    statusEl.className = "prism-queue-status";
    statusEl.classList.add(`prism-queue-status--${status}`);
    statusEl.textContent = label || status;
  }

  // ── State Transitions ──────────────────────────────────────────────────

  function setState(newState: PrismState): void {
    if (destroyed) return;
    prismState = newState;

    // Guard: only active during processing
    setBeforeUnload(newState === "processing");

    updateUI();
  }

  function updateUI(): void {
    if (destroyed) return;
    const hasFile = Boolean(getCurrentFile());

    // Upload zone: visible when idle, fully hidden when files loaded
    if (prismState === "idle") {
      show(opts.uploadZone);
      hideInputPreview();
      hide(opts.btnUpload);
    } else {
      hide(opts.uploadZone);
      show(opts.btnUpload);
    }

    // File queue
    if (prismState === "idle") {
      hide(opts.fileQueue);
    } else {
      show(opts.fileQueue);
    }

    // Module bar + panel
    if (prismState === "idle" || prismState === "processing") {
      if (prismState === "idle") {
        hide(opts.moduleBar);
        hide(opts.modulePanel);
      }
    } else {
      show(opts.moduleBar);
      show(opts.modulePanel);
    }

    // Progress
    if (prismState === "processing") {
      show(opts.progressSection);
    } else {
      hide(opts.progressSection);
      opts.progressFill.style.width = "0%";
      opts.progressFill.classList.remove("prism-progress-fill--indeterminate");
      opts.progressText.textContent = "";
    }

    // Output summary + preview
    if (prismState === "complete") {
      show(opts.previewSection);
      show(opts.outputSummary);
    } else {
      hide(opts.previewSection);
      hide(opts.outputSummary);
      opts.outputSummary.innerHTML = "";
      hideAllPreviews();
    }

    // ── Action bar buttons ──────────────────────────────────────────────
    // Run button: visible in files_loaded, configured, complete, error
    // Shows "Load" in purple when engine isn't loaded yet, "Run" in cyan otherwise
    const loadableState = isLoadableState(prismState);
    const engineLoading = Boolean(engine && engine.state === "loading");
    const engineLoaded = Boolean(engine && (engine.state === "ready" || engine.state === "running"));
    if (prismState === "complete") {
      opts.btnRun.textContent = runAckActive ? "Ran" : "Run";
      opts.btnRun.style.display = "";
    } else if (prismState === "error") {
      opts.btnRun.textContent = "Try Again";
      opts.btnRun.style.display = "";
    } else if (loadableState) {
      opts.btnRun.textContent = engineLoading ? "Loading..." : engineLoaded ? "Run" : "Load";
      opts.btnRun.style.display = "";
    } else {
      opts.btnRun.style.display = "none";
    }

    if (!engineLoaded && loadableState) {
      opts.btnRun.classList.add("action-btn--load");
    } else {
      opts.btnRun.classList.remove("action-btn--load");
    }
    opts.btnRun.classList.toggle("action-btn--ran", runAckActive && prismState === "complete");

    if (engineLoading && loadableState) {
      opts.btnRun.classList.add("action-btn--loading");
      opts.btnRun.disabled = true;
      opts.btnRun.setAttribute("aria-busy", "true");
    } else {
      opts.btnRun.classList.remove("action-btn--loading");
      opts.btnRun.disabled = false;
      opts.btnRun.setAttribute("aria-busy", "false");
    }

    opts.btnCancel.style.display = prismState === "processing" ? "" : "none";
    const lensVisibleByState = prismState === "files_loaded" ||
      prismState === "configured" ||
      prismState === "complete" ||
      prismState === "error";
    opts.btnLens.style.display = handoffSupported && lensVisibleByState ? "" : "none";
    opts.btnLens.disabled = !handoffSupported || !getCurrentFile() || prismState === "processing" || lensHandoffInFlight;
    opts.btnLens.setAttribute("aria-busy", lensHandoffInFlight ? "true" : "false");
    opts.alphaBadge.style.display = hasFile ? "" : "none";

    // Show action bar when not idle
    if (prismState === "idle") {
      opts.actionBar.style.opacity = "0";
      setTimeout(() => { if (!destroyed && prismState === "idle") hide(opts.actionBar); }, ACTION_BAR_FADE_MS);
    } else {
      show(opts.actionBar);
      requestAnimationFrame(() => { if (!destroyed) opts.actionBar.style.opacity = "1"; });
    }

    // Disable module controls during processing
    const locked = prismState === "processing";
    opts.modulePanel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button").forEach((el) => {
      el.disabled = locked;
    });

    // Queue status
    if (prismState === "processing") {
      updateQueueStatus("processing", "processing...");
    } else if (prismState === "complete") {
      updateQueueStatus("complete", "done");
    } else if (prismState === "error") {
      updateQueueStatus("error", "error");
    }
  }

  function hideAllPreviews(): void {
    hide(opts.previewVideo);
    hide(opts.previewAudio);
    hide(opts.previewImg);
    hide(opts.previewText);
    opts.previewVideo.pause();
    opts.previewVideo.removeAttribute("src");
    opts.previewAudio.pause();
    opts.previewAudio.removeAttribute("src");
    opts.previewImg.removeAttribute("src");
    opts.previewImg.removeAttribute("role");
    opts.previewImg.removeAttribute("tabindex");
    opts.previewImg.removeAttribute("title");
    opts.previewImg.style.cursor = "default";
    opts.previewImg.onclick = null;
    opts.previewImg.onkeydown = null;
    opts.previewText.textContent = "";
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  // ── Input Preview ──────────────────────────────────────────────────────

  function hideInputPreview(): void {
    hide(opts.inputVideo);
    hide(opts.inputAudio);
    hide(opts.inputImg);
    show(opts.inputGlyph);
    opts.inputVideo.pause();
    opts.inputVideo.removeAttribute("src");
    opts.inputAudio.pause();
    opts.inputAudio.removeAttribute("src");
    opts.inputImg.removeAttribute("src");
    opts.inputGlyph.textContent = "FILE";
    opts.sourceName.textContent = "";
    opts.sourceSize.textContent = "";
    opts.sourceType.textContent = "";
    hide(opts.inputPreview);
  }

  // ── Toast ──────────────────────────────────────────────────────────────

  function showToast(message: string): void {
    if (destroyed) return;
    const existing = document.querySelector(".prism-toast");
    if (existing) existing.remove();

    const toast = el("div", "prism-toast", message);
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateX(-50%) translateY(0)";
    });

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%) translateY(8px)";
      setTimeout(() => toast.remove(), TOAST_EXIT_MS);
    }, TOAST_VISIBLE_MS);
  }

  // ── Engine Setup ───────────────────────────────────────────────────────

  function ensureEngine(): PrismEngine {
    if (!engine) {
      const prismWindow = window as PrismWarmWindow;
      const warmEngine = prismWindow[PRISM_WARM_ENGINE_KEY] ?? null;
      if (warmEngine) {
        warmEngine.setCallbacks(createEngineCallbacks());
        engine = warmEngine;
      } else {
        engine = createEngine(createEngineCallbacks());
        prismWindow[PRISM_WARM_ENGINE_KEY] = engine;
      }
    }
    return engine;
  }

  // ── File Handling ──────────────────────────────────────────────────────

  async function processFile(file: File): Promise<void> {
    if (destroyed) return;

    const eng = ensureEngine();

    // Probe the file
    const fileInfo = await eng.probeFile(file);

    // Append to queue (first file becomes primary)
    const isFirst = fileQueue.length === 0;
    fileQueue.push({ file, info: fileInfo });
    if (isFirst) primaryIndex = 0;

    // Update file queue display
    renderFileQueue();

    // Notify workbench of file queue changes
    (modules.workbench as WorkbenchModule).setFileQueue(fileQueue);

    if (isFirst) {
      applyPrimaryFileContext();
    }

    setState("files_loaded");
  }

  function renderFileQueue(): void {
    revokeQueueThumbUrls();
    opts.fileQueueList.innerHTML = "";
    if (fileQueue.length === 0) return;

    for (let idx = 0; idx < fileQueue.length; idx++) {
      const { info, file } = fileQueue[idx];
      const isPrimary = idx === primaryIndex;
      const row = el("div", `prism-queue-item${isPrimary ? " prism-queue-item--primary" : ""}`);

      const thumb = el("span", "prism-queue-thumb");
      if (info.category === "image") {
        const thumbImg = el("img", "prism-queue-thumb-img") as HTMLImageElement;
        thumbImg.alt = "";
        thumbImg.setAttribute("aria-hidden", "true");
        const thumbUrl = URL.createObjectURL(file);
        queueThumbUrls.add(thumbUrl);
        thumbImg.onload = () => {
          URL.revokeObjectURL(thumbUrl);
          queueThumbUrls.delete(thumbUrl);
        };
        thumbImg.onerror = () => {
          URL.revokeObjectURL(thumbUrl);
          queueThumbUrls.delete(thumbUrl);
        };
        thumbImg.src = thumbUrl;
        thumb.appendChild(thumbImg);
      } else {
        thumb.textContent = info.category === "video"
          ? "VID"
          : info.category === "audio"
            ? "AUD"
            : info.category === "subtitle"
              ? "SUB"
              : "FILE";
      }
      row.appendChild(thumb);

      // Top row: name, duration, size, category, status
      const nameEl = el("span", "prism-queue-name", info.name);
      const sizeEl = el("span", "prism-queue-size", info.sizeLabel);
      const categoryEl = el("span", "prism-queue-category", info.category);

      const durationEl = info.duration !== null
        ? el("span", "prism-queue-duration", formatDuration(info.duration))
        : null;

      row.appendChild(nameEl);
      if (durationEl) row.appendChild(durationEl);
      row.appendChild(sizeEl);
      row.appendChild(categoryEl);

      // Queue actions (only when 2+ files)
      if (fileQueue.length >= 2) {
        const actions = el("div", "prism-queue-actions");

        if (idx > 0) {
          const upBtn = el("button", "prism-queue-btn", "\u2191");
          upBtn.type = "button";
          upBtn.title = "Move up";
          const capturedIdx = idx;
          upBtn.addEventListener("click", () => { moveQueueItem(capturedIdx, capturedIdx - 1); });
          actions.appendChild(upBtn);
        }

        if (idx < fileQueue.length - 1) {
          const downBtn = el("button", "prism-queue-btn", "\u2193");
          downBtn.type = "button";
          downBtn.title = "Move down";
          const capturedIdx = idx;
          downBtn.addEventListener("click", () => { moveQueueItem(capturedIdx, capturedIdx + 1); });
          actions.appendChild(downBtn);
        }

        const removeBtn = el("button", "prism-queue-btn prism-queue-btn--danger", "\u00d7");
        removeBtn.type = "button";
        removeBtn.title = "Remove";
        const capturedIdx = idx;
        removeBtn.addEventListener("click", () => { removeQueueItem(capturedIdx); });
        actions.appendChild(removeBtn);

        row.appendChild(actions);
      }

      const statusEl = el("span", "prism-queue-status prism-queue-status--ready", "ready");
      row.appendChild(statusEl);

      // Details row: codec, resolution, bitrate, channels (from probe)
      const details: string[] = [];
      if (info.resolution) details.push(info.resolution);
      if (info.videoCodec) details.push(info.videoCodec);
      if (info.audioCodec) details.push(info.audioCodec);
      if (info.channels !== null) {
        const chLabel = info.channels === 1 ? "mono" : info.channels === 2 ? "stereo" : info.channels === 6 ? "5.1" : info.channels === 8 ? "7.1" : `${info.channels}ch`;
        details.push(chLabel);
      }
      if (info.bitrate !== null) details.push(`${info.bitrate} kbps`);

      if (details.length > 0) {
        const detailsRow = el("div", "prism-queue-details");
        for (const d of details) {
          detailsRow.appendChild(el("span", "prism-detail", d));
        }
        row.appendChild(detailsRow);
      }

      opts.fileQueueList.appendChild(row);
    }
  }

  function revokeQueueThumbUrls(): void {
    if (queueThumbUrls.size === 0) return;
    for (const url of queueThumbUrls) {
      URL.revokeObjectURL(url);
    }
    queueThumbUrls.clear();
  }

  function moveQueueItem(from: number, to: number): void {
    if (to < 0 || to >= fileQueue.length) return;
    const item = fileQueue.splice(from, 1)[0];
    fileQueue.splice(to, 0, item);
    // Adjust primary index
    if (primaryIndex === from) primaryIndex = to;
    else if (from < primaryIndex && to >= primaryIndex) primaryIndex--;
    else if (from > primaryIndex && to <= primaryIndex) primaryIndex++;
    renderFileQueue();
    (modules.workbench as WorkbenchModule).setFileQueue(fileQueue);
  }

  function removeQueueItem(idx: number): void {
    const removedPrimary = idx === primaryIndex;
    fileQueue.splice(idx, 1);
    if (fileQueue.length === 0) {
      clearAll();
      return;
    }
    // Adjust primary index
    if (primaryIndex >= fileQueue.length) primaryIndex = 0;
    else if (idx < primaryIndex) primaryIndex--;

    if (removedPrimary) {
      applyPrimaryFileContext();
      return;
    }

    renderFileQueue();
    (modules.workbench as WorkbenchModule).setFileQueue(fileQueue);
  }

  function formatDuration(sec: number | null): string {
    if (sec === null || !isFinite(sec)) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // ── Reset output (keep file loaded) ────────────────────────────────────

  function resetOutput(): void {
    if (outputUrl) { URL.revokeObjectURL(outputUrl); outputUrl = null; }
    outputData = null;
    outputName = "";
    runAckActive = false;
    if (runAckTimer) {
      clearTimeout(runAckTimer);
      runAckTimer = null;
    }
    hideAllPreviews();
    opts.terminalLog.textContent = "";
    // Re-render active module panel (settings are preserved)
    if (getCurrentFileInfo()) {
      modules[activeModuleId].render(opts.modulePanel);
    }
  }

  function triggerRunAck(): void {
    runAckActive = true;
    if (runAckTimer) clearTimeout(runAckTimer);
    runAckTimer = setTimeout(() => {
      runAckActive = false;
      runAckTimer = null;
      if (!destroyed) updateUI();
    }, RUN_ACK_MS);
  }

  function scrollToOutputSummary(): void {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      if (destroyed) return;
      opts.outputSummary.scrollIntoView({
        behavior: smooth ? "smooth" : "auto",
        block: "start",
      });
    });
  }

  // ── VFS Cleanup ──────────────────────────────────────────────────────

  async function cleanupVFS(eng: PrismEngine, inputNames: string[], keepOutput?: string): Promise<void> {
    for (const name of inputNames) {
      try { await eng.deleteFile(`/input/${name}`); } catch { /* non-fatal */ }
    }
    try {
      const files = await eng.listDir("/output");
      for (const f of files) {
        if (f !== keepOutput) await eng.deleteFile(`/output/${f}`);
      }
    } catch { /* non-fatal */ }
  }

  // ── Run ────────────────────────────────────────────────────────────────

  async function run(): Promise<void> {
    const currentFile = getCurrentFile();
    const currentFileInfo = getCurrentFileInfo();
    if (destroyed || !currentFile || !currentFileInfo) return;

    const activeModule = modules[activeModuleId];
    const result = activeModule.build();
    if (!result) {
      showToast("Nothing to do. Configure an operation first.");
      return;
    }

    const eng = ensureEngine();

    // Load engine if needed
    if (eng.state === "idle" || eng.state === "error") {
      opts.engineStatus.textContent = "loading engine...";
      await eng.load();
      if (destroyed || (eng.state as string) !== "ready") return;
    }

    setState("processing");
    opts.terminalLog.textContent = "";

    const isMultiFile = !!(result as { multiFile?: boolean }).multiFile;
    const writtenInputNames: string[] = [];

    try {
      if (isMultiFile) {
        // Write ALL queue files to VFS
        for (const entry of fileQueue) {
          const data = await readFileAsUint8Array(entry.file);
          if (destroyed) return;
          await eng.writeFile(`/input/${entry.info.name}`, data);
          writtenInputNames.push(entry.info.name);
          if (destroyed) return;
        }
      } else {
        // Write only the primary input file to VFS
        const data = await readFileAsUint8Array(currentFile);
        if (destroyed) return;
        await eng.writeFile(`/input/${currentFile.name}`, data);
        writtenInputNames.push(currentFile.name);
        if (destroyed) return;
      }

      // Run prepare hook if the module needs to write extra files (e.g., subtitle burn, concat manifest)
      if (result.prepare) {
        await result.prepare(eng);
        if (destroyed) return;
      }

      // Execute — check return code
      const ret = await eng.exec(result.args);
      if (destroyed) return;

      if (ret === 0) {
        // Success — read output
        try {
          outputData = await eng.readFile(`/output/${result.outputName}`);
          outputName = result.outputName;
          const visualUnchanged = await isVisualOutputUnchanged(
            currentFile,
            currentFileInfo,
            outputData,
            outputName,
          );
          showOutputPreview(outputData, outputName, visualUnchanged);
          triggerRunAck();
          setState("complete");
          scrollToOutputSummary();

          // Fire metadata diff analysis asynchronously (non-blocking)
          if (currentFile && outputData) {
            runMetadataDiffAsync(currentFile, outputData, outputName);
          }
        } catch {
          showToast("Processing completed but output file wasn't found.");
          setState("error");
        }
      }
      // ret !== 0: engine's onError callback already fired and set state to error

      // Cleanup VFS — also remove concat manifest if present
      if (isMultiFile) writtenInputNames.push("concat_list.txt");
      await cleanupVFS(eng, writtenInputNames, ret === 0 ? result.outputName : undefined);
    } catch (err) {
      if (destroyed) return;
      showToast("An unexpected error occurred.");
      setState("error");
      // Clean up VFS after unexpected errors
      await cleanupVFS(eng, writtenInputNames);
    }
  }

  // ── Output Summary ──────────────────────────────────────────────────────

  function renderOutputSummary(data: Uint8Array, name: string, visualUnchanged = false): void {
    opts.outputSummary.innerHTML = "";
    const row = el("div", "prism-output-info");
    row.classList.add("prism-output-info--download");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-label", `Download ${name}`);
    row.addEventListener("click", () => { downloadOutput(); });
    row.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        downloadOutput();
      }
    });

    row.appendChild(el("span", "prism-output-name", name));
    row.appendChild(el("span", "prism-output-size", formatSize(data.byteLength)));

    // Compression ratio vs input
    const cfi = getCurrentFileInfo();
    if (cfi) {
      const inputSize = cfi.size;
      const outputSize = data.byteLength;
      if (inputSize > 0 && outputSize !== inputSize) {
        const ratio = ((1 - outputSize / inputSize) * 100);
        const ratioEl = el("span", "prism-output-ratio");
        if (ratio > 0) {
          ratioEl.textContent = `${Math.round(ratio)}% smaller`;
        } else {
          ratioEl.textContent = `${Math.round(Math.abs(ratio))}% larger`;
          ratioEl.classList.add("prism-output-ratio--larger");
        }
        row.appendChild(ratioEl);
      }
    }

    if (visualUnchanged) {
      const unchangedBadge = el("span", "prism-output-badge", "No visual change");
      row.appendChild(unchangedBadge);
    }

    opts.outputSummary.appendChild(row);
    show(opts.outputSummary);
  }

  async function getImageDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        const dims = { width: image.naturalWidth, height: image.naturalHeight };
        URL.revokeObjectURL(url);
        resolve(dims);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      image.src = url;
    });
  }

  async function isVisualOutputUnchanged(
    inputFile: File,
    inputInfo: FileInfo,
    output: Uint8Array,
    outputFileName: string,
  ): Promise<boolean> {
    if (inputInfo.category !== "image") return false;
    const outputExt = outputFileName.split(".").pop()?.toLowerCase() || "";
    const outputMime = mimeForExtension(outputExt);
    if (!outputMime.startsWith("image/")) return false;
    if (inputFile.size !== output.byteLength) return false;

    const inputBytes = await readFileAsUint8Array(inputFile);
    if (inputBytes.length !== output.length) return false;
    for (let i = 0; i < inputBytes.length; i++) {
      if (inputBytes[i] !== output[i]) return false;
    }

    const [inputDims, outputDims] = await Promise.all([
      getImageDimensions(inputFile),
      getImageDimensions(new Blob([output], { type: outputMime })),
    ]);
    if (!inputDims || !outputDims) return false;

    return inputDims.width === outputDims.width && inputDims.height === outputDims.height;
  }

  // ── Metadata Diff Report ────────────────────────────────────────────────

  function runMetadataDiffAsync(inputFile: File, outData: Uint8Array, outName: string): void {
    import("./prism-metadata-diff").then(({ analyzeMetadataDiff }) => {
      analyzeMetadataDiff(inputFile, outData, outName).then((diff) => {
        if (destroyed || prismState !== "complete") return;
        renderMetadataReport(diff);
      }).catch(() => {
        // Metadata diff is best-effort; swallow errors silently.
      });
    }).catch(() => {
      // Module load failure is non-fatal.
    });
  }

  function renderMetadataReport(diff: MetadataDiffResult): void {
    if (diff.removedCount === 0 && diff.survivingCount === 0) return;

    const report = el("div", "prism-meta-report");

    // ── Summary Bar ──
    const summary = el("div", "prism-meta-summary");

    const levelClass = diff.cleanLevel === "full"
      ? "prism-meta-level--full"
      : diff.cleanLevel === "partial"
        ? "prism-meta-level--partial"
        : "prism-meta-level--none";

    const indicator = el("span", `prism-meta-level ${levelClass}`);
    indicator.textContent = diff.cleanLevel === "full" ? "●" : diff.cleanLevel === "partial" ? "◐" : "○";
    summary.appendChild(indicator);

    if (diff.removedCount > 0) {
      const removedEl = el("span", "prism-meta-removed-count");
      removedEl.textContent = `${diff.removedCount} field${diff.removedCount !== 1 ? "s" : ""} removed`;
      summary.appendChild(removedEl);
    }

    if (diff.survivingCount > 0) {
      const survivingEl = el("span", "prism-meta-surviving-count");
      survivingEl.textContent = `${diff.survivingCount} surviving`;
      summary.appendChild(survivingEl);
    }

    if (diff.removedCount === 0 && diff.survivingCount > 0) {
      const noneEl = el("span", "prism-meta-removed-count");
      noneEl.textContent = "no metadata removed";
      summary.appendChild(noneEl);
    }

    report.appendChild(summary);

    // ── Category Breakdowns ──
    for (const cat of diff.categories) {
      if (cat.removed.length === 0 && cat.surviving.length === 0) continue;

      const section = el("div", "prism-meta-cat");
      section.dataset.cat = cat.id;

      // Toggle header
      const toggle = el("button", "prism-meta-toggle");
      toggle.type = "button";
      const arrow = el("span", "prism-meta-arrow", "\u25B6");
      const title = el("span", "prism-meta-title", cat.title);
      const badge = el("span", "prism-meta-badge");
      if (cat.removed.length > 0) {
        badge.textContent = `-${cat.removed.length}`;
        badge.classList.add("prism-meta-badge--removed");
      } else {
        badge.textContent = String(cat.surviving.length);
      }
      toggle.append(arrow, title, badge);
      toggle.setAttribute("aria-expanded", "false");
      section.appendChild(toggle);

      // Body (collapsed by default)
      const body = el("div", "prism-meta-body");
      body.style.display = "none";

      // Removed fields (Sorted by label)
      const sortedRemoved = [...cat.removed].sort((a, b) => a.label.localeCompare(b.label));
      for (const field of sortedRemoved) {
        const row = el("div", "prism-meta-field prism-meta-field--removed");
        const label = el("span", "prism-meta-field-label");
        label.textContent = `\u2715 ${field.label}`; // Use a cross icon for removed
        const value = el("span", "prism-meta-field-value", field.displayValue || String(field.value ?? ""));
        row.append(label, value);
        body.appendChild(row);
      }

      // Surviving fields (Sorted by label)
      const sortedSurviving = [...cat.surviving].sort((a, b) => a.label.localeCompare(b.label));
      for (const field of sortedSurviving) {
        const row = el("div", "prism-meta-field prism-meta-field--surviving");
        const label = el("span", "prism-meta-field-label", field.label);
        const value = el("span", "prism-meta-field-value", field.displayValue || String(field.value ?? ""));
        row.append(label, value);
        body.appendChild(row);
      }

      section.appendChild(body);

      // Toggle interaction
      toggle.addEventListener("click", () => {
        const expanded = body.style.display !== "none";
        body.style.display = expanded ? "none" : "";
        arrow.style.transform = expanded ? "rotate(0deg)" : "rotate(90deg)";
        toggle.setAttribute("aria-expanded", String(!expanded));
      });

      report.appendChild(section);
    }

    opts.outputSummary.appendChild(report);
  }

  // ── Preview Output ─────────────────────────────────────────────────────

  function showOutputPreview(data: Uint8Array, name: string, visualUnchanged = false): void {
    hideAllPreviews();
    show(opts.previewSection);
    renderOutputSummary(data, name, visualUnchanged);

    const ext = name.split(".").pop()?.toLowerCase() || "";
    const mime = mimeForExtension(ext);
    const blob = new Blob([data], { type: mime });
    previewUrl = URL.createObjectURL(blob);

    if (mime.startsWith("video/")) {
      opts.previewVideo.src = previewUrl;
      show(opts.previewVideo);
    } else if (mime.startsWith("audio/")) {
      opts.previewAudio.src = previewUrl;
      show(opts.previewAudio);
    } else if (mime.startsWith("image/")) {
      opts.previewImg.src = previewUrl;
      opts.previewImg.style.cursor = "pointer";
      opts.previewImg.setAttribute("role", "button");
      opts.previewImg.setAttribute("tabindex", "0");
      opts.previewImg.setAttribute("title", "Tap to download");
      opts.previewImg.onclick = () => { downloadOutput(); };
      opts.previewImg.onkeydown = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          downloadOutput();
        }
      };
      show(opts.previewImg);
    } else if (mime.startsWith("text/") || ext === "srt" || ext === "ass" || ext === "ssa" || ext === "vtt") {
      const text = new TextDecoder().decode(data);
      opts.previewText.textContent = text;
      show(opts.previewText);
    }
  }

  // ── Download ───────────────────────────────────────────────────────────

  function downloadOutput(): void {
    if (!outputData || !outputName) return;

    // Revoke any previous tracked download URL
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }

    const ext = outputName.split(".").pop()?.toLowerCase() || "";
    const mime = mimeForExtension(ext);
    const blob = new Blob([outputData], { type: mime });
    const url = URL.createObjectURL(blob);
    downloadUrl = url;

    const a = document.createElement("a");
    a.href = url;
    a.download = outputName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (downloadUrl === url) downloadUrl = null;
    }, 100);
  }

  // ── Clear ──────────────────────────────────────────────────────────────

  function clearAll(): void {
    fileQueue = [];
    primaryIndex = 0;
    revokeQueueThumbUrls();
    clearRefreshFileToken();
    if (outputUrl) { URL.revokeObjectURL(outputUrl); outputUrl = null; }
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
    outputData = null;
    outputName = "";
    runAckActive = false;
    if (runAckTimer) {
      clearTimeout(runAckTimer);
      runAckTimer = null;
    }
    hideAllPreviews();
    hideInputPreview();
    hide(opts.sizeWarning);
    opts.fileQueueList.innerHTML = "";
    opts.terminalLog.textContent = "";
    opts.modulePanel.innerHTML = "";
    // Reset ALL modules
    for (const mod of Object.values(modules)) {
      mod.reset();
    }
    activeModuleId = "workbench";
    setBeforeUnload(false);
    setState("idle");
  }

  // ── Terminal Toggle ────────────────────────────────────────────────────

  function toggleTerminal(): void {
    terminalOpen = !terminalOpen;
    if (terminalOpen) {
      show(opts.terminalBody);
      opts.terminalToggle.setAttribute("aria-expanded", "true");
      opts.terminalToggle.textContent = "\u25be Terminal";
    } else {
      hide(opts.terminalBody);
      opts.terminalToggle.setAttribute("aria-expanded", "false");
      opts.terminalToggle.textContent = "\u25b8 Terminal";
    }
  }

  // ── Upload Zone Events ─────────────────────────────────────────────────

  on(opts.uploadZone, "dragenter", (e: DragEvent) => {
    e.preventDefault();
    dragCounter++;
    opts.uploadZone.classList.add("prism-drop-active");
  });

  on(opts.uploadZone, "dragover", (e: DragEvent) => {
    e.preventDefault();
  });

  on(opts.uploadZone, "dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      opts.uploadZone.classList.remove("prism-drop-active");
    }
  });

  on(opts.uploadZone, "drop", (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    opts.uploadZone.classList.remove("prism-drop-active");
    const files = e.dataTransfer?.files;
    if (files) {
      for (let i = 0; i < files.length; i++) {
        processFile(files[i]);
      }
    }
  });

  on(opts.uploadZone, "click", () => {
    opts.fileInput.click();
  });

  on(opts.uploadZone, "keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      opts.fileInput.click();
    }
  });

  on(opts.fileInput, "change", () => {
    const files = opts.fileInput.files;
    if (files) {
      for (let i = 0; i < files.length; i++) {
        processFile(files[i]);
      }
    }
    opts.fileInput.value = "";
  });

  // Page-level drag-and-drop (allows dropping files anywhere on the page)
  on(opts.page, "dragover", (e: DragEvent) => {
    e.preventDefault();
  });

  on(opts.page, "drop", (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    opts.uploadZone.classList.remove("prism-drop-active");
    const files = e.dataTransfer?.files;
    if (files) {
      for (let i = 0; i < files.length; i++) {
        processFile(files[i]);
      }
    }
  });

  // Global paste
  on(document, "paste", (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      for (let i = 0; i < files.length; i++) {
        processFile(files[i]);
      }
    }
  });

  // ── Module Tab Clicks ─────────────────────────────────────────────────

  on(opts.moduleBar, "click", (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-module]");
    if (!target || target.disabled) return;

    const modId = target.dataset.module as ModuleId;
    if (modId && modules[modId]) {
      switchModule(modId);
    }
  });

  // ── Action Bar Events ──────────────────────────────────────────────────

  on(opts.btnRun, "click", () => {
    if (prismState === "complete" || prismState === "error") {
      // "Run Again" / "Try Again" — reset output, return to file-loaded state
      resetOutput();
      setState("files_loaded");
      updateQueueStatus("ready", "ready");
      return;
    }

    const loadableState = isLoadableState(prismState);
    const currentEngineState = engine?.state ?? "idle";
    if (loadableState && (currentEngineState === "idle" || currentEngineState === "error")) {
      const eng = ensureEngine();
      opts.engineStatus.textContent = "loading engine...";
      void eng.load().catch(() => { });
      return;
    }

    if (currentEngineState === "loading") return;

    run();
  });

  on(opts.btnCancel, "click", () => { engine?.cancel(); });
  on(opts.btnLens, "click", async () => {
    const currentFile = getCurrentFile();
    if (!currentFile || !handoffSupported || lensHandoffInFlight) return;
    lensHandoffInFlight = true;
    updateUI();
    try {
      const draftSnapshot = await collectDraftSnapshotForHandoff();
      let token: string;
      try {
        token = await createFileHandoff(currentFile, draftSnapshot ?? undefined);
      } catch {
        token = await createFileHandoff(currentFile);
      }
      window.location.href = buildLensHandoffUrl(token);
    } catch {
      showToast("could not handoff file to lens");
    } finally {
      lensHandoffInFlight = false;
      if (!destroyed) updateUI();
    }
  });
  on(opts.btnUpload, "click", () => { opts.fileInput.click(); });
  on(opts.btnClear, "click", () => { clearAll(); });

  // ── Terminal Toggle + Copy ──────────────────────────────────────────────

  on(opts.terminalToggle, "click", () => { toggleTerminal(); });

  on(opts.terminalCopy, "click", () => {
    const log = opts.terminalLog.textContent || "";
    // Find the ffmpeg command line (starts with "$ ffmpeg")
    const cmdLine = log.split("\n").find((l) => l.startsWith("$ ffmpeg"));
    const text = cmdLine ? cmdLine.slice(2) : log; // strip the "$ " prefix
    navigator.clipboard.writeText(text).then(
      () => { showToast("Copied to clipboard."); },
      () => { showToast("Couldn't copy \u2014 try selecting manually."); },
    );
  });

  // ── Initial UI State ───────────────────────────────────────────────────

  setState("idle");
  hide(opts.terminalBody);

  async function initLensHandoffSupport(): Promise<void> {
    handoffSupported = await supportsFileHandoff();
    if (destroyed) return;
    updateUI();
  }

  void initLensHandoffSupport();

  async function consumeLensHandoffIfPresent(): Promise<void> {
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

      let notice: string | null = null;
      const hadDraftMetadata = payload.metadata !== null;
      const draft = hadDraftMetadata ? parsePrismDraftSnapshot(payload.metadata) : null;
      if (hadDraftMetadata && !draft) {
        notice = "loaded file. prism draft could not be restored";
      }

      let queueRestored = false;
      if (draft?.queueRef) {
        queueRestored = await restoreQueueFromSnapshot(draft);
        if (!queueRestored && !notice) {
          notice = "restored current file only. previous queue session was unavailable";
        }
      }

      if (!queueRestored) {
        if (fileQueue.length > 0) {
          clearAll();
        }
        await processFile(payload.file);
      }
      if (destroyed) return;

      if (draft) {
        const restoredDraft = restoreDraftSnapshot(draft, getCurrentFile() ?? payload.file);
        if (!restoredDraft && !notice) {
          notice = "loaded file. draft settings did not match this file";
        }
      }

      if (notice) {
        showToast(notice);
      }
    } catch {
      if (!destroyed) {
        showToast("could not load handoff from lens");
      }
    }
  }

  async function restoreRefreshFileIfPresent(): Promise<void> {
    if (fileQueue.length > 0) return;
    const token = loadRefreshFileToken();
    if (!token) return;

    try {
      const payload = await consumeFileHandoffWithRetry(token);
      if (!payload) {
        clearRefreshFileToken();
        return;
      }
      if (destroyed || fileQueue.length > 0) return;
      await processFile(payload.file);
    } catch {
      // Ignore restore failures silently.
    }
  }

  void (async () => {
    await consumeLensHandoffIfPresent();
    await restoreRefreshFileIfPresent();
  })();

  // ── Cleanup ────────────────────────────────────────────────────────────

  return () => {
    destroyed = true;
    setBeforeUnload(false);
    opts.previewVideo.pause();
    opts.previewVideo.removeAttribute("src");
    opts.previewAudio.pause();
    opts.previewAudio.removeAttribute("src");
    opts.inputVideo.pause();
    opts.inputVideo.removeAttribute("src");
    opts.inputAudio.pause();
    opts.inputAudio.removeAttribute("src");
    revokeQueueThumbUrls();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    if (toastTimer) clearTimeout(toastTimer);
    if (runAckTimer) clearTimeout(runAckTimer);
    const toast = document.querySelector(".prism-toast");
    if (toast) toast.remove();
    engine?.setCallbacks({});
    engine = null;
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  };
}
