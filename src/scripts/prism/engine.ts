// prism-engine.ts — ffmpeg.wasm wrapper.
// Loads ffmpeg class + core assets from CDN with failover + cache.
// and picks single-thread (baseline) or multi-thread (enhanced) automatically.
// All state is scoped inside createEngine() for clean Astro lifecycle teardown.

// ─── CDN URLs ────────────────────────────────────────────────────────────────

interface EngineCdnProvider {
  name: string;
  ffmpeg: string;
  core: string;
  coreMt: string;
}

const ENGINE_CDN_PROVIDERS: EngineCdnProvider[] = [
  {
    name: "jsDelivr",
    ffmpeg: "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm",
    core: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm",
    coreMt: "https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm",
  },
  {
    name: "unpkg",
    ffmpeg: "https://unpkg.com/@ffmpeg/ffmpeg@0.12.15/dist/esm",
    core: "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm",
    coreMt: "https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/esm",
  },
];

export const PRISM_ENGINE_ASSET_CACHE = "prism-ffmpeg-assets-v1";

function getEngineAssetUrlsForProvider(provider: EngineCdnProvider, useMultiThread: boolean): string[] {
  const coreCDN = useMultiThread ? provider.coreMt : provider.core;
  const assetUrls: string[] = [
    `${provider.ffmpeg}/worker.js`,
    `${coreCDN}/ffmpeg-core.js`,
    `${coreCDN}/ffmpeg-core.wasm`,
  ];
  if (useMultiThread) assetUrls.push(`${coreCDN}/ffmpeg-core.worker.js`);
  return assetUrls;
}

async function isEngineProviderFullyCached(provider: EngineCdnProvider, useMultiThread: boolean): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(PRISM_ENGINE_ASSET_CACHE);
    const urls = getEngineAssetUrlsForProvider(provider, useMultiThread);
    const matches = await Promise.all(urls.map((url) => cache.match(url)));
    return matches.every(Boolean);
  } catch {
    return false;
  }
}

async function getPreferredEngineProviders(useMultiThread: boolean): Promise<EngineCdnProvider[]> {
  if (typeof caches === "undefined") return ENGINE_CDN_PROVIDERS;
  try {
    const warmFlags = await Promise.all(
      ENGINE_CDN_PROVIDERS.map(async (provider) => ({
        provider,
        warm: await isEngineProviderFullyCached(provider, useMultiThread),
      })),
    );

    const warmProviders = warmFlags.filter((p) => p.warm).map((p) => p.provider);
    if (warmProviders.length === 0) return ENGINE_CDN_PROVIDERS;
    const coldProviders = warmFlags.filter((p) => !p.warm).map((p) => p.provider);
    return [...warmProviders, ...coldProviders];
  } catch {
    return ENGINE_CDN_PROVIDERS;
  }
}

/**
 * Returns true only if *all* ffmpeg core assets required for this browser tier are already present in CacheStorage.
 * This is used to decide whether Prism should auto-warm the engine without triggering a CDN download.
 */
export async function arePrismEngineAssetsCached(): Promise<boolean> {
  const useMultiThread = canUseSharedArrayBuffer();
  for (const provider of ENGINE_CDN_PROVIDERS) {
    // eslint-disable-next-line no-await-in-loop
    if (await isEngineProviderFullyCached(provider, useMultiThread)) return true;
  }
  return false;
}

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
  category: "video" | "audio" | "image" | "subtitle" | "markdown" | "pdf" | "text" | "unknown";
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

export interface LoadProgressEvent {
  loadedBytes: number;
  totalBytes: number;
  ratio: number;
}

export interface EngineCallbacks {
  onStateChange?: (state: EngineState) => void;
  onProgress?: (progress: ProgressEvent) => void;
  onLoadProgress?: (progress: LoadProgressEvent) => void;
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
  /** Swap event callbacks without recreating the engine */
  setCallbacks(callbacks: EngineCallbacks): void;
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
  if (/\.txt$/.test(n)) return "markdown";
  if (/\.(md|markdown)$/.test(n)) return "markdown";
  if (t === "application/pdf" || /\.pdf$/.test(n)) return "pdf";
  if (/\.(json|xml|ya?ml|toml|csv|tsv|log|ini|cfg|conf)$/.test(n)) return "text";
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
    return typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
  } catch {
    return false;
  }
}

// ─── Engine Factory ──────────────────────────────────────────────────────────

export function createEngine(callbacks: EngineCallbacks = {}): PrismEngine {
  let activeCallbacks: EngineCallbacks = callbacks;
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
  const assetBlobUrlCache = new Map<string, string>();

  const LOG_BUFFER = 2000;
  const IMPORT_TIMEOUT_MS = 15000;
  const ASSET_FETCH_TIMEOUT_MS = 60000;
  const ENGINE_BOOT_TIMEOUT_MS = 90000;
  const ENGINE_ASSET_CACHE = PRISM_ENGINE_ASSET_CACHE;

  function setState(s: EngineState): void {
    if (destroyed) return;
    state = s;
    activeCallbacks.onStateChange?.(s);
  }

  function log(msg: string): void {
    if (destroyed) return;
    lastLogLines.push(msg);
    if (lastLogLines.length > LOG_BUFFER) lastLogLines.shift();
    activeCallbacks.onLog?.(msg);
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

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function fetchEngineAsset(url: string): Promise<Response> {
    if (typeof caches === "undefined") {
      return fetch(url, { method: "GET", mode: "cors" });
    }

    const cache = await caches.open(ENGINE_ASSET_CACHE);
    const cached = await cache.match(url);
    if (cached) {
      return cached;
    }

    const response = await fetch(url, { method: "GET", mode: "cors" });
    if (response.ok) {
      try {
        await cache.put(url, response.clone());
      } catch {
        // cache put can fail due to quota/private mode; continue with network response
      }
    }
    return response;
  }

  async function getAssetSize(url: string): Promise<number | null> {
    try {
      if (typeof caches !== "undefined") {
        const cache = await caches.open(ENGINE_ASSET_CACHE);
        const cached = await cache.match(url);
        if (cached) {
          const blob = await cached.blob();
          return blob.size;
        }
      }

      const response = await fetch(url, { method: "HEAD", mode: "cors" });
      if (!response.ok) return null;
      const len = response.headers.get("content-length");
      if (!len) return null;
      const size = parseInt(len, 10);
      return Number.isFinite(size) && size > 0 ? size : null;
    } catch {
      return null;
    }
  }

  async function createBlobUrlFromRemote(
    url: string,
    mimeType: string,
    options?: { knownSize?: number | null; onChunk?: (bytes: number) => void },
  ): Promise<string> {
    const existing = assetBlobUrlCache.get(url);
    if (existing) {
      if (options?.knownSize && options.knownSize > 0) {
        options.onChunk?.(options.knownSize);
      }
      return existing;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ASSET_FETCH_TIMEOUT_MS);

    try {
      const response = await withTimeout(
        fetchEngineAsset(url),
        ASSET_FETCH_TIMEOUT_MS,
        `asset request (${url})`,
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      let blob: Blob;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let done = false;
        while (!done) {
          const next = await reader.read();
          done = next.done;
          if (!next.value || next.value.length === 0) continue;
          chunks.push(next.value);
          options?.onChunk?.(next.value.length);
        }
        // TS DOM lib typing is strict about BlobPart requiring ArrayBuffer-backed views.
        // Convert chunks to ArrayBuffer to avoid Uint8Array<ArrayBufferLike> incompatibility.
        const parts = chunks.map((chunk) => {
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          return copy.buffer;
        });
        blob = new Blob(parts, { type: mimeType });
      } else {
        const buffer = await response.arrayBuffer();
        options?.onChunk?.(buffer.byteLength);
        blob = new Blob([buffer], { type: mimeType });
      }

      const blobUrl = URL.createObjectURL(blob);
      blobUrls.push(blobUrl);
      assetBlobUrlCache.set(url, blobUrl);
      return blobUrl;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`asset fetch failed (${url}): ${raw}`);
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function createPatchedClassWorkerUrl(ffmpegBaseUrl: string): Promise<string> {
    const workerScriptUrl = `${ffmpegBaseUrl}/worker.js`;
    const cacheKey = `${workerScriptUrl}::patched`;
    const existing = assetBlobUrlCache.get(cacheKey);
    if (existing) return existing;

    const response = await withTimeout(
      fetchEngineAsset(workerScriptUrl),
      ASSET_FETCH_TIMEOUT_MS,
      `asset request (${workerScriptUrl})`,
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${workerScriptUrl}`);
    }

    const source = await response.text();
    const patched = source
      .replaceAll('from "./const.js"', `from "${ffmpegBaseUrl}/const.js"`)
      .replaceAll('from "./errors.js"', `from "${ffmpegBaseUrl}/errors.js"`);

    const blobUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
    blobUrls.push(blobUrl);
    assetBlobUrlCache.set(cacheKey, blobUrl);
    return blobUrl;
  }

  async function load(): Promise<void> {
    if (destroyed) return;
    if (state === "ready" || state === "loading") return;

    setState("loading");
    lastLogLines = [];

    try {
      // Detect tier and load appropriate core
      const useMultiThread = canUseSharedArrayBuffer();
      tier = useMultiThread ? "enhanced" : "baseline";

      const providerOrder = await getPreferredEngineProviders(useMultiThread);

      let lastLoadError: unknown = null;

      for (const provider of providerOrder) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let candidate: any = null;
        try {
          log(`loading ${tier} engine via ${provider.name}...`);

          const ffmpegModule = await withTimeout(
            import(/* @vite-ignore */ `${provider.ffmpeg}/index.js`),
            IMPORT_TIMEOUT_MS,
            `${provider.name} module import`,
          );

          const FFmpeg = ffmpegModule.FFmpeg;
          if (typeof FFmpeg !== "function") {
            throw new Error(`invalid FFmpeg module from ${provider.name}`);
          }

          candidate = new FFmpeg();

          candidate.on("log", ({ message }: { message: string }) => {
            handleLogMessage(message);
          });

          candidate.on("progress", ({ progress, time }: { progress: number; time: number }) => {
            if (destroyed) return;
            const elapsed = (performance.now() - startTime) / 1000;
            const timeSec = time / 1_000_000;

            if (durationSec === 0) {
              activeCallbacks.onProgress?.({ ratio: -1, speed: null, eta: null, time: timeSec });
              return;
            }

            const speed = elapsed > 0.5 && timeSec > 0 ? timeSec / elapsed : null;
            const eta =
              progress > 0.01 && durationSec > 0 && speed && speed > 0
                ? (durationSec - timeSec) / speed
                : null;

            activeCallbacks.onProgress?.({
              ratio: Math.min(Math.max(progress, 0), 1),
              speed: speed ? Math.round(speed * 10) / 10 : null,
              eta: eta ? Math.round(eta) : null,
              time: timeSec,
            });
          });

          const coreCDN = useMultiThread ? provider.coreMt : provider.core;
          log(`fetching assets via ${provider.name}...`);
          const assetUrls: string[] = [
            `${provider.ffmpeg}/worker.js`,
            `${coreCDN}/ffmpeg-core.js`,
            `${coreCDN}/ffmpeg-core.wasm`,
          ];
          if (useMultiThread) {
            assetUrls.push(`${coreCDN}/ffmpeg-core.worker.js`);
          }

          const assetSizes = new Map<string, number | null>();
          await Promise.all(assetUrls.map(async (assetUrl) => {
            assetSizes.set(assetUrl, await getAssetSize(assetUrl));
          }));

          const totalBytes = assetUrls.reduce((sum, assetUrl) => sum + (assetSizes.get(assetUrl) ?? 0), 0);
          let loadedBytes = 0;
          const reportLoadProgress = (): void => {
            activeCallbacks.onLoadProgress?.({
              loadedBytes,
              totalBytes,
              ratio: totalBytes > 0 ? Math.min(loadedBytes / totalBytes, 1) : 0,
            });
          };
          reportLoadProgress();

          const classWorkerURL = await createPatchedClassWorkerUrl(provider.ffmpeg);
          loadedBytes += assetSizes.get(`${provider.ffmpeg}/worker.js`) ?? 0;
          reportLoadProgress();

          const coreJsUrl = `${coreCDN}/ffmpeg-core.js`;
          const coreWasmUrl = `${coreCDN}/ffmpeg-core.wasm`;
          const coreURL = await createBlobUrlFromRemote(coreJsUrl, "text/javascript", {
            knownSize: assetSizes.get(coreJsUrl),
            onChunk: (bytes) => {
              loadedBytes += bytes;
              reportLoadProgress();
            },
          });
          const wasmURL = await createBlobUrlFromRemote(coreWasmUrl, "application/wasm", {
            knownSize: assetSizes.get(coreWasmUrl),
            onChunk: (bytes) => {
              loadedBytes += bytes;
              reportLoadProgress();
            },
          });
          const workerURL = useMultiThread
            ? await createBlobUrlFromRemote(`${coreCDN}/ffmpeg-core.worker.js`, "text/javascript", {
                knownSize: assetSizes.get(`${coreCDN}/ffmpeg-core.worker.js`),
                onChunk: (bytes) => {
                  loadedBytes += bytes;
                  reportLoadProgress();
                },
              })
            : undefined;

          log(`initializing runtime via ${provider.name}...`);
          await withTimeout(
            candidate.load({ classWorkerURL, coreURL, wasmURL, workerURL }),
            ENGINE_BOOT_TIMEOUT_MS,
            `${provider.name} engine bootstrap`,
          );
          try { await candidate.createDir("/input"); } catch { /* may already exist */ }
          try { await candidate.createDir("/output"); } catch { /* may already exist */ }

          ffmpeg = candidate;
          activeCallbacks.onLoadProgress?.({ loadedBytes: totalBytes, totalBytes, ratio: 1 });
          log(`engine ready \u2014 ${tier} via ${provider.name}`);
          setState("ready");
          return;
        } catch (err) {
          lastLoadError = err;
          const raw = err instanceof Error ? err.message : String(err);
          log(`engine load failed via ${provider.name}: ${raw}`);
          try {
            candidate?.terminate?.();
          } catch {
            // best effort
          }
        }
      }

      throw (lastLoadError ?? new Error("No engine CDN provider succeeded"));
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      log(`engine load failed: ${raw}`);
      setState("error");
      activeCallbacks.onError?.({
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
      activeCallbacks.onError?.({
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
        activeCallbacks.onError?.({
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
        activeCallbacks.onError?.({
          message: "Operation cancelled.",
          raw,
          code: "cancelled",
        });
        return -1;
      }

      log(`exec error: ${raw}`);
      setState("error");
      activeCallbacks.onError?.({
        message: translateError(raw),
        raw,
        code: raw.includes("memory") || raw.includes("OOM") ? "oom" : "exec_failed",
      });
      return -1;
    }
  }

  function setCallbacks(nextCallbacks: EngineCallbacks): void {
    activeCallbacks = nextCallbacks;
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
  // Path B: if engine is loaded, use native ffprobe for structured JSON probe.

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

  function parseProbeLogOutput(logText: string, info: FileInfo): void {
    // Duration: 00:05:23.45, bitrate: 1234 kb/s
    if (info.duration === null) {
      const durMatch = logText.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (durMatch) {
        const d = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
        if (isFinite(d) && d > 0) info.duration = d;
      }
    }

    if (info.bitrate === null) {
      const brMatch = logText.match(/bitrate:\s*(\d+)\s*kb\/s/);
      if (brMatch) {
        info.bitrate = parseInt(brMatch[1]);
      }
    }

    // Video stream: "Stream #0:0: Video: h264 ..., 1920x1080, ..."
    const videoLine = logText.match(/Stream\s+#\d+:\d+.*?Video:\s*(\w+)[^\n]*/);
    if (videoLine) {
      if (info.videoCodec === null) {
        info.videoCodec = videoLine[1];
      }
      if (info.resolution === null) {
        const resMatch = videoLine[0].match(/\b(\d{2,5})x(\d{2,5})\b/);
        if (resMatch) {
          info.resolution = `${resMatch[1]}x${resMatch[2]}`;
        }
      }
    }

    // Audio stream: "Stream #0:1: Audio: aac ..., 44100 Hz, stereo, ..."
    const audioLine = logText.match(/Stream\s+#\d+:\d+.*?Audio:\s*(\w+)[^\n]*/);
    if (audioLine) {
      if (info.audioCodec === null) {
        info.audioCodec = audioLine[1];
      }
      if (info.channels === null) {
        const chMatch = audioLine[0].match(/\b(mono|stereo|5\.1|7\.1)\b|(\d+)\s*channels/i);
        if (chMatch) {
          if (chMatch[1] === "mono") info.channels = 1;
          else if (chMatch[1] === "stereo") info.channels = 2;
          else if (chMatch[1] === "5.1") info.channels = 6;
          else if (chMatch[1] === "7.1") info.channels = 8;
          else if (chMatch[2]) info.channels = parseInt(chMatch[2]);
        }
      }
    }
  }

  async function probeViaFfprobe(file: File, info: FileInfo): Promise<FileInfo> {
    if (!ffmpeg || state === "running" || probing) return info;

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const probePath = `/probe/${safeName}`;

    probing = true;
    try {
      try { await ffmpeg.createDir("/probe"); } catch { /* may exist */ }

      const data = await readFileAsUint8Array(file);
      await ffmpeg.writeFile(probePath, data);

      // ffmpeg.wasm has no ffprobe — run `ffmpeg -i` to extract stream info from log output
      const logBefore = lastLogLines.length;
      await ffmpeg.exec(["-i", probePath]);

      const probeOutput = lastLogLines.slice(logBefore).join("\n");
      parseProbeLogOutput(probeOutput, info);

      try { await ffmpeg.deleteFile(probePath); } catch { /* noop */ }
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

    const isMedia = category === "video" || category === "audio" || category === "image" || category === "subtitle";
    if (state === "ready" && ffmpeg && isMedia) {
      // Path B: engine is available — use native ffprobe for structured probe
      await probeViaFfprobe(file, info);
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
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const blob = new Blob([copy.buffer], { type: mimeType });
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
    assetBlobUrlCache.clear();

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
    setCallbacks,
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
    html: "text/html", md: "text/markdown", pdf: "application/pdf",
    txt: "text/plain", json: "application/json", xml: "application/xml",
    yaml: "text/yaml", yml: "text/yaml", toml: "text/plain",
    csv: "text/csv", tsv: "text/tab-separated-values", log: "text/plain",
    ini: "text/plain", cfg: "text/plain", conf: "text/plain",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}
