// prism-audio.ts — The Audio Lab module: loudness normalization, dynamic normalization, volume, speed.

import type { FileInfo } from "./prism-engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AudioAction = "normalize" | "dynaudnorm" | "volume" | "speed";

export interface AudioConfig {
  action: AudioAction;
  // Normalize (EBU R128)
  targetLoudness: number; // dB, e.g. -14
  targetPeak: number;     // dB, e.g. -1
  // Dynamic Audio Normalization
  frameLength: number;    // ms, e.g. 150
  gaussianSize: number;   // odd integer, e.g. 15
  // Volume
  volumeValue: string;    // e.g. "1.5" or "3dB"
  volumeUnit: "multiplier" | "dB";
  // Speed
  speedFactor: number;    // 0.5–2.0
}

export interface AudioModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): { args: string[]; outputName: string } | null;
  getConfig(): AudioConfig;
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

// ─── Module ──────────────────────────────────────────────────────────────────

export function createAudioLab(): AudioModule {
  let currentFile: FileInfo | null = null;
  let container: HTMLElement | null = null;
  let actionTabsEl: HTMLElement | null = null;
  let panelEl: HTMLElement | null = null;

  const config: AudioConfig = {
    action: "normalize",
    targetLoudness: -14,
    targetPeak: -1,
    frameLength: 150,
    gaussianSize: 15,
    volumeValue: "1.0",
    volumeUnit: "multiplier",
    speedFactor: 1.0,
  };

  const ACTIONS: { id: AudioAction; label: string }[] = [
    { id: "normalize",   label: "Normalize" },
    { id: "dynaudnorm",  label: "Dynamic" },
    { id: "volume",      label: "Volume" },
    { id: "speed",       label: "Speed" },
  ];

  // ── Action Tabs ──────────────────────────────────────────────────────────

  function renderActionTabs(parent: HTMLElement): void {
    actionTabsEl = el("div", "al-action-tabs");

    for (const action of ACTIONS) {
      const btn = el("button", "al-tab", action.label);
      btn.dataset.action = action.id;
      if (action.id === config.action) btn.classList.add("al-tab--active");

      btn.addEventListener("click", () => {
        config.action = action.id;
        actionTabsEl?.querySelectorAll(".al-tab").forEach((t) => t.classList.remove("al-tab--active"));
        btn.classList.add("al-tab--active");
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
      case "normalize":   renderNormalizePanel(panelEl); break;
      case "dynaudnorm":  renderDynaudnormPanel(panelEl); break;
      case "volume":      renderVolumePanel(panelEl); break;
      case "speed":       renderSpeedPanel(panelEl); break;
    }
  }

  function renderNormalizePanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "al-hint",
      "EBU R128 loudness normalization. Analyzes the entire file and applies a uniform gain to match the target loudness. Best for music and podcasts."));

    // Target loudness
    const loudGroup = el("div", "al-field");
    loudGroup.appendChild(el("label", "al-label", "Target Loudness (LUFS)"));
    const loudInput = createInput("al-loudness", "number", String(config.targetLoudness), "-14");
    loudInput.min = "-30";
    loudInput.max = "0";
    loudInput.step = "1";
    loudInput.addEventListener("change", () => { config.targetLoudness = parseFloat(loudInput.value) || -14; });
    loudGroup.appendChild(loudInput);
    parent.appendChild(loudGroup);

    // Target peak
    const peakGroup = el("div", "al-field");
    peakGroup.appendChild(el("label", "al-label", "True Peak (dBTP)"));
    const peakInput = createInput("al-peak", "number", String(config.targetPeak), "-1");
    peakInput.min = "-10";
    peakInput.max = "0";
    peakInput.step = "0.5";
    peakInput.addEventListener("change", () => { config.targetPeak = parseFloat(peakInput.value) || -1; });
    peakGroup.appendChild(peakInput);
    parent.appendChild(peakGroup);
  }

  function renderDynaudnormPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "al-hint",
      "Dynamic audio normalization — adjusts gain on a per-frame basis for real-time leveling. Good for dialogue or content with varying loudness."));

    // Frame length
    const frameGroup = el("div", "al-field");
    frameGroup.appendChild(el("label", "al-label", "Frame Length (ms)"));
    const frameInput = createInput("al-frame", "number", String(config.frameLength), "150");
    frameInput.min = "10";
    frameInput.max = "8000";
    frameInput.step = "10";
    frameInput.addEventListener("change", () => { config.frameLength = parseInt(frameInput.value) || 150; });
    frameGroup.appendChild(frameInput);
    parent.appendChild(frameGroup);

    // Gaussian window size
    const gaussGroup = el("div", "al-field");
    gaussGroup.appendChild(el("label", "al-label", "Gaussian Window Size"));
    const gaussSelect = createSelect("al-gauss", [
      { value: "3",  label: "3 (responsive)" },
      { value: "7",  label: "7" },
      { value: "15", label: "15 (balanced)" },
      { value: "31", label: "31 (smooth)" },
    ], String(config.gaussianSize));
    gaussSelect.addEventListener("change", () => { config.gaussianSize = parseInt(gaussSelect.value); });
    gaussGroup.appendChild(gaussSelect);
    parent.appendChild(gaussGroup);
  }

  function renderVolumePanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "al-hint",
      "Simple volume adjustment. Multiply or add a fixed gain to the entire audio track."));

    // Unit select
    const unitGroup = el("div", "al-field");
    unitGroup.appendChild(el("label", "al-label", "Mode"));
    const unitSelect = createSelect("al-vol-unit", [
      { value: "multiplier", label: "Multiplier (e.g. 1.5x)" },
      { value: "dB",         label: "Decibels (e.g. +3dB)" },
    ], config.volumeUnit);
    unitSelect.addEventListener("change", () => {
      config.volumeUnit = unitSelect.value as "multiplier" | "dB";
      // Update placeholder
      volInput.placeholder = config.volumeUnit === "dB" ? "3" : "1.5";
    });
    unitGroup.appendChild(unitSelect);
    parent.appendChild(unitGroup);

    // Value
    const volGroup = el("div", "al-field");
    const volLabel = config.volumeUnit === "dB" ? "Value (0 = no change)" : "Value (1.0 = no change)";
    volGroup.appendChild(el("label", "al-label", volLabel));
    const volInput = createInput("al-vol-value", "text", config.volumeValue, config.volumeUnit === "dB" ? "0" : "1.0");
    volInput.addEventListener("change", () => { config.volumeValue = volInput.value; });
    volGroup.appendChild(volInput);
    parent.appendChild(volGroup);
  }

  function renderSpeedPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "al-hint",
      "Change playback speed without pitch shifting. Uses the atempo filter. Range: 0.5x to 2.0x per pass (can be chained for extreme values)."));

    // Speed factor
    const speedGroup = el("div", "al-field");
    speedGroup.appendChild(el("label", "al-label", "Speed Factor"));
    const speedSelect = createSelect("al-speed", [
      { value: "0.5",  label: "0.5x (half speed)" },
      { value: "0.75", label: "0.75x" },
      { value: "1",    label: "1.0x (original)" },
      { value: "1.25", label: "1.25x" },
      { value: "1.5",  label: "1.5x" },
      { value: "1.75", label: "1.75x" },
      { value: "2.0",  label: "2.0x (double speed)" },
    ], String(config.speedFactor));
    speedSelect.addEventListener("change", () => { config.speedFactor = parseFloat(speedSelect.value) || 1.0; });
    speedGroup.appendChild(speedSelect);
    parent.appendChild(speedGroup);
  }

  // ── Build ffmpeg command ─────────────────────────────────────────────────

  function build(): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const inputPath = `/input/${currentFile.name}`;
    const baseName = currentFile.name.replace(/\.[^.]+$/, "");
    const isVideo = currentFile.category === "video";

    switch (config.action) {
      case "normalize":   return buildNormalize(inputPath, baseName, isVideo);
      case "dynaudnorm":  return buildDynaudnorm(inputPath, baseName, isVideo);
      case "volume":      return buildVolume(inputPath, baseName, isVideo);
      case "speed":       return buildSpeed(inputPath, baseName, isVideo);
    }
  }

  function getOutputExt(isVideo: boolean): string {
    if (isVideo) return "mp4";
    const ext = currentFile?.name.split(".").pop()?.toLowerCase() || "mp3";
    // For audio, try to keep the same container; fall back to m4a for AAC output
    if (["mp3", "wav", "flac", "ogg", "opus", "m4a"].includes(ext)) return ext;
    return "m4a";
  }

  /** Map output extension to the appropriate audio codec + optional bitrate. */
  function getAudioCodecArgs(ext: string, isVideo: boolean): string[] {
    if (isVideo) return ["-c:a", "aac", "-b:a", "192k"];
    const codecMap: Record<string, { codec: string; lossy: boolean }> = {
      flac: { codec: "flac", lossy: false },
      wav:  { codec: "pcm_s16le", lossy: false },
      mp3:  { codec: "libmp3lame", lossy: true },
      ogg:  { codec: "libvorbis", lossy: true },
      opus: { codec: "libopus", lossy: true },
      m4a:  { codec: "aac", lossy: true },
    };
    const entry = codecMap[ext] || { codec: "aac", lossy: true };
    const args = ["-c:a", entry.codec];
    if (entry.lossy) args.push("-b:a", "192k");
    return args;
  }

  function buildNormalize(inputPath: string, baseName: string, isVideo: boolean): { args: string[]; outputName: string } {
    const ext = getOutputExt(isVideo);
    const outputName = `${baseName}_normalized.${ext}`;
    const outputPath = `/output/${outputName}`;

    const af = `loudnorm=I=${config.targetLoudness}:TP=${config.targetPeak}:LRA=11`;

    const args = ["-i", inputPath];
    if (isVideo) args.push("-c:v", "copy");
    args.push("-af", af, ...getAudioCodecArgs(ext, isVideo));
    if (ext === "mp4") args.push("-movflags", "+faststart");
    args.push("-y", outputPath);

    return { args, outputName };
  }

  function buildDynaudnorm(inputPath: string, baseName: string, isVideo: boolean): { args: string[]; outputName: string } {
    const ext = getOutputExt(isVideo);
    const outputName = `${baseName}_dynorm.${ext}`;
    const outputPath = `/output/${outputName}`;

    const af = `dynaudnorm=f=${config.frameLength}:g=${config.gaussianSize}`;

    const args = ["-i", inputPath];
    if (isVideo) args.push("-c:v", "copy");
    args.push("-af", af, ...getAudioCodecArgs(ext, isVideo));
    if (ext === "mp4") args.push("-movflags", "+faststart");
    args.push("-y", outputPath);

    return { args, outputName };
  }

  function buildVolume(inputPath: string, baseName: string, isVideo: boolean): { args: string[]; outputName: string } {
    const ext = getOutputExt(isVideo);
    const outputName = `${baseName}_volume.${ext}`;
    const outputPath = `/output/${outputName}`;

    let volVal = config.volumeValue.trim();
    if (config.volumeUnit === "dB" && !volVal.endsWith("dB")) {
      volVal = `${volVal}dB`;
    }

    const args = ["-i", inputPath];
    if (isVideo) args.push("-c:v", "copy");
    args.push("-af", `volume=${volVal}`, ...getAudioCodecArgs(ext, isVideo));
    if (ext === "mp4") args.push("-movflags", "+faststart");
    args.push("-y", outputPath);

    return { args, outputName };
  }

  function buildSpeed(inputPath: string, baseName: string, isVideo: boolean): { args: string[]; outputName: string } {
    const ext = getOutputExt(isVideo);
    const outputName = `${baseName}_speed.${ext}`;
    const outputPath = `/output/${outputName}`;

    // atempo only supports 0.5–2.0 per filter instance; chain for extreme values
    let factor = Math.max(0.5, Math.min(config.speedFactor, 2.0));
    const atempoFilters: string[] = [];

    // In case we ever need chaining (future expansion)
    while (factor > 2.0) {
      atempoFilters.push("atempo=2.0");
      factor /= 2.0;
    }
    while (factor < 0.5) {
      atempoFilters.push("atempo=0.5");
      factor /= 0.5;
    }
    atempoFilters.push(`atempo=${factor}`);

    const af = atempoFilters.join(",");

    const args = ["-i", inputPath];
    if (isVideo) args.push("-c:v", "copy");
    args.push("-af", af, ...getAudioCodecArgs(ext, isVideo));
    if (ext === "mp4") args.push("-movflags", "+faststart");
    args.push("-y", outputPath);

    return { args, outputName };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    render(target: HTMLElement): void {
      container = target;
      container.innerHTML = "";
      renderActionTabs(container);
      panelEl = el("div", "al-panel");
      container.appendChild(panelEl);
      renderPanel();
    },

    configure(file: FileInfo): void {
      currentFile = file;
      if (container) {
        container.innerHTML = "";
        renderActionTabs(container);
        panelEl = el("div", "al-panel");
        container.appendChild(panelEl);
        renderPanel();
      }
    },

    build,

    getConfig(): AudioConfig { return { ...config }; },

    reset(): void {
      currentFile = null;
      config.action = "normalize";
      config.targetLoudness = -14;
      config.targetPeak = -1;
      config.frameLength = 150;
      config.gaussianSize = 15;
      config.volumeValue = "1.0";
      config.volumeUnit = "multiplier";
      config.speedFactor = 1.0;
      if (panelEl) panelEl.innerHTML = "";
    },
  };
}
