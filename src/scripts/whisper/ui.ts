import {
  WhisperEngine,
  type WhisperHuntCarrier,
  type WhisperHuntMatch,
  type WhisperExtractPayload,
} from "./wasm";
import {
  q,
  asInput,
  asButton,
  asPre,
  clearNode,
  formatSize,
  fileToBytes,
  copyToClipboard,
  flashText,
  appendToLog,
  setLogDotActive,
} from "./ui-helpers";

/* ── Interface & IDs ───────────────────────────────────── */

export interface WhisperUIOptions {
  page: HTMLElement;
  modeButtons: NodeListOf<HTMLButtonElement>;
  uploadZone: HTMLElement;
  carrierInput: HTMLInputElement;
  huntCarrierInput: HTMLInputElement;
  payloadInput: HTMLInputElement;
  passwordInput: HTMLInputElement;
  passwordGenButton: HTMLButtonElement;
  passwordCopyButton: HTMLButtonElement;
  passwordPasteButton: HTMLButtonElement;
  passwordMeta: HTMLElement;
  onlyDecodeHereInput: HTMLInputElement;
  allowTailFallbackInput: HTMLInputElement;
  clueInput: HTMLInputElement;
  opTitle: HTMLElement;
  runButton: HTMLButtonElement;
  uploadButton: HTMLButtonElement;
  clearButton: HTMLButtonElement;
  actionsBar: HTMLElement;
  statusLine: HTMLElement;
  logOutput: HTMLPreElement;
  logDot: HTMLElement;
  results: HTMLElement;
  downloadArea: HTMLElement;
  progressSection: HTMLElement;
  progressFill: HTMLElement;
  uploadText: HTMLElement;
  uploadMeta: HTMLElement;
  huntLabel: HTMLElement;
  payloadLabel: HTMLElement;
}

export const WHISPER_UI_IDS = {
  page: "whisper-page",
  uploadZone: "whisper-upload-zone",
  carrierInput: "whisper-carrier-input",
  huntCarrierInput: "whisper-hunt-carrier-input",
  payloadInput: "whisper-payload-input",
  passwordInput: "whisper-password-input",
  passwordGenButton: "whisper-password-gen",
  passwordCopyButton: "whisper-password-copy",
  passwordPasteButton: "whisper-password-paste",
  passwordMeta: "whisper-password-meta",
  onlyDecodeHereInput: "whisper-only-decode-here",
  allowTailFallbackInput: "whisper-allow-tail-fallback",
  clueInput: "whisper-clue-input",
  opTitle: "whisper-op-title",
  runButton: "whisper-action-run",
  uploadButton: "whisper-action-upload",
  clearButton: "whisper-action-clear",
  actionsBar: "whisper-actions",
  statusLine: "whisper-status-line",
  logOutput: "whisper-log-output",
  logDot: "whisper-log-dot",
  results: "whisper-results",
  downloadArea: "whisper-download-area",
  progressSection: "whisper-progress-section",
  progressFill: "whisper-progress-fill",
  uploadText: "whisper-upload-text",
  uploadMeta: "whisper-upload-meta",
  huntLabel: "whisper-hunt-label",
  payloadLabel: "whisper-payload-label",
} as const;

/* ── Constants ─────────────────────────────────────────── */

const MODE_EMBED = "embed";
const MODE_EXTRACT = "extract";
const MODE_HUNT = "hunt";
const MODE_LIVE = "live";
type WhisperMode = typeof MODE_EMBED | typeof MODE_EXTRACT | typeof MODE_HUNT | typeof MODE_LIVE;

const ACTION_BAR_FADE_MS = 200;
const MODE_LABELS: Record<WhisperMode, string> = {
  [MODE_EMBED]: "Embed",
  [MODE_EXTRACT]: "Extract",
  [MODE_HUNT]: "Hunt",
  [MODE_LIVE]: "Live",
};

/* ── DOM Helpers ───────────────────────────────────────── */

function isMode(value: string | null | undefined): value is WhisperMode {
  return value === MODE_EMBED || value === MODE_EXTRACT || value === MODE_HUNT || value === MODE_LIVE;
}

function readSingleFile(input: HTMLInputElement): File | null {
  return input.files?.[0] ?? null;
}

function uuidV4FromRandom(bytes: Uint8Array): string {
  // RFC4122 v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 12).join("")}-${hex.slice(12, 16).join("")}${hex.slice(16).join("")}`;
}

function generateUuidPassword(): string {
  if (typeof crypto === "undefined") throw new Error("Secure random unavailable.");
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return uuidV4FromRandom(bytes);
  }
  throw new Error("Secure random unavailable.");
}

/* ── Resolve ───────────────────────────────────────────── */

export function resolveWhisperUIOptions(root: ParentNode = document): WhisperUIOptions | null {
  const page = q(root, WHISPER_UI_IDS.page);
  const uploadZone = q(root, WHISPER_UI_IDS.uploadZone);
  const carrierInput = asInput(q(root, WHISPER_UI_IDS.carrierInput));
  const huntCarrierInput = asInput(q(root, WHISPER_UI_IDS.huntCarrierInput));
  const payloadInput = asInput(q(root, WHISPER_UI_IDS.payloadInput));
  const passwordInput = asInput(q(root, WHISPER_UI_IDS.passwordInput));
  const passwordGenButton = asButton(q(root, WHISPER_UI_IDS.passwordGenButton));
  const passwordCopyButton = asButton(q(root, WHISPER_UI_IDS.passwordCopyButton));
  const passwordPasteButton = asButton(q(root, WHISPER_UI_IDS.passwordPasteButton));
  const passwordMeta = q(root, WHISPER_UI_IDS.passwordMeta);
  const onlyDecodeHereInput = asInput(q(root, WHISPER_UI_IDS.onlyDecodeHereInput));
  const allowTailFallbackInput = asInput(q(root, WHISPER_UI_IDS.allowTailFallbackInput));
  const clueInput = asInput(q(root, WHISPER_UI_IDS.clueInput));
  const opTitle = q(root, WHISPER_UI_IDS.opTitle);
  const runButton = asButton(q(root, WHISPER_UI_IDS.runButton));
  const uploadButton = asButton(q(root, WHISPER_UI_IDS.uploadButton));
  const clearButton = asButton(q(root, WHISPER_UI_IDS.clearButton));
  const actionsBar = q(root, WHISPER_UI_IDS.actionsBar);
  const statusLine = q(root, WHISPER_UI_IDS.statusLine);
  const logOutput = asPre(q(root, WHISPER_UI_IDS.logOutput));
  const logDot = q(root, WHISPER_UI_IDS.logDot);
  const results = q(root, WHISPER_UI_IDS.results);
  const downloadArea = q(root, WHISPER_UI_IDS.downloadArea);
  const progressSection = q(root, WHISPER_UI_IDS.progressSection);
  const progressFill = q(root, WHISPER_UI_IDS.progressFill);
  const uploadText = q(root, WHISPER_UI_IDS.uploadText);
  const uploadMeta = q(root, WHISPER_UI_IDS.uploadMeta);
  const huntLabel = q(root, WHISPER_UI_IDS.huntLabel);
  const payloadLabel = q(root, WHISPER_UI_IDS.payloadLabel);
  const modeButtons = root.querySelectorAll<HTMLButtonElement>("[data-whisper-mode]");

  if (
    !page || !uploadZone || !carrierInput || !huntCarrierInput || !payloadInput ||
    !passwordInput || !passwordGenButton || !passwordCopyButton || !passwordPasteButton || !passwordMeta || !onlyDecodeHereInput || !allowTailFallbackInput || !clueInput || !runButton || !uploadButton || !clearButton ||
    !actionsBar || !statusLine || !opTitle || !logOutput || !logDot || !results || !downloadArea ||
    !progressSection || !progressFill ||
    !uploadText || !uploadMeta || !huntLabel || !payloadLabel || modeButtons.length === 0
  ) {
    return null;
  }

  return {
    page, modeButtons, uploadZone, carrierInput, huntCarrierInput, payloadInput,
    passwordInput, passwordGenButton, passwordCopyButton, passwordPasteButton, passwordMeta, onlyDecodeHereInput, allowTailFallbackInput, clueInput, runButton, uploadButton, clearButton, actionsBar,
    opTitle, statusLine, logOutput, logDot, results, downloadArea, progressSection, progressFill,
    uploadText, uploadMeta,
    huntLabel, payloadLabel,
  };
}

/* ── Init ──────────────────────────────────────────────── */

export function initWhisper(opts: WhisperUIOptions): () => void {
  const engine = new WhisperEngine();
  const savedMode = sessionStorage.getItem("whisper-mode");
  const savedCarrier = sessionStorage.getItem("whisper-carrier");
  let activeMode: WhisperMode = isMode(savedMode) ? savedMode : MODE_EMBED;
  let busy = false;
  let actionBarVisible = false;
  let liveLoggedReady = false;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  const releaseUrls = new Set<string>();
  const ac = new AbortController();
  const { signal } = ac;
  let passwordMetaTimer: ReturnType<typeof setTimeout> | null = null;

  function setPasswordMeta(text: string, ms = 1600): void {
    if (passwordMetaTimer !== null) { clearTimeout(passwordMetaTimer); passwordMetaTimer = null; }
    opts.passwordMeta.textContent = text;
    if (!text) return;
    passwordMetaTimer = setTimeout(() => {
      opts.passwordMeta.textContent = "";
      passwordMetaTimer = null;
    }, ms);
  }

  function syncOpTitle(): void {
    // Op title text is driven by markup+CSS using [data-mode] and [data-busy].
    opts.page.dataset.busy = busy ? "1" : "0";
  }

  function refreshUI(): void {
    syncState();
    syncGuidance();
  }

  /* ── Action bar visibility (rAF fade like Cage/Lens) ── */

  function showActionsBar(): void {
    if (actionBarVisible) return;
    actionBarVisible = true;
    if (fadeTimer !== null) { clearTimeout(fadeTimer); fadeTimer = null; }
    opts.actionsBar.style.display = "";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { opts.actionsBar.style.opacity = "1"; });
    });
  }

  function hideActionsBar(): void {
    if (!actionBarVisible) return;
    actionBarVisible = false;
    opts.actionsBar.style.opacity = "0";
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      opts.actionsBar.style.display = "none";
      fadeTimer = null;
    }, ACTION_BAR_FADE_MS);
  }

  /* ── Status & log ────────────────────────────────────── */

  function updateStatus(text: string): void {
    opts.statusLine.textContent = text;
  }

  function appendLog(line: string): void {
    appendToLog(opts.logOutput, line);
  }

  function clearLog(): void {
    opts.logOutput.textContent = "";
  }

  function setLogActive(active: boolean): void {
    setLogDotActive(opts.logDot, active);
  }

  /* ── Download & result helpers ───────────────────────── */

  function clearDownloads(): void {
    for (const url of releaseUrls) URL.revokeObjectURL(url);
    releaseUrls.clear();
    clearNode(opts.downloadArea);
  }

  function clearOutputs(): void {
    clearNode(opts.results);
    clearLog();
    clearDownloads();
  }

  function makeDownloadCard(
    title: string, fileName: string, mimeType: string, data: Uint8Array | Blob,
  ): { node: HTMLElement; url: string } {
    const blob = data instanceof Blob
      ? data
      : new Blob([new Uint8Array(data)], { type: mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const size = data instanceof Blob ? data.size : data.length;

    const card = document.createElement("div");
    card.className = "whisper-download-card";

    const titleEl = document.createElement("p");
    titleEl.className = "whisper-download-title";
    titleEl.textContent = title;

    const metaEl = document.createElement("p");
    metaEl.className = "whisper-download-meta";
    metaEl.textContent = `${fileName} \u00B7 ${formatSize(size)}`;

    const link = document.createElement("a");
    link.className = "whisper-download-link";
    link.href = url;
    link.download = fileName;
    link.textContent = "Download";

    card.append(titleEl, metaEl, link);
    return { node: card, url };
  }

  function addPayloadDownload(label: string, payload: WhisperExtractPayload): void {
    const card = makeDownloadCard(label, payload.name, payload.type, payload.bytes);
    releaseUrls.add(card.url);
    opts.downloadArea.appendChild(card.node);
  }

  function renderResult(text: string, tone: "ok" | "warn" | "error" = "ok"): void {
    const node = document.createElement("p");
    node.className = `whisper-result whisper-result--${tone}`;
    node.textContent = text;
    opts.results.appendChild(node);
  }

  /* ── State queries ───────────────────────────────────── */

  function hasCarrier(): boolean {
    return (opts.carrierInput.files?.length ?? 0) > 0;
  }

  function hasHuntFiles(): boolean {
    return (opts.huntCarrierInput.files?.length ?? 0) > 0;
  }

  function hasPayload(): boolean {
    return (opts.payloadInput.files?.length ?? 0) > 0;
  }

  function hasPassword(): boolean {
    return opts.passwordInput.value.length > 0;
  }

  function canRun(): boolean {
    if (busy) return false;
    if (activeMode === MODE_LIVE) return false;
    if (activeMode === MODE_EMBED && isCarrierUrl()) return false;
    const pw = hasPassword();
    switch (activeMode) {
      case MODE_EMBED: return hasCarrier() && hasPayload() && pw;
      case MODE_EXTRACT: return hasCarrier() && pw;
      case MODE_HUNT: return hasHuntFiles() && pw;
    }
  }

  /* ── Sync all button states ──────────────────────────── */

  function syncState(): void {
    if (activeMode === MODE_LIVE) return;
    if (activeMode === MODE_EMBED && isCarrierUrl()) return;

    // Run button: label reflects mode, disabled until prerequisites met
    opts.runButton.textContent = MODE_LABELS[activeMode];
    opts.runButton.disabled = !canRun();

    // Clear: enabled when anything is loaded
    opts.clearButton.disabled = busy || (!hasCarrier() && !hasHuntFiles() && !hasPayload());

    // Mode buttons locked while busy
    opts.modeButtons.forEach((btn) => { btn.disabled = busy; });

    // Password tools
    opts.passwordGenButton.disabled = busy;
    opts.passwordCopyButton.disabled = busy || !hasPassword();
  }

  /* ── Contextual guidance ────────────────────────────── */

  function syncGuidance(): void {
    if (busy) { opts.statusLine.classList.remove("whisper-status--ready"); return; }
    if (activeMode === MODE_LIVE) return;
    if (activeMode === MODE_EMBED && isCarrierUrl()) {
      updateStatus("steganography seal — compose below");
      opts.statusLine.classList.remove("whisper-status--ready");
      return;
    }
    let ready = false;
    switch (activeMode) {
      case MODE_EMBED:
        if (!hasCarrier()) { updateStatus("drop a carrier file"); break; }
        if (!hasPayload()) { updateStatus("add a payload file"); break; }
        if (!hasPassword()) { updateStatus("enter a password"); break; }
        updateStatus("all set"); ready = true; break;
      case MODE_EXTRACT:
        if (!hasCarrier()) { updateStatus("drop a carrier file"); break; }
        if (!hasPassword()) { updateStatus("enter a password"); break; }
        updateStatus("all set"); ready = true; break;
      case MODE_HUNT:
        if (!hasHuntFiles()) { updateStatus("choose carrier files to scan"); break; }
        if (!hasPassword()) { updateStatus("enter a password"); break; }
        updateStatus("all set"); ready = true; break;
    }
    opts.statusLine.classList.toggle("whisper-status--ready", ready);
  }

  /* ── Mode ────────────────────────────────────────────── */

  function isCarrierUrl(): boolean {
    return opts.page.dataset.carrier === "url";
  }

  function syncCarrier(isUrl: boolean): void {
    if (isUrl) {
      opts.page.dataset.carrier = "url";
      sessionStorage.setItem("whisper-carrier", "url");
    } else {
      delete opts.page.dataset.carrier;
      sessionStorage.removeItem("whisper-carrier");
    }
  }

  function setMode(mode: WhisperMode): void {
    activeMode = mode;
    opts.page.dataset.mode = mode;
    sessionStorage.setItem("whisper-mode", mode);

    if (mode === MODE_EMBED) {
      const urlRadio = opts.page.querySelector<HTMLInputElement>('input[name="ws-carrier-type"][value="url"]');
      syncCarrier(!!urlRadio?.checked);
    } else {
      syncCarrier(false);
    }

    syncOpTitle();
    opts.modeButtons.forEach((btn) => {
      const active = btn.dataset.whisperMode === mode;
      btn.classList.toggle("whisper-mode-btn--active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (mode === MODE_LIVE) {
      if (!liveLoggedReady) {
        liveLoggedReady = true;
        appendLog("live ready");
      }
      hideActionsBar();
    } else if (mode === MODE_EMBED && isCarrierUrl()) {
      hideActionsBar();
    } else {
      opts.passwordInput.placeholder = mode === MODE_EMBED ? "password to encrypt" : "password to decrypt";
    }
    refreshUI();
  }

  /* ── Upload zone state ───────────────────────────────── */

  function compactUploadZone(): void {
    opts.uploadZone.classList.add("whisper-upload-zone--compact");
  }

  function expandUploadZone(): void {
    opts.uploadZone.classList.remove("whisper-upload-zone--compact");
  }

  function updateUploadInfo(file: File | null): void {
    if (!file) {
      opts.uploadText.textContent = "drop a carrier file here";
      opts.uploadMeta.textContent = "";
      return;
    }
    opts.uploadText.textContent = file.name;
    opts.uploadMeta.textContent = `${formatSize(file.size)} \u00B7 ${file.type || "unknown type"}`;
  }

  /* ── Upload zone interactions ────────────────────────── */

  const openCarrierPicker = () => opts.carrierInput.click();

  opts.uploadZone.addEventListener("click", openCarrierPicker, { signal });
  opts.uploadZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCarrierPicker(); }
  }, { signal });

  opts.uploadZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    opts.uploadZone.classList.add("whisper-drop-active");
  }, { signal });
  opts.uploadZone.addEventListener("dragleave", () => {
    opts.uploadZone.classList.remove("whisper-drop-active");
  }, { signal });
  opts.uploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    opts.uploadZone.classList.remove("whisper-drop-active");
    const files = (e as DragEvent).dataTransfer?.files;
    if (files && files.length > 0) {
      const dt = new DataTransfer();
      dt.items.add(files[0]);
      opts.carrierInput.files = dt.files;
      opts.carrierInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { signal });

  // Paste-to-upload
  window.addEventListener("paste", (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const dt = new DataTransfer();
      dt.items.add(file);
      opts.carrierInput.files = dt.files;
      opts.carrierInput.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
  }, { signal });

  /* ── File input change listeners ─────────────────────── */

  opts.carrierInput.addEventListener("change", () => {
    const file = readSingleFile(opts.carrierInput);
    updateUploadInfo(file);
    if (file) {
      compactUploadZone();
      showActionsBar();
    } else {
      expandUploadZone();
      hideActionsBar();
    }
    refreshUI();
  }, { signal });

  opts.huntCarrierInput.addEventListener("change", () => {
    const count = opts.huntCarrierInput.files?.length ?? 0;
    opts.huntLabel.textContent = count > 0
      ? `${count} file${count === 1 ? "" : "s"} selected`
      : "choose files\u2026";
    // In hunt mode, show action bar when hunt files are selected
    if (activeMode === MODE_HUNT && count > 0) showActionsBar();
    refreshUI();
  }, { signal });

  opts.payloadInput.addEventListener("change", () => {
    const file = readSingleFile(opts.payloadInput);
    opts.payloadLabel.textContent = file ? file.name : "choose file\u2026";
    refreshUI();
  }, { signal });

  // Password typing affects canRun
  opts.passwordInput.addEventListener("input", refreshUI, { signal });
  opts.onlyDecodeHereInput.addEventListener("change", refreshUI, { signal });
  opts.allowTailFallbackInput.addEventListener("change", refreshUI, { signal });

  opts.passwordGenButton.addEventListener("click", () => {
    let pw = "";
    try {
      pw = generateUuidPassword();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "generate failed";
      setPasswordMeta(msg);
      appendLog(msg);
      return;
    }
    opts.passwordInput.value = pw;
    opts.passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    opts.passwordInput.focus();
    try { opts.passwordInput.setSelectionRange(0, pw.length); } catch { /* ignore */ }
    flashText(opts.passwordGenButton, "Generated");
    setPasswordMeta("generated a strong password");
    appendLog("generated password");
  }, { signal });

  opts.passwordCopyButton.addEventListener("click", async () => {
    try {
      await copyToClipboard(opts.passwordInput.value);
      flashText(opts.passwordCopyButton, "Copied");
      setPasswordMeta("copied to clipboard");
      appendLog("copied password to clipboard");
    } catch (error) {
      setPasswordMeta(error instanceof Error ? error.message : "copy failed");
      appendLog(error instanceof Error ? error.message : "copy failed");
    }
  }, { signal });

  opts.passwordPasteButton.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        opts.passwordInput.value = text;
        opts.passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
        flashText(opts.passwordPasteButton, "pasted");
      }
    } catch {
      flashText(opts.passwordPasteButton, "failed");
    }
  }, { signal });

  /* ── Action bar buttons ──────────────────────────────── */

  opts.uploadButton.addEventListener("click", openCarrierPicker, { signal });

  /* ── Mode switching ──────────────────────────────────── */

  opts.modeButtons.forEach((button) => button.addEventListener("click", (event: Event) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLButtonElement)) return;
    const mode = target.dataset.whisperMode;
    if (!isMode(mode)) return;
    setMode(mode);
  }, { signal }));

  /* ── Carrier type toggle (embed: file vs url/seal) ──── */

  const carrierRadios = opts.page.querySelectorAll<HTMLInputElement>('input[name="ws-carrier-type"]');
  carrierRadios.forEach((radio) => radio.addEventListener("change", () => {
    syncCarrier(radio.value === "url");
    if (isCarrierUrl()) {
      hideActionsBar();
    } else {
      opts.passwordInput.placeholder = "password to encrypt";
      if (hasCarrier()) showActionsBar();
    }
    refreshUI();
  }, { signal }));

  /* ── Busy state ──────────────────────────────────────── */

  function setBusy(isBusy: boolean): void {
    busy = isBusy;
    opts.progressSection.style.display = isBusy ? "" : "none";
    opts.progressFill.classList.toggle("whisper-progress--indeterminate", isBusy);
    opts.runButton.classList.toggle("action-btn--loading", isBusy);
    setLogActive(isBusy);
    syncOpTitle();
    syncState();
  }

  let flashRunTimer: ReturnType<typeof setTimeout> | null = null;

  function flashRunAck(): void {
    opts.runButton.classList.add("action-btn--ran");
    if (flashRunTimer !== null) clearTimeout(flashRunTimer);
    flashRunTimer = setTimeout(() => {
      opts.runButton.classList.remove("action-btn--ran");
      flashRunTimer = null;
    }, 1000);
  }

  /* ── Operations ──────────────────────────────────────── */

  async function runEmbed(): Promise<void> {
    const carrier = readSingleFile(opts.carrierInput)!;
    const payloadFile = readSingleFile(opts.payloadInput)!;
    const password = opts.passwordInput.value;

    setBusy(true);
    clearOutputs();
    updateStatus(`embedding into ${carrier.name}\u2026`);

    try {
      const result = await engine.embedFile(
        carrier,
        payloadFile,
        password,
        {
          preferInertSpace: true,
          maxCandidates: 28,
          onlyDecodeHere: opts.onlyDecodeHereInput.checked,
          allowTailFallback: opts.allowTailFallbackInput.checked,
        },
      );

      result.logs.forEach((line) => appendLog(line));

      const dl = makeDownloadCard(
        result.envelope.mode === "inert-slot" ? "Embedded into inert slot" : "Embedded via EOF tail",
        result.outputName, result.outputType, result.outputFile,
      );
      releaseUrls.add(dl.url);
      opts.downloadArea.appendChild(dl.node);

      renderResult(
        `Embedded at offset ${result.envelope.offset} (${result.envelope.mode}).`,
        "ok",
      );
      updateStatus("embed complete");
      flashRunAck();
    } catch (error) {
      renderResult(error instanceof Error ? error.message : "Embed failed.", "error");
      updateStatus("embed failed");
    } finally {
      setBusy(false);
    }
  }

  async function runExtract(): Promise<void> {
    const carrier = readSingleFile(opts.carrierInput)!;
    const password = opts.passwordInput.value;
    const clue = opts.clueInput.value;

    setBusy(true);
    clearOutputs();
    updateStatus(`extracting from ${carrier.name}\u2026`);

    try {
      const result = await engine.extractFile(carrier, password, { clue, destructOnExtract: false });

      result.logs.forEach((line) => appendLog(line));

      if (!result.found || !result.payload) {
        renderResult("no payload found \u2014 check password or try a different file", "warn");
        updateStatus("nothing found");
        return;
      }

      addPayloadDownload(`Recovered from ${carrier.name}`, result.payload);
      renderResult(
        `Recovered ${result.payload.name} (${formatSize(result.payload.bytes.length)}), hash ${result.payload.hashHex.slice(0, 16)}\u2026`,
        "ok",
      );
      updateStatus("extract complete");
      flashRunAck();
    } catch (error) {
      renderResult(error instanceof Error ? error.message : "Extract failed.", "error");
      updateStatus("extract failed");
    } finally {
      setBusy(false);
    }
  }

  async function runHunt(): Promise<void> {
    const files = Array.from(opts.huntCarrierInput.files ?? []);
    const password = opts.passwordInput.value;
    const clue = opts.clueInput.value;

    setBusy(true);
    clearOutputs();
    updateStatus(`scanning ${files.length} file${files.length === 1 ? "" : "s"}\u2026`);

    try {
      const carriers: WhisperHuntCarrier[] = [];
      for (const file of files) {
        carriers.push({ name: file.name, bytes: await fileToBytes(file), type: file.type });
      }

      const result = await engine.hunt(carriers, password, {
        clue, destructOnExtract: false,
      });

      result.logs.forEach((line) => appendLog(line));

      if (result.matches.length === 0) {
        renderResult(`no payloads in ${result.scannedCount} file${result.scannedCount === 1 ? "" : "s"} \u2014 check password or add more files`, "warn");
        updateStatus("nothing found");
        return;
      }

      result.matches.forEach((match: WhisperHuntMatch, index) => {
        addPayloadDownload(`Match ${index + 1}: ${match.sourceName}`, match.payload);
        renderResult(
          `${match.sourceName} \u2192 ${match.payload.name} @ ${match.offset} (confidence ${(match.confidence * 100).toFixed(0)}%)`,
          "ok",
        );
      });

      updateStatus(`hunt complete (${result.matches.length} match${result.matches.length === 1 ? "" : "es"})`);
      flashRunAck();
    } catch (error) {
      renderResult(error instanceof Error ? error.message : "Hunt failed.", "error");
      updateStatus("hunt failed");
    } finally {
      setBusy(false);
    }
  }

  /* ── Run button dispatches to current mode ───────────── */

  opts.runButton.addEventListener("click", () => {
    if (!canRun()) return;
    switch (activeMode) {
      case MODE_EMBED: runEmbed(); break;
      case MODE_EXTRACT: runExtract(); break;
      case MODE_HUNT: runHunt(); break;
    }
  }, { signal });

  /* ── Clear: reset everything to initial state ────────── */

  opts.clearButton.addEventListener("click", () => {
    clearOutputs();
    opts.passwordInput.value = "";
    opts.clueInput.value = "";
    opts.carrierInput.value = "";
    opts.huntCarrierInput.value = "";
    opts.payloadInput.value = "";
    updateUploadInfo(null);
    expandUploadZone();
    hideActionsBar();
    opts.huntLabel.textContent = "choose files\u2026";
    opts.payloadLabel.textContent = "choose file\u2026";
    refreshUI();
  }, { signal });

  /* ── Initial state ───────────────────────────────────── */

  if (savedCarrier === "url") {
    const urlRadio = opts.page.querySelector<HTMLInputElement>('input[name="ws-carrier-type"][value="url"]');
    if (urlRadio) urlRadio.checked = true;
  }
  setMode(activeMode);
  appendLog("whisper ready");

  return () => {
    ac.abort();
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    if (passwordMetaTimer !== null) clearTimeout(passwordMetaTimer);
    if (flashRunTimer !== null) clearTimeout(flashRunTimer);
    clearDownloads();
  };
}
