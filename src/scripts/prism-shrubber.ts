// prism-shrubber.ts — The Shrubber module: privacy & metadata stripping.
// Actions: strip-metadata, clean-streams, deep-clean.

import type { FileInfo } from "./prism-engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ShrubberAction = "strip-metadata" | "clean-streams" | "deep-clean";

export interface ShrubberConfig {
  action: ShrubberAction;
  keepAudio: boolean;
}

export interface ShrubberModule {
  render(container: HTMLElement): void;
  configure(file: FileInfo): void;
  build(): { args: string[]; outputName: string } | null;
  getConfig(): ShrubberConfig;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ─── Module ──────────────────────────────────────────────────────────────────

export function createShrubber(): ShrubberModule {
  let currentFile: FileInfo | null = null;
  let container: HTMLElement | null = null;
  let actionTabsEl: HTMLElement | null = null;
  let panelEl: HTMLElement | null = null;

  const config: ShrubberConfig = {
    action: "strip-metadata",
    keepAudio: true,
  };

  const ACTIONS: { id: ShrubberAction; label: string; forCategory: FileInfo["category"][] }[] = [
    { id: "strip-metadata", label: "Strip Metadata", forCategory: ["video", "audio", "image"] },
    { id: "clean-streams",  label: "Clean Streams",  forCategory: ["video", "audio"] },
    { id: "deep-clean",     label: "Deep Clean",     forCategory: ["video", "audio", "image"] },
  ];

  // ── Action Tabs ──────────────────────────────────────────────────────────

  function renderActionTabs(parent: HTMLElement): void {
    actionTabsEl = el("div", "shrub-action-tabs");

    for (const action of ACTIONS) {
      if (currentFile && !action.forCategory.includes(currentFile.category)) continue;

      const btn = el("button", "shrub-tab", action.label);
      btn.dataset.action = action.id;
      if (action.id === config.action) btn.classList.add("shrub-tab--active");

      btn.addEventListener("click", () => {
        config.action = action.id;
        actionTabsEl?.querySelectorAll(".shrub-tab").forEach((t) => t.classList.remove("shrub-tab--active"));
        btn.classList.add("shrub-tab--active");
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
      case "strip-metadata":  renderStripPanel(panelEl); break;
      case "clean-streams":   renderCleanStreamsPanel(panelEl); break;
      case "deep-clean":      renderDeepCleanPanel(panelEl); break;
    }
  }

  function renderStripPanel(parent: HTMLElement): void {
    const hint = el("p", "shrub-hint",
      "Removes all metadata tags (title, artist, comment, GPS, EXIF, etc.) while keeping all streams intact. Uses stream copy — no re-encoding.");
    parent.appendChild(hint);
  }

  function renderCleanStreamsPanel(parent: HTMLElement): void {
    const hint = el("p", "shrub-hint",
      "Removes non-essential streams like data tracks, attachments, and embedded fonts. Keeps video and audio only. Uses stream copy.");
    parent.appendChild(hint);
  }

  function renderDeepCleanPanel(parent: HTMLElement): void {
    if (!currentFile) return;

    const hint = el("p", "shrub-hint",
      "Full privacy scrub: strips all metadata, removes non-essential streams, and re-encodes to eliminate any steganographic or hidden data.");
    parent.appendChild(hint);

    if (currentFile.category === "video") {
      const audioGroup = el("div", "shrub-field shrub-field--row");
      const audioLabel = el("label", "shrub-toggle-label");
      const audioCheck = document.createElement("input");
      audioCheck.type = "checkbox";
      audioCheck.checked = config.keepAudio;
      audioCheck.addEventListener("change", () => { config.keepAudio = audioCheck.checked; });
      audioLabel.appendChild(audioCheck);
      audioLabel.appendChild(document.createTextNode(" Keep audio track"));
      audioGroup.appendChild(audioLabel);
      parent.appendChild(audioGroup);
    }
  }

  // ── Build ffmpeg command ─────────────────────────────────────────────────

  function build(): { args: string[]; outputName: string } | null {
    if (!currentFile) return null;

    const inputPath = `/input/${currentFile.name}`;
    const baseName = currentFile.name.replace(/\.[^.]+$/, "");
    const ext = currentFile.name.split(".").pop() || "mp4";

    switch (config.action) {
      case "strip-metadata":  return buildStripMetadata(inputPath, baseName, ext);
      case "clean-streams":   return buildCleanStreams(inputPath, baseName, ext);
      case "deep-clean":      return buildDeepClean(inputPath, baseName, ext);
    }
  }

  function buildStripMetadata(inputPath: string, baseName: string, ext: string): { args: string[]; outputName: string } {
    const outputName = `${baseName}_stripped.${ext}`;
    const outputPath = `/output/${outputName}`;

    const args = ["-i", inputPath, "-map_metadata", "-1", "-c", "copy", "-y", outputPath];
    return { args, outputName };
  }

  function buildCleanStreams(inputPath: string, baseName: string, ext: string): { args: string[]; outputName: string } {
    const outputName = `${baseName}_cleaned.${ext}`;
    const outputPath = `/output/${outputName}`;

    const args = ["-i", inputPath, "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-y", outputPath];
    return { args, outputName };
  }

  /** Map audio container extension to a safe codec for re-encoding. */
  function getDeepCleanAudioArgs(ext: string): { outExt: string; codecArgs: string[] } {
    const map: Record<string, { outExt: string; codec: string; lossy: boolean }> = {
      flac: { outExt: "flac", codec: "flac", lossy: false },
      wav:  { outExt: "wav",  codec: "pcm_s16le", lossy: false },
      mp3:  { outExt: "mp3",  codec: "libmp3lame", lossy: true },
      ogg:  { outExt: "ogg",  codec: "libvorbis", lossy: true },
      opus: { outExt: "opus", codec: "libopus", lossy: true },
      m4a:  { outExt: "m4a",  codec: "aac", lossy: true },
      aac:  { outExt: "m4a",  codec: "aac", lossy: true },
      wma:  { outExt: "mp3",  codec: "libmp3lame", lossy: true },
      aiff: { outExt: "wav",  codec: "pcm_s16le", lossy: false },
      ape:  { outExt: "flac", codec: "flac", lossy: false },
      wv:   { outExt: "flac", codec: "flac", lossy: false },
    };
    const entry = map[ext.toLowerCase()] || { outExt: "m4a", codec: "aac", lossy: true };
    const args = ["-c:a", entry.codec];
    if (entry.lossy) args.push("-b:a", "192k");
    return { outExt: entry.outExt, codecArgs: args };
  }

  function buildDeepClean(inputPath: string, baseName: string, ext: string): { args: string[]; outputName: string } {
    if (!currentFile) return { args: [], outputName: "" };

    const category = currentFile.category;

    if (category === "image") {
      // Re-encode the image to strip all EXIF/metadata
      const outputExt = ext === "jpg" || ext === "jpeg" ? "jpg" : ext === "png" ? "png" : "png";
      const outputName = `${baseName}_deep.${outputExt}`;
      const outputPath = `/output/${outputName}`;
      const args = ["-i", inputPath, "-map_metadata", "-1", "-y", outputPath];
      return { args, outputName };
    }

    if (category === "audio") {
      const { outExt, codecArgs } = getDeepCleanAudioArgs(ext);
      const outputName = `${baseName}_deep.${outExt}`;
      const outputPath = `/output/${outputName}`;
      const args = ["-i", inputPath, "-map_metadata", "-1", "-map", "0:a?", ...codecArgs, "-y", outputPath];
      return { args, outputName };
    }

    // Video: full deep clean
    const outputName = `${baseName}_deep.mp4`;
    const outputPath = `/output/${outputName}`;
    const args = ["-i", inputPath, "-map_metadata", "-1"];

    args.push("-map", "0:v?");
    if (config.keepAudio) {
      args.push("-map", "0:a?");
    }

    args.push("-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    args.push("-c:v", "libx264", "-crf", "23", "-preset", "medium");

    if (config.keepAudio) {
      args.push("-c:a", "aac", "-b:a", "192k");
    }

    args.push("-movflags", "+faststart", "-y", outputPath);
    return { args, outputName };
  }

  // ── Public API ───────────────────────────────────────────────────────────

  return {
    render(target: HTMLElement): void {
      container = target;
      container.innerHTML = "";
      renderActionTabs(container);
      panelEl = el("div", "shrub-panel");
      container.appendChild(panelEl);
      renderPanel();
    },

    configure(file: FileInfo): void {
      currentFile = file;
      // Default to strip-metadata, falling back if not available
      const available = ACTIONS.filter((a) => a.forCategory.includes(file.category));
      if (!available.find((a) => a.id === config.action)) {
        config.action = available[0]?.id ?? "strip-metadata";
      }
      if (container) {
        container.innerHTML = "";
        renderActionTabs(container);
        panelEl = el("div", "shrub-panel");
        container.appendChild(panelEl);
        renderPanel();
      }
    },

    build,

    getConfig(): ShrubberConfig { return { ...config }; },

    setConfig(nextConfig: unknown): void {
      if (!isRecord(nextConfig)) return;

      if (typeof nextConfig.keepAudio === "boolean") {
        config.keepAudio = nextConfig.keepAudio;
      }

      if (typeof nextConfig.action === "string") {
        const requested = nextConfig.action as ShrubberAction;
        const currentCategory = currentFile?.category ?? null;
        const allowed = currentCategory
          ? ACTIONS.filter((a) => a.forCategory.includes(currentCategory)).map((a) => a.id)
          : ACTIONS.map((a) => a.id);
        if (allowed.includes(requested)) {
          config.action = requested;
        }
      }

      if (container) {
        container.innerHTML = "";
        renderActionTabs(container);
        panelEl = el("div", "shrub-panel");
        container.appendChild(panelEl);
        renderPanel();
      }
    },

    reset(): void {
      currentFile = null;
      config.action = "strip-metadata";
      config.keepAudio = true;
      if (panelEl) panelEl.innerHTML = "";
    },
  };
}
