// prism-audio.ts — The Audio Lab module: composable audio processing pipeline.
// 8 toggle sections that chain into a single -af argument.

import type { FileInfo } from "./prism-engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AudioConfig {
  // Noise Reduction
  noiseEnabled: boolean;
  noiseAmount: number;      // 10–97
  noiseFloor: number;       // -80 to -20
  // Frequency Filter
  freqEnabled: boolean;
  freqLowCut: number;      // Hz
  freqHighCut: number;      // Hz
  // EQ (3-band)
  eqEnabled: boolean;
  eqLowFreq: number;
  eqLowGain: number;       // ±12 dB
  eqMidFreq: number;
  eqMidGain: number;
  eqHighFreq: number;
  eqHighGain: number;
  // Compressor
  compEnabled: boolean;
  compThreshold: number;    // dB
  compRatio: number;
  compAttack: number;       // ms
  compRelease: number;      // ms
  compMakeup: number;       // dB
  // Limiter
  limiterEnabled: boolean;
  limiterCeiling: number;   // dBFS, -9 to 0
  // Noise Gate
  gateEnabled: boolean;
  gateThreshold: number;    // dBFS, -80 to -10
  gateRatio: number;        // 1 to 20
  gateAttack: number;       // ms
  gateRelease: number;      // ms
  // Loudness (mode selector preserves old Normalize/Dynamic/Volume)
  loudnessEnabled: boolean;
  loudnessMode: "normalize" | "dynaudnorm" | "volume";
  // Normalize params
  targetLoudness: number;
  targetPeak: number;
  // Dynamic params
  frameLength: number;
  gaussianSize: number;
  // Volume params
  volumeValue: string;
  volumeUnit: "multiplier" | "dB";
  // Speed
  speedEnabled: boolean;
  speedFactor: number;      // 0.5–2.0
  // Fade
  fadeEnabled: boolean;
  fadeInDuration: number;   // seconds
  fadeOutDuration: number;  // seconds
  // Silence Trim
  silenceEnabled: boolean;
  silenceThreshold: string; // dB string e.g. "-30dB"
  silenceMinDuration: number; // seconds
}

export interface AudioModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): { args: string[]; outputName: string } | null;
  getConfig(): AudioConfig;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── Module ──────────────────────────────────────────────────────────────────

export function createAudioLab(): AudioModule {
  let currentFile: FileInfo | null = null;
  let container: HTMLElement | null = null;

  const config: AudioConfig = {
    noiseEnabled: false,
    noiseAmount: 30,
    noiseFloor: -50,
    freqEnabled: false,
    freqLowCut: 80,
    freqHighCut: 16000,
    eqEnabled: false,
    eqLowFreq: 100,
    eqLowGain: 0,
    eqMidFreq: 1000,
    eqMidGain: 0,
    eqHighFreq: 8000,
    eqHighGain: 0,
    compEnabled: false,
    compThreshold: -20,
    compRatio: 4,
    compAttack: 20,
    compRelease: 250,
    compMakeup: 0,
    limiterEnabled: false,
    limiterCeiling: -1,
    gateEnabled: false,
    gateThreshold: -45,
    gateRatio: 8,
    gateAttack: 10,
    gateRelease: 120,
    loudnessEnabled: false,
    loudnessMode: "normalize",
    targetLoudness: -14,
    targetPeak: -1,
    frameLength: 150,
    gaussianSize: 15,
    volumeValue: "1.0",
    volumeUnit: "multiplier",
    speedEnabled: false,
    speedFactor: 1.0,
    fadeEnabled: false,
    fadeInDuration: 1,
    fadeOutDuration: 1,
    silenceEnabled: false,
    silenceThreshold: "-30dB",
    silenceMinDuration: 0.5,
  };

  // ── Render ──────────────────────────────────────────────────────────────

  function renderAll(): void {
    if (!container) return;
    container.innerHTML = "";

    const section = el("div", "al-section");
    const title = el("div", "al-section-title", "Audio Pipeline");
    section.appendChild(title);

    renderNoiseToggle(section);
    renderFreqToggle(section);
    renderEqToggle(section);
    renderCompToggle(section);
    renderLimiterToggle(section);
    renderGateToggle(section);
    renderLoudnessToggle(section);
    renderSpeedToggle(section);
    renderFadeToggle(section);
    renderSilenceToggle(section);

    container.appendChild(section);
  }

  // ── Toggle helpers ─────────────────────────────────────────────────────

  function makeToggleRow(
    label: string,
    enabled: boolean,
    onToggle: (checked: boolean) => void,
    renderOpts: (opts: HTMLElement) => void,
  ): HTMLElement {
    const row = el("div", `al-toggle-row${enabled ? " al-toggle-row--active" : ""}`);

    const header = el("label", "al-toggle-header");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = enabled;
    check.addEventListener("change", () => {
      onToggle(check.checked);
      row.classList.toggle("al-toggle-row--active", check.checked);
      opts.style.display = check.checked ? "" : "none";
    });
    header.appendChild(check);
    header.appendChild(el("span", "al-toggle-name", label));
    row.appendChild(header);

    const opts = el("div", "al-toggle-opts");
    opts.style.display = enabled ? "" : "none";
    renderOpts(opts);
    row.appendChild(opts);

    return row;
  }

  // ── Section Renderers ──────────────────────────────────────────────────

  function renderNoiseToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Noise Reduction", config.noiseEnabled, (v) => { config.noiseEnabled = v; }, (opts) => {
      const amountGroup = el("div", "al-field");
      amountGroup.appendChild(el("label", "al-label", "Amount (10\u201397)"));
      const amountInput = createInput("al-noise-amount", "number", String(config.noiseAmount), "30");
      amountInput.min = "10"; amountInput.max = "97"; amountInput.step = "1";
      amountInput.addEventListener("change", () => { config.noiseAmount = parseInt(amountInput.value) || 30; });
      amountGroup.appendChild(amountInput);
      opts.appendChild(amountGroup);

      const floorGroup = el("div", "al-field");
      floorGroup.appendChild(el("label", "al-label", "Noise Floor (dB)"));
      const floorInput = createInput("al-noise-floor", "number", String(config.noiseFloor), "-50");
      floorInput.min = "-80"; floorInput.max = "-20"; floorInput.step = "1";
      floorInput.addEventListener("change", () => { config.noiseFloor = parseInt(floorInput.value) || -50; });
      floorGroup.appendChild(floorInput);
      opts.appendChild(floorGroup);
    }));
  }

  function renderFreqToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Frequency Filter", config.freqEnabled, (v) => { config.freqEnabled = v; }, (opts) => {
      const lowGroup = el("div", "al-field");
      lowGroup.appendChild(el("label", "al-label", "Low Cut (Hz)"));
      const lowInput = createInput("al-freq-low", "number", String(config.freqLowCut), "80");
      lowInput.min = "20"; lowInput.max = "2000"; lowInput.step = "10";
      lowInput.addEventListener("change", () => { config.freqLowCut = parseInt(lowInput.value) || 80; });
      lowGroup.appendChild(lowInput);
      opts.appendChild(lowGroup);

      const highGroup = el("div", "al-field");
      highGroup.appendChild(el("label", "al-label", "High Cut (Hz)"));
      const highInput = createInput("al-freq-high", "number", String(config.freqHighCut), "16000");
      highInput.min = "2000"; highInput.max = "22000"; highInput.step = "100";
      highInput.addEventListener("change", () => { config.freqHighCut = parseInt(highInput.value) || 16000; });
      highGroup.appendChild(highInput);
      opts.appendChild(highGroup);
    }));
  }

  function renderEqToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("EQ (3-Band)", config.eqEnabled, (v) => { config.eqEnabled = v; }, (opts) => {
      const bands: { label: string; freqKey: "eqLowFreq" | "eqMidFreq" | "eqHighFreq"; gainKey: "eqLowGain" | "eqMidGain" | "eqHighGain"; defFreq: number; defGain: number }[] = [
        { label: "Low", freqKey: "eqLowFreq", gainKey: "eqLowGain", defFreq: 100, defGain: 0 },
        { label: "Mid", freqKey: "eqMidFreq", gainKey: "eqMidGain", defFreq: 1000, defGain: 0 },
        { label: "High", freqKey: "eqHighFreq", gainKey: "eqHighGain", defFreq: 8000, defGain: 0 },
      ];

      for (const band of bands) {
        const freqGroup = el("div", "al-field");
        freqGroup.appendChild(el("label", "al-label", `${band.label} Freq (Hz)`));
        const freqInput = createInput(`al-eq-${band.label.toLowerCase()}-freq`, "number", String(config[band.freqKey]), String(band.defFreq));
        freqInput.min = "20"; freqInput.max = "20000"; freqInput.step = "10";
        freqInput.addEventListener("change", () => { (config[band.freqKey] as number) = parseInt(freqInput.value) || band.defFreq; });
        freqGroup.appendChild(freqInput);
        opts.appendChild(freqGroup);

        const gainGroup = el("div", "al-field");
        gainGroup.appendChild(el("label", "al-label", `${band.label} Gain (dB)`));
        const gainInput = createInput(`al-eq-${band.label.toLowerCase()}-gain`, "number", String(config[band.gainKey]), "0");
        gainInput.min = "-12"; gainInput.max = "12"; gainInput.step = "0.5";
        gainInput.addEventListener("change", () => { (config[band.gainKey] as number) = parseFloat(gainInput.value) || 0; });
        gainGroup.appendChild(gainInput);
        opts.appendChild(gainGroup);
      }
    }));
  }

  function renderCompToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Compressor", config.compEnabled, (v) => { config.compEnabled = v; }, (opts) => {
      const fields: { label: string; key: keyof AudioConfig; def: number; min: string; max: string; step: string; placeholder: string }[] = [
        { label: "Threshold (dB)", key: "compThreshold", def: -20, min: "-60", max: "0", step: "1", placeholder: "-20" },
        { label: "Ratio", key: "compRatio", def: 4, min: "1", max: "20", step: "0.5", placeholder: "4" },
        { label: "Attack (ms)", key: "compAttack", def: 20, min: "0.01", max: "2000", step: "1", placeholder: "20" },
        { label: "Release (ms)", key: "compRelease", def: 250, min: "1", max: "9000", step: "10", placeholder: "250" },
        { label: "Makeup Gain (dB)", key: "compMakeup", def: 0, min: "0", max: "30", step: "0.5", placeholder: "0" },
      ];

      for (const f of fields) {
        const group = el("div", "al-field");
        group.appendChild(el("label", "al-label", f.label));
        const input = createInput(`al-comp-${f.key}`, "number", String(config[f.key]), f.placeholder);
        input.min = f.min; input.max = f.max; input.step = f.step;
        input.addEventListener("change", () => { (config[f.key] as number) = parseFloat(input.value) || f.def; });
        group.appendChild(input);
        opts.appendChild(group);
      }
    }));
  }

  function renderLoudnessToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Loudness", config.loudnessEnabled, (v) => { config.loudnessEnabled = v; }, (opts) => {
      // Mode selector
      const modeGroup = el("div", "al-field");
      modeGroup.appendChild(el("label", "al-label", "Mode"));
      const modeSelect = createSelect("al-loudness-mode", [
        { value: "normalize", label: "Normalize (EBU R128)" },
        { value: "dynaudnorm", label: "Dynamic Normalization" },
        { value: "volume", label: "Volume Adjustment" },
      ], config.loudnessMode);
      modeSelect.addEventListener("change", () => {
        config.loudnessMode = modeSelect.value as AudioConfig["loudnessMode"];
        renderAll();
      });
      modeGroup.appendChild(modeSelect);
      opts.appendChild(modeGroup);

      // Conditionally render params based on mode
      if (config.loudnessMode === "normalize") {
        opts.appendChild(el("p", "al-hint",
          "EBU R128 loudness normalization. Analyzes the entire file and applies a uniform gain."));

        const loudGroup = el("div", "al-field");
        loudGroup.appendChild(el("label", "al-label", "Target Loudness (LUFS)"));
        const loudInput = createInput("al-loudness", "number", String(config.targetLoudness), "-14");
        loudInput.min = "-30"; loudInput.max = "0"; loudInput.step = "1";
        loudInput.addEventListener("change", () => { config.targetLoudness = parseFloat(loudInput.value) || -14; });
        loudGroup.appendChild(loudInput);
        opts.appendChild(loudGroup);

        const peakGroup = el("div", "al-field");
        peakGroup.appendChild(el("label", "al-label", "True Peak (dBTP)"));
        const peakInput = createInput("al-peak", "number", String(config.targetPeak), "-1");
        peakInput.min = "-10"; peakInput.max = "0"; peakInput.step = "0.5";
        peakInput.addEventListener("change", () => { config.targetPeak = parseFloat(peakInput.value) || -1; });
        peakGroup.appendChild(peakInput);
        opts.appendChild(peakGroup);
      } else if (config.loudnessMode === "dynaudnorm") {
        opts.appendChild(el("p", "al-hint",
          "Per-frame gain adjustment for real-time leveling. Good for dialogue."));

        const frameGroup = el("div", "al-field");
        frameGroup.appendChild(el("label", "al-label", "Frame Length (ms)"));
        const frameInput = createInput("al-frame", "number", String(config.frameLength), "150");
        frameInput.min = "10"; frameInput.max = "8000"; frameInput.step = "10";
        frameInput.addEventListener("change", () => { config.frameLength = parseInt(frameInput.value) || 150; });
        frameGroup.appendChild(frameInput);
        opts.appendChild(frameGroup);

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
        opts.appendChild(gaussGroup);
      } else if (config.loudnessMode === "volume") {
        opts.appendChild(el("p", "al-hint",
          "Simple volume adjustment — multiply or add a fixed gain."));

        const unitGroup = el("div", "al-field");
        unitGroup.appendChild(el("label", "al-label", "Mode"));
        const unitSelect = createSelect("al-vol-unit", [
          { value: "multiplier", label: "Multiplier (e.g. 1.5x)" },
          { value: "dB",         label: "Decibels (e.g. +3dB)" },
        ], config.volumeUnit);
        unitSelect.addEventListener("change", () => {
          config.volumeUnit = unitSelect.value as "multiplier" | "dB";
          volInput.placeholder = config.volumeUnit === "dB" ? "0" : "1.0";
        });
        unitGroup.appendChild(unitSelect);
        opts.appendChild(unitGroup);

        const volGroup = el("div", "al-field");
        const volLabel = config.volumeUnit === "dB" ? "Value (0 = no change)" : "Value (1.0 = no change)";
        volGroup.appendChild(el("label", "al-label", volLabel));
        const volInput = createInput("al-vol-value", "text", config.volumeValue, config.volumeUnit === "dB" ? "0" : "1.0");
        volInput.addEventListener("change", () => { config.volumeValue = volInput.value; });
        volGroup.appendChild(volInput);
        opts.appendChild(volGroup);
      }
    }));
  }

  function renderLimiterToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Limiter", config.limiterEnabled, (v) => { config.limiterEnabled = v; }, (opts) => {
      opts.appendChild(el("p", "al-hint",
        "Prevents clipping by limiting peaks to a ceiling. Useful after compression or loudness changes."));

      const ceilingGroup = el("div", "al-field");
      ceilingGroup.appendChild(el("label", "al-label", "Ceiling (dBFS)"));
      const ceilingInput = createInput("al-limiter-ceiling", "number", String(config.limiterCeiling), "-1");
      ceilingInput.min = "-9";
      ceilingInput.max = "0";
      ceilingInput.step = "0.5";
      ceilingInput.addEventListener("change", () => {
        const value = parseFloat(ceilingInput.value);
        config.limiterCeiling = Number.isFinite(value) ? Math.min(0, Math.max(-9, value)) : -1;
      });
      ceilingGroup.appendChild(ceilingInput);
      opts.appendChild(ceilingGroup);
    }));
  }

  function renderGateToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Noise Gate", config.gateEnabled, (v) => { config.gateEnabled = v; }, (opts) => {
      opts.appendChild(el("p", "al-hint",
        "Reduces low-level background noise between phrases by attenuating signals below a threshold."));

      const thresholdGroup = el("div", "al-field");
      thresholdGroup.appendChild(el("label", "al-label", "Threshold (dBFS)"));
      const thresholdInput = createInput("al-gate-threshold", "number", String(config.gateThreshold), "-45");
      thresholdInput.min = "-80";
      thresholdInput.max = "-10";
      thresholdInput.step = "1";
      thresholdInput.addEventListener("change", () => {
        const value = parseFloat(thresholdInput.value);
        config.gateThreshold = Number.isFinite(value) ? Math.min(-10, Math.max(-80, value)) : -45;
      });
      thresholdGroup.appendChild(thresholdInput);
      opts.appendChild(thresholdGroup);

      const ratioGroup = el("div", "al-field");
      ratioGroup.appendChild(el("label", "al-label", "Ratio"));
      const ratioInput = createInput("al-gate-ratio", "number", String(config.gateRatio), "8");
      ratioInput.min = "1";
      ratioInput.max = "20";
      ratioInput.step = "0.5";
      ratioInput.addEventListener("change", () => {
        const value = parseFloat(ratioInput.value);
        config.gateRatio = Number.isFinite(value) ? Math.min(20, Math.max(1, value)) : 8;
      });
      ratioGroup.appendChild(ratioInput);
      opts.appendChild(ratioGroup);

      const attackGroup = el("div", "al-field");
      attackGroup.appendChild(el("label", "al-label", "Attack (ms)"));
      const attackInput = createInput("al-gate-attack", "number", String(config.gateAttack), "10");
      attackInput.min = "0.1";
      attackInput.max = "1000";
      attackInput.step = "1";
      attackInput.addEventListener("change", () => {
        const value = parseFloat(attackInput.value);
        config.gateAttack = Number.isFinite(value) ? Math.min(1000, Math.max(0.1, value)) : 10;
      });
      attackGroup.appendChild(attackInput);
      opts.appendChild(attackGroup);

      const releaseGroup = el("div", "al-field");
      releaseGroup.appendChild(el("label", "al-label", "Release (ms)"));
      const releaseInput = createInput("al-gate-release", "number", String(config.gateRelease), "120");
      releaseInput.min = "1";
      releaseInput.max = "4000";
      releaseInput.step = "1";
      releaseInput.addEventListener("change", () => {
        const value = parseFloat(releaseInput.value);
        config.gateRelease = Number.isFinite(value) ? Math.min(4000, Math.max(1, value)) : 120;
      });
      releaseGroup.appendChild(releaseInput);
      opts.appendChild(releaseGroup);
    }));
  }

  function renderSpeedToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Speed", config.speedEnabled, (v) => { config.speedEnabled = v; }, (opts) => {
      opts.appendChild(el("p", "al-hint",
        "Change playback speed without pitch shifting. Range: 0.5x to 2.0x."));

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
      opts.appendChild(speedGroup);
    }));
  }

  function renderFadeToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Fade", config.fadeEnabled, (v) => { config.fadeEnabled = v; }, (opts) => {
      const inGroup = el("div", "al-field");
      inGroup.appendChild(el("label", "al-label", "Fade In (seconds)"));
      const inInput = createInput("al-fade-in", "number", String(config.fadeInDuration), "1");
      inInput.min = "0"; inInput.max = "30"; inInput.step = "0.5";
      inInput.addEventListener("change", () => { config.fadeInDuration = parseFloat(inInput.value) || 0; });
      inGroup.appendChild(inInput);
      opts.appendChild(inGroup);

      const outGroup = el("div", "al-field");
      outGroup.appendChild(el("label", "al-label", "Fade Out (seconds)"));
      const outInput = createInput("al-fade-out", "number", String(config.fadeOutDuration), "1");
      outInput.min = "0"; outInput.max = "30"; outInput.step = "0.5";
      outInput.addEventListener("change", () => { config.fadeOutDuration = parseFloat(outInput.value) || 0; });
      outGroup.appendChild(outInput);
      opts.appendChild(outGroup);
    }));
  }

  function renderSilenceToggle(parent: HTMLElement): void {
    parent.appendChild(makeToggleRow("Silence Trim", config.silenceEnabled, (v) => { config.silenceEnabled = v; }, (opts) => {
      opts.appendChild(el("p", "al-hint",
        "Remove leading and trailing silence from the audio."));

      const threshGroup = el("div", "al-field");
      threshGroup.appendChild(el("label", "al-label", "Threshold"));
      const threshSelect = createSelect("al-silence-thresh", [
        { value: "-50dB", label: "-50 dB (quiet rooms)" },
        { value: "-40dB", label: "-40 dB (normal)" },
        { value: "-30dB", label: "-30 dB (aggressive)" },
        { value: "-20dB", label: "-20 dB (very aggressive)" },
      ], config.silenceThreshold);
      threshSelect.addEventListener("change", () => { config.silenceThreshold = threshSelect.value; });
      threshGroup.appendChild(threshSelect);
      opts.appendChild(threshGroup);

      const durGroup = el("div", "al-field");
      durGroup.appendChild(el("label", "al-label", "Min Silence Duration (seconds)"));
      const durInput = createInput("al-silence-dur", "number", String(config.silenceMinDuration), "0.5");
      durInput.min = "0.1"; durInput.max = "10"; durInput.step = "0.1";
      durInput.addEventListener("change", () => { config.silenceMinDuration = parseFloat(durInput.value) || 0.5; });
      durGroup.appendChild(durInput);
      opts.appendChild(durGroup);
    }));
  }

  // ── Build ffmpeg command ─────────────────────────────────────────────────

  function getOutputExt(isVideo: boolean): string {
    if (isVideo) return "mp4";
    const ext = currentFile?.name.split(".").pop()?.toLowerCase() || "mp3";
    if (["mp3", "wav", "flac", "ogg", "opus", "m4a"].includes(ext)) return ext;
    return "m4a";
  }

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

  function build(): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const inputPath = `/input/${currentFile.name}`;
    const baseName = currentFile.name.replace(/\.[^.]+$/, "");
    const isVideo = currentFile.category === "video";

    // Build -af chain: iterate enabled sections in pipeline order
    const afParts: string[] = [];
    const suffixParts: string[] = [];

    // 1. Noise Reduction
    if (config.noiseEnabled) {
      afParts.push(`afftdn=nr=${config.noiseAmount}:nf=${config.noiseFloor}`);
      suffixParts.push("denoised");
    }

    // 2. Frequency Filter
    if (config.freqEnabled) {
      afParts.push(`highpass=f=${config.freqLowCut}`);
      afParts.push(`lowpass=f=${config.freqHighCut}`);
      suffixParts.push("filtered");
    }

    // 3. EQ
    if (config.eqEnabled) {
      const bands = [
        { freq: config.eqLowFreq, gain: config.eqLowGain },
        { freq: config.eqMidFreq, gain: config.eqMidGain },
        { freq: config.eqHighFreq, gain: config.eqHighGain },
      ];
      for (const b of bands) {
        if (b.gain !== 0) {
          afParts.push(`equalizer=f=${b.freq}:t=h:w=200:g=${b.gain}`);
        }
      }
      suffixParts.push("eq");
    }

    // 4. Compressor
    if (config.compEnabled) {
      afParts.push(`acompressor=threshold=${config.compThreshold / 1000}:ratio=${config.compRatio}:attack=${config.compAttack}:release=${config.compRelease}:makeup=${config.compMakeup}`);
      suffixParts.push("compressed");
    }

    // 5. Limiter
    if (config.limiterEnabled) {
      const ceilingDb = Math.min(0, Math.max(-9, config.limiterCeiling));
      const linear = Math.pow(10, ceilingDb / 20);
      afParts.push(`alimiter=limit=${linear.toFixed(4)}`);
      suffixParts.push("limited");
    }

    // 6. Noise Gate
    if (config.gateEnabled) {
      const thresholdLinear = Math.pow(10, Math.min(-10, Math.max(-80, config.gateThreshold)) / 20);
      const ratio = Math.min(20, Math.max(1, config.gateRatio));
      const attack = Math.min(1000, Math.max(0.1, config.gateAttack));
      const release = Math.min(4000, Math.max(1, config.gateRelease));
      afParts.push(`agate=threshold=${thresholdLinear.toFixed(6)}:ratio=${ratio.toFixed(2)}:attack=${attack}:release=${release}`);
      suffixParts.push("gated");
    }

    // 7. Loudness
    if (config.loudnessEnabled) {
      if (config.loudnessMode === "normalize") {
        afParts.push(`loudnorm=I=${config.targetLoudness}:TP=${config.targetPeak}:LRA=11`);
        suffixParts.push("normalized");
      } else if (config.loudnessMode === "dynaudnorm") {
        afParts.push(`dynaudnorm=f=${config.frameLength}:g=${config.gaussianSize}`);
        suffixParts.push("dynorm");
      } else if (config.loudnessMode === "volume") {
        let volVal = config.volumeValue.trim();
        if (config.volumeUnit === "dB" && !volVal.endsWith("dB")) {
          volVal = `${volVal}dB`;
        }
        afParts.push(`volume=${volVal}`);
        suffixParts.push("volume");
      }
    }

    // 8. Speed
    if (config.speedEnabled && config.speedFactor !== 1.0) {
      let factor = Math.max(0.5, Math.min(config.speedFactor, 2.0));
      const atempoFilters: string[] = [];
      while (factor > 2.0) {
        atempoFilters.push("atempo=2.0");
        factor /= 2.0;
      }
      while (factor < 0.5) {
        atempoFilters.push("atempo=0.5");
        factor /= 0.5;
      }
      atempoFilters.push(`atempo=${factor}`);
      afParts.push(...atempoFilters);
      suffixParts.push("speed");
    }

    // 9. Fade
    if (config.fadeEnabled) {
      if (config.fadeInDuration > 0) {
        afParts.push(`afade=t=in:d=${config.fadeInDuration}`);
      }
      if (config.fadeOutDuration > 0) {
        const totalDuration = currentFile.duration ?? 0;
        const fadeOutStart = Math.max(0, totalDuration - config.fadeOutDuration);
        afParts.push(`afade=t=out:st=${fadeOutStart}:d=${config.fadeOutDuration}`);
      }
      suffixParts.push("faded");
    }

    // 10. Silence Trim
    if (config.silenceEnabled) {
      const d = config.silenceMinDuration;
      const t = config.silenceThreshold;
      afParts.push(`silenceremove=start_periods=1:start_duration=${d}:start_threshold=${t}:stop_periods=1:stop_duration=${d}:stop_threshold=${t}`);
      suffixParts.push("trimmed");
    }

    // Nothing enabled
    if (afParts.length === 0) return null;

    const ext = getOutputExt(isVideo);
    const suffix = suffixParts.length > 0 ? `_${suffixParts.join("_")}` : "";
    const outputName = `${baseName}${suffix}.${ext}`;
    const outputPath = `/output/${outputName}`;

    const args = ["-i", inputPath];
    if (isVideo) args.push("-c:v", "copy");
    args.push("-af", afParts.join(","), ...getAudioCodecArgs(ext, isVideo));
    if (ext === "mp4") args.push("-movflags", "+faststart");
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
      if (container) {
        container.innerHTML = "";
        renderAll();
      }
    },

    build,

    getConfig(): AudioConfig { return { ...config }; },

    setConfig(nextConfig: unknown): void {
      if (!isRecord(nextConfig)) return;

      const setBool = (key: keyof AudioConfig): void => {
        if (typeof nextConfig[key] === "boolean") {
          (config[key] as boolean) = nextConfig[key] as boolean;
        }
      };
      const setNumber = (key: keyof AudioConfig, min: number, max: number): void => {
        const value = nextConfig[key];
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        (config[key] as number) = Math.min(max, Math.max(min, value));
      };

      setBool("noiseEnabled");
      setBool("freqEnabled");
      setBool("eqEnabled");
      setBool("compEnabled");
      setBool("limiterEnabled");
      setBool("gateEnabled");
      setBool("loudnessEnabled");
      setBool("speedEnabled");
      setBool("fadeEnabled");
      setBool("silenceEnabled");

      setNumber("noiseAmount", 10, 97);
      setNumber("noiseFloor", -80, -20);
      setNumber("freqLowCut", 20, 2000);
      setNumber("freqHighCut", 2000, 22000);
      setNumber("eqLowFreq", 20, 20000);
      setNumber("eqLowGain", -12, 12);
      setNumber("eqMidFreq", 20, 20000);
      setNumber("eqMidGain", -12, 12);
      setNumber("eqHighFreq", 20, 20000);
      setNumber("eqHighGain", -12, 12);
      setNumber("compThreshold", -60, 0);
      setNumber("compRatio", 1, 20);
      setNumber("compAttack", 0.01, 2000);
      setNumber("compRelease", 1, 9000);
      setNumber("compMakeup", 0, 30);
      setNumber("limiterCeiling", -9, 0);
      setNumber("gateThreshold", -80, -10);
      setNumber("gateRatio", 1, 20);
      setNumber("gateAttack", 0.1, 1000);
      setNumber("gateRelease", 1, 4000);
      setNumber("targetLoudness", -30, 0);
      setNumber("targetPeak", -10, 0);
      setNumber("frameLength", 10, 8000);
      setNumber("speedFactor", 0.5, 2);
      setNumber("fadeInDuration", 0, 30);
      setNumber("fadeOutDuration", 0, 30);
      setNumber("silenceMinDuration", 0.1, 10);

      if (typeof nextConfig.gaussianSize === "number" && Number.isFinite(nextConfig.gaussianSize)) {
        const rounded = Math.round(nextConfig.gaussianSize);
        if (rounded === 3 || rounded === 7 || rounded === 15 || rounded === 31) {
          config.gaussianSize = rounded;
        }
      }

      if (nextConfig.loudnessMode === "normalize" || nextConfig.loudnessMode === "dynaudnorm" || nextConfig.loudnessMode === "volume") {
        config.loudnessMode = nextConfig.loudnessMode;
      }

      if (nextConfig.volumeUnit === "multiplier" || nextConfig.volumeUnit === "dB") {
        config.volumeUnit = nextConfig.volumeUnit;
      }
      if (typeof nextConfig.volumeValue === "string") {
        const cleaned = nextConfig.volumeValue.trim();
        if (cleaned) config.volumeValue = cleaned;
      }
      if (typeof nextConfig.silenceThreshold === "string") {
        const cleaned = nextConfig.silenceThreshold.trim();
        if (cleaned) config.silenceThreshold = cleaned;
      }

      if (container) {
        container.innerHTML = "";
        renderAll();
      }
    },

    reset(): void {
      currentFile = null;
      config.noiseEnabled = false;
      config.noiseAmount = 30;
      config.noiseFloor = -50;
      config.freqEnabled = false;
      config.freqLowCut = 80;
      config.freqHighCut = 16000;
      config.eqEnabled = false;
      config.eqLowFreq = 100;
      config.eqLowGain = 0;
      config.eqMidFreq = 1000;
      config.eqMidGain = 0;
      config.eqHighFreq = 8000;
      config.eqHighGain = 0;
      config.compEnabled = false;
      config.compThreshold = -20;
      config.compRatio = 4;
      config.compAttack = 20;
      config.compRelease = 250;
      config.compMakeup = 0;
      config.limiterEnabled = false;
      config.limiterCeiling = -1;
      config.gateEnabled = false;
      config.gateThreshold = -45;
      config.gateRatio = 8;
      config.gateAttack = 10;
      config.gateRelease = 120;
      config.loudnessEnabled = false;
      config.loudnessMode = "normalize";
      config.targetLoudness = -14;
      config.targetPeak = -1;
      config.frameLength = 150;
      config.gaussianSize = 15;
      config.volumeValue = "1.0";
      config.volumeUnit = "multiplier";
      config.speedEnabled = false;
      config.speedFactor = 1.0;
      config.fadeEnabled = false;
      config.fadeInDuration = 1;
      config.fadeOutDuration = 1;
      config.silenceEnabled = false;
      config.silenceThreshold = "-30dB";
      config.silenceMinDuration = 0.5;
      if (container) container.innerHTML = "";
    },
  };
}
