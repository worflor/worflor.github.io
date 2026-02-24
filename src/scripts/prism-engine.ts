// prism-engine.ts — ffmpeg.wasm wrapper with zero npm dependencies.
// Loads everything from CDN at runtime. Detects SharedArrayBuffer support
// and picks single-thread (baseline) or multi-thread (enhanced) automatically.
// All state is scoped inside createEngine() for clean Astro lifecycle teardown.

// ─── CDN URLs ────────────────────────────────────────────────────────────────

const FFMPEG_CDN = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm";
const UTIL_CDN = "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm";
const CORE_CDN = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
const CORE_MT_CDN = "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/umd";

// ─── Types ───────────────────────────────────────────────────────────────────

export type EngineTier = "baseline" | "enhanced";
export type EngineState = "idle" | "loading" | "ready" | "running" | "error";

export interface FileInfo {
  name: string;
  size: number;
  type: string;
  /** Duration in seconds (video/audio only, null for images/subs) */
  duration: number | null;
  /** Human-readable size string */
  sizeLabel: string;
  /** Detected media category */
  category: "video" | "audio" | "image" | "subtitle" | "unknown";
  /** Resolution as "WxH" string, e.g. "1920x1080" (video only, null otherwise) */
  resolution: string | null;
  /** Video codec name (e.g. "h264"), null if not a video or not detected */
  videoCodec: string | null;
  /** Audio codec name (e.g. "aac"), null if not detected */
  audioCodec: string | null;
  /** Number of audio channels (e.g. 2 for stereo), null if not detected */
  channels: number | null;
  /** Overall bitrate in kbps, null if not detected */
  bitrate: number | null;
}

export interface ProgressEvent {
  /** 0–1 */
  ratio: number;
  /** Processing speed multiplier (e.g. 2.1 means 2.1x realtime) */
  speed: number | null;
  /** Estimated seconds remaining */
  eta: number | null;
  /** Current time position in seconds */
  time: number;
}

export interface EngineCallbacks {
  onStateChange?: (state: EngineState) => void;
  onProgress?: (progress: ProgressEvent) => void;
  onLog?: (message: string) => void;
  onError?: (error: EngineError) => void;
}

export interface EngineError {
  /** Human-readable message */
  message: string;
  /** Raw ffmpeg error (if available) */
  raw?: string;
  /** Error code */
  code: "load_failed" | "exec_failed" | "oom" | "cancelled" | "unsupported";
}

export interface OutputFile {
  name: string;
  data: Uint8Array;
  url: string; // blob URL — must be revoked by consumer
}

export interface PrismEngine {
  /** Current state */
  readonly state: EngineState;
  /** Detected tier */
  readonly tier: EngineTier | null;
  /** Load the WASM engine (lazy — call before first exec) */
  load(): Promise<void>;
  /** Run an ffmpeg command. Files must be mounted first. Returns exit code. */
  exec(args: string[]): Promise<number>;
  /** Write a file into the VFS */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Read a file from the VFS */
  readFile(path: string): Promise<Uint8Array>;
  /** Delete a file from the VFS */
  deleteFile(path: string): Promise<void>;
  /** List files in a VFS directory */
  listDir(path: string): Promise<string[]>;
  /** Create a directory in the VFS */
  mkdir(path: string): Promise<void>;
  /** Cancel the currently running operation */
  cancel(): Promise<void>;
  /** Probe a file for basic info (uses browser element heuristics and optionally ffmpeg) */
  probeFile(file: File): Promise<FileInfo>;
  /** Create a blob URL for output data */
  createOutputUrl(data: Uint8Array, mimeType: string): string;
  /** Return the last n log lines, useful for error reporting */
  getLastLogs(n: number): string[];
  /** Destroy the engine and free all resources */
  destroy(): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function detectCategory(file: File): FileInfo["category"] {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();

  if (t.startsWith("video/") || /\.(mp4|mkv|webm|avi|mov|flv|wmv|m4v|3gp|ogv|ts|mts)$/.test(n)) return "video";
  if (t.startsWith("audio/") || /\.(mp3|wav|flac|aac|ogg|opus|m4a|wma|aiff|ape|wv)$/.test(n)) return "audio";
  if (t.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|heic|heif|avif|svg|ico)$/.test(n)) return "image";
  if (/\.(srt|ass|ssa|vtt|sub|idx|smi|sami|lrc)$/.test(n)) return "subtitle";
  return "unknown";
}

export function isPrismSupportedFile(file: File): boolean {
  return detectCategory(file) !== "unknown";
}

export function translateError(raw: string): string {
  if (raw.includes("moov atom not found")) return "This file appears to be incomplete or corrupted. Try downloading it again.";
  if (raw.includes("Invalid data found when processing input")) return "Prism couldn't read this file. It might be in a format that isn't supported.";
  if (raw.includes("Output file is empty") || raw.includes("output file #0 does not contain")) return "Something went wrong — the output was empty. Try a different format or check the Terminal for details.";
  if (raw.includes("out of memory") || raw.includes("Cannot allocate memory") || raw.includes("OOM")) return "This file is too large for browser processing. Try a shorter clip or a smaller file.";
  if (raw.includes("Unknown encoder") || (raw.includes("Encoder") && raw.includes("not found"))) return "This codec isn't available in the browser version. Try a different output format.";
  if (raw.includes("Decoder") && raw.includes("not found")) return "This codec is not supported for decoding in the browser version. Try a different input format.";
  if (raw.includes("No such file")) return "An internal file wasn't found. This is a bug — please try again.";
  if (raw.includes("Permission denied")) return "File access was denied. This is likely a browser security restriction.";
  if (raw.includes("already running")) return "The engine is already busy processing. Please wait or cancel the current operation.";
  return "Something went wrong during processing. Check the Terminal for details.";
}

export function canUseSharedArrayBuffer(): boolean {
  try {
    return typeof SharedArrayBuffer !== "undefined";
  } catch {
    return false;
  }
}

// ─── Engine Factory ──────────────────────────────────────────────────────────

export function createEngine(callbacks: EngineCallbacks = {}): PrismEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ffmpeg: any = null;
  let state: EngineState = "idle";
  let tier: EngineTier | null = null;
  let destroyed = false;
  let cancelling = false;
  let probing = false;
  let lastLogLines: string[] = [];
  let durationSec = 0;
  let startTime = 0;
  const blobUrls: string[] = [];

  const LOG_BUFFER = 2000;

  function setState(s: EngineState): void {
    if (destroyed) return;
    state = s;
    callbacks.onStateChange?.(s);
  }

  function log(msg: string): void {
    if (destroyed) return;
    lastLogLines.push(msg);
    if (lastLogLines.length > LOG_BUFFER) lastLogLines.shift();
    callbacks.onLog?.(msg);
  }

  // Log handler: extract duration for ETA calculation and forward to terminal.
  // Does NOT emit progress events — that is done exclusively in the progress handler.
  function handleLogMessage(msg: string): void {
    log(msg);

    // Extract duration from "Duration: HH:MM:SS.ms" — needed for ETA
    const durMatch = msg.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (durMatch) {
      durationSec =
        parseInt(durMatch[1]) * 3600 +
        parseInt(durMatch[2]) * 60 +
        parseInt(durMatch[3]) +
        parseInt(durMatch[4]) / 100;
    }
  }

  async function load(): Promise<void> {
    if (destroyed) return;
    if (state === "ready" || state === "loading") return;

    setState("loading");
    lastLogLines = [];

    try {
      // Dynamically import from CDN — no npm dependencies
      const ffmpegModule = await import(/* @vite-ignore */ `${FFMPEG_CDN}/index.js`);
      const utilModule = await import(/* @vite-ignore */ `${UTIL_CDN}/index.js`);

      const FFmpeg = ffmpegModule.FFmpeg;
      const toBlobURL = utilModule.toBlobURL;

      ffmpeg = new FFmpeg();

      // Wire up logging — only extracts duration, does NOT emit progress
      ffmpeg.on("log", ({ message }: { message: string }) => {
        handleLogMessage(message);
      });

      // Progress events are the single source of truth for ratio/speed/eta
      ffmpeg.on("progress", ({ progress, time }: { progress: number; time: number }) => {
        if (destroyed) return;
        const elapsed = (performance.now() - startTime) / 1000;
        const timeSec = time / 1_000_000; // ffmpeg reports time in microseconds

        // When duration is unknown (images, some formats), signal indeterminate
        if (durationSec === 0) {
          callbacks.onProgress?.({ ratio: -1, speed: null, eta: null, time: timeSec });
          return;
        }

        const speed = elapsed > 0.5 && timeSec > 0 ? timeSec / elapsed : null;
        const eta =
          progress > 0.01 && durationSec > 0 && speed && speed > 0
            ? (durationSec - timeSec) / speed
            : null;

        callbacks.onProgress?.({
          ratio: Math.min(Math.max(progress, 0), 1),
          speed: speed ? Math.round(speed * 10) / 10 : null,
          eta: eta ? Math.round(eta) : null,
          time: timeSec,
        });
      });

      // Detect tier and load appropriate core
      const useMultiThread = canUseSharedArrayBuffer();
      tier = useMultiThread ? "enhanced" : "baseline";

      const coreCDN = useMultiThread ? CORE_MT_CDN : CORE_CDN;

      // Convert CDN URLs to blob URLs — required by ffmpeg.wasm to avoid CORS hangs
      log(`loading ${tier} engine...`);
      const coreURL = await toBlobURL(`${coreCDN}/ffmpeg-core.js`, "text/javascript");
      const wasmURL = await toBlobURL(`${coreCDN}/ffmpeg-core.wasm`, "application/wasm");
      const workerURL = useMultiThread
        ? await toBlobURL(`${coreCDN}/ffmpeg-core.worker.js`, "text/javascript")
        : undefined;

      await ffmpeg.load({ coreURL, wasmURL, workerURL });
      log(`engine ready (${tier})`);

      // Create working directories
      await ffmpeg.createDir("/input");
      await ffmpeg.createDir("/output");

      setState("ready");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      log(`engine load failed: ${raw}`);
      setState("error");
      callbacks.onError?.({
        message: "Failed to load the processing engine. Check your internet connection and try again.",
        raw,
        code: "load_failed",
      });
    }
  }

  async function exec(args: string[]): Promise<number> {
    if (destroyed) return -1;

    if (state === "running" || probing) {
      const err = new Error("already running");
      callbacks.onError?.({
        message: translateError("already running"),
        raw: err.message,
        code: "exec_failed",
      });
      return -1;
    }

    if (state !== "ready") {
      throw new Error("Engine not ready. Call load() first.");
    }

    setState("running");
    durationSec = 0;
    startTime = performance.now();
    lastLogLines = [];

    log(`$ ffmpeg ${args.join(" ")}`);

    try {
      const ret = await ffmpeg.exec(args);
      if (destroyed) return ret ?? -1;

      if (ret !== 0) {
        const raw = lastLogLines.slice(-10).join("\n");
        setState("ready");
        callbacks.onError?.({
          message: translateError(raw),
          raw,
          code: "exec_failed",
        });
        return ret;
      }

      setState("ready");
      return ret;
    } catch (err) {
      if (destroyed) return -1;
      const raw = err instanceof Error ? err.message : String(err);

      if (raw.includes("abort") || raw.includes("terminated") || cancelling) {
        // State will be set by cancel() after terminate completes
        if (!cancelling) setState("ready");
        callbacks.onError?.({
          message: "Operation cancelled.",
          raw,
          code: "cancelled",
        });
        return -1;
      }

      log(`exec error: ${raw}`);
      setState("error");
      callbacks.onError?.({
        message: translateError(raw),
        raw,
        code: raw.includes("memory") || raw.includes("OOM") ? "oom" : "exec_failed",
      });
      return -1;
    }
  }

  async function writeFile(path: string, data: Uint8Array): Promise<void> {
    if (destroyed || !ffmpeg) return;
    await ffmpeg.writeFile(path, data);
  }

  async function readFile(path: string): Promise<Uint8Array> {
    if (destroyed || !ffmpeg) throw new Error("Engine destroyed");
    const data = await ffmpeg.readFile(path);
    if (data instanceof Uint8Array) return data;
    // ffmpeg.wasm may return a string for text files
    return new TextEncoder().encode(data as string);
  }

  async function deleteFile(path: string): Promise<void> {
    if (destroyed || !ffmpeg) return;
    try {
      await ffmpeg.deleteFile(path);
    } catch {
      // file may not exist — that's fine
    }
  }

  async function listDir(path: string): Promise<string[]> {
    if (destroyed || !ffmpeg) return [];
    try {
      const entries = await ffmpeg.listDir(path);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return entries
        .filter((e: any) => !e.isDir && e.name !== "." && e.name !== "..")
        .map((e: any) => e.name);
    } catch {
      return [];
    }
  }

  async function mkdir(path: string): Promise<void> {
    if (destroyed || !ffmpeg) return;
    try {
      await ffmpeg.createDir(path);
    } catch {
      // directory may already exist
    }
  }

  async function cancel(): Promise<void> {
    if (destroyed || !ffmpeg || state !== "running") return;
    if (cancelling) return;

    cancelling = true;
    log("cancelling...");

    const instanceToTerminate = ffmpeg;
    ffmpeg = null;

    try {
      instanceToTerminate.terminate();
    } catch {
      // ignore terminate errors
    }

    cancelling = false;

    // Reset to idle so load() guard allows re-entry (it skips "ready" and "loading")
    setState("idle");

    // Reload engine for next use
    await load();
  }

  // ─── probeFile: two-path implementation ────────────────────────────────────
  // Path A: browser <video>/<audio> element for files the browser can play.
  // Path B: if engine is loaded, use ffmpeg -i to get deeper codec/resolution info.

  function probeViaBrowserElement(file: File, info: FileInfo): Promise<FileInfo> {
    return new Promise((resolve) => {
      const category = info.category;
      if (category !== "video" && category !== "audio") {
        resolve(info);
        return;
      }

      const el = document.createElement(category) as HTMLVideoElement | HTMLAudioElement;
      const url = URL.createObjectURL(file);
      el.preload = "metadata";

      const cleanup = () => {
        URL.revokeObjectURL(url);
        el.removeAttribute("src");
      };

      el.onloadedmetadata = () => {
        info.duration = isFinite(el.duration) ? el.duration : null;
        if (category === "video" && el instanceof HTMLVideoElement) {
          const w = el.videoWidth;
          const h = el.videoHeight;
          if (w > 0 && h > 0) {
            info.resolution = `${w}x${h}`;
          }
        }
        cleanup();
        resolve(info);
      };

      el.onerror = () => {
        cleanup();
        resolve(info); // still resolve — duration just stays null
      };

      el.src = url;
    });
  }

  function parseFfmpegProbeOutput(stderr: string[], info: FileInfo): void {
    for (const line of stderr) {
      // Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s
      const durMatch = line.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (durMatch && info.duration === null) {
        info.duration =
          parseInt(durMatch[1]) * 3600 +
          parseInt(durMatch[2]) * 60 +
          parseInt(durMatch[3]) +
          parseInt(durMatch[4]) / 100;
      }

      // bitrate: 1234 kb/s
      const bitrateMatch = line.match(/bitrate:\s*(\d+)\s*kb\/s/);
      if (bitrateMatch && info.bitrate === null) {
        info.bitrate = parseInt(bitrateMatch[1]);
      }

      // Video stream: Stream #0:0: Video: h264 (High), yuv420p, 1920x1080 ...
      const videoStreamMatch = line.match(/Stream.*Video:\s*([\w\d]+).*?,.*?(\d{2,5})x(\d{2,5})/);
      if (videoStreamMatch) {
        if (info.videoCodec === null) info.videoCodec = videoStreamMatch[1];
        if (info.resolution === null) {
          info.resolution = `${videoStreamMatch[2]}x${videoStreamMatch[3]}`;
        }
      }

      // Audio stream: Stream #0:1: Audio: aac, 44100 Hz, stereo, fltp, 128 kb/s
      const audioStreamMatch = line.match(/Stream.*Audio:\s*([\w\d]+)/);
      if (audioStreamMatch && info.audioCodec === null) {
        info.audioCodec = audioStreamMatch[1];
      }

      // Channels: stereo = 2, mono = 1, 5.1 = 6, etc.
      if (line.includes("Audio:") && info.channels === null) {
        if (/\bstereo\b/i.test(line)) info.channels = 2;
        else if (/\bmono\b/i.test(line)) info.channels = 1;
        else if (/\b5\.1\b/.test(line)) info.channels = 6;
        else if (/\b7\.1\b/.test(line)) info.channels = 8;
        else {
          // try to grab explicit channel count like "2 channels"
          const chMatch = line.match(/(\d+)\s+channels?/i);
          if (chMatch) info.channels = parseInt(chMatch[1]);
        }
      }
    }
  }

  async function probeViaFfmpeg(file: File, info: FileInfo): Promise<FileInfo> {
    if (!ffmpeg || state === "running" || probing) return info;

    const probePath = `/probe/${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    probing = true;
    try {
      // Ensure probe directory exists
      try { await ffmpeg.createDir("/probe"); } catch { /* may exist */ }

      // Write file into VFS
      const data = await readFileAsUint8Array(file);
      await ffmpeg.writeFile(probePath, data);

      // Capture log lines produced during probe
      const probeLines: string[] = [];
      const probeHandler = ({ message }: { message: string }) => {
        probeLines.push(message);
      };
      ffmpeg.on("log", probeHandler);

      // Run ffmpeg -i which will fail (no output) but emit stream info to stderr
      try {
        await ffmpeg.exec(["-i", probePath]);
      } catch {
        // expected to fail — we only care about the log output
      }

      ffmpeg.off("log", probeHandler);

      // Clean up probe file
      try { await ffmpeg.deleteFile(probePath); } catch { /* noop */ }

      parseFfmpegProbeOutput(probeLines, info);
    } catch {
      // probe failure is non-fatal — return whatever info we have
    } finally {
      probing = false;
    }

    return info;
  }

  async function probeFile(file: File): Promise<FileInfo> {
    const category = detectCategory(file);

    const info: FileInfo = {
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

    if (state === "ready" && ffmpeg) {
      // Path B: engine is available — use ffmpeg for deep probe
      await probeViaFfmpeg(file, info);
      // Fill in any gaps with browser element
      if (info.duration === null && (category === "video" || category === "audio")) {
        await probeViaBrowserElement(file, info);
      }
    } else if (category === "video" || category === "audio") {
      // Path A: browser element quick probe
      await probeViaBrowserElement(file, info);
    }

    return info;
  }

  function createOutputUrl(data: Uint8Array, mimeType: string): string {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    return url;
  }

  function getLastLogs(n: number): string[] {
    if (n <= 0) return [];
    return lastLogLines.slice(-n);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;

    // Revoke all blob URLs
    for (const url of blobUrls) {
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
    }
    blobUrls.length = 0;

    // Terminate ffmpeg
    if (ffmpeg) {
      try { ffmpeg.terminate(); } catch { /* noop */ }
      ffmpeg = null;
    }

    lastLogLines = [];
  }

  return {
    get state() { return state; },
    get tier() { return tier; },
    load,
    exec,
    writeFile,
    readFile,
    deleteFile,
    listDir,
    mkdir,
    cancel,
    probeFile,
    createOutputUrl,
    getLastLogs,
    destroy,
  };
}

// ─── Utility: read a File into Uint8Array (no dependency needed) ─────────────

export function readFileAsUint8Array(file: File): Promise<Uint8Array> {
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

// ─── Utility: size warning level ─────────────────────────────────────────────

export type SizeWarning = "none" | "caution" | "warning";

export function checkFileSize(bytes: number, isMobile: boolean): SizeWarning {
  const cautionThreshold = isMobile ? 250 * 1024 * 1024 : 500 * 1024 * 1024;
  const warningThreshold = isMobile ? 600 * 1024 * 1024 : 1200 * 1024 * 1024;
  if (bytes > warningThreshold) return "warning";
  if (bytes > cautionThreshold) return "caution";
  return "none";
}

export function isMobileDevice(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 0 && window.innerWidth < 768);
}

// ─── MIME type helpers ───────────────────────────────────────────────────────

export function mimeForExtension(ext: string): string {
  const map: Record<string, string> = {
    mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/opus", m4a: "audio/mp4",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    srt: "text/plain", vtt: "text/vtt", ass: "text/plain", ssa: "text/plain",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}
