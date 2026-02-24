// prism-workbench.ts — The Workbench module: section-based additive media processing.
// Two sections: Output (format/quality/resolution) + Adjustments (toggleable Trim/Rotate/Crop).
// Special output modes (GIF, Thumbnail, Extract Audio) are mutually exclusive with Output.

import type { FileInfo } from "./prism-engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkbenchConfig {
  // Output
  outputFormat: string;
  quality: "fast" | "balanced" | "quality";
  resolution: string; // "original" | "1080p" | "720p" | "480p" | "360p"
  // Adjustments (additive toggles)
  trimEnabled: boolean;
  trimStart: string;
  trimEnd: string;
  trimExact: boolean;
  rotateEnabled: boolean;
  rotateMode: "90cw" | "90ccw" | "180" | "hflip" | "vflip";
  cropEnabled: boolean;
  cropAspect: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
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
  { label: "WebM (VP9)", ext: "webm", vcodec: "libvpx-vp9", acodec: "libopus", container: "webm" },
  { label: "WebM (VP8)", ext: "webm-vp8", vcodec: "libvpx", acodec: "libvorbis", container: "webm" },
  { label: "MKV (H.264)", ext: "mkv", vcodec: "libx264", acodec: "aac", container: "matroska" },
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

const QUALITY_CRF: Record<string, Record<string, number>> = {
  libx264:       { fast: 28, balanced: 23, quality: 18 },
  "libvpx-vp9":  { fast: 38, balanced: 33, quality: 28 },
  libvpx:        { fast: 10, balanced: 7, quality: 4 },
};

const AUDIO_BITRATE: Record<string, string> = {
  fast: "128k",
  balanced: "192k",
  quality: "320k",
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

// ─── Module ──────────────────────────────────────────────────────────────────

export interface WorkbenchModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): { args: string[]; outputName: string } | null;
  getConfig(): WorkbenchConfig;
  reset(): void;
}

export function createWorkbench(): WorkbenchModule {
  let currentFile: FileInfo | null = null;
  let container: HTMLElement | null = null;

  const config: WorkbenchConfig = {
    outputFormat: "mp4",
    quality: "balanced",
    resolution: "original",
    trimEnabled: false,
    trimStart: "0",
    trimEnd: "",
    trimExact: false,
    rotateEnabled: false,
    rotateMode: "90cw",
    cropEnabled: false,
    cropAspect: "1:1",
    specialMode: null,
    gifStart: "0",
    gifDuration: "5",
    gifWidth: 480,
    gifFps: 15,
    thumbTime: "0",
    thumbGrid: false,
    thumbCount: 9,
    audioFormat: "mp3",
  };

  function getFormatsForFile(file: FileInfo): FormatOption[] {
    if (file.category === "audio") return AUDIO_FORMATS;
    if (file.category === "image") return IMAGE_FORMATS;
    return VIDEO_FORMATS;
  }

  function suggestFormat(file: FileInfo): string {
    const n = file.name.toLowerCase();

    if (file.category === "image") {
      if (n.endsWith(".png")) return "webp";
      if (n.endsWith(".bmp") || n.endsWith(".tiff") || n.endsWith(".tif")) return "png";
      if (n.endsWith(".webp")) return "png";
      if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "webp";
      if (n.endsWith(".gif")) return "png";
      if (n.endsWith(".heic") || n.endsWith(".heif") || n.endsWith(".avif")) return "png";
      return "webp";
    }

    if (file.category === "audio") {
      if (n.endsWith(".wav") || n.endsWith(".flac")) return "mp3";
      if (n.endsWith(".mp3")) return "m4a";
      if (n.endsWith(".ogg") || n.endsWith(".opus")) return "mp3";
      return "mp3";
    }

    if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "webm";
    if (n.endsWith(".mkv")) return "mp4";
    if (n.endsWith(".webm")) return "mp4";
    return "mp4";
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

    // Quality select
    const qualityGroup = el("div", "wb-field");
    qualityGroup.appendChild(el("label", "wb-label", "Quality"));
    const qualityOptions = category === "image"
      ? [
          { value: "fast", label: "Compact (smaller file)" },
          { value: "balanced", label: "Balanced" },
          { value: "quality", label: "Maximum (larger file)" },
        ]
      : [
          { value: "fast", label: "Fast (smaller file)" },
          { value: "balanced", label: "Balanced" },
          { value: "quality", label: "Quality (larger file)" },
        ];
    const qualitySelect = createSelect("wb-quality", qualityOptions, config.quality);
    qualitySelect.disabled = config.specialMode !== null;
    qualitySelect.addEventListener("change", () => { config.quality = qualitySelect.value as WorkbenchConfig["quality"]; });
    qualityGroup.appendChild(qualitySelect);
    body.appendChild(qualityGroup);

    // Resolution select (video + image)
    if (showResolution) {
      const resolutionGroup = el("div", "wb-field");
      resolutionGroup.appendChild(el("label", "wb-label", "Resolution"));
      const resolutionSelect = createSelect(
        "wb-resolution",
        RESOLUTION_OPTIONS.map((r) => ({
          value: r.value,
          label: r.value === "original" && currentFile?.resolution
            ? `Original (${currentFile.resolution})`
            : r.label,
        })),
        config.resolution,
      );
      resolutionSelect.disabled = config.specialMode !== null;
      resolutionSelect.addEventListener("change", () => { config.resolution = resolutionSelect.value; });
      resolutionGroup.appendChild(resolutionSelect);
      body.appendChild(resolutionGroup);
    }

    section.appendChild(body);
    parent.appendChild(section);
  }

  // ── Adjustments Section ─────────────────────────────────────────────────

  function renderAdjustmentsSection(parent: HTMLElement): void {
    if (!currentFile) return;

    const category = currentFile.category;
    const hasTrim = category === "video" || category === "audio";
    const hasRotate = category === "video" || category === "image";
    const hasCrop = category === "video" || category === "image";

    if (!hasTrim && !hasRotate && !hasCrop) return;

    const section = el("div", "wb-section");
    const title = el("div", "wb-section-title", "Adjustments");
    section.appendChild(title);

    if (hasTrim) renderTrimToggle(section);
    if (hasRotate) renderRotateToggle(section);
    if (hasCrop) renderCropToggle(section);

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

    if (config.trimEnabled && currentFile.duration !== null) {
      const hint = el("span", "wb-toggle-hint", formatDuration(currentFile.duration));
      header.appendChild(hint);
    }

    row.appendChild(header);

    // Options (shown when enabled)
    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.trimEnabled ? "" : "none";

    if (currentFile.duration !== null) {
      const durationHint = el("p", "wb-hint", `Duration: ${formatDuration(currentFile.duration)}`);
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
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.rotateEnabled ? "" : "none";

    const modeGroup = el("div", "wb-field");
    modeGroup.appendChild(el("label", "wb-label", "Transform"));
    const modeSelect = createSelect("wb-rotate-mode", [
      { value: "90cw",  label: "Rotate 90\u00b0 clockwise" },
      { value: "90ccw", label: "Rotate 90\u00b0 counter-clockwise" },
      { value: "180",   label: "Rotate 180\u00b0" },
      { value: "hflip", label: "Flip horizontal (mirror)" },
      { value: "vflip", label: "Flip vertical" },
    ], config.rotateMode);
    modeSelect.addEventListener("change", () => { config.rotateMode = modeSelect.value as WorkbenchConfig["rotateMode"]; });
    modeGroup.appendChild(modeSelect);
    opts.appendChild(modeGroup);

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
    });
    header.appendChild(check);
    header.appendChild(el("span", "wb-toggle-name", "Crop"));
    row.appendChild(header);

    const opts = el("div", "wb-toggle-opts");
    opts.style.display = config.cropEnabled ? "" : "none";

    const aspectGroup = el("div", "wb-field");
    aspectGroup.appendChild(el("label", "wb-label", "Aspect Ratio"));
    const aspectSelect = createSelect("wb-crop-aspect", [
      { value: "1:1",  label: "1:1 (square)" },
      { value: "16:9", label: "16:9 (widescreen)" },
      { value: "9:16", label: "9:16 (vertical)" },
      { value: "4:3",  label: "4:3 (classic)" },
      { value: "3:4",  label: "3:4 (portrait)" },
    ], config.cropAspect);
    aspectSelect.addEventListener("change", () => { config.cropAspect = aspectSelect.value as WorkbenchConfig["cropAspect"]; });
    aspectGroup.appendChild(aspectSelect);
    opts.appendChild(aspectGroup);

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
    durGroup.appendChild(el("label", "wb-label", "Duration (seconds)"));
    const durInput = createInput("wb-gif-dur", "number", String(config.gifDuration), "5");
    durInput.addEventListener("change", () => { config.gifDuration = durInput.value; });
    durGroup.appendChild(durInput);
    opts.appendChild(durGroup);

    const widthGroup = el("div", "wb-field");
    widthGroup.appendChild(el("label", "wb-label", "Width (px)"));
    const widthInput = createInput("wb-gif-width", "number", String(config.gifWidth), "480");
    widthInput.addEventListener("change", () => { config.gifWidth = parseInt(widthInput.value) || 480; });
    widthGroup.appendChild(widthInput);
    opts.appendChild(widthGroup);

    const fpsGroup = el("div", "wb-field");
    fpsGroup.appendChild(el("label", "wb-label", "Frame rate"));
    const fpsSelect = createSelect("wb-gif-fps", [
      { value: "10", label: "10 fps (small)" },
      { value: "15", label: "15 fps (balanced)" },
      { value: "24", label: "24 fps (smooth)" },
    ], String(config.gifFps));
    fpsSelect.addEventListener("change", () => { config.gifFps = parseInt(fpsSelect.value); });
    fpsGroup.appendChild(fpsSelect);
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
    countGroup.appendChild(el("label", "wb-label", "Frames"));
    const countSelect = createSelect("wb-thumb-count", [
      { value: "4", label: "4 frames (2\u00d72)" },
      { value: "9", label: "9 frames (3\u00d73)" },
      { value: "16", label: "16 frames (4\u00d74)" },
    ], String(config.thumbCount));
    countSelect.addEventListener("change", () => { config.thumbCount = parseInt(countSelect.value); });
    countGroup.appendChild(countSelect);
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
    const qualitySelect = createSelect("wb-audio-quality", [
      { value: "fast", label: "Fast (128k)" },
      { value: "balanced", label: "Balanced (192k)" },
      { value: "quality", label: "Quality (320k)" },
    ], config.quality);
    qualitySelect.addEventListener("change", () => { config.quality = qualitySelect.value as WorkbenchConfig["quality"]; });
    qualityGroup.appendChild(qualitySelect);
    opts.appendChild(qualityGroup);

    parent.appendChild(opts);
  }

  // ── Build ffmpeg command ─────────────────────────────────────────────────

  function build(): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const inputPath = `/input/${currentFile.name}`;

    // Special modes override everything
    if (config.specialMode === "gif") return buildGif(inputPath);
    if (config.specialMode === "thumbnail") return buildThumbnail(inputPath);
    if (config.specialMode === "extract-audio") return buildExtractAudio(inputPath);

    // Normal mode: unified convert + adjustments
    return buildUnified(inputPath);
  }

  function buildUnified(inputPath: string): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const category = currentFile.category;
    const formats = getFormatsForFile(currentFile);
    const fmt = formats.find((f) => f.ext === config.outputFormat) || formats[0];
    const baseName = currentFile.name.replace(/\.[^.]+$/, "");
    const fileExt = fmt.ext === "webm-vp8" ? "webm" : fmt.ext;

    // Build suffix from active adjustments
    const suffixParts: string[] = [];
    if (config.trimEnabled) suffixParts.push("trimmed");
    if (config.rotateEnabled) suffixParts.push("rotated");
    if (config.cropEnabled) suffixParts.push("cropped");
    const suffix = suffixParts.length > 0 ? `_${suffixParts.join("_")}` : "";

    const outputName = `${baseName}${suffix}.${fileExt}`;
    const outputPath = `/output/${outputName}`;

    // Determine if we need to re-encode
    const inputExt = currentFile.name.split(".").pop()?.toLowerCase() || "";
    const sameFormat = inputExt === fileExt || (inputExt === "webm" && fmt.ext === "webm-vp8");

    // No-change fast path: same format, no adjustments — stream-copy everything
    const noChanges = !config.trimEnabled && !config.rotateEnabled && !config.cropEnabled &&
      config.resolution === "original" && sameFormat;
    if (noChanges) {
      return { args: ["-i", inputPath, "-c", "copy", "-y", outputPath], outputName };
    }

    const trimOnly = config.trimEnabled && !config.rotateEnabled && !config.cropEnabled &&
      sameFormat && config.resolution === "original" && !config.trimExact;

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
    const vfParts: string[] = [];

    // Rotate / Flip filter
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

    // Crop filter
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

    // Resolution scaling
    const resOpt = RESOLUTION_OPTIONS.find((r) => r.value === config.resolution);
    if (resOpt && resOpt.height !== null && (category === "video" || category === "image")) {
      vfParts.push(`scale=-2:${resOpt.height}`);
    }

    // Apply -vf chain
    if (vfParts.length > 0) {
      args.push("-vf", vfParts.join(","));
    }

    // ── Image conversion ──────────────────────────────────────────────
    if (category === "image") {
      if (fileExt === "jpg" || fileExt === "jpeg") {
        const q = config.quality === "fast" ? "10" : config.quality === "quality" ? "2" : "5";
        args.push("-q:v", q);
      }
      if (fileExt === "webp") {
        const q = config.quality === "fast" ? "50" : config.quality === "quality" ? "95" : "80";
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
          args.push("-qmin", String(crf), "-qmax", String(crf + 5), "-b:v", "0");
        } else {
          args.push("-crf", String(crf));
        }
      }

      if (fmt.vcodec === "libx264") {
        const preset = config.quality === "fast" ? "veryfast" : config.quality === "quality" ? "slow" : "medium";
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

    if (fmtDef.acodec === "copy") {
      args.push("-vn", "-c:a", "copy");
    } else {
      args.push("-vn", "-c:a", fmtDef.acodec);
      if (fmtDef.acodec === "libmp3lame" || fmtDef.acodec === "aac" || fmtDef.acodec === "libvorbis" || fmtDef.acodec === "libopus") {
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
      config.rotateEnabled = false;
      config.cropEnabled = false;

      if (container) {
        renderAll();
      }
    },

    build,

    getConfig(): WorkbenchConfig { return { ...config }; },

    reset(): void {
      currentFile = null;
      config.outputFormat = "mp4";
      config.quality = "balanced";
      config.resolution = "original";
      config.trimEnabled = false;
      config.trimStart = "0";
      config.trimEnd = "";
      config.trimExact = false;
      config.rotateEnabled = false;
      config.rotateMode = "90cw";
      config.cropEnabled = false;
      config.cropAspect = "1:1";
      config.specialMode = null;
      config.gifStart = "0";
      config.gifDuration = "5";
      config.gifWidth = 480;
      config.gifFps = 15;
      config.thumbTime = "0";
      config.thumbGrid = false;
      config.thumbCount = 9;
      config.audioFormat = "mp3";
      if (container) container.innerHTML = "";
    },
  };
}
