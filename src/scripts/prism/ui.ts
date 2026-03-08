// prism-ui.ts — UI orchestration, state machine, DOM binding for The Prism.
// All state is scoped inside initPrism() for clean Astro lifecycle teardown.

import {
  createEngine,
  readFileAsUint8Array,
  checkFileSize,
  isMobileDevice,
  mimeForExtension,
  formatSize,
  detectCategory,
  type PrismEngine,
  type FileInfo,
  type EngineState,
  type EngineCallbacks,
  type ProgressEvent,
  type LoadProgressEvent,
  type EngineError,
} from "./engine";
import {
  buildLensHandoffUrl,
  clearHandoffTokenFromCurrentUrl,
  consumeFileHandoffWithRetry,
  consumePrismQueueSessionWithRetry,
  createFileHandoff,
  createPrismQueueSession,
  getHandoffTokenFromCurrentUrl,
  supportsFileHandoff,
} from "../shared/file-handoff";
import {
  createPrismFileSignature,
  createPrismDraftSnapshot,
  parsePrismDraftSnapshot,
  sanitizePrismDraftValue,
  samePrismFileSignature,
  type PrismDraftQueueRef,
  type PrismDraftModuleId,
  type PrismDraftSnapshot,
} from "./draft";

import { createWorkbench } from "./workbench";
import { createShrubber } from "./shrubber";
import { createAudioLab } from "./audio";
import { createSubtitles } from "./subtitles";
import { createTransparency } from "./transparency";
import { createScribe } from "./scribe";
import { createFlatcap } from "./flatcap";
import type { DocumentBuildResult } from "./scribe";
import type { MetadataDiffResult } from "./metadata-diff";

// ─── Module Type ──────────────────────────────────────────────────────────────

type ModuleId = "workbench" | "shrubber" | "audio" | "subtitles" | "transparency" | "scribe" | "flatcap";

type FfmpegBuildResult = {
  pipeline?: "ffmpeg";
  args: string[];
  outputName: string;
  prepare?: (engine: PrismEngine) => Promise<void>;
  multiFile?: boolean;
};

type BuildResult = FfmpegBuildResult | DocumentBuildResult | null;

interface PrismModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): BuildResult;
  getConfig(): unknown;
  setConfig?(config: unknown): void;
  setFile?(file: File): void;
  setFileQueue?(queue: { file: File; info: FileInfo }[]): void;
  reset(): void;
}

const MODULE_VISIBILITY: Record<ModuleId, FileInfo["category"][]> = {
  workbench: ["video", "audio", "image"],
  shrubber: ["video", "audio", "image"],
  audio: ["video", "audio"],
  subtitles: ["video", "subtitle"],
  transparency: ["video"],
  scribe: ["markdown", "image", "text"],
  flatcap: ["pdf"],
};

const DOCUMENT_MODULES: ReadonlySet<ModuleId> = new Set(["scribe", "flatcap"]);

function isDocumentModule(id: ModuleId): boolean {
  return DOCUMENT_MODULES.has(id);
}

function isDocumentResult(r: NonNullable<BuildResult>): r is DocumentBuildResult {
  return "pipeline" in r && r.pipeline === "document";
}

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
  terminalToggle: HTMLElement;
  logWrap: HTMLElement;
  logDot: HTMLElement;
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
  logWrap: "prism-log-wrap",
  logDot: "prism-log-dot",
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
  const logWrap = q(root, PRISM_UI_IDS.logWrap);
  const logDot = q(root, PRISM_UI_IDS.logDot);
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


  if (!page || !uploadZone || !fileInput || !inputPreview || !inputVideo ||
    !inputAudio || !inputImg || !inputGlyph || !sourceName || !sourceSize || !sourceType ||
    !fileQueue || !fileQueueList ||
    !moduleBar || !modulePanel || !previewSection || !previewVideo ||
    !previewAudio || !previewImg || !previewText || !terminalSection ||
    !terminalToggle || !logWrap || !logDot || !terminalLog || !progressSection ||
    !progressBar || !progressFill || !progressText || !engineStatus ||
    !actionBar || !btnRun || !btnCancel || !btnLens || !alphaBadge || !btnUpload ||
    !btnClear || !sizeWarning || !outputSummary) {
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
    terminalToggle,
    logWrap,
    logDot,
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
const LOG_DIM_MS = 2000;

function logTimestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

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
  let inputPreviewUrl: string | null = null;
  let downloadUrl: string | null = null;
  let terminalOpen = true;
  let logDimTimer: ReturnType<typeof setTimeout> | null = null;
  let dragCounter = 0;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let runAckTimer: ReturnType<typeof setTimeout> | null = null;
  let runAckActive = false;
  let lensHandoffInFlight = false;
  let handoffSupported = true;
  let bootRestorePending = false;
  let configDirty = false;
  const vfsInputSignatures = new Map<string, string>();
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

  function getFileSignature(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  async function ensureInputInVfs(eng: PrismEngine, file: File, name: string): Promise<void> {
    const path = `/input/${name}`;
    const signature = getFileSignature(file);
    if (vfsInputSignatures.get(path) === signature) return;

    const data = await readFileAsUint8Array(file);
    if (destroyed) return;
    await eng.writeFile(path, data);
    vfsInputSignatures.set(path, signature);
  }

  async function removeCachedInput(path: string): Promise<void> {
    vfsInputSignatures.delete(path);
    if (!engine || engine.state === "idle" || engine.state === "loading" || engine.state === "running") return;
    try {
      await engine.deleteFile(path);
    } catch {
      // best-effort cleanup
    }
  }

  async function clearCachedInputs(): Promise<void> {
    const cachedPaths = Array.from(vfsInputSignatures.keys());
    vfsInputSignatures.clear();
    if (!engine || engine.state === "idle" || engine.state === "loading" || engine.state === "running") return;
    for (const path of cachedPaths) {
      try {
        await engine.deleteFile(path);
      } catch {
        // best-effort cleanup
      }
    }
  }

  // ── Module Registry ─────────────────────────────────────────────────────

  const modules: Record<ModuleId, PrismModule> = {
    workbench: createWorkbench(),
    shrubber: createShrubber(),
    audio: createAudioLab(),
    subtitles: createSubtitles(),
    transparency: createTransparency(),
    scribe: createScribe(),
    flatcap: createFlatcap(),
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
        opts.terminalLog.textContent += `[${logTimestamp()}] ${msg}\n`;
        opts.terminalLog.scrollTop = opts.terminalLog.scrollHeight;
        opts.logDot.classList.add("prism-log-active");
        if (logDimTimer !== null) clearTimeout(logDimTimer);
        logDimTimer = setTimeout(() => { opts.logDot.classList.remove("prism-log-active"); logDimTimer = null; }, LOG_DIM_MS);
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

    showInputPreview(currentFile, currentFileInfo);
    updateModuleTabVisibility(currentFileInfo.category);

    for (const [id, mod] of Object.entries(modules) as [ModuleId, PrismModule][]) {
      if (!MODULE_VISIBILITY[id].includes(currentFileInfo.category)) continue;
      mod.configure(currentFileInfo);
      if (typeof mod.setFile === "function") mod.setFile(currentFile);
    }

    const requestedModule = MODULE_VISIBILITY[activeModuleId].includes(currentFileInfo.category)
      ? activeModuleId
      : (Object.keys(MODULE_VISIBILITY) as ModuleId[]).find(
        (id) => MODULE_VISIBILITY[id].includes(currentFileInfo.category),
      ) ?? "workbench";
    switchModule(requestedModule);
    renderFileQueue();
    for (const mod of Object.values(modules) as PrismModule[]) {
      if (typeof mod.setFileQueue === "function") mod.setFileQueue(fileQueue);
    }
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

    // Update tab styling + roving tabindex (WAI-ARIA tabs)
    const tabs = opts.moduleBar.querySelectorAll<HTMLButtonElement>("[data-module]");
    tabs.forEach((tab) => {
      if (tab.dataset.module === id) {
        tab.classList.add("prism-tab--active");
        tab.setAttribute("aria-selected", "true");
        tab.setAttribute("tabindex", "0");
      } else {
        tab.classList.remove("prism-tab--active");
        tab.setAttribute("aria-selected", "false");
        tab.setAttribute("tabindex", "-1");
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

      const applicable = MODULE_VISIBILITY[modId].includes(category);
      tab.style.display = applicable ? "" : "none";
      tab.disabled = !applicable;

      if (modId === activeModuleId && applicable) {
        activeStillVisible = true;
      }
    });

    // If active module doesn't apply, fall back to first applicable
    if (!activeStillVisible) {
      const firstApplicable = (Object.keys(MODULE_VISIBILITY) as ModuleId[]).find(
        (id) => MODULE_VISIBILITY[id].includes(category),
      );
      if (firstApplicable) {
        switchModule(firstApplicable);
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

    updateClearButton();
    updateUI();
  }

  function updateUI(): void {
    if (destroyed) return;
    const hasFile = Boolean(getCurrentFile());

    // Upload zone: visible when idle, fully hidden when files loaded
    if (prismState === "idle") {
      if (bootRestorePending) hide(opts.uploadZone);
      else show(opts.uploadZone);
      hideInputPreview();
      hide(opts.btnUpload);
    } else {
      hide(opts.uploadZone);
      show(opts.btnUpload);
    }

    // File queue + input preview
    if (prismState === "idle") {
      hide(opts.fileQueue);
      hide(opts.inputPreview);
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

    // Progress — hide for document modules (instant ops, no ffmpeg progress to show)
    if (prismState === "processing" && !isDocumentModule(activeModuleId)) {
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
    const isDocMod = isDocumentModule(activeModuleId);

    if (prismState === "complete") {
      opts.btnRun.textContent = runAckActive ? "Ran" : "Run";
      opts.btnRun.style.display = "";
    } else if (prismState === "error") {
      opts.btnRun.textContent = "Try Again";
      opts.btnRun.style.display = "";
    } else if (loadableState) {
      if (isDocMod) {
        opts.btnRun.textContent = "Run";
      } else {
        opts.btnRun.textContent = engineLoading ? "Loading..." : engineLoaded ? "Run" : "Load";
      }
      opts.btnRun.style.display = "";
    } else {
      opts.btnRun.style.display = "none";
    }

    if (!engineLoaded && loadableState && !isDocMod) {
      opts.btnRun.classList.add("action-btn--load");
    } else {
      opts.btnRun.classList.remove("action-btn--load");
    }
    opts.btnRun.classList.toggle("action-btn--ran", runAckActive && prismState === "complete");

    if (engineLoading && loadableState && !isDocMod) {
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

    // Engine status: hide entire status line for document modules (no ffmpeg)
    const statusLine = opts.engineStatus.parentElement;
    if (isDocMod && hasFile) {
      opts.engineStatus.textContent = "";
      if (statusLine) statusLine.style.display = "none";
    } else {
      if (statusLine) statusLine.style.display = "";
      if (!engine || engine.state === "idle") {
        opts.engineStatus.textContent = "engine idle";
      }
    }

    // Show action bar when not idle
    if (prismState === "idle") {
      opts.actionBar.style.opacity = "0";
      setTimeout(() => { if (!destroyed && prismState === "idle") hide(opts.actionBar); }, ACTION_BAR_FADE_MS);
    } else {
      show(opts.actionBar);
      requestAnimationFrame(() => { if (!destroyed) opts.actionBar.style.opacity = "1"; });
    }

    // Disable module controls and queue actions during processing
    const locked = prismState === "processing";
    opts.modulePanel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button").forEach((el) => {
      el.disabled = locked;
    });
    opts.fileQueueList.querySelectorAll<HTMLButtonElement>(".prism-queue-btn").forEach((btn) => {
      btn.disabled = locked;
    });
    opts.fileQueueList.classList.toggle("prism-queue--locked", locked);

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
    // Remove any document preview iframes and notes
    opts.previewSection.querySelectorAll<HTMLElement>(".prism-preview-doc, .prism-preview-doc-wrap, .prism-doc-card, .prism-preview-note").forEach((f) => f.remove());
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
    document.title = "Prism | woflo";
    const strip = opts.inputPreview.querySelector(".prism-input-preview");
    if (strip) strip.classList.remove("prism-input-preview--hero");
    hide(opts.inputPreview);
    if (inputPreviewUrl) {
      URL.revokeObjectURL(inputPreviewUrl);
      inputPreviewUrl = null;
    }
  }

  function showInputPreview(file: File, info: FileInfo): void {
    hideInputPreview();

    opts.sourceName.textContent = info.name;
    opts.sourceSize.textContent = info.sizeLabel;
    document.title = `${info.name} — Prism`;

    const cat = info.category;
    const typeLabel =
      cat === "video" ? (info.videoCodec ?? "Video")
        : cat === "audio" ? (info.audioCodec ?? "Audio")
          : cat === "image" ? "Image"
            : cat === "subtitle" ? "Subtitle"
              : cat === "markdown" ? "Markdown"
                : cat === "pdf" ? "PDF"
                  : file.type || "File";
    opts.sourceType.textContent = typeLabel;

    // Show media preview or glyph
    const strip = opts.inputPreview.querySelector(".prism-input-preview");
    if (cat === "video") {
      if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl);
      inputPreviewUrl = URL.createObjectURL(file);
      opts.inputVideo.src = inputPreviewUrl;
      show(opts.inputVideo);
      hide(opts.inputGlyph);
      if (strip) strip.classList.add("prism-input-preview--hero");
    } else if (cat === "image") {
      if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl);
      inputPreviewUrl = URL.createObjectURL(file);
      opts.inputImg.src = inputPreviewUrl;
      show(opts.inputImg);
      hide(opts.inputGlyph);
      if (strip) strip.classList.add("prism-input-preview--hero");
    } else if (cat === "audio") {
      // Show glyph + audio player below strip
      opts.inputGlyph.textContent = "AUD";
      show(opts.inputGlyph);
      if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl);
      inputPreviewUrl = URL.createObjectURL(file);
      opts.inputAudio.src = inputPreviewUrl;
      show(opts.inputAudio);
    } else {
      const glyphText =
        cat === "markdown" ? "MD"
          : cat === "pdf" ? "PDF"
            : cat === "text" ? "TXT"
              : cat === "subtitle" ? "SUB"
                : "FILE";
      opts.inputGlyph.textContent = glyphText;
      show(opts.inputGlyph);
    }

    show(opts.inputPreview);
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

    // Check category first — document files don't need the ffmpeg engine
    const category = detectCategory(file);
    let fileInfo: FileInfo;

    if (category === "unknown") {
      showToast(`Unsupported file type: ${file.name}`);
      return;
    }

    if (category === "markdown" || category === "pdf" || category === "text") {
      fileInfo = {
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        duration: null,
        sizeLabel: formatSize(file.size),
        category,
        resolution: null,
        videoCodec: null,
        audioCodec: null,
        channels: null,
        bitrate: null,
      };
    } else {
      const eng = ensureEngine();
      fileInfo = await eng.probeFile(file);
    }

    // Check compatibility with current queue
    const isFirst = fileQueue.length === 0;
    if (!isFirst) {
      const primaryCat = fileQueue[primaryIndex].info.category;
      const hasSharedModule = (Object.keys(MODULE_VISIBILITY) as ModuleId[]).some(
        (id) => MODULE_VISIBILITY[id].includes(primaryCat) && MODULE_VISIBILITY[id].includes(fileInfo.category),
      );
      if (!hasSharedModule) {
        // Incompatible type — replace the entire queue with this new file
        clearAll();
        fileQueue = [{ file, info: fileInfo }];
        primaryIndex = 0;
        renderFileQueue();
        for (const mod of Object.values(modules) as PrismModule[]) {
          if (typeof mod.setFileQueue === "function") mod.setFileQueue(fileQueue);
        }
        applyPrimaryFileContext();
        setState("files_loaded");
        return;
      }
    }

    fileQueue.push({ file, info: fileInfo });
    if (isFirst) primaryIndex = 0;

    // Update file queue display
    renderFileQueue();

    // Notify workbench of file queue changes
    for (const mod of Object.values(modules) as PrismModule[]) {
      if (typeof mod.setFileQueue === "function") mod.setFileQueue(fileQueue);
    }

    if (isFirst) {
      applyPrimaryFileContext();
    }

    setState("files_loaded");
  }

  function renderFileQueue(): void {
    revokeQueueThumbUrls();
    opts.fileQueueList.innerHTML = "";
    if (fileQueue.length <= 1) return;

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
              : info.category === "markdown"
                ? "MD"
                : info.category === "pdf"
                  ? "PDF"
                  : info.category === "text"
                    ? "TXT"
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

      // Click row to select as active file
      row.style.cursor = "pointer";
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      const selectIdx = idx;
      row.addEventListener("click", (e: MouseEvent) => {
        // Don't select if clicking a queue action button
        if ((e.target as HTMLElement).closest(".prism-queue-actions")) return;
        if (selectIdx === primaryIndex) return;
        selectQueueItem(selectIdx);
      });
      row.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (selectIdx !== primaryIndex) selectQueueItem(selectIdx);
        }
      });

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
    for (const mod of Object.values(modules) as PrismModule[]) {
      if (typeof mod.setFileQueue === "function") mod.setFileQueue(fileQueue);
    }
  }

  function removeQueueItem(idx: number): void {
    const removed = fileQueue[idx];
    if (removed) {
      void removeCachedInput(`/input/${removed.info.name}`);
    }
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
    for (const mod of Object.values(modules) as PrismModule[]) {
      if (typeof mod.setFileQueue === "function") mod.setFileQueue(fileQueue);
    }
  }

  function selectQueueItem(idx: number): void {
    if (idx < 0 || idx >= fileQueue.length || idx === primaryIndex) return;
    if (prismState === "processing") return;
    primaryIndex = idx;
    resetOutput();
    applyPrimaryFileContext();
    setState("files_loaded");
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
      // If outputSummary is hidden (doc card mode), scroll to the preview section instead
      const target = opts.outputSummary.style.display === "none" ? opts.previewSection : opts.outputSummary;
      target.scrollIntoView({
        behavior: smooth ? "smooth" : "auto",
        block: "start",
      });
    });
  }

  // ── VFS Cleanup ──────────────────────────────────────────────────────

  async function cleanupVFS(eng: PrismEngine, inputNames: string[], keepOutput?: string): Promise<void> {
    for (const name of inputNames) {
      vfsInputSignatures.delete(`/input/${name}`);
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

    // ── Document pipeline ──────────────────────────────────────────────
    if (isDocumentResult(result)) {
      setState("processing");
      opts.terminalLog.textContent = "";
      // Skip the progress bar for document ops — they're typically instant
      // (Scribe is sync, Flatcap only waits on CDN load which has its own feedback)

      try {
        opts.terminalLog.appendChild(document.createTextNode(`[${logTimestamp()}] ${activeModuleId} processing...\n`));
        const data = await result.execute();
        if (destroyed) return;

        opts.terminalLog.appendChild(document.createTextNode(`[${logTimestamp()}] ${activeModuleId} done \u2014 ${formatSize(data.byteLength)}\n`));
        opts.terminalLog.scrollTop = opts.terminalLog.scrollHeight;
        outputData = data;
        outputName = result.outputName;
        showOutputPreview(data, result.outputName, false);
        triggerRunAck();
        setState("complete");
        scrollToOutputSummary();

        // Fire metadata diff for document outputs (e.g. verify annotation removal)
        const currentFile = getCurrentFile();
        if (currentFile && outputData) {
          runMetadataDiffAsync(currentFile, outputData, outputName);
        }
      } catch (err) {
        if (destroyed) return;
        const msg = err instanceof Error ? err.message : "Document processing failed.";
        opts.terminalLog.appendChild(document.createTextNode(`[${logTimestamp()}] error: ${msg}\n`));
        showToast(msg);
        if (!terminalOpen) toggleTerminal();
        setState("error");
      }
      return;
    }

    // ── FFmpeg pipeline ────────────────────────────────────────────────
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
    const transientInputNames: string[] = [];

    try {
      if (isMultiFile) {
        // Ensure ALL queue files are available in VFS (skip unchanged files)
        for (const entry of fileQueue) {
          await ensureInputInVfs(eng, entry.file, entry.info.name);
          if (destroyed) return;
        }
      } else {
        // Ensure only the primary input file is available in VFS
        await ensureInputInVfs(eng, currentFile, currentFile.name);
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
      if (isMultiFile) transientInputNames.push("concat_list.txt");
      await cleanupVFS(eng, transientInputNames, ret === 0 ? result.outputName : undefined);
    } catch (err) {
      if (destroyed) return;
      showToast("An unexpected error occurred.");
      setState("error");
      // Clean up VFS after unexpected errors
      await cleanupVFS(eng, transientInputNames);
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

    row.appendChild(el("span", "prism-output-dl-icon", "\u2913")); // ⤓ download arrow
    row.appendChild(el("span", "prism-output-name", name));
    row.appendChild(el("span", "prism-output-size", formatSize(data.byteLength)));

    // Compression ratio vs input
    // Skip for document pipeline cross-format (e.g. md→html) where size increase is inherent
    const cfi = getCurrentFileInfo();
    if (cfi) {
      const inputExt = cfi.name.split(".").pop()?.toLowerCase() || "";
      const outputExt = name.split(".").pop()?.toLowerCase() || "";
      const crossFormatDoc = isDocumentModule(activeModuleId) && inputExt !== outputExt;
      // Flatcap: only show size ratio when flatten or strip actually removed content
      const flatcapNoStrip = activeModuleId === "flatcap" && (() => {
        const cfg = modules[activeModuleId].getConfig() as { flattenAnnotations?: boolean; stripMetadata?: boolean };
        return !cfg.flattenAnnotations && !cfg.stripMetadata;
      })();
      const inputSize = cfi.size;
      const outputSize = data.byteLength;
      if (inputSize > 0 && outputSize !== inputSize && !crossFormatDoc && !flatcapNoStrip) {
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

    // "Inspect in Lens" link — lets users analyze their output
    if (handoffSupported) {
      const inspectBtn = el("button", "prism-output-inspect", "Inspect output in Lens");
      inspectBtn.addEventListener("click", async () => {
        if (!outputData || !outputName) return;
        inspectBtn.textContent = "Handing off...";
        inspectBtn.disabled = true;
        try {
          const ext = outputName.split(".").pop()?.toLowerCase() || "";
          const mime = mimeForExtension(ext);
          const outFile = new File([outputData], outputName, { type: mime });
          const token = await createFileHandoff(outFile);
          window.location.href = buildLensHandoffUrl(token);
        } catch {
          showToast("Could not hand off to Lens.");
          inspectBtn.textContent = "Inspect output in Lens";
          inspectBtn.disabled = false;
        }
      });
      opts.outputSummary.appendChild(inspectBtn);
    }

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
    import("./metadata-diff").then(({ analyzeMetadataDiff }) => {
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

    const ext = name.split(".").pop()?.toLowerCase() || "";
    const mime = mimeForExtension(ext);
    const blob = new Blob([data], { type: mime });
    previewUrl = URL.createObjectURL(blob);

    if (ext === "html" || ext === "pdf") {
      // Unified card: download header → preview → actions → inspect
      renderDocCard(data, name, ext, visualUnchanged);
    } else {
      // All other types: separate download bar + inline preview
      renderOutputSummary(data, name, visualUnchanged);

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
        opts.previewImg.setAttribute("title", "Open full-size image");
        opts.previewImg.onclick = () => { openImageViewer(); };
        opts.previewImg.onkeydown = (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openImageViewer();
          }
        };
        show(opts.previewImg);
      } else if (mime.startsWith("text/") || ext === "srt" || ext === "ass" || ext === "ssa" || ext === "vtt") {
        const text = new TextDecoder().decode(data);
        opts.previewText.textContent = text;
        show(opts.previewText);
      }
      // pdf + unknown: download bar is sufficient, no inline preview
    }
  }

  function renderDocCard(data: Uint8Array, name: string, ext: string, visualUnchanged: boolean): void {
    // Hide the separate output summary — everything lives in one card
    opts.outputSummary.innerHTML = "";
    hide(opts.outputSummary);

    const card = document.createElement("div");
    card.className = "prism-doc-card";

    // ── Download header ──────────────────────────────────────────────
    const header = el("div", "prism-doc-card-header");
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-label", `Download ${name}`);
    header.addEventListener("click", () => { downloadOutput(); });
    header.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); downloadOutput(); }
    });
    header.appendChild(el("span", "prism-output-dl-icon", "\u2913"));
    header.appendChild(el("span", "prism-output-name", name));
    header.appendChild(el("span", "prism-output-size", formatSize(data.byteLength)));

    const cfi = getCurrentFileInfo();
    if (cfi) {
      const inputExt = cfi.name.split(".").pop()?.toLowerCase() || "";
      const outputExt = name.split(".").pop()?.toLowerCase() || "";
      const crossFormatDoc = isDocumentModule(activeModuleId) && inputExt !== outputExt;
      const flatcapNoStrip = activeModuleId === "flatcap" && (() => {
        const cfg = modules[activeModuleId].getConfig() as { flattenAnnotations?: boolean; stripMetadata?: boolean };
        return !cfg.flattenAnnotations && !cfg.stripMetadata;
      })();
      const inputSize = cfi.size;
      const outputSize = data.byteLength;
      if (inputSize > 0 && outputSize !== inputSize && !crossFormatDoc && !flatcapNoStrip) {
        const ratio = ((1 - outputSize / inputSize) * 100);
        const ratioEl = el("span", "prism-output-ratio");
        if (ratio > 0) {
          ratioEl.textContent = `${Math.round(ratio)}% smaller`;
        } else {
          ratioEl.textContent = `${Math.round(Math.abs(ratio))}% larger`;
          ratioEl.classList.add("prism-output-ratio--larger");
        }
        header.appendChild(ratioEl);
      }
    }

    if (visualUnchanged) {
      header.appendChild(el("span", "prism-output-badge", "No visual change"));
    }

    card.appendChild(header);

    // ── Content area (format-specific) ───────────────────────────────
    if (ext === "html") {
      const htmlContent = new TextDecoder().decode(data);

      const iframe = document.createElement("iframe");
      iframe.className = "prism-preview-doc";
      iframe.sandbox.add("allow-same-origin");
      iframe.srcdoc = htmlContent;
      iframe.title = "Document preview";
      card.appendChild(iframe);

      const btnRow = el("div", "prism-preview-doc-actions");
      const printBtn = el("button", "prism-preview-doc-print", "Save as PDF");
      printBtn.addEventListener("click", () => {
        const w = window.open("", "_blank");
        if (w) {
          w.document.write(htmlContent);
          w.document.close();
          w.addEventListener("load", () => w.print());
          setTimeout(() => { try { w.print(); } catch { /* already printed */ } }, 600);
        }
      });
      btnRow.appendChild(printBtn);
      const openBtn = el("button", "prism-preview-doc-open", "Open HTML");
      openBtn.addEventListener("click", () => {
        if (previewUrl) window.open(previewUrl, "_blank", "noopener,noreferrer");
      });
      btnRow.appendChild(openBtn);
      card.appendChild(btnRow);
    } else if (ext === "pdf") {
      const pdfFrame = document.createElement("iframe");
      pdfFrame.className = "prism-preview-doc";
      if (previewUrl) pdfFrame.src = previewUrl;
      pdfFrame.title = "PDF preview";
      card.appendChild(pdfFrame);

      const btnRow = el("div", "prism-preview-doc-actions");
      const printBtn = el("button", "prism-preview-doc-print", "Save as PDF");
      printBtn.addEventListener("click", () => {
        if (!previewUrl) return;
        const w = window.open(previewUrl, "_blank");
        if (w) {
          w.addEventListener("load", () => { try { w.print(); } catch { /* blocked */ } });
          setTimeout(() => { try { w.print(); } catch { /* already printed or blocked */ } }, 600);
        }
      });
      btnRow.appendChild(printBtn);
      const openBtn = el("button", "prism-preview-doc-open", "View");
      openBtn.addEventListener("click", () => {
        if (previewUrl) window.open(previewUrl, "_blank", "noopener,noreferrer");
      });
      btnRow.appendChild(openBtn);
      card.appendChild(btnRow);
    }

    // ── Inspect in Lens ──────────────────────────────────────────────
    if (handoffSupported) {
      const inspectBtn = el("button", "prism-doc-card-inspect", "Inspect output in Lens");
      inspectBtn.addEventListener("click", async () => {
        if (!outputData || !outputName) return;
        inspectBtn.textContent = "Handing off...";
        inspectBtn.disabled = true;
        try {
          const ext = outputName.split(".").pop()?.toLowerCase() || "";
          const inspectMime = mimeForExtension(ext);
          const outFile = new File([outputData], outputName, { type: inspectMime });
          const token = await createFileHandoff(outFile);
          window.location.href = buildLensHandoffUrl(token);
        } catch {
          showToast("Could not hand off to Lens.");
          inspectBtn.textContent = "Inspect output in Lens";
          inspectBtn.disabled = false;
        }
      });
      card.appendChild(inspectBtn);
    }

    const preview = opts.previewSection.querySelector(".prism-preview");
    if (preview) preview.appendChild(card);
    else opts.previewSection.appendChild(card);
  }

  // ── Download ───────────────────────────────────────────────────────────

  function openImageViewer(): void {
    if (!previewUrl) return;
    window.open(previewUrl, "_blank", "noopener,noreferrer");
  }

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

  function markConfigDirty(): void {
    if (!configDirty) {
      configDirty = true;
      updateClearButton();
    }
  }

  function updateClearButton(): void {
    if (configDirty && prismState !== "idle") {
      opts.btnClear.textContent = "Defaults";
    } else {
      opts.btnClear.textContent = "Clear";
    }
  }

  function resetDefaults(): void {
    // Reset only configs, keep files
    const currentFile = getCurrentFile();
    const currentFileInfo = getCurrentFileInfo();
    for (const mod of Object.values(modules)) {
      mod.reset();
    }
    // Re-apply file context so modules reconfigure for the current file
    if (currentFile && currentFileInfo) {
      for (const [id, mod] of Object.entries(modules) as [ModuleId, PrismModule][]) {
        if (!MODULE_VISIBILITY[id].includes(currentFileInfo.category)) continue;
        mod.configure(currentFileInfo);
        if (typeof mod.setFile === "function") mod.setFile(currentFile);
      }
      if (fileQueue.length > 0) {
        for (const mod of Object.values(modules) as PrismModule[]) {
          if (typeof mod.setFileQueue === "function") mod.setFileQueue(fileQueue);
        }
      }
    }
    // Re-render active module
    opts.modulePanel.innerHTML = "";
    modules[activeModuleId].render(opts.modulePanel);
    configDirty = false;
    updateClearButton();
    // Reset output if any
    if (prismState === "complete" || prismState === "error") {
      resetOutput();
      setState("files_loaded");
    }
    showToast("Reset to defaults.");
  }

  function clearAll(): void {
    fileQueue = [];
    primaryIndex = 0;
    void clearCachedInputs();
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
    configDirty = false;
    setBeforeUnload(false);
    setState("idle");
  }

  // ── Terminal Toggle ────────────────────────────────────────────────────

  function toggleTerminal(): void {
    const collapsed = opts.logWrap.classList.toggle("prism-log-collapsed");
    terminalOpen = !collapsed;
    opts.terminalToggle.setAttribute("aria-expanded", String(!collapsed));
    localStorage.setItem("prism-log-collapsed", collapsed ? "1" : "0");
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
    // Only accept file drags (not text/link drags)
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
    }
  });

  on(opts.page, "drop", (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      dragCounter = 0;
      opts.uploadZone.classList.remove("prism-drop-active");
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

  // ── Module Tab Clicks + Keyboard ──────────────────────────────────────

  on(opts.moduleBar, "click", (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-module]");
    if (!target || target.disabled) return;

    const modId = target.dataset.module as ModuleId;
    if (modId && modules[modId]) {
      switchModule(modId);
    }
  });

  // Arrow key navigation between visible tabs (WAI-ARIA tabs pattern)
  on(opts.moduleBar, "keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (!target.matches("[data-module]")) return;

    const visibleTabs = Array.from(
      opts.moduleBar.querySelectorAll<HTMLButtonElement>("[data-module]"),
    ).filter((t) => t.style.display !== "none" && !t.disabled);
    const idx = visibleTabs.indexOf(target as HTMLButtonElement);
    if (idx < 0) return;

    let next: HTMLButtonElement | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = visibleTabs[(idx + 1) % visibleTabs.length];
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = visibleTabs[(idx - 1 + visibleTabs.length) % visibleTabs.length];
    } else if (e.key === "Home") {
      next = visibleTabs[0];
    } else if (e.key === "End") {
      next = visibleTabs[visibleTabs.length - 1];
    }

    if (next) {
      e.preventDefault();
      next.focus();
      const modId = next.dataset.module as ModuleId;
      if (modId && modules[modId]) switchModule(modId);
    }
  });

  // ── Action Bar Events ──────────────────────────────────────────────────

  on(opts.btnRun, "click", () => {
    if (prismState === "complete" || prismState === "error") {
      // "Run Again" / "Try Again" — reset output, then rerun immediately
      resetOutput();
      setState("files_loaded");
      updateQueueStatus("ready", "ready");
    }

    const loadableState = isLoadableState(prismState);
    const isDocMod = isDocumentModule(activeModuleId);
    const currentEngineState = engine?.state ?? "idle";

    // Document modules skip engine loading entirely
    if (!isDocMod) {
      if (loadableState && (currentEngineState === "idle" || currentEngineState === "error")) {
        const eng = ensureEngine();
        opts.engineStatus.textContent = "loading engine...";
        void eng.load().catch(() => { });
        return;
      }
      if (currentEngineState === "loading") return;
    }

    void run();
  });

  on(opts.btnCancel, "click", () => {
    vfsInputSignatures.clear();
    void engine?.cancel();
  });

  // Keyboard shortcuts: Ctrl+Enter to run, Escape to cancel
  on(document, "keydown", (e: KeyboardEvent) => {
    if (destroyed) return;
    // Don't intercept when focus is in an input/textarea/contenteditable
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;

    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      opts.btnRun.click();
    } else if (e.key === "Escape" && prismState === "processing") {
      e.preventDefault();
      opts.btnCancel.click();
    }
  });
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
  on(opts.btnClear, "click", () => {
    if (configDirty && prismState !== "idle") {
      resetDefaults();
    } else {
      clearAll();
    }
  });

  // Track config changes via delegated events on the module panel
  on(opts.modulePanel, "input", () => { markConfigDirty(); });
  on(opts.modulePanel, "change", () => { markConfigDirty(); });

  // ── Runtime Log Toggle ─────────────────────────────────────────────────

  on(opts.terminalToggle, "click", () => { toggleTerminal(); });
  on(opts.terminalToggle, "keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTerminal(); }
  });

  // Restore collapsed state from localStorage
  if (localStorage.getItem("prism-log-collapsed") === "1") {
    opts.logWrap.classList.add("prism-log-collapsed");
    opts.terminalToggle.setAttribute("aria-expanded", "false");
    terminalOpen = false;
  }

  // ── Initial UI State ───────────────────────────────────────────────────

  setState("idle");

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

  bootRestorePending = Boolean(getHandoffTokenFromCurrentUrl() || loadRefreshFileToken());
  if (bootRestorePending) {
    updateUI();
  }

  void (async () => {
    try {
      await consumeLensHandoffIfPresent();
      await restoreRefreshFileIfPresent();
    } finally {
      bootRestorePending = false;
      if (!destroyed) updateUI();
    }
  })();

  // ── Cleanup ────────────────────────────────────────────────────────────

  return () => {
    destroyed = true;
    if (logDimTimer !== null) { clearTimeout(logDimTimer); logDimTimer = null; }
    setBeforeUnload(false);
    opts.previewVideo.pause();
    opts.previewVideo.removeAttribute("src");
    opts.previewAudio.pause();
    opts.previewAudio.removeAttribute("src");
    opts.inputVideo.pause();
    opts.inputVideo.removeAttribute("src");
    opts.inputAudio.pause();
    opts.inputAudio.removeAttribute("src");
    if (inputPreviewUrl) URL.revokeObjectURL(inputPreviewUrl);
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
    document.title = "Prism | woflo";
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  };
}
