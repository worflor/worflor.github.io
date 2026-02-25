// prism-workbench.ts — The Workbench module: section-based additive media processing.
// Two sections: Output (format/quality/resolution) + Adjustments (toggleable Trim/Rotate/Crop).
// Special output modes (GIF, Thumbnail, Extract Audio) are mutually exclusive with Output.

import type { FileInfo } from "./engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkbenchConfig {
  // Output
  outputFormat: string;
  quality: "compact" | "low" | "original" | "high" | "maximum";
  resolution: "original" | "1080p" | "720p" | "480p" | "360p" | "custom";
  customWidth: number;
  customHeight: number;
  // FPS
  fpsEnabled: boolean;
  fpsValue: number; // 24 | 25 | 30 | 60
  // Adjustments (additive toggles)
  trimEnabled: boolean;
  trimStart: string;
  trimEnd: string;
  trimExact: boolean;
  deinterlaceEnabled: boolean;
  deinterlaceMode: "yadif" | "bwdif";
  rotateEnabled: boolean;
  rotateMode: "90cw" | "90ccw" | "180" | "hflip" | "vflip";
  cropEnabled: boolean;
  cropAspect: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  padEnabled: boolean;
  padAspect: "16:9" | "9:16" | "4:3" | "3:4" | "1:1" | "21:9";
  padColor: string; // hex without #
  colorEnabled: boolean;
  colorBrightness: number;  // −1…1
  colorContrast: number;    // 0…2
  colorSaturation: number;  // 0…3
  colorGamma: number;       // 0.1…10
  denoiseEnabled: boolean;
  denoiseStrength: number;  // 0.5…6.0
  debandEnabled: boolean;
  debandStrength: number;   // 0.5…3.0
  sharpenEnabled: boolean;
  sharpenStrength: number;  // 0.1…2.0
  vignetteEnabled: boolean;
  vignetteIntensity: number; // 0.1…1.0
  fadeEnabled: boolean;
  fadeInDuration: number;   // seconds
  fadeOutDuration: number;  // seconds
  // Special output modes (mutually exclusive, null = normal convert)
  specialMode: null | "gif" | "thumbnail" | "extract-audio";
  // GIF settings
  gifStart: string;
  gifDuration: string;
  gifWidth: number;
  gifFps: number;
  // Thumbnail settings
  thumbTime: string;
  thumbGrid: boolean;
  thumbCount: number;
  // Extract Audio settings
  audioFormat: string;
  // Concat
  concatEnabled: boolean;
  concatMode: "demuxer" | "filter";
}

interface FormatOption {
  label: string;
  ext: string;
  vcodec?: string;
  acodec?: string;
  container: string;
}

// ─── Format definitions ──────────────────────────────────────────────────────

const VIDEO_FORMATS: FormatOption[] = [
  { label: "MP4 (H.264)", ext: "mp4", vcodec: "libx264", acodec: "aac", container: "mp4" },
  { label: "MP4 (H.265)", ext: "mp4-hevc", vcodec: "libx265", acodec: "aac", container: "mp4" },
  { label: "WebM (VP9)", ext: "webm", vcodec: "libvpx-vp9", acodec: "libopus", container: "webm" },
  { label: "WebM (VP8)", ext: "webm-vp8", vcodec: "libvpx", acodec: "libvorbis", container: "webm" },
  { label: "MKV (H.264)", ext: "mkv", vcodec: "libx264", acodec: "aac", container: "matroska" },
  { label: "MKV (H.265)", ext: "mkv-hevc", vcodec: "libx265", acodec: "aac", container: "matroska" },
];

const AUDIO_FORMATS: FormatOption[] = [
  { label: "MP3", ext: "mp3", acodec: "libmp3lame", container: "mp3" },
  { label: "AAC (M4A)", ext: "m4a", acodec: "aac", container: "ipod" },
  { label: "OGG (Vorbis)", ext: "ogg", acodec: "libvorbis", container: "ogg" },
  { label: "WAV", ext: "wav", acodec: "pcm_s16le", container: "wav" },
  { label: "FLAC", ext: "flac", acodec: "flac", container: "flac" },
  { label: "Opus", ext: "opus", acodec: "libopus", container: "opus" },
];

const IMAGE_FORMATS: FormatOption[] = [
  { label: "PNG", ext: "png", container: "image2" },
  { label: "JPEG", ext: "jpg", container: "image2" },
  { label: "WebP", ext: "webp", container: "webp" },
  { label: "BMP", ext: "bmp", container: "image2" },
  { label: "GIF (still)", ext: "gif", container: "gif" },
];

const EXTRACT_AUDIO_FORMATS: { label: string; ext: string; acodec: string; streamCopyFrom?: string[] }[] = [
  { label: "MP3", ext: "mp3", acodec: "libmp3lame" },
  { label: "M4A (AAC)", ext: "m4a", acodec: "copy", streamCopyFrom: ["aac"] },
  { label: "WAV", ext: "wav", acodec: "pcm_s16le" },
  { label: "FLAC", ext: "flac", acodec: "flac" },
  { label: "OGG (Vorbis)", ext: "ogg", acodec: "libvorbis" },
];

const RESOLUTION_OPTIONS: { label: string; value: string; height: number | null }[] = [
  { label: "Original", value: "original", height: null },
  { label: "1080p", value: "1080p", height: 1080 },
  { label: "720p", value: "720p", height: 720 },
  { label: "480p", value: "480p", height: 480 },
  { label: "360p", value: "360p", height: 360 },
];

const QUALITY_CRF: Record<string, Record<WorkbenchConfig["quality"], number>> = {
  libx264:       { compact: 30, low: 26, original: 23, high: 20, maximum: 18 },
  libx265:       { compact: 34, low: 31, original: 28, high: 25, maximum: 22 },
  "libvpx-vp9":  { compact: 42, low: 37, original: 33, high: 30, maximum: 27 },
  libvpx:        { compact: 28, low: 20, original: 12, high: 7, maximum: 4 },
};

const AUDIO_BITRATE: Record<WorkbenchConfig["quality"], string> = {
  compact: "128k",
  low: "160k",
  original: "192k",
  high: "256k",
  maximum: "320k",
};

const VIDEO_PRESET: Record<WorkbenchConfig["quality"], "veryfast" | "fast" | "medium" | "slow" | "slower"> = {
  compact: "veryfast",
  low: "fast",
  original: "medium",
  high: "slow",
  maximum: "slower",
};

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
  if (type === "number") {
    input.inputMode = "decimal";
  }
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function createSlider(
  id: string,
  min: number, max: number, step: number, value: number,
  display: (v: number) => string,
): { container: HTMLElement; input: HTMLInputElement } {
  const container = el("div", "wb-slider-row");
  const input = document.createElement("input");
  input.type = "range";
  input.className = "wb-slider";
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(Math.min(max, Math.max(min, value)));
  const valueEl = el("span", "wb-slider-value", display(parseFloat(input.value)));
  input.addEventListener("input", () => { valueEl.textContent = display(parseFloat(input.value)); });
  container.appendChild(input);
  container.appendChild(valueEl);
  return { container, input };
}

function createPills<T extends string>(
  options: { value: T; label: string }[],
  selected: T,
  onChange: (value: T) => void,
  wrap = false,
): HTMLElement {
  const group = el("div", wrap ? "wb-pills wb-pills--wrap" : "wb-pills");
  for (const opt of options) {
    const pill = el("button", `wb-pill${opt.value === selected ? " wb-pill--active" : ""}`, opt.label) as HTMLButtonElement;
    pill.type = "button";
    pill.dataset.value = opt.value;
    pill.addEventListener("click", () => {
      group.querySelectorAll(".wb-pill").forEach((p) => p.classList.remove("wb-pill--active"));
      pill.classList.add("wb-pill--active");
      onChange(opt.value);
    });
    group.appendChild(pill);
  }
  return group;
}

function formatDuration(sec: number | null): string {
  if (sec === null || !isFinite(sec)) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parseTimeToSeconds(time: string): number {
  const trimmed = time.trim();
  if (!trimmed) return 0;

  const asNum = Number(trimmed);
  if (isFinite(asNum)) return asNum;

  const parts = trimmed.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── Module ──────────────────────────────────────────────────────────────────

export interface WorkbenchModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): { args: string[]; outputName: string; prepare?: (engine: { writeFile(path: string, data: Uint8Array | string): Promise<void> }) => Promise<void>; multiFile?: boolean } | null;
  getConfig(): WorkbenchConfig;
  setConfig(config: unknown): void;
  reset(): void;
  setFileQueue(queue: { file: File; info: FileInfo }[]): void;
}

export function createWorkbench(): WorkbenchModule {
  let currentFile: FileInfo | null = null;
  let container: HTMLElement | null = null;
  let fileQueueRef: { file: File; info: FileInfo }[] = [];

  const config: WorkbenchConfig = {
    outputFormat: "mp4",
    quality: "original",
    resolution: "original",
    customWidth: 1920,
    customHeight: 1080,
    fpsEnabled: false,
    fpsValue: 30,
    trimEnabled: false,
    trimStart: "0",
    trimEnd: "",
    trimExact: false,
    deinterlaceEnabled: false,
    deinterlaceMode: "yadif",
    rotateEnabled: false,
    rotateMode: "90cw",
    cropEnabled: false,
    cropAspect: "1:1",
    padEnabled: false,
    padAspect: "16:9",
    padColor: "000000",
    colorEnabled: false,
    colorBrightness: 0,
    colorContrast: 1,
    colorSaturation: 1,
    colorGamma: 1,
    denoiseEnabled: false,
    denoiseStrength: 1.5,
    debandEnabled: false,
    debandStrength: 1.0,
    sharpenEnabled: false,
    sharpenStrength: 1.0,
    vignetteEnabled: false,
    vignetteIntensity: 0.35,
    fadeEnabled: false,
    fadeInDuration: 1,
    fadeOutDuration: 1,
    specialMode: null,
    gifStart: "0",
    gifDuration: "5",
    gifWidth: 480,
    gifFps: 15,
    thumbTime: "0",
    thumbGrid: false,
    thumbCount: 9,
    audioFormat: "mp3",
    concatEnabled: false,
    concatMode: "demuxer",
  };

  function getFormatsForFile(file: FileInfo): FormatOption[] {
    if (file.category === "audio") return AUDIO_FORMATS;
    if (file.category === "image") return IMAGE_FORMATS;
    return VIDEO_FORMATS;
  }

  // ── Render: section-based layout ────────────────────────────────────────

  function renderAll(): void {
    if (!container || !currentFile) return;
    container.innerHTML = "";

    renderOutputSection(container);
    renderAdjustmentsSection(container);

    if (currentFile.category === "video") {
      renderSpecialOutputsSection(container);
    }
  }

  // ── Output Section ──────────────────────────────────────────────────────

  function renderOutputSection(parent: HTMLElement): void {
    if (!currentFile) return;

    const section = el("div", "wb-section");
    if (config.specialMode) section.classList.add("wb-section--dimmed");
    section.id = "wb-output-section";

    const title = el("div", "wb-section-title", "Output");
    section.appendChild(title);

    const body = el("div", "wb-panel");

    const formats = getFormatsForFile(currentFile);
    const category = currentFile.category;
    const showResolution = category === "video" || category === "image";

    // Format select
    const formatGroup = el("div", "wb-field");
    formatGroup.appendChild(el("label", "wb-label", "Format"));
    const formatSelect = createSelect(
      "wb-format",
      formats.map((f) => ({ value: f.ext, label: f.label })),
      config.outputFormat,
    );
    formatSelect.disabled = config.specialMode !== null;
    formatSelect.addEventListener("change", () => {
      config.outputFormat = formatSelect.value;
    });
    formatGroup.appendChild(formatSelect);
    body.appendChild(formatGroup);

    // Quality pills
    const qualityGroup = el("div", "wb-field");
    qualityGroup.appendChild(el("label", "wb-label", "Quality"));
    const qualityDefs: { value: WorkbenchConfig["quality"]; label: string }[] = [
      { value: "compact", label: "Compact" },
      { value: "low", label: "Low" },
      { value: "original", label: "Original" },
      { value: "high", label: "High" },
      { value: "maximum", label: "Maximum" },
    ];
    const qualityPillsEl = createPills(
      qualityDefs,
      config.quality,
      (v) => { config.quality = v; },
    );
    if (config.specialMode !== null) {
      qualityPillsEl.querySelectorAll(".wb-pill").forEach((p) => ((p as HTMLButtonElement).disabled = true));
    }
    qualityGroup.appendChild(qualityPillsEl);
    body.appendChild(qualityGroup);

    // Resolution pills + custom dimensions (video + image)
    if (showResolution) {
      const resolutionGroup = el("div", "wb-field");
      resolutionGroup.appendChild(el("label", "wb-label", "Resolution"));

      const resolutionDefs: { value: WorkbenchConfig["resolution"]; label: string }[] = [
        {
          value: "original",
          label: currentFile?.resolution ? `Original (${currentFile.resolution})` : "Original",
        },
        { value: "1080p", label: "1080p" },
        { value: "720p", label: "720p" },
        { value: "480p", label: "480p" },
        { value: "360p", label: "360p" },
        { value: "custom", label: "Custom" },
      ];

      const resolutionPills = createPills(
        resolutionDefs,
        config.resolution,
        (value) => {
          config.resolution = value;
          customRow.style.display = value === "custom" ? "" : "none";
        },
        true,
      );
      if (config.specialMode !== null) {
        resolutionPills.querySelectorAll(".wb-pill").forEach((p) => ((p as HTMLButtonElement).disabled = true));
      }
      resolutionGroup.appendChild(resolutionPills);

      const customRow = el("div", "wb-field wb-field--row");
      customRow.style.display = config.resolution === "custom" ? "" : "none";

      const widthWrap = el("div", "wb-field");
      widthWrap.appendChild(el("label", "wb-label", "Width"));
      const widthInput = createInput("wb-resolution-width", "number", String(config.customWidth), "1920");
      widthInput.min = "16";
      widthInput.max = "8192";
      widthInput.step = "1";
      widthInput.disabled = config.specialMode !== null;
      widthInput.addEventListener("change", () => {
        config.customWidth = Math.max(16, Math.min(8192, Math.round(parseFloat(widthInput.value) || 1920)));
        widthInput.value = String(config.customWidth);
      });
      widthWrap.appendChild(widthInput);

      const heightWrap = el("div", "wb-field");
      heightWrap.appendChild(el("label", "wb-label", "Height"));
      const heightInput = createInput("wb-resolution-height", "number", String(config.customHeight), "1080");
      heightInput.min = "16";
      heightInput.max = "8192";
      heightInput.step = "1";
      heightInput.disabled = config.specialMode !== null;
      heightInput.addEventListener("change", () => {
        config.customHeight = Math.max(16, Math.min(8192, Math.round(parseFloat(heightInput.value) || 1080)));
        heightInput.value = String(config.customHeight);
      });
      heightWrap.appendChild(heightInput);

      customRow.appendChild(widthWrap);
      customRow.appendChild(heightWrap);
      resolutionGroup.appendChild(customRow);

      body.appendChild(resolutionGroup);
    }

    // FPS control (video only)
    if (category === "video") {
      const fpsRow = el("div", "wb-field");
      const fpsHeader = el("div", "wb-fps-header");
      const fpsLabel = el("label", "wb-toggle-label");
      const fpsCheck = document.createElement("input");
      fpsCheck.type = "checkbox";
      fpsCheck.checked = config.fpsEnabled;
      fpsCheck.disabled = config.specialMode !== null;
      fpsCheck.addEventListener("change", () => {
        config.fpsEnabled = fpsCheck.checked;
        fpsNumInput.disabled = !fpsCheck.checked || config.specialMode !== null;
      });
      fpsLabel.appendChild(fpsCheck);
      fpsLabel.appendChild(document.createTextNode(" Lock Frame Rate"));
      fpsHeader.appendChild(fpsLabel);
      const fpsNumInput = createInput("wb-fps", "number", String(config.fpsValue), "30");
      fpsNumInput.min = "1";
      fpsNumInput.max = "120";
      fpsNumInput.step = "1";
      fpsNumInput.className = "prism-input wb-fps-input";
      fpsNumInput.disabled = !config.fpsEnabled || config.specialMode !== null;
      fpsNumInput.addEventListener("change", () => { config.fpsValue = Math.max(1, Math.min(120, parseInt(fpsNumInput.value) || 30)); });
      fpsHeader.appendChild(fpsNumInput);
      fpsHeader.appendChild(el("span", "wb-fps-unit", "fps"));
      fpsRow.appendChild(fpsHeader);
      body.appendChild(fpsRow);
    }

    section.appendChild(body);
    parent.appendChild(section);
  }

  // ── Adjustments Section ─────────────────────────────────────────────────

  function renderAdjustmentsSection(parent: HTMLElement): void {
    if (!currentFile) return;

    const category = currentFile.category;
    const hasTrim = category === "video" || category === "audio";
    const hasDeinterlace = category === "video";
    const hasRotate = category === "video" || category === "image";
    const hasCrop = category === "video" || category === "image";
    const hasPad = category === "video" || category === "image";
    const hasColor = category === "video" || category === "image";
    const hasDenoise = category === "video" || category === "image";
    const hasDeband = category === "video" || category === "image";
    const hasSharpen = category === "video" || category === "image";
    const hasVignette = category === "video" || category === "image";
    const hasFade = category === "video";

    if (!hasTrim && !hasRotate && !hasCrop) return;

    const section = el("div", "wb-section");
    const title = el("div", "wb-section-title", "Adjustments");
    section.appendChild(title);

    // Render order: Trim → Deinterlace → Rotate → Crop → Pad → Color → Denoise → Deband → Sharpen → Vignette → Fade
    if (hasTrim) renderTrimToggle(section);
    if (hasDeinterlace) renderDeinterlaceToggle(section);
    if (hasRotate) renderRotateToggle(section);
    if (hasCrop) renderCropToggle(section);
    if (hasPad) renderPadToggle(section);
    if (hasColor) renderColorToggle(section);
    if (hasDenoise) renderDenoiseToggle(section);
    if (hasDeband) renderDebandToggle(section);
    if (hasSharpen) renderSharpenToggle(section);
    if (hasVignette) renderVignetteToggle(section);
    if (hasFade) renderFadeToggle(section);

    // Concat toggle (only when 2+ files in queue)
    if (fileQueueRef.length >= 2) renderConcatToggle(section);

    parent.appendChild(section);
  }

  function renderTrimToggle(parent: HTMLElement): void {
    if (!currentFile) return;

    const row = el("div", `wb-toggle-row${config.trimEnabled ? " wb-toggle-row--active" : ""}`);

    // Header with checkbox
    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.trimEnabled;
    check.addEventListener("change", () => {
      config.trimEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);

    const label = el("span", "wb-toggle-name", "Trim");
    header.appendChild(label);

    // Always show duration for context; show trim range when active
    if (currentFile.duration !== null) {
      const hintText = config.trimEnabled
        ? `${config.trimStart || "0"} → ${config.trimEnd || formatDuration(currentFile.duration)}`
        : formatDuration(currentFile.duration);
      header.appendChild(el("span", "wb-toggle-hint", hintText));
    }

    row.appendChild(header);

    // Options (shown when enabled)
    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.trimEnabled ? "" : "none";

    if (currentFile.duration !== null) {
      const durationHint = el("p", "wb-hint", `${formatDuration(currentFile.duration)} total`);
      opts.appendChild(durationHint);
    }

    const startGroup = el("div", "wb-field");
    startGroup.appendChild(el("label", "wb-label", "Start"));
    const startInput = createInput("wb-trim-start", "text", config.trimStart, "0:00");
    startInput.addEventListener("change", () => { config.trimStart = startInput.value; });
    startGroup.appendChild(startInput);
    opts.appendChild(startGroup);

    const endGroup = el("div", "wb-field");
    endGroup.appendChild(el("label", "wb-label", "End"));
    const endInput = createInput("wb-trim-end", "text", config.trimEnd, formatDuration(currentFile.duration) || "end");
    endInput.addEventListener("change", () => { config.trimEnd = endInput.value; });
    endGroup.appendChild(endInput);
    opts.appendChild(endGroup);

    const exactGroup = el("div", "wb-field wb-field--row");
    const exactLabel = el("label", "wb-toggle-label");
    const exactCheck = document.createElement("input");
    exactCheck.type = "checkbox";
    exactCheck.id = "wb-trim-exact";
    exactCheck.checked = config.trimExact;
    exactCheck.addEventListener("change", () => { config.trimExact = exactCheck.checked; });
    exactLabel.appendChild(exactCheck);
    exactLabel.appendChild(document.createTextNode(" Frame-accurate"));
    exactGroup.appendChild(exactLabel);
    const exactHint = el("p", "wb-hint", "Re-encodes for precise timing. Slower but exact.");
    exactGroup.appendChild(exactHint);
    opts.appendChild(exactGroup);

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderRotateToggle(parent: HTMLElement): void {
    const rotateLabels: Record<string, string> = {
      "90cw": "90° CW", "90ccw": "90° CCW", "180": "180°", "hflip": "Flip H", "vflip": "Flip V",
    };
    const row = el("div", `wb-toggle-row${config.rotateEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.rotateEnabled;
    check.addEventListener("change", () => {
      config.rotateEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Rotate / Flip"));
    if (config.rotateEnabled) {
      header.appendChild(el("span", "wb-toggle-hint", rotateLabels[config.rotateMode] ?? config.rotateMode));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.rotateEnabled ? "" : "none";

    opts.appendChild(createPills(
      [
        { value: "90cw",  label: "90° CW" },
        { value: "90ccw", label: "90° CCW" },
        { value: "180",   label: "180°" },
        { value: "hflip", label: "Flip H" },
        { value: "vflip", label: "Flip V" },
      ] as { value: WorkbenchConfig["rotateMode"]; label: string }[],
      config.rotateMode,
      (v) => { config.rotateMode = v; },
    ));

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderCropToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.cropEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.cropEnabled;
    check.addEventListener("change", () => {
      config.cropEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
      // Mutually exclusive with pad
      if (check.checked && config.padEnabled) {
        config.padEnabled = false;
        renderAll();
      }
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Crop"));
    if (config.cropEnabled) {
      header.appendChild(el("span", "wb-toggle-hint", config.cropAspect));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.cropEnabled ? "" : "none";

    opts.appendChild(createPills(
      [
        { value: "16:9", label: "16:9" },
        { value: "9:16", label: "9:16" },
        { value: "1:1",  label: "1:1" },
        { value: "4:3",  label: "4:3" },
        { value: "3:4",  label: "3:4" },
      ] as { value: WorkbenchConfig["cropAspect"]; label: string }[],
      config.cropAspect,
      (v) => { config.cropAspect = v; },
    ));

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderDeinterlaceToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.deinterlaceEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.deinterlaceEnabled;
    check.addEventListener("change", () => {
      config.deinterlaceEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Deinterlace"));
    if (config.deinterlaceEnabled) {
      header.appendChild(el("span", "wb-toggle-hint", config.deinterlaceMode));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.deinterlaceEnabled ? "" : "none";

    opts.appendChild(createPills(
      [
        { value: "yadif", label: "yadif — fast" },
        { value: "bwdif", label: "bwdif — quality" },
      ] as { value: WorkbenchConfig["deinterlaceMode"]; label: string }[],
      config.deinterlaceMode,
      (v) => { config.deinterlaceMode = v; },
    ));

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderPadToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.padEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.padEnabled;
    check.addEventListener("change", () => {
      config.padEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
      // Mutually exclusive with crop
      if (check.checked && config.cropEnabled) {
        config.cropEnabled = false;
        renderAll();
      }
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Letterbox"));
    if (config.padEnabled) {
      header.appendChild(el("span", "wb-toggle-hint", config.padAspect));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.padEnabled ? "" : "none";

    opts.appendChild(createPills(
      [
        { value: "16:9", label: "16:9" },
        { value: "9:16", label: "9:16" },
        { value: "4:3",  label: "4:3" },
        { value: "3:4",  label: "3:4" },
        { value: "1:1",  label: "1:1" },
        { value: "21:9", label: "21:9" },
      ] as { value: WorkbenchConfig["padAspect"]; label: string }[],
      config.padAspect,
      (v) => { config.padAspect = v; },
    ));

    const colorGroup = el("div", "wb-field");
    colorGroup.appendChild(el("label", "wb-label", "Background"));
    const colorPickerRow = el("div", "wb-color-picker-row");
    const colorPicker = document.createElement("input");
    colorPicker.type = "color";
    colorPicker.className = "wb-color-picker";
    colorPicker.id = "wb-pad-color";
    colorPicker.value = `#${config.padColor.padStart(6, "0")}`;
    colorPicker.addEventListener("input", () => { config.padColor = colorPicker.value.slice(1); });
    const colorLabel = el("span", "wb-color-picker-label", `#${config.padColor.padStart(6, "0")}`);
    colorPicker.addEventListener("input", () => { colorLabel.textContent = colorPicker.value; });
    colorPickerRow.appendChild(colorPicker);
    colorPickerRow.appendChild(colorLabel);
    colorGroup.appendChild(colorPickerRow);
    opts.appendChild(colorGroup);

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderColorToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.colorEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.colorEnabled;
    check.addEventListener("change", () => {
      config.colorEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Color"));
    if (config.colorEnabled) {
      const parts: string[] = [];
      if (config.colorBrightness !== 0)   parts.push(`☀ ${config.colorBrightness >= 0 ? "+" : ""}${config.colorBrightness.toFixed(2)}`);
      if (config.colorContrast !== 1)     parts.push(`◑ ${config.colorContrast.toFixed(2)}`);
      if (config.colorSaturation !== 1)   parts.push(`◉ ${config.colorSaturation.toFixed(2)}`);
      if (config.colorGamma !== 1)        parts.push(`γ ${config.colorGamma.toFixed(2)}`);
      if (parts.length > 0) header.appendChild(el("span", "wb-toggle-hint", parts.join("  ")));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.colorEnabled ? "" : "none";

    // Brightness
    const brightGroup = el("div", "wb-field");
    brightGroup.appendChild(el("label", "wb-label", "Brightness"));
    const { container: brightSlider, input: brightInput } = createSlider(
      "wb-color-brightness", -1, 1, 0.02, config.colorBrightness,
      (v) => (v >= 0 ? "+" : "") + v.toFixed(2),
    );
    brightInput.addEventListener("input", () => { config.colorBrightness = parseFloat(brightInput.value); });
    brightGroup.appendChild(brightSlider);
    opts.appendChild(brightGroup);

    // Contrast
    const contrastGroup = el("div", "wb-field");
    contrastGroup.appendChild(el("label", "wb-label", "Contrast"));
    const { container: contrastSlider, input: contrastInput } = createSlider(
      "wb-color-contrast", 0, 2, 0.02, config.colorContrast,
      (v) => v.toFixed(2),
    );
    contrastInput.addEventListener("input", () => { config.colorContrast = parseFloat(contrastInput.value); });
    contrastGroup.appendChild(contrastSlider);
    opts.appendChild(contrastGroup);

    // Saturation
    const satGroup = el("div", "wb-field");
    satGroup.appendChild(el("label", "wb-label", "Saturation"));
    const { container: satSlider, input: satInput } = createSlider(
      "wb-color-saturation", 0, 3, 0.02, config.colorSaturation,
      (v) => v.toFixed(2),
    );
    satInput.addEventListener("input", () => { config.colorSaturation = parseFloat(satInput.value); });
    satGroup.appendChild(satSlider);
    opts.appendChild(satGroup);

    // Gamma
    const gammaGroup = el("div", "wb-field");
    gammaGroup.appendChild(el("label", "wb-label", "Gamma"));
    const { container: gammaSlider, input: gammaInput } = createSlider(
      "wb-color-gamma", 0.1, 4, 0.05, Math.min(config.colorGamma, 4),
      (v) => v.toFixed(2),
    );
    gammaInput.addEventListener("input", () => { config.colorGamma = parseFloat(gammaInput.value); });
    gammaGroup.appendChild(gammaSlider);
    opts.appendChild(gammaGroup);

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderSharpenToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.sharpenEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.sharpenEnabled;
    check.addEventListener("change", () => {
      config.sharpenEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Sharpen"));
    if (config.sharpenEnabled) {
      header.appendChild(el("span", "wb-toggle-hint", config.sharpenStrength.toFixed(2)));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.sharpenEnabled ? "" : "none";

    const strengthGroup = el("div", "wb-field");
    strengthGroup.appendChild(el("label", "wb-label", "Strength"));
    const { container: strengthSlider, input: strengthInput } = createSlider(
      "wb-sharpen-strength", 0.1, 2.0, 0.05, config.sharpenStrength,
      (v) => v.toFixed(2),
    );
    strengthInput.addEventListener("input", () => { config.sharpenStrength = parseFloat(strengthInput.value); });
    strengthGroup.appendChild(strengthSlider);
    opts.appendChild(strengthGroup);

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderDenoiseToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.denoiseEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.denoiseEnabled;
    check.addEventListener("change", () => {
      config.denoiseEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Denoise"));
    if (config.denoiseEnabled) {
      header.appendChild(el("span", "wb-toggle-hint", config.denoiseStrength.toFixed(1)));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.denoiseEnabled ? "" : "none";

    const strengthGroup = el("div", "wb-field");
    strengthGroup.appendChild(el("label", "wb-label", "Strength"));
    const { container: strengthSlider, input: strengthInput } = createSlider(
      "wb-denoise-strength", 0.5, 6.0, 0.1, config.denoiseStrength,
      (v) => v.toFixed(1),
    );
    strengthInput.addEventListener("input", () => { config.denoiseStrength = parseFloat(strengthInput.value); });
    strengthGroup.appendChild(strengthSlider);
    opts.appendChild(strengthGroup);

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderDebandToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.debandEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.debandEnabled;
    check.addEventListener("change", () => {
      config.debandEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Deband"));
    if (config.debandEnabled) {
      header.appendChild(el("span", "wb-toggle-hint", config.debandStrength.toFixed(1)));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.debandEnabled ? "" : "none";

    const strengthGroup = el("div", "wb-field");
    strengthGroup.appendChild(el("label", "wb-label", "Strength"));
    const { container: strengthSlider, input: strengthInput } = createSlider(
      "wb-deband-strength", 0.5, 3.0, 0.1, config.debandStrength,
      (v) => v.toFixed(1),
    );
    strengthInput.addEventListener("input", () => { config.debandStrength = parseFloat(strengthInput.value); });
    strengthGroup.appendChild(strengthSlider);
    opts.appendChild(strengthGroup);

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderVignetteToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.vignetteEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.vignetteEnabled;
    check.addEventListener("change", () => {
      config.vignetteEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Vignette"));
    if (config.vignetteEnabled) {
      header.appendChild(el("span", "wb-toggle-hint", config.vignetteIntensity.toFixed(2)));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.vignetteEnabled ? "" : "none";

    const intensityGroup = el("div", "wb-field");
    intensityGroup.appendChild(el("label", "wb-label", "Intensity"));
    const { container: intensitySlider, input: intensityInput } = createSlider(
      "wb-vignette-intensity", 0.1, 1.0, 0.05, config.vignetteIntensity,
      (v) => v.toFixed(2),
    );
    intensityInput.addEventListener("input", () => { config.vignetteIntensity = parseFloat(intensityInput.value); });
    intensityGroup.appendChild(intensitySlider);
    opts.appendChild(intensityGroup);

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderFadeToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.fadeEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.fadeEnabled;
    check.addEventListener("change", () => {
      config.fadeEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Fade"));
    if (config.fadeEnabled) {
      const inStr = config.fadeInDuration > 0 ? `↑${config.fadeInDuration.toFixed(1)}s` : "";
      const outStr = config.fadeOutDuration > 0 ? `↓${config.fadeOutDuration.toFixed(1)}s` : "";
      const fadeHint = [inStr, outStr].filter(Boolean).join("  ");
      if (fadeHint) header.appendChild(el("span", "wb-toggle-hint", fadeHint));
    }
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.fadeEnabled ? "" : "none";

    const inGroup = el("div", "wb-field");
    inGroup.appendChild(el("label", "wb-label", "Fade In"));
    const { container: inSlider, input: inInput } = createSlider(
      "wb-fade-in", 0, 30, 0.5, config.fadeInDuration,
      (v) => v === 0 ? "off" : `${v.toFixed(1)}s`,
    );
    inInput.addEventListener("input", () => { config.fadeInDuration = parseFloat(inInput.value); });
    inGroup.appendChild(inSlider);
    opts.appendChild(inGroup);

    const outGroup = el("div", "wb-field");
    outGroup.appendChild(el("label", "wb-label", "Fade Out"));
    const { container: outSlider, input: outInput } = createSlider(
      "wb-fade-out", 0, 30, 0.5, config.fadeOutDuration,
      (v) => v === 0 ? "off" : `${v.toFixed(1)}s`,
    );
    outInput.addEventListener("input", () => { config.fadeOutDuration = parseFloat(outInput.value); });
    outGroup.appendChild(outSlider);
    opts.appendChild(outGroup);

    row.appendChild(opts);
    parent.appendChild(row);
  }

  function renderConcatToggle(parent: HTMLElement): void {
    const row = el("div", `wb-toggle-row${config.concatEnabled ? " wb-toggle-row--active" : ""}`);

    const header = el("label", "wb-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = config.concatEnabled;
    check.addEventListener("change", () => {
      config.concatEnabled = check.checked;
      row.classList.toggle("wb-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", `Join ${fileQueueRef.length} Files`));
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.concatEnabled ? "" : "none";

    const modeGroup = el("div", "wb-field");
    modeGroup.appendChild(el("label", "wb-label", "Mode"));
    modeGroup.appendChild(createPills(
      [
        { value: "demuxer", label: "Fast join" },
        { value: "filter",  label: "Re-encode" },
      ] as { value: WorkbenchConfig["concatMode"]; label: string }[],
      config.concatMode,
      (v) => { config.concatMode = v; },
    ));
    opts.appendChild(modeGroup);

    // Warning for demuxer mode with mixed formats
    if (config.concatMode === "demuxer" && fileQueueRef.length >= 2) {
      const exts = new Set(fileQueueRef.map((f) => f.info.name.split(".").pop()?.toLowerCase()));
      if (exts.size > 1) {
        const warn = el("p", "wb-hint", "Files have different formats. Fast join may fail \u2014 consider Re-encode mode.");
        warn.style.color = "#ff6b35";
        opts.appendChild(warn);
      }
    }

    row.appendChild(opts);
    parent.appendChild(row);
  }

  // ── Special Outputs Section ─────────────────────────────────────────────

  function renderSpecialOutputsSection(parent: HTMLElement): void {
    if (!currentFile || currentFile.category !== "video") return;

    const section = el("div", "wb-section");
    const title = el("div", "wb-section-title", "Special Outputs");
    section.appendChild(title);

    const btnRow = el("div", "wb-special-row");

    const modes: { id: WorkbenchConfig["specialMode"]; label: string }[] = [
      { id: "gif", label: "GIF" },
      { id: "thumbnail", label: "Thumbnail" },
      { id: "extract-audio", label: "Extract Audio" },
    ];

    for (const mode of modes) {
      const btn = el("button", `wb-special-btn${config.specialMode === mode.id ? " wb-special-btn--active" : ""}`, mode.label);
      btn.type = "button";
      btn.addEventListener("click", () => {
        config.specialMode = config.specialMode === mode.id ? null : mode.id;
        renderAll();
      });
      btnRow.appendChild(btn);
    }

    section.appendChild(btnRow);

    // Render settings for active special mode
    if (config.specialMode === "gif") renderGifSettings(section);
    if (config.specialMode === "thumbnail") renderThumbnailSettings(section);
    if (config.specialMode === "extract-audio") renderExtractAudioSettings(section);

    parent.appendChild(section);
  }

  function renderGifSettings(parent: HTMLElement): void {
    const opts = el("div", "wb-panel");

    const startGroup = el("div", "wb-field");
    startGroup.appendChild(el("label", "wb-label", "Start time"));
    const startInput = createInput("wb-gif-start", "text", config.gifStart, "0:00");
    startInput.addEventListener("change", () => { config.gifStart = startInput.value; });
    startGroup.appendChild(startInput);
    opts.appendChild(startGroup);

    const durGroup = el("div", "wb-field");
    durGroup.appendChild(el("label", "wb-label", "Duration"));
    const durInput = createInput("wb-gif-dur", "number", String(config.gifDuration), "5");
    durInput.addEventListener("change", () => { config.gifDuration = durInput.value; });
    durGroup.appendChild(durInput);
    opts.appendChild(durGroup);

    const widthGroup = el("div", "wb-field");
    widthGroup.appendChild(el("label", "wb-label", "Width"));
    const { container: widthSliderContainer, input: widthSliderInput } = createSlider(
      "wb-gif-width", 240, 1280, 8, config.gifWidth,
      (v) => `${v}px`,
    );
    widthSliderInput.addEventListener("input", () => { config.gifWidth = parseInt(widthSliderInput.value); });
    widthGroup.appendChild(widthSliderContainer);
    opts.appendChild(widthGroup);

    const fpsGroup = el("div", "wb-field");
    fpsGroup.appendChild(el("label", "wb-label", "Frame rate"));
    const { container: fpsSlider, input: fpsInput } = createSlider(
      "wb-gif-fps", 1, 30, 1, config.gifFps,
      (v) => `${v} fps`,
    );
    fpsInput.addEventListener("input", () => { config.gifFps = parseInt(fpsInput.value); });
    fpsGroup.appendChild(fpsSlider);
    opts.appendChild(fpsGroup);

    parent.appendChild(opts);
  }

  function renderThumbnailSettings(parent: HTMLElement): void {
    const opts = el("div", "wb-panel");

    const timeGroup = el("div", "wb-field");
    timeGroup.appendChild(el("label", "wb-label", "Timestamp"));
    const timeInput = createInput("wb-thumb-time", "text", config.thumbTime, "0:00");
    timeInput.addEventListener("change", () => { config.thumbTime = timeInput.value; });
    timeGroup.appendChild(timeInput);
    opts.appendChild(timeGroup);

    const gridGroup = el("div", "wb-field wb-field--row");
    const gridLabel = el("label", "wb-toggle-label");
    const gridCheck = document.createElement("input");
    gridCheck.type = "checkbox";
    gridCheck.id = "wb-thumb-grid";
    gridCheck.checked = config.thumbGrid;
    gridCheck.addEventListener("change", () => {
      config.thumbGrid = gridCheck.checked;
      countGroup.style.display = gridCheck.checked ? "" : "none";
    });
    gridLabel.appendChild(gridCheck);
    gridLabel.appendChild(document.createTextNode(" Contact sheet"));
    gridGroup.appendChild(gridLabel);
    opts.appendChild(gridGroup);

    const countGroup = el("div", "wb-field");
    countGroup.style.display = config.thumbGrid ? "" : "none";
    countGroup.appendChild(el("label", "wb-label", "Grid Size"));
    countGroup.appendChild(createPills(
      [
        { value: "4",  label: "2×2" },
        { value: "9",  label: "3×3" },
        { value: "16", label: "4×4" },
      ],
      String(config.thumbCount),
      (v) => { config.thumbCount = parseInt(v); },
    ));
    opts.appendChild(countGroup);

    parent.appendChild(opts);
  }

  function renderExtractAudioSettings(parent: HTMLElement): void {
    const opts = el("div", "wb-panel");

    const formatGroup = el("div", "wb-field");
    formatGroup.appendChild(el("label", "wb-label", "Audio Format"));
    const formatSelect = createSelect(
      "wb-audio-format",
      EXTRACT_AUDIO_FORMATS.map((f) => ({ value: f.ext, label: f.label })),
      config.audioFormat,
    );
    formatSelect.addEventListener("change", () => { config.audioFormat = formatSelect.value; });
    formatGroup.appendChild(formatSelect);
    opts.appendChild(formatGroup);

    const qualityGroup = el("div", "wb-field");
    qualityGroup.appendChild(el("label", "wb-label", "Quality (when re-encoding)"));
    const audioQPills = el("div", "wb-quality-pills");
    const audioQDefs: { value: WorkbenchConfig["quality"]; label: string; hint: string }[] = [
      { value: "compact", label: "128k", hint: "" },
      { value: "low", label: "160k", hint: "" },
      { value: "original", label: "192k", hint: "" },
      { value: "high", label: "256k", hint: "" },
      { value: "maximum", label: "320k", hint: "" },
    ];
    for (const opt of audioQDefs) {
      const pill = el("button", `wb-quality-pill${config.quality === opt.value ? " wb-quality-pill--active" : ""}`, opt.label);
      pill.type = "button";
      pill.addEventListener("click", () => {
        config.quality = opt.value;
        audioQPills.querySelectorAll(".wb-quality-pill").forEach((p) => p.classList.remove("wb-quality-pill--active"));
        pill.classList.add("wb-quality-pill--active");
      });
      audioQPills.appendChild(pill);
    }
    qualityGroup.appendChild(audioQPills);
    opts.appendChild(qualityGroup);

    parent.appendChild(opts);
  }

  // ── Build ffmpeg command ─────────────────────────────────────────────────

  function build(): { args: string[]; outputName: string; prepare?: (engine: { writeFile(path: string, data: Uint8Array | string): Promise<void> }) => Promise<void>; multiFile?: boolean } | null {
    if (!currentFile) return null;

    const inputPath = `/input/${currentFile.name}`;

    // Special modes override everything
    if (config.specialMode === "gif") return buildGif(inputPath);
    if (config.specialMode === "thumbnail") return buildThumbnail(inputPath);
    if (config.specialMode === "extract-audio") return buildExtractAudio(inputPath);

    // Normal mode: unified convert + adjustments
    return buildUnified(inputPath);
  }

  function buildUnified(inputPath: string): { args: string[]; outputName: string; prepare?: (engine: { writeFile(path: string, data: Uint8Array | string): Promise<void> }) => Promise<void>; multiFile?: boolean } | null {
    if (!currentFile) return null;

    // ── Concat build — completely separate path ──────────────────
    if (config.concatEnabled && fileQueueRef.length >= 2) {
      return buildConcat();
    }

    const category = currentFile.category;
    const formats = getFormatsForFile(currentFile);
    const fmt = formats.find((f) => f.ext === config.outputFormat) || formats[0];
    const baseName = currentFile.name.replace(/\.[^.]+$/, "");
    const fileExt = fmt.ext === "webm-vp8" ? "webm" : fmt.ext === "mp4-hevc" ? "mp4" : fmt.ext === "mkv-hevc" ? "mkv" : fmt.ext;

    // Build suffix from active adjustments
    const suffixParts: string[] = [];
    if (config.trimEnabled) suffixParts.push("trimmed");
    if (config.deinterlaceEnabled) suffixParts.push("deinterlaced");
    if (config.rotateEnabled) suffixParts.push("rotated");
    if (config.cropEnabled) suffixParts.push("cropped");
    if (config.padEnabled) suffixParts.push("padded");
    if (config.colorEnabled) suffixParts.push("color");
    if (config.denoiseEnabled) suffixParts.push("denoise");
    if (config.debandEnabled) suffixParts.push("deband");
    if (config.sharpenEnabled) suffixParts.push("sharp");
    if (config.vignetteEnabled) suffixParts.push("vignette");
    if (config.fadeEnabled) suffixParts.push("faded");
    if (config.fpsEnabled) suffixParts.push(`${config.fpsValue}fps`);
    const suffix = suffixParts.length > 0 ? `_${suffixParts.join("_")}` : "";

    const outputName = `${baseName}${suffix}.${fileExt}`;
    const outputPath = `/output/${outputName}`;

    // Determine if we need to re-encode
    const inputExt = currentFile.name.split(".").pop()?.toLowerCase() || "";
    const sameFormat = inputExt === fileExt || (inputExt === "webm" && fmt.ext === "webm-vp8");

    // No-change fast path: same format, no adjustments — stream-copy everything
    const noChanges = !config.trimEnabled && !config.rotateEnabled && !config.cropEnabled &&
      !config.deinterlaceEnabled && !config.padEnabled && !config.colorEnabled &&
      !config.denoiseEnabled && !config.debandEnabled && !config.sharpenEnabled && !config.vignetteEnabled && !config.fadeEnabled && !config.fpsEnabled &&
      config.resolution === "original" && sameFormat;
    if (noChanges) {
      return { args: ["-i", inputPath, "-c", "copy", "-y", outputPath], outputName };
    }

    const hasVisualFilters = config.rotateEnabled || config.cropEnabled || config.deinterlaceEnabled ||
      config.padEnabled || config.colorEnabled || config.denoiseEnabled || config.debandEnabled || config.sharpenEnabled || config.vignetteEnabled ||
      config.fadeEnabled || config.fpsEnabled || config.resolution !== "original";

    const trimOnly = config.trimEnabled && !hasVisualFilters &&
      sameFormat && !config.trimExact;

    const args: string[] = [];

    // Trim: if not frame-accurate, seek before -i for speed
    if (config.trimEnabled && !config.trimExact) {
      const startSec = parseTimeToSeconds(config.trimStart);
      if (startSec > 0) args.push("-ss", String(startSec));
    }

    args.push("-i", inputPath);

    // Trim: if frame-accurate, seek after -i
    if (config.trimEnabled && config.trimExact) {
      const startSec = parseTimeToSeconds(config.trimStart);
      if (startSec > 0) args.push("-ss", String(startSec));
      if (config.trimEnd) {
        const endSec = parseTimeToSeconds(config.trimEnd);
        args.push("-to", String(endSec));
      }
    } else if (config.trimEnabled && config.trimEnd) {
      const startSec = parseTimeToSeconds(config.trimStart);
      const endSec = parseTimeToSeconds(config.trimEnd);
      const duration = endSec - startSec;
      if (duration > 0) args.push("-t", String(duration));
    }

    // Stream-copy fast path: trim-only with same format
    if (trimOnly) {
      args.push("-c", "copy");
      args.push("-y", outputPath);
      return { args, outputName };
    }

    // ── Build -vf chain ──────────────────────────────────────────────
    // Order: yadif/bwdif → rotate → crop → scale → fps → pad → eq → unsharp → fade
    const vfParts: string[] = [];

    // 1. Deinterlace — must be first (operates on interlaced fields)
    if (config.deinterlaceEnabled && category === "video") {
      vfParts.push(config.deinterlaceMode);
    }

    // 2. Rotate / Flip
    if (config.rotateEnabled && (category === "video" || category === "image")) {
      const vfMap: Record<string, string> = {
        "90cw":  "transpose=1",
        "90ccw": "transpose=2",
        "180":   "transpose=1,transpose=1",
        "hflip": "hflip",
        "vflip": "vflip",
      };
      const rotateVf = vfMap[config.rotateMode] || "transpose=1";
      vfParts.push(rotateVf);
    }

    // 3. Crop
    if (config.cropEnabled && (category === "video" || category === "image")) {
      const aspectMap: Record<string, string> = {
        "1:1":  "crop=min(iw\\,ih):min(iw\\,ih)",
        "16:9": "crop=min(iw\\,ih*16/9):min(ih\\,iw*9/16)",
        "9:16": "crop=min(iw\\,ih*9/16):min(ih\\,iw*16/9)",
        "4:3":  "crop=min(iw\\,ih*4/3):min(ih\\,iw*3/4)",
        "3:4":  "crop=min(iw\\,ih*3/4):min(ih\\,iw*4/3)",
      };
      vfParts.push(aspectMap[config.cropAspect] || aspectMap["1:1"]);
    }

    // 4. Resolution scaling
    if (config.resolution === "custom" && (category === "video" || category === "image")) {
      const width = Math.max(16, Math.min(8192, Math.round(config.customWidth || 1920)));
      const height = Math.max(16, Math.min(8192, Math.round(config.customHeight || 1080)));
      if (category === "video") {
        const evenW = width % 2 === 0 ? width : width - 1;
        const evenH = height % 2 === 0 ? height : height - 1;
        vfParts.push(`scale=${Math.max(16, evenW)}:${Math.max(16, evenH)}`);
      } else {
        vfParts.push(`scale=${width}:${height}`);
      }
    } else {
      const resOpt = RESOLUTION_OPTIONS.find((r) => r.value === config.resolution);
      if (resOpt && resOpt.height !== null && (category === "video" || category === "image")) {
        vfParts.push(`scale=-2:${resOpt.height}`);
      }
    }

    // 5. FPS (after scale)
    if (config.fpsEnabled && category === "video") {
      vfParts.push(`fps=${config.fpsValue}`);
    }

    // 6. Pad / Letterbox (after scale, needs to know output dimensions)
    if (config.padEnabled && (category === "video" || category === "image")) {
      const padMap: Record<string, string> = {
        "16:9": "pad=max(iw\\,ih*16/9):max(ih\\,iw*9/16):(ow-iw)/2:(oh-ih)/2",
        "9:16": "pad=max(iw\\,ih*9/16):max(ih\\,iw*16/9):(ow-iw)/2:(oh-ih)/2",
        "4:3":  "pad=max(iw\\,ih*4/3):max(ih\\,iw*3/4):(ow-iw)/2:(oh-ih)/2",
        "3:4":  "pad=max(iw\\,ih*3/4):max(ih\\,iw*4/3):(ow-iw)/2:(oh-ih)/2",
        "1:1":  "pad=max(iw\\,ih):max(iw\\,ih):(ow-iw)/2:(oh-ih)/2",
        "21:9": "pad=max(iw\\,ih*21/9):max(ih\\,iw*9/21):(ow-iw)/2:(oh-ih)/2",
      };
      const padBase = padMap[config.padAspect] || padMap["16:9"];
      const color = config.padColor || "000000";
      vfParts.push(`${padBase}:color=0x${color}`);
    }

    // 7. Color / EQ (after spatial transforms)
    if (config.colorEnabled && (category === "video" || category === "image")) {
      const eqParts: string[] = [];
      if (config.colorBrightness !== 0) eqParts.push(`brightness=${config.colorBrightness}`);
      if (config.colorContrast !== 1) eqParts.push(`contrast=${config.colorContrast}`);
      if (config.colorSaturation !== 1) eqParts.push(`saturation=${config.colorSaturation}`);
      if (config.colorGamma !== 1) eqParts.push(`gamma=${config.colorGamma}`);
      if (eqParts.length > 0) {
        vfParts.push(`eq=${eqParts.join(":")}`);
      }
    }

    // 8. Denoise (after color, before sharpen)
    if (config.denoiseEnabled && (category === "video" || category === "image")) {
      const s = Math.max(0.5, Math.min(6, config.denoiseStrength));
      const lumaSpatial = s.toFixed(2);
      const chromaSpatial = (s * 0.75).toFixed(2);
      const lumaTmp = (s * 1.5).toFixed(2);
      const chromaTmp = (s * 1.125).toFixed(2);
      vfParts.push(`hqdn3d=${lumaSpatial}:${chromaSpatial}:${lumaTmp}:${chromaTmp}`);
    }

    // 9. Deband (after denoise)
    if (config.debandEnabled && (category === "video" || category === "image")) {
      const s = Math.max(0.5, Math.min(3, config.debandStrength));
      const threshold = (0.012 * s).toFixed(4);
      const range = Math.round(10 + s * 4);
      vfParts.push(`deband=1thr=${threshold}:2thr=${threshold}:3thr=${threshold}:4thr=${threshold}:range=${range}`);
    }

    // 10. Sharpen (after denoise/deband)
    if (config.sharpenEnabled && (category === "video" || category === "image")) {
      // Map 0.1–2.0 → luma_amount 0.05–1.5, kernel size 3 for light, 5 for heavier
      const s = config.sharpenStrength;
      const lumaAmount = parseFloat((s * 0.75).toFixed(3));
      const kernelSize = s <= 0.8 ? 3 : 5;
      vfParts.push(`unsharp=${kernelSize}:${kernelSize}:${lumaAmount}`);
    }

    // 11. Vignette (late-stage look)
    if (config.vignetteEnabled && (category === "video" || category === "image")) {
      const intensity = Math.max(0.1, Math.min(1, config.vignetteIntensity));
      const angle = (0.4 + intensity * 2.6).toFixed(2);
      vfParts.push(`vignette=angle=${angle}`);
    }

    // 12. Fade — must be LAST (operates on final pixel values)
    if (config.fadeEnabled && category === "video") {
      if (config.fadeInDuration > 0) {
        vfParts.push(`fade=t=in:d=${config.fadeInDuration}`);
      }
      if (config.fadeOutDuration > 0) {
        // Calculate fade-out start time
        let totalDuration = currentFile.duration ?? 0;
        if (config.trimEnabled) {
          const startSec = parseTimeToSeconds(config.trimStart);
          const endSec = config.trimEnd ? parseTimeToSeconds(config.trimEnd) : totalDuration;
          totalDuration = endSec - startSec;
        }
        const fadeOutStart = Math.max(0, totalDuration - config.fadeOutDuration);
        vfParts.push(`fade=t=out:st=${fadeOutStart}:d=${config.fadeOutDuration}`);
      }
    }

    // Apply -vf chain
    if (vfParts.length > 0) {
      args.push("-vf", vfParts.join(","));
    }

    // ── Image conversion ──────────────────────────────────────────────
    if (category === "image") {
      // Limit to a single frame to prevent multi-frame output
      args.push("-frames:v", "1");

      if (fileExt === "jpg" || fileExt === "jpeg") {
        const q = config.quality === "compact"
          ? "12"
          : config.quality === "low"
            ? "8"
            : config.quality === "original"
              ? "5"
              : config.quality === "high"
                ? "3"
                : "2";
        args.push("-q:v", q);
      }
      if (fileExt === "webp") {
        const q = config.quality === "compact"
          ? "45"
          : config.quality === "low"
            ? "65"
            : config.quality === "original"
              ? "80"
              : config.quality === "high"
                ? "90"
                : "95";
        args.push("-quality", q);
      }
      if (fileExt === "png") {
        args.push("-pred", "mixed");
      }

      args.push("-y", outputPath);
      return { args, outputName };
    }

    // ── Video codec ──────────────────────────────────────────────────
    if (fmt.vcodec && category === "video") {
      args.push("-c:v", fmt.vcodec);

      const crf = QUALITY_CRF[fmt.vcodec]?.[config.quality];
      if (crf !== undefined) {
        if (fmt.vcodec === "libvpx-vp9") {
          args.push("-crf", String(crf), "-b:v", "0");
        } else if (fmt.vcodec === "libvpx") {
          args.push("-qmin", String(crf), "-qmax", String(crf + 13), "-b:v", "0");
        } else {
          args.push("-crf", String(crf));
        }
      }

      if (fmt.vcodec === "libx264" || fmt.vcodec === "libx265") {
        const preset = VIDEO_PRESET[config.quality] || "medium";
        args.push("-preset", preset);
      }
    }

    // ── Audio codec ──────────────────────────────────────────────────
    if (fmt.acodec) {
      args.push("-c:a", fmt.acodec);
      if (
        category === "audio" ||
        fmt.acodec === "aac" ||
        fmt.acodec === "libmp3lame" ||
        fmt.acodec === "libvorbis" ||
        fmt.acodec === "libopus"
      ) {
        args.push("-b:a", AUDIO_BITRATE[config.quality] || "192k");
      }
    }

    if (fileExt === "mp4" || fileExt === "m4v") {
      args.push("-movflags", "+faststart");
    }

    args.push("-y", outputPath);
    return { args, outputName };
  }

  function buildConcat(): { args: string[]; outputName: string; prepare?: (engine: { writeFile(path: string, data: Uint8Array | string): Promise<void> }) => Promise<void>; multiFile: boolean } | null {
    if (fileQueueRef.length < 2) return null;

    const baseName = fileQueueRef[0].info.name.replace(/\.[^.]+$/, "");

    if (config.concatMode === "demuxer") {
      // Fast concat demuxer — stream copy, same format files
      const outputExt = fileQueueRef[0].info.name.split(".").pop()?.toLowerCase() || "mp4";
      const outputName = `${baseName}_joined.${outputExt}`;
      const outputPath = `/output/${outputName}`;

      const manifest = fileQueueRef
        .map((f) => `file '/input/${f.info.name}'`)
        .join("\n");

      return {
        args: ["-f", "concat", "-safe", "0", "-i", "/input/concat_list.txt", "-c", "copy", "-y", outputPath],
        outputName,
        multiFile: true,
        prepare: async (engine) => {
          const encoder = new TextEncoder();
          await engine.writeFile("/input/concat_list.txt", encoder.encode(manifest));
        },
      };
    } else {
      // Filter concat — re-encode
      const n = fileQueueRef.length;
      const outputName = `${baseName}_joined.mp4`;
      const outputPath = `/output/${outputName}`;

      const inputs: string[] = [];
      for (const f of fileQueueRef) {
        inputs.push("-i", `/input/${f.info.name}`);
      }

      const streamLabels = fileQueueRef.map((_, i) => `[${i}:v][${i}:a]`).join("");
      const filterComplex = `${streamLabels}concat=n=${n}:v=1:a=1[outv][outa]`;

      return {
        args: [...inputs, "-filter_complex", filterComplex, "-map", "[outv]", "-map", "[outa]",
          "-c:v", "libx264", "-crf", "23", "-preset", "medium",
          "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart",
          "-y", outputPath],
        outputName,
        multiFile: true,
      };
    }
  }

  function buildGif(inputPath: string): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const startSec = parseTimeToSeconds(config.gifStart);
    const duration = parseFloat(config.gifDuration) || 5;
    if (duration <= 0) return null;

    const baseName = currentFile.name.replace(/\.[^.]+$/, "");
    const outputName = `${baseName}.gif`;
    const outputPath = `/output/${outputName}`;

    const filters = `fps=${config.gifFps},scale=${config.gifWidth}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;

    const args = [
      "-ss", String(startSec),
      "-t", String(duration),
      "-i", inputPath,
      "-filter_complex", filters,
      "-y", outputPath,
    ];

    return { args, outputName };
  }

  function buildThumbnail(inputPath: string): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const baseName = currentFile.name.replace(/\.[^.]+$/, "");

    if (config.thumbGrid) {
      const count = config.thumbCount;
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      const duration = currentFile.duration ?? 60;
      const interval = duration / count;

      const outputName = `${baseName}_contact.png`;
      const outputPath = `/output/${outputName}`;

      const vf = `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval})',scale=320:-1,tile=${cols}x${rows}`;

      const args = [
        "-i", inputPath,
        "-vf", vf,
        "-frames:v", "1",
        "-vsync", "vfr",
        "-y", outputPath,
      ];

      return { args, outputName };
    } else {
      const outputName = `${baseName}_thumb.png`;
      const outputPath = `/output/${outputName}`;
      let timeSec = parseTimeToSeconds(config.thumbTime);

      if (currentFile.duration !== null && timeSec > currentFile.duration) {
        timeSec = Math.max(0, currentFile.duration - 1);
      }

      const args = [
        "-ss", String(timeSec),
        "-i", inputPath,
        "-frames:v", "1",
        "-y", outputPath,
      ];

      return { args, outputName };
    }
  }

  function buildExtractAudio(inputPath: string): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const baseName = currentFile.name.replace(/\.[^.]+$/, "");
    const fmtDef = EXTRACT_AUDIO_FORMATS.find((f) => f.ext === config.audioFormat) || EXTRACT_AUDIO_FORMATS[0];
    const outputName = `${baseName}.${fmtDef.ext}`;
    const outputPath = `/output/${outputName}`;

    const args = ["-i", inputPath];

    // Stream-copy only when the source codec matches the expected input
    const canCopy = fmtDef.acodec === "copy" &&
      fmtDef.streamCopyFrom &&
      currentFile.audioCodec !== null &&
      fmtDef.streamCopyFrom.includes(currentFile.audioCodec.toLowerCase());

    if (canCopy) {
      args.push("-vn", "-c:a", "copy");
    } else {
      // Fall back to re-encoding with the appropriate codec
      const codec = fmtDef.acodec === "copy" ? "aac" : fmtDef.acodec;
      args.push("-vn", "-c:a", codec);
      if (codec === "libmp3lame" || codec === "aac" || codec === "libvorbis" || codec === "libopus") {
        args.push("-b:a", AUDIO_BITRATE[config.quality] || "192k");
      }
    }

    if (fmtDef.ext === "m4a") {
      args.push("-movflags", "+faststart");
    }

    args.push("-y", outputPath);
    return { args, outputName };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    render(target: HTMLElement): void {
      container = target;
      container.innerHTML = "";
      renderAll();
    },

    configure(file: FileInfo): void {
      currentFile = file;
      // Default to the file's current format; fall back to first available
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const formats = getFormatsForFile(file);
      const match = formats.find((f) => f.ext === ext);
      config.outputFormat = match ? match.ext : formats[0].ext;
      config.trimEnd = formatDuration(file.duration);
      config.gifDuration = file.duration && file.duration < 5 ? String(Math.floor(file.duration)) : "5";
      config.specialMode = null;
      config.trimEnabled = false;
      config.deinterlaceEnabled = false;
      config.rotateEnabled = false;
      config.cropEnabled = false;
      config.padEnabled = false;
      config.colorEnabled = false;
      config.denoiseEnabled = false;
      config.debandEnabled = false;
      config.sharpenEnabled = false;
      config.vignetteEnabled = false;
      config.fadeEnabled = false;
      config.fpsEnabled = false;
      config.concatEnabled = false;

      if (container) {
        renderAll();
      }
    },

    build,

    getConfig(): WorkbenchConfig { return { ...config }; },

    setConfig(nextConfig: unknown): void {
      if (!isRecord(nextConfig)) return;

      const setBool = (key: keyof WorkbenchConfig): void => {
        if (typeof nextConfig[key] === "boolean") {
          (config[key] as boolean) = nextConfig[key] as boolean;
        }
      };
      const setNumber = (key: keyof WorkbenchConfig, min: number, max: number): void => {
        const value = nextConfig[key];
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        (config[key] as number) = Math.min(max, Math.max(min, value));
      };

      if (typeof nextConfig.outputFormat === "string") config.outputFormat = nextConfig.outputFormat;
      if (
        nextConfig.resolution === "original" ||
        nextConfig.resolution === "1080p" ||
        nextConfig.resolution === "720p" ||
        nextConfig.resolution === "480p" ||
        nextConfig.resolution === "360p" ||
        nextConfig.resolution === "custom"
      ) {
        config.resolution = nextConfig.resolution;
      }
      if (typeof nextConfig.trimStart === "string") config.trimStart = nextConfig.trimStart;
      if (typeof nextConfig.trimEnd === "string") config.trimEnd = nextConfig.trimEnd;
      if (typeof nextConfig.gifStart === "string") config.gifStart = nextConfig.gifStart;
      if (typeof nextConfig.gifDuration === "string") config.gifDuration = nextConfig.gifDuration;
      if (typeof nextConfig.thumbTime === "string") config.thumbTime = nextConfig.thumbTime;
      if (typeof nextConfig.audioFormat === "string") config.audioFormat = nextConfig.audioFormat;

      if (
        nextConfig.quality === "compact" ||
        nextConfig.quality === "low" ||
        nextConfig.quality === "original" ||
        nextConfig.quality === "high" ||
        nextConfig.quality === "maximum"
      ) {
        config.quality = nextConfig.quality;
      }
      if (nextConfig.deinterlaceMode === "yadif" || nextConfig.deinterlaceMode === "bwdif") {
        config.deinterlaceMode = nextConfig.deinterlaceMode;
      }
      if (
        nextConfig.rotateMode === "90cw" ||
        nextConfig.rotateMode === "90ccw" ||
        nextConfig.rotateMode === "180" ||
        nextConfig.rotateMode === "hflip" ||
        nextConfig.rotateMode === "vflip"
      ) {
        config.rotateMode = nextConfig.rotateMode;
      }
      if (
        nextConfig.cropAspect === "1:1" ||
        nextConfig.cropAspect === "16:9" ||
        nextConfig.cropAspect === "9:16" ||
        nextConfig.cropAspect === "4:3" ||
        nextConfig.cropAspect === "3:4"
      ) {
        config.cropAspect = nextConfig.cropAspect;
      }
      if (
        nextConfig.padAspect === "16:9" ||
        nextConfig.padAspect === "9:16" ||
        nextConfig.padAspect === "4:3" ||
        nextConfig.padAspect === "3:4" ||
        nextConfig.padAspect === "1:1" ||
        nextConfig.padAspect === "21:9"
      ) {
        config.padAspect = nextConfig.padAspect;
      }
      // sharpenStrength handled by setNumber below
      if (nextConfig.specialMode === null || nextConfig.specialMode === "gif" || nextConfig.specialMode === "thumbnail" || nextConfig.specialMode === "extract-audio") {
        config.specialMode = nextConfig.specialMode;
      }
      if (nextConfig.concatMode === "demuxer" || nextConfig.concatMode === "filter") {
        config.concatMode = nextConfig.concatMode;
      }

      if (typeof nextConfig.padColor === "string") {
        const cleaned = nextConfig.padColor.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
        if (cleaned.length > 0) config.padColor = cleaned.padStart(6, "0");
      }

      setBool("fpsEnabled");
      setBool("trimEnabled");
      setBool("trimExact");
      setBool("deinterlaceEnabled");
      setBool("rotateEnabled");
      setBool("cropEnabled");
      setBool("padEnabled");
      setBool("colorEnabled");
      setBool("denoiseEnabled");
      setBool("debandEnabled");
      setBool("sharpenEnabled");
      setBool("vignetteEnabled");
      setBool("fadeEnabled");
      setBool("thumbGrid");
      setBool("concatEnabled");

      setNumber("fpsValue", 1, 240);
      setNumber("customWidth", 16, 8192);
      setNumber("customHeight", 16, 8192);
      setNumber("colorBrightness", -1, 1);
      setNumber("colorContrast", 0, 2);
      setNumber("colorSaturation", 0, 3);
      setNumber("colorGamma", 0.1, 10);
      setNumber("denoiseStrength", 0.5, 6.0);
      setNumber("debandStrength", 0.5, 3.0);
      setNumber("sharpenStrength", 0.1, 2.0);
      setNumber("vignetteIntensity", 0.1, 1.0);
      setNumber("fadeInDuration", 0, 120);
      setNumber("fadeOutDuration", 0, 120);
      setNumber("gifWidth", 16, 4096);
      setNumber("gifFps", 1, 60);
      setNumber("thumbCount", 1, 100);

      if (currentFile) {
        const formats = getFormatsForFile(currentFile);
        if (!formats.some((format) => format.ext === config.outputFormat)) {
          const ext = currentFile.name.split(".").pop()?.toLowerCase() || "";
          const matching = formats.find((format) => format.ext === ext);
          config.outputFormat = matching ? matching.ext : formats[0].ext;
        }
        if (currentFile.category !== "video") {
          config.specialMode = null;
          config.fadeEnabled = false;
        }
      }
      if (fileQueueRef.length < 2) {
        config.concatEnabled = false;
      }

      if (container && currentFile) {
        renderAll();
      }
    },

    reset(): void {
      currentFile = null;
      fileQueueRef = [];
      config.outputFormat = "mp4";
      config.quality = "original";
      config.resolution = "original";
      config.customWidth = 1920;
      config.customHeight = 1080;
      config.fpsEnabled = false;
      config.fpsValue = 30;
      config.trimEnabled = false;
      config.trimStart = "0";
      config.trimEnd = "";
      config.trimExact = false;
      config.deinterlaceEnabled = false;
      config.deinterlaceMode = "yadif";
      config.rotateEnabled = false;
      config.rotateMode = "90cw";
      config.cropEnabled = false;
      config.cropAspect = "1:1";
      config.padEnabled = false;
      config.padAspect = "16:9";
      config.padColor = "000000";
      config.colorEnabled = false;
      config.colorBrightness = 0;
      config.colorContrast = 1;
      config.colorSaturation = 1;
      config.colorGamma = 1;
      config.denoiseEnabled = false;
      config.denoiseStrength = 1.5;
      config.debandEnabled = false;
      config.debandStrength = 1.0;
      config.sharpenEnabled = false;
      config.sharpenStrength = 1.0;
      config.vignetteEnabled = false;
      config.vignetteIntensity = 0.35;
      config.fadeEnabled = false;
      config.fadeInDuration = 1;
      config.fadeOutDuration = 1;
      config.specialMode = null;
      config.gifStart = "0";
      config.gifDuration = "5";
      config.gifWidth = 480;
      config.gifFps = 15;
      config.thumbTime = "0";
      config.thumbGrid = false;
      config.thumbCount = 9;
      config.audioFormat = "mp3";
      config.concatEnabled = false;
      config.concatMode = "demuxer";
      if (container) container.innerHTML = "";
    },

    setFileQueue(queue: { file: File; info: FileInfo }[]): void {
      fileQueueRef = queue;
      // Re-render to show/hide concat toggle
      if (container && currentFile) renderAll();
    },
  };
}
