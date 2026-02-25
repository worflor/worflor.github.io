// prism-subtitles.ts — The Subtitles module: extract, convert, and burn subtitles.

import type { FileInfo, PrismEngine } from "./engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SubtitleAction = "extract" | "convert" | "burn";

export interface SubtitleConfig {
  action: SubtitleAction;
  // Extract
  trackIndex: number;
  extractFormat: string; // "srt" | "vtt" | "ass"
  // Convert
  convertFormat: string; // "srt" | "vtt" | "ass"
  // Burn
  fontSize: number;
  marginV: number;  // vertical margin from bottom
  burnSource: "embedded" | "external";
  externalSubFile: File | null;
}

export interface SubtitleModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): { args: string[]; outputName: string; prepare?: (engine: PrismEngine) => Promise<void> } | null;
  getConfig(): SubtitleConfig;
  setConfig(config: unknown): void;
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

function createInput(id: string, type: string, value: string, placeholder?: string): HTMLInputElement {
  const input = el("input", "prism-input") as HTMLInputElement;
  input.id = id;
  input.type = type;
  if (type === "number") input.inputMode = "decimal";
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  return input;
}

/** Escape a VFS path for use inside ffmpeg's subtitles= filter argument. */
function escapeSubtitlePath(path: string): string {
  // The subtitles filter uses libass which treats : [ ] ' \ as special
  return path.replace(/([\\':[\]])/g, "\\$1");
}

function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error("Unexpected FileReader result type"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── Module ──────────────────────────────────────────────────────────────────

export function createSubtitles(): SubtitleModule {
  let currentFile: FileInfo | null = null;
  let container: HTMLElement | null = null;
  let actionTabsEl: HTMLElement | null = null;
  let panelEl: HTMLElement | null = null;

  const config: SubtitleConfig = {
    action: "extract",
    trackIndex: 0,
    extractFormat: "srt",
    convertFormat: "vtt",
    fontSize: 24,
    marginV: 30,
    burnSource: "embedded",
    externalSubFile: null,
  };

  function suggestAction(file: FileInfo): SubtitleAction {
    if (file.category === "subtitle") return "convert";
    return "extract"; // video
  }

  const ACTIONS: { id: SubtitleAction; label: string; forCategory: FileInfo["category"][] }[] = [
    { id: "extract", label: "Extract",  forCategory: ["video"] },
    { id: "convert", label: "Convert",  forCategory: ["subtitle"] },
    { id: "burn",    label: "Burn In",  forCategory: ["video"] },
  ];

  // ── Action Tabs ──────────────────────────────────────────────────────────

  function renderActionTabs(parent: HTMLElement): void {
    actionTabsEl = el("div", "sub-action-tabs");

    for (const action of ACTIONS) {
      if (currentFile && !action.forCategory.includes(currentFile.category)) continue;

      const btn = el("button", "sub-tab", action.label);
      btn.dataset.action = action.id;
      if (action.id === config.action) btn.classList.add("sub-tab--active");

      btn.addEventListener("click", () => {
        config.action = action.id;
        actionTabsEl?.querySelectorAll(".sub-tab").forEach((t) => t.classList.remove("sub-tab--active"));
        btn.classList.add("sub-tab--active");
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
      case "extract": renderExtractPanel(panelEl); break;
      case "convert": renderConvertPanel(panelEl); break;
      case "burn":    renderBurnPanel(panelEl); break;
    }
  }

  function renderExtractPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "sub-hint",
      "Extract a subtitle track from the video container into a standalone file."));

    // Track index
    const trackGroup = el("div", "sub-field");
    trackGroup.appendChild(el("label", "sub-label", "Subtitle Track Index"));
    const trackInput = createInput("sub-track", "number", String(config.trackIndex), "0");
    trackInput.min = "0";
    trackInput.max = "10";
    trackInput.step = "1";
    trackInput.addEventListener("change", () => { config.trackIndex = parseInt(trackInput.value) || 0; });
    trackGroup.appendChild(trackInput);
    trackGroup.appendChild(el("p", "sub-hint", "0 = first subtitle track, 1 = second, etc."));
    parent.appendChild(trackGroup);

    // Output format
    const fmtGroup = el("div", "sub-field");
    fmtGroup.appendChild(el("label", "sub-label", "Output Format"));
    const fmtSelect = createSelect("sub-extract-fmt", [
      { value: "srt", label: "SRT" },
      { value: "vtt", label: "WebVTT" },
      { value: "ass", label: "ASS / SSA" },
    ], config.extractFormat);
    fmtSelect.addEventListener("change", () => { config.extractFormat = fmtSelect.value; });
    fmtGroup.appendChild(fmtSelect);
    parent.appendChild(fmtGroup);
  }

  function renderConvertPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "sub-hint",
      "Convert between subtitle formats (SRT, WebVTT, ASS)."));

    const fmtGroup = el("div", "sub-field");
    fmtGroup.appendChild(el("label", "sub-label", "Output Format"));
    const fmtSelect = createSelect("sub-convert-fmt", [
      { value: "srt", label: "SRT" },
      { value: "vtt", label: "WebVTT" },
      { value: "ass", label: "ASS / SSA" },
    ], config.convertFormat);
    fmtSelect.addEventListener("change", () => { config.convertFormat = fmtSelect.value; });
    fmtGroup.appendChild(fmtSelect);
    parent.appendChild(fmtGroup);
  }

  function renderBurnPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "sub-hint",
      "Hardcode subtitles into the video. This re-encodes the video with subtitles permanently baked in."));

    // Source selection
    const srcGroup = el("div", "sub-field");
    srcGroup.appendChild(el("label", "sub-label", "Subtitle Source"));
    const srcSelect = createSelect("sub-burn-src", [
      { value: "embedded", label: "Embedded (from video file)" },
      { value: "external", label: "External subtitle file" },
    ], config.burnSource);

    const fileDropZone = el("div", "sub-file-drop");
    fileDropZone.style.display = config.burnSource === "external" ? "" : "none";

    srcSelect.addEventListener("change", () => {
      config.burnSource = srcSelect.value as "embedded" | "external";
      fileDropZone.style.display = config.burnSource === "external" ? "" : "none";
    });
    srcGroup.appendChild(srcSelect);
    parent.appendChild(srcGroup);

    // External file drop zone
    const dropLabel = el("p", "sub-hint", config.externalSubFile ? `Selected: ${config.externalSubFile.name}` : "Drop a subtitle file here or click to browse");
    fileDropZone.appendChild(dropLabel);

    const fileInputEl = document.createElement("input");
    fileInputEl.type = "file";
    fileInputEl.accept = ".srt,.vtt,.ass,.ssa,.sub";
    fileInputEl.style.display = "none";

    fileInputEl.addEventListener("change", () => {
      const f = fileInputEl.files?.[0];
      if (f) {
        config.externalSubFile = f;
        dropLabel.textContent = `Selected: ${f.name}`;
      }
    });

    fileDropZone.addEventListener("click", () => fileInputEl.click());
    fileDropZone.addEventListener("dragover", (e) => { e.preventDefault(); });
    fileDropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const f = (e as DragEvent).dataTransfer?.files[0];
      if (f) {
        config.externalSubFile = f;
        dropLabel.textContent = `Selected: ${f.name}`;
      }
    });

    fileDropZone.appendChild(fileInputEl);
    parent.appendChild(fileDropZone);

    // Font size
    const sizeGroup = el("div", "sub-field");
    sizeGroup.appendChild(el("label", "sub-label", "Font Size"));
    const sizeSelect = createSelect("sub-font-size", [
      { value: "16", label: "Small (16)" },
      { value: "24", label: "Medium (24)" },
      { value: "32", label: "Large (32)" },
      { value: "42", label: "Extra Large (42)" },
    ], String(config.fontSize));
    sizeSelect.addEventListener("change", () => { config.fontSize = parseInt(sizeSelect.value); });
    sizeGroup.appendChild(sizeSelect);
    parent.appendChild(sizeGroup);

    // Margin
    const marginGroup = el("div", "sub-field");
    marginGroup.appendChild(el("label", "sub-label", "Bottom Margin (px)"));
    const marginInput = createInput("sub-margin", "number", String(config.marginV), "30");
    marginInput.min = "0";
    marginInput.max = "200";
    marginInput.step = "5";
    marginInput.addEventListener("change", () => { config.marginV = parseInt(marginInput.value) || 30; });
    marginGroup.appendChild(marginInput);
    parent.appendChild(marginGroup);
  }

  // ── Build ffmpeg command ─────────────────────────────────────────────────

  function build(): { args: string[]; outputName: string; prepare?: (engine: PrismEngine) => Promise<void> } | null {
    if (!currentFile) return null;

    const inputPath = `/input/${currentFile.name}`;
    const baseName = currentFile.name.replace(/\.[^.]+$/, "");

    switch (config.action) {
      case "extract": return buildExtract(inputPath, baseName);
      case "convert": return buildConvert(inputPath, baseName);
      case "burn":    return buildBurn(inputPath, baseName);
    }
  }

  function buildExtract(inputPath: string, baseName: string): { args: string[]; outputName: string } {
    const outputName = `${baseName}.${config.extractFormat}`;
    const outputPath = `/output/${outputName}`;

    const args = ["-i", inputPath, "-map", `0:s:${config.trackIndex}`, "-y", outputPath];
    return { args, outputName };
  }

  function buildConvert(inputPath: string, baseName: string): { args: string[]; outputName: string } {
    const outputName = `${baseName}.${config.convertFormat}`;
    const outputPath = `/output/${outputName}`;

    const args = ["-i", inputPath, "-y", outputPath];
    return { args, outputName };
  }

  function buildBurn(inputPath: string, baseName: string): { args: string[]; outputName: string; prepare?: (engine: PrismEngine) => Promise<void> } {
    // Detect input format to pick matching codec and container
    const inputExt = currentFile!.name.split(".").pop()?.toLowerCase() || "";
    const isWebM = inputExt === "webm";
    const vcodec = isWebM ? "libvpx-vp9" : "libx264";
    const crf = isWebM ? "33" : "23";
    const container = isWebM ? "webm" : "mp4";
    const acodec = isWebM ? "libopus" : "aac";

    const outputName = `${baseName}_burned.${container}`;
    const outputPath = `/output/${outputName}`;

    const codecArgs = ["-c:v", vcodec, "-crf", crf];
    if (!isWebM) codecArgs.push("-preset", "medium");
    if (isWebM) codecArgs.push("-b:v", "0");
    codecArgs.push("-c:a", acodec, "-b:a", "192k");
    if (!isWebM) codecArgs.push("-movflags", "+faststart");

    if (config.burnSource === "external" && config.externalSubFile) {
      const subFile = config.externalSubFile;
      const subFileName = subFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const subPath = `/input/${subFileName}`;

      // Use force_style for font size and margin; escape path for libass
      const vf = `subtitles=${escapeSubtitlePath(subPath)}:force_style='FontSize=${config.fontSize},MarginV=${config.marginV}'`;

      const args = ["-i", inputPath, "-vf", vf, ...codecArgs, "-y", outputPath];

      return {
        args,
        outputName,
        prepare: async (engine: PrismEngine) => {
          const data = await readFileAsUint8Array(subFile);
          await engine.writeFile(subPath, data);
        },
      };
    }

    // Embedded subtitles — escape path for libass
    const vf = `subtitles=${escapeSubtitlePath(inputPath)}:force_style='FontSize=${config.fontSize},MarginV=${config.marginV}'`;
    const args = ["-i", inputPath, "-vf", vf, ...codecArgs, "-y", outputPath];

    return { args, outputName };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    render(target: HTMLElement): void {
      container = target;
      container.innerHTML = "";
      renderActionTabs(container);
      panelEl = el("div", "sub-panel");
      container.appendChild(panelEl);
      renderPanel();
    },

    configure(file: FileInfo): void {
      currentFile = file;
      config.action = suggestAction(file);
      // Scale font size based on video resolution
      if (file.resolution) {
        const h = parseInt(file.resolution.split("x")[1]) || 0;
        if (h >= 2160) config.fontSize = 42;
        else if (h >= 1080) config.fontSize = 32;
        else if (h >= 720) config.fontSize = 24;
        else config.fontSize = 16;
      }
      if (container) {
        container.innerHTML = "";
        renderActionTabs(container);
        panelEl = el("div", "sub-panel");
        container.appendChild(panelEl);
        renderPanel();
      }
    },

    build,

    getConfig(): SubtitleConfig { return { ...config, externalSubFile: config.externalSubFile }; },

    setConfig(nextConfig: unknown): void {
      if (!isRecord(nextConfig)) return;

      const currentCategory = currentFile?.category ?? null;
      const allowedActions = currentCategory
        ? ACTIONS.filter((a) => a.forCategory.includes(currentCategory)).map((a) => a.id)
        : ACTIONS.map((a) => a.id);
      if (typeof nextConfig.action === "string") {
        const requested = nextConfig.action as SubtitleAction;
        if (allowedActions.includes(requested)) {
          config.action = requested;
        }
      }

      if (typeof nextConfig.trackIndex === "number" && Number.isFinite(nextConfig.trackIndex)) {
        config.trackIndex = Math.max(0, Math.floor(nextConfig.trackIndex));
      }

      if (nextConfig.extractFormat === "srt" || nextConfig.extractFormat === "vtt" || nextConfig.extractFormat === "ass") {
        config.extractFormat = nextConfig.extractFormat;
      }
      if (nextConfig.convertFormat === "srt" || nextConfig.convertFormat === "vtt" || nextConfig.convertFormat === "ass") {
        config.convertFormat = nextConfig.convertFormat;
      }

      if (typeof nextConfig.fontSize === "number" && Number.isFinite(nextConfig.fontSize)) {
        config.fontSize = Math.max(8, Math.round(nextConfig.fontSize));
      }
      if (typeof nextConfig.marginV === "number" && Number.isFinite(nextConfig.marginV)) {
        config.marginV = Math.max(0, Math.round(nextConfig.marginV));
      }
      if (nextConfig.burnSource === "embedded" || nextConfig.burnSource === "external") {
        config.burnSource = nextConfig.burnSource;
      }
      if (nextConfig.externalSubFile instanceof File || nextConfig.externalSubFile === null) {
        config.externalSubFile = nextConfig.externalSubFile;
      }

      if (container) {
        container.innerHTML = "";
        renderActionTabs(container);
        panelEl = el("div", "sub-panel");
        container.appendChild(panelEl);
        renderPanel();
      }
    },

    reset(): void {
      currentFile = null;
      config.action = "extract";
      config.trackIndex = 0;
      config.extractFormat = "srt";
      config.convertFormat = "vtt";
      config.fontSize = 24;
      config.marginV = 30;
      config.burnSource = "embedded";
      config.externalSubFile = null;
      if (panelEl) panelEl.innerHTML = "";
    },
  };
}
