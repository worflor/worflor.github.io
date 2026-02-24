// prism-transparency.ts — The Transparency module: visual diagnostics for video.
// Actions: motion-vectors, frame-types, waveform, histogram.

import type { FileInfo } from "./prism-engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TransparencyAction = "motion-vectors" | "frame-types" | "waveform" | "histogram";

export interface TransparencyConfig {
  action: TransparencyAction;
  // Motion vectors
  mvForward: boolean;
  mvBackward: boolean;
  // Waveform
  waveformMode: "column" | "row";
  waveformEnvelope: "none" | "instant" | "peak";
  // Histogram — no extra config, uses default overlay
}

export interface TransparencyModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): { args: string[]; outputName: string } | null;
  getConfig(): TransparencyConfig;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── Module ──────────────────────────────────────────────────────────────────

export function createTransparency(): TransparencyModule {
  let currentFile: FileInfo | null = null;
  let container: HTMLElement | null = null;
  let actionTabsEl: HTMLElement | null = null;
  let panelEl: HTMLElement | null = null;

  const config: TransparencyConfig = {
    action: "histogram",
    mvForward: true,
    mvBackward: false,
    waveformMode: "column",
    waveformEnvelope: "instant",
  };

  const ACTIONS: { id: TransparencyAction; label: string }[] = [
    { id: "histogram",      label: "Histogram" },
    { id: "waveform",       label: "Waveform" },
    { id: "frame-types",    label: "Frame Types" },
    { id: "motion-vectors", label: "Motion Vectors" },
  ];

  // ── Action Tabs ──────────────────────────────────────────────────────────

  function renderActionTabs(parent: HTMLElement): void {
    actionTabsEl = el("div", "trans-action-tabs");

    for (const action of ACTIONS) {
      const btn = el("button", "trans-tab", action.label);
      btn.dataset.action = action.id;
      if (action.id === config.action) btn.classList.add("trans-tab--active");

      btn.addEventListener("click", () => {
        config.action = action.id;
        actionTabsEl?.querySelectorAll(".trans-tab").forEach((t) => t.classList.remove("trans-tab--active"));
        btn.classList.add("trans-tab--active");
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
      case "motion-vectors": renderMotionVectorsPanel(panelEl); break;
      case "frame-types":    renderFrameTypesPanel(panelEl); break;
      case "waveform":       renderWaveformPanel(panelEl); break;
      case "histogram":      renderHistogramPanel(panelEl); break;
    }
  }

  function renderMotionVectorsPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "trans-hint",
      "Visualize motion vectors from the video codec. Shows how the encoder predicts motion between frames. Requires re-encoding with motion vector export."));

    const fwdGroup = el("div", "trans-field trans-field--row");
    const fwdLabel = el("label", "trans-toggle-label");
    const fwdCheck = document.createElement("input");
    fwdCheck.type = "checkbox";
    fwdCheck.checked = config.mvForward;
    fwdCheck.addEventListener("change", () => { config.mvForward = fwdCheck.checked; });
    fwdLabel.appendChild(fwdCheck);
    fwdLabel.appendChild(document.createTextNode(" Forward predicted (P-frames)"));
    fwdGroup.appendChild(fwdLabel);
    parent.appendChild(fwdGroup);

    const bwdGroup = el("div", "trans-field trans-field--row");
    const bwdLabel = el("label", "trans-toggle-label");
    const bwdCheck = document.createElement("input");
    bwdCheck.type = "checkbox";
    bwdCheck.checked = config.mvBackward;
    bwdCheck.addEventListener("change", () => { config.mvBackward = bwdCheck.checked; });
    bwdLabel.appendChild(bwdCheck);
    bwdLabel.appendChild(document.createTextNode(" Backward predicted (B-frames)"));
    bwdGroup.appendChild(bwdLabel);
    parent.appendChild(bwdGroup);
  }

  function renderFrameTypesPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "trans-hint",
      "Overlays the frame type (I, P, B) on each frame. Useful for analyzing GOP structure and keyframe placement. I-frames are full pictures, P-frames reference previous frames, B-frames reference both directions."));
  }

  function renderWaveformPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "trans-hint",
      "Generates a video waveform monitor showing luminance and color distribution. Used for color grading and exposure analysis."));

    // Mode
    const modeGroup = el("div", "trans-field");
    modeGroup.appendChild(el("label", "trans-label", "Mode"));
    const modeSelect = createSelect("trans-wf-mode", [
      { value: "column", label: "Column (standard)" },
      { value: "row",    label: "Row" },
    ], config.waveformMode);
    modeSelect.addEventListener("change", () => { config.waveformMode = modeSelect.value as "column" | "row"; });
    modeGroup.appendChild(modeSelect);
    parent.appendChild(modeGroup);

    // Envelope
    const envGroup = el("div", "trans-field");
    envGroup.appendChild(el("label", "trans-label", "Envelope"));
    const envSelect = createSelect("trans-wf-env", [
      { value: "none",    label: "None" },
      { value: "instant", label: "Instant" },
      { value: "peak",    label: "Peak hold" },
    ], config.waveformEnvelope);
    envSelect.addEventListener("change", () => { config.waveformEnvelope = envSelect.value as "none" | "instant" | "peak"; });
    envGroup.appendChild(envSelect);
    parent.appendChild(envGroup);
  }

  function renderHistogramPanel(parent: HTMLElement): void {
    parent.appendChild(el("p", "trans-hint",
      "Overlays a real-time color histogram on the video. Shows the distribution of RGB values across each frame. Helpful for identifying clipped highlights, crushed blacks, or color imbalances."));
  }

  // ── Build ffmpeg command ─────────────────────────────────────────────────

  function build(): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const inputPath = `/input/${currentFile.name}`;
    const baseName = currentFile.name.replace(/\.[^.]+$/, "");

    switch (config.action) {
      case "motion-vectors": return buildMotionVectors(inputPath, baseName);
      case "frame-types":    return buildFrameTypes(inputPath, baseName);
      case "waveform":       return buildWaveform(inputPath, baseName);
      case "histogram":      return buildHistogram(inputPath, baseName);
    }
  }

  function buildMotionVectors(inputPath: string, baseName: string): { args: string[]; outputName: string } {
    const outputName = `${baseName}_mvectors.mp4`;
    const outputPath = `/output/${outputName}`;

    // Build the mv= flags
    const mvParts: string[] = [];
    if (config.mvForward) mvParts.push("pf");
    if (config.mvBackward) mvParts.push("bf", "bb");
    if (mvParts.length === 0) mvParts.push("pf"); // fallback

    const mvFlag = mvParts.join("+");

    const args = [
      "-flags2", "+export_mvs",
      "-i", inputPath,
      "-vf", `codecview=mv=${mvFlag}`,
      "-c:v", "libx264", "-crf", "18", "-preset", "fast",
      "-an",
      "-movflags", "+faststart",
      "-y", outputPath,
    ];

    return { args, outputName };
  }

  function buildFrameTypes(inputPath: string, baseName: string): { args: string[]; outputName: string } {
    const outputName = `${baseName}_frames.mp4`;
    const outputPath = `/output/${outputName}`;

    const vf = "drawtext=text='%{pict_type}':x=10:y=10:fontsize=48:fontcolor=white:borderw=2:bordercolor=black";

    const args = [
      "-i", inputPath,
      "-vf", vf,
      "-c:v", "libx264", "-crf", "18", "-preset", "fast",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outputPath,
    ];

    return { args, outputName };
  }

  function buildWaveform(inputPath: string, baseName: string): { args: string[]; outputName: string } {
    const outputName = `${baseName}_waveform.mp4`;
    const outputPath = `/output/${outputName}`;

    const envMap: Record<string, number> = { none: 0, instant: 1, peak: 2 };
    const envVal = envMap[config.waveformEnvelope] ?? 1;

    const vf = `waveform=m=${config.waveformMode}:e=${envVal}`;

    const args = [
      "-i", inputPath,
      "-vf", vf,
      "-c:v", "libx264", "-crf", "18", "-preset", "fast",
      "-an",
      "-movflags", "+faststart",
      "-y", outputPath,
    ];

    return { args, outputName };
  }

  function buildHistogram(inputPath: string, baseName: string): { args: string[]; outputName: string } {
    const outputName = `${baseName}_histogram.mp4`;
    const outputPath = `/output/${outputName}`;

    const vf = "split[a][b];[b]histogram[h];[a][h]overlay";

    const args = [
      "-i", inputPath,
      "-filter_complex", vf,
      "-c:v", "libx264", "-crf", "18", "-preset", "fast",
      "-an",
      "-movflags", "+faststart",
      "-y", outputPath,
    ];

    return { args, outputName };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    render(target: HTMLElement): void {
      container = target;
      container.innerHTML = "";
      renderActionTabs(container);
      panelEl = el("div", "trans-panel");
      container.appendChild(panelEl);
      renderPanel();
    },

    configure(file: FileInfo): void {
      currentFile = file;
      if (container) {
        container.innerHTML = "";
        renderActionTabs(container);
        panelEl = el("div", "trans-panel");
        container.appendChild(panelEl);
        renderPanel();
      }
    },

    build,

    getConfig(): TransparencyConfig { return { ...config }; },

    setConfig(nextConfig: unknown): void {
      if (!isRecord(nextConfig)) return;

      if (typeof nextConfig.action === "string") {
        const action = nextConfig.action;
        if (action === "motion-vectors" || action === "frame-types" || action === "waveform" || action === "histogram") {
          config.action = action;
        }
      }
      if (typeof nextConfig.mvForward === "boolean") config.mvForward = nextConfig.mvForward;
      if (typeof nextConfig.mvBackward === "boolean") config.mvBackward = nextConfig.mvBackward;

      if (nextConfig.waveformMode === "column" || nextConfig.waveformMode === "row") {
        config.waveformMode = nextConfig.waveformMode;
      }
      if (nextConfig.waveformEnvelope === "none" || nextConfig.waveformEnvelope === "instant" || nextConfig.waveformEnvelope === "peak") {
        config.waveformEnvelope = nextConfig.waveformEnvelope;
      }

      if (container) {
        container.innerHTML = "";
        renderActionTabs(container);
        panelEl = el("div", "trans-panel");
        container.appendChild(panelEl);
        renderPanel();
      }
    },

    reset(): void {
      currentFile = null;
      config.action = "histogram";
      config.mvForward = true;
      config.mvBackward = false;
      config.waveformMode = "column";
      config.waveformEnvelope = "instant";
      if (panelEl) panelEl.innerHTML = "";
    },
  };
}
