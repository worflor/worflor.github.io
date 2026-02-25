/**
 * Whisper Seal — UI layer.
 *
 * Seal is integrated into Embed mode as a carrier-type "URL (Seal)".
 * Compose fields live inline in the operation panel; computing, my-seal,
 * result, and unseal phases show as an overlay that hides the solo panel.
 */

import {
  getOrCreateSealIdentity,
  getExistingSealIdentity,
  isSealCodeValid,
  normalizeSealCodeInput,
  parseSealPublicCode,
  sealMessage,
  unsealMessage,
  buildSealUrl,
  parseSealFragment,
  expiryLabel,
  COMPUTE_MIN_DISPLAY_MS,
  type SealIdentityMode,
  type SealPayload,
} from "./seal";
import {
  createQrDetector,
  decodeWs2FromImage,
  getQrCameraConstraints,
  getQrScanIntervalMs,
  getQrScannerCapability,
  renderSealQrToCanvas,
} from "./seal-qr";
import {
  q,
  asInput,
  asButton,
  asPre,
  copyToClipboard,
  flashText,
  createLogger,
} from "./ui-helpers";

/* ── Interface & IDs ──────────────────────────────────────── */

export interface WhisperSealUIOptions {
  page: HTMLElement;
  logOutput: HTMLPreElement;
  logDot: HTMLElement;

  /* Overlay */
  overlay: HTMLElement;
  soloPanel: HTMLElement;

  /* My Seal button (in carrier toggle row) */
  mySealBtn: HTMLButtonElement;
  mySealInline: HTMLElement;
  mySealInlinePanel: HTMLElement;

  /* Inline compose fields */
  recipientSealInput: HTMLInputElement;
  recipientPasteBtn: HTMLButtonElement;
  recipientQrScanBtn: HTMLButtonElement;
  recipientQrImageBtn: HTMLButtonElement;
  recipientQrFileInput: HTMLInputElement;
  recipientQrStopBtn: HTMLButtonElement;
  recipientQrPanel: HTMLElement;
  recipientQrStatus: HTMLElement;
  recipientQrVideo: HTMLVideoElement;
  sealValidation: HTMLElement;
  messageInput: HTMLTextAreaElement;
  charCount: HTMLElement;
  extraPasswordInput: HTMLInputElement;
  expiryGroup: HTMLElement;
  expiryCustomWrap: HTMLElement;
  expiryCustomVal: HTMLInputElement;
  expiryCustomUnit: HTMLSelectElement;
  sealItBtn: HTMLButtonElement;

  /* Inline seal result */
  sealedResultWrap: HTMLElement;
  sealedUrlInline: HTMLPreElement;
  sealedResultInfo: HTMLElement;
  sealedResultWarning: HTMLElement;

  /* Overlay: computing */
  computingPhase: HTMLElement;

  /* Overlay: my seal */
  mySealPhase: HTMLElement;
  sealCode: HTMLElement;
  sealQrCanvas: HTMLCanvasElement;
  sealQrStatus: HTMLElement;
  sealCopyBtn: HTMLButtonElement;
  sealBackBtn: HTMLButtonElement;

  /* Overlay: result */
  resultPhase: HTMLElement;
  sealedUrl: HTMLPreElement;
  urlCopyBtn: HTMLButtonElement;
  resultSealTarget: HTMLElement;
  resultExpiryText: HTMLElement;
  resultUrlWarning: HTMLElement;
  resultDoneBtn: HTMLButtonElement;

  /* Overlay: unseal */
  unsealPhase: HTMLElement;
  unsealProgress: HTMLElement;
  unsealSuccess: HTMLElement;
  decryptedMessage: HTMLPreElement;
  msgCopyBtn: HTMLButtonElement;
  unsealDoneBtn: HTMLButtonElement;
  unsealFail: HTMLElement;
  failBackBtn: HTMLButtonElement;
  unsealExpired: HTMLElement;
  expiredBackBtn: HTMLButtonElement;
  unsealPassword: HTMLElement;
  unsealPwInput: HTMLInputElement;
  unsealPwPasteBtn: HTMLButtonElement;
  unsealPwSubmitBtn: HTMLButtonElement;
}

export const WHISPER_SEAL_IDS = {
  overlay: "ws-overlay",
  mySealBtn: "ws-my-seal-btn",
  mySealInline: "ws-my-seal-inline",
  mySealInlinePanel: "ws-my-seal-inline-panel",
  recipientSealInput: "ws-recipient-seal",
  recipientPasteBtn: "ws-recipient-paste",
  recipientQrScanBtn: "ws-recipient-qr-scan",
  recipientQrImageBtn: "ws-recipient-qr-image",
  recipientQrFileInput: "ws-recipient-qr-file",
  recipientQrStopBtn: "ws-recipient-qr-stop",
  recipientQrPanel: "ws-recipient-qr-panel",
  recipientQrStatus: "ws-recipient-qr-status",
  recipientQrVideo: "ws-recipient-qr-video",
  sealValidation: "ws-seal-validation",
  messageInput: "ws-message",
  charCount: "ws-char-count",
  extraPasswordInput: "ws-extra-password",
  expiryGroup: "ws-expiry",
  expiryCustomWrap: "ws-expiry-custom",
  expiryCustomVal: "ws-expiry-custom-val",
  expiryCustomUnit: "ws-expiry-custom-unit",
  sealItBtn: "ws-seal-it",
  sealedResultWrap: "ws-sealed-result",
  sealedUrlInline: "ws-sealed-url-inline",
  sealedResultInfo: "ws-sealed-result-info",
  sealedResultWarning: "ws-sealed-result-warning",
  computingPhase: "ws-computing-phase",
  mySealPhase: "ws-my-seal-phase",
  sealCode: "ws-seal-code",
  sealQrCanvas: "ws-seal-qr-canvas",
  sealQrStatus: "ws-seal-qr-status",
  sealCopyBtn: "ws-seal-copy",
  sealBackBtn: "ws-seal-back",
  resultPhase: "ws-result-phase",
  sealedUrl: "ws-sealed-url",
  urlCopyBtn: "ws-url-copy",
  resultSealTarget: "ws-result-seal-target",
  resultExpiryText: "ws-result-expiry-text",
  resultUrlWarning: "ws-result-url-warning",
  resultDoneBtn: "ws-result-done",
  unsealPhase: "ws-unseal-phase",
  unsealProgress: "ws-unseal-progress",
  unsealSuccess: "ws-unseal-success",
  decryptedMessage: "ws-decrypted-message",
  msgCopyBtn: "ws-msg-copy",
  unsealDoneBtn: "ws-unseal-done",
  unsealFail: "ws-unseal-fail",
  failBackBtn: "ws-fail-back",
  unsealExpired: "ws-unseal-expired",
  expiredBackBtn: "ws-expired-back",
  unsealPassword: "ws-unseal-password",
  unsealPwInput: "ws-unseal-pw-input",
  unsealPwPasteBtn: "ws-unseal-pw-paste",
  unsealPwSubmitBtn: "ws-unseal-pw-submit",
} as const;

/** URLs above this may be truncated by messaging apps. */
const URL_WARN_LENGTH = 2000;
const SEAL_MODE_SESSION_KEY = "whisper-seal-mode";

/* ── Resolve ──────────────────────────────────────────────── */

export function resolveWhisperSealUIOptions(root: ParentNode = document): WhisperSealUIOptions | null {
  const IDS = WHISPER_SEAL_IDS;

  const page = q(root, "whisper-page");
  const logOutput = asPre(q(root, "whisper-log-output"));
  const logDot = q(root, "whisper-log-dot");

  const overlay = q(root, IDS.overlay);
  const soloPanel = root.querySelector<HTMLElement>(".whisper-op-solo");

  const mySealBtn = asButton(q(root, IDS.mySealBtn));
  const mySealInline = q(root, IDS.mySealInline);
  const mySealInlinePanel = q(root, IDS.mySealInlinePanel);

  const recipientSealInput = asInput(q(root, IDS.recipientSealInput));
  const recipientPasteBtn = asButton(q(root, IDS.recipientPasteBtn));
  const recipientQrScanBtn = asButton(q(root, IDS.recipientQrScanBtn));
  const recipientQrImageBtn = asButton(q(root, IDS.recipientQrImageBtn));
  const recipientQrFileInput = asInput(q(root, IDS.recipientQrFileInput));
  const recipientQrStopBtn = asButton(q(root, IDS.recipientQrStopBtn));
  const recipientQrPanel = q(root, IDS.recipientQrPanel);
  const recipientQrStatus = q(root, IDS.recipientQrStatus);
  const recipientQrVideo = root.querySelector<HTMLVideoElement>(`#${IDS.recipientQrVideo}`);
  const sealValidation = q(root, IDS.sealValidation);
  const messageInput = root.querySelector<HTMLTextAreaElement>(`#${IDS.messageInput}`);
  const charCount = q(root, IDS.charCount);
  const extraPasswordInput = asInput(q(root, IDS.extraPasswordInput));
  const expiryGroup = q(root, IDS.expiryGroup);
  const expiryCustomWrap = q(root, IDS.expiryCustomWrap);
  const expiryCustomVal = asInput(q(root, IDS.expiryCustomVal));
  const expiryCustomUnit = root.querySelector<HTMLSelectElement>(`#${IDS.expiryCustomUnit}`);
  const sealItBtn = asButton(q(root, IDS.sealItBtn));
  const sealedResultWrap = q(root, IDS.sealedResultWrap);
  const sealedUrlInline = asPre(q(root, IDS.sealedUrlInline));
  const sealedResultInfo = q(root, IDS.sealedResultInfo);
  const sealedResultWarning = q(root, IDS.sealedResultWarning);

  const computingPhase = q(root, IDS.computingPhase);
  const mySealPhase = q(root, IDS.mySealPhase);
  const sealCode = q(root, IDS.sealCode);
  const sealQrCanvas = root.querySelector<HTMLCanvasElement>(`#${IDS.sealQrCanvas}`);
  const sealQrStatus = q(root, IDS.sealQrStatus);
  const sealCopyBtn = asButton(q(root, IDS.sealCopyBtn));
  const sealBackBtn = asButton(q(root, IDS.sealBackBtn));

  const resultPhase = q(root, IDS.resultPhase);
  const sealedUrl = asPre(q(root, IDS.sealedUrl));
  const urlCopyBtn = asButton(q(root, IDS.urlCopyBtn));
  const resultSealTarget = q(root, IDS.resultSealTarget);
  const resultExpiryText = q(root, IDS.resultExpiryText);
  const resultUrlWarning = q(root, IDS.resultUrlWarning);
  const resultDoneBtn = asButton(q(root, IDS.resultDoneBtn));

  const unsealPhase = q(root, IDS.unsealPhase);
  const unsealProgress = q(root, IDS.unsealProgress);
  const unsealSuccess = q(root, IDS.unsealSuccess);
  const decryptedMessage = asPre(q(root, IDS.decryptedMessage));
  const msgCopyBtn = asButton(q(root, IDS.msgCopyBtn));
  const unsealDoneBtn = asButton(q(root, IDS.unsealDoneBtn));
  const unsealFail = q(root, IDS.unsealFail);
  const failBackBtn = asButton(q(root, IDS.failBackBtn));
  const unsealExpired = q(root, IDS.unsealExpired);
  const expiredBackBtn = asButton(q(root, IDS.expiredBackBtn));
  const unsealPassword = q(root, IDS.unsealPassword);
  const unsealPwInput = asInput(q(root, IDS.unsealPwInput));
  const unsealPwPasteBtn = asButton(q(root, IDS.unsealPwPasteBtn));
  const unsealPwSubmitBtn = asButton(q(root, IDS.unsealPwSubmitBtn));

  if (
    !page || !logOutput || !logDot ||
    !overlay || !soloPanel || !mySealBtn || !mySealInline || !mySealInlinePanel ||
    !recipientSealInput || !recipientPasteBtn || !recipientQrScanBtn || !recipientQrImageBtn ||
    !recipientQrFileInput || !recipientQrStopBtn || !recipientQrPanel || !recipientQrStatus || !recipientQrVideo ||
    !sealValidation ||
    !messageInput || !charCount || !extraPasswordInput ||
    !expiryGroup ||
    !expiryCustomWrap || !expiryCustomVal || !expiryCustomUnit ||
    !sealItBtn ||
    !sealedResultWrap || !sealedUrlInline || !sealedResultInfo || !sealedResultWarning ||
    !computingPhase || !mySealPhase || !sealCode || !sealQrCanvas || !sealQrStatus || !sealCopyBtn || !sealBackBtn ||
    !resultPhase || !sealedUrl || !urlCopyBtn || !resultSealTarget ||
    !resultExpiryText || !resultUrlWarning || !resultDoneBtn ||
    !unsealPhase || !unsealProgress || !unsealSuccess || !decryptedMessage ||
    !msgCopyBtn || !unsealDoneBtn || !unsealFail || !failBackBtn ||
    !unsealExpired || !expiredBackBtn ||
    !unsealPassword || !unsealPwInput || !unsealPwPasteBtn || !unsealPwSubmitBtn
  ) {
    return null;
  }

  return {
    page, logOutput, logDot,
    overlay, soloPanel, mySealBtn, mySealInline, mySealInlinePanel,
    recipientSealInput, recipientPasteBtn, recipientQrScanBtn, recipientQrImageBtn,
    recipientQrFileInput, recipientQrStopBtn, recipientQrPanel, recipientQrStatus, recipientQrVideo,
    sealValidation,
    messageInput, charCount, extraPasswordInput,
    expiryGroup,
    expiryCustomWrap, expiryCustomVal, expiryCustomUnit,
    sealItBtn,
    sealedResultWrap, sealedUrlInline, sealedResultInfo, sealedResultWarning,
    computingPhase, mySealPhase, sealCode, sealQrCanvas, sealQrStatus, sealCopyBtn, sealBackBtn,
    resultPhase, sealedUrl, urlCopyBtn, resultSealTarget,
    resultExpiryText, resultUrlWarning, resultDoneBtn,
    unsealPhase, unsealProgress, unsealSuccess, decryptedMessage,
    msgCopyBtn, unsealDoneBtn, unsealFail, failBackBtn,
    unsealExpired, expiredBackBtn,
    unsealPassword, unsealPwInput, unsealPwPasteBtn, unsealPwSubmitBtn,
  };
}

/* ── Helpers ──────────────────────────────────────────────── */

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function compactSealCode(code: string): string {
  if (code.length <= 34) return code;
  return `${code.slice(0, 20)}…${code.slice(-12)}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function populateStatusMeta(container: HTMLElement, payload: SealPayload): void {
  const meta = container.querySelector<HTMLElement>(".ws-status-meta");
  if (!meta) return;
  const parts: string[] = [];

  if (payload.t > 0) {
    const d = new Date(payload.t);
    const now = Date.now();
    if (now >= payload.t) {
      const ago = now - payload.t;
      const mins = Math.floor(ago / 60_000);
      const hrs = Math.floor(ago / 3_600_000);
      const days = Math.floor(ago / 86_400_000);
      const secs = Math.floor(ago / 1_000);
      const agoText = days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : mins > 0 ? `${mins}m ago` : `${secs}s ago`;
      parts.push(`expired ${agoText}`);
    } else {
      const rem = payload.t - now;
      const mins = Math.ceil(rem / 60_000);
      const hrs = Math.round(rem / 3_600_000);
      const days = Math.round(rem / 86_400_000);
      const secs = Math.ceil(rem / 1_000);
      const minsFloor = Math.floor(rem / 60_000);
      const remText = days > 1 ? `${days}d` : hrs > 0 ? `${hrs}h` : minsFloor > 0 ? `${minsFloor}m` : `${secs}s`;
      parts.push(`expires in ${remText}`);
    }
    parts.push(d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  } else {
    parts.push("no expiry");
  }

  if (payload.rf) {
    parts.push(`seal ${payload.rf.slice(0, 8)}`);
  }

  if (payload.p === 1) {
    parts.push("phrase-locked");
  }

  const sep = '<span class="ws-status-meta-sep">\u00b7</span>';
  meta.innerHTML = parts.map((p) => `<span>${p}</span>`).join(sep);
}

/* ── Init ─────────────────────────────────────────────────── */

export function initWhisperSeal(opts: WhisperSealUIOptions): () => void {
  const ac = new AbortController();
  const { signal } = ac;

  const { log, cleanup: cleanupLogger } = createLogger(opts.logOutput, opts.logDot);

  const overlayPanels = [
    opts.computingPhase, opts.mySealPhase,
    opts.resultPhase, opts.unsealPhase,
  ];

  let busy = false;
  let pendingPayload: SealPayload | null = null;
  let mySealPublicCode = "";
  let currentIdentityMode: SealIdentityMode = "stable";

  type QrScanStopReason = "accepted" | "cancelled" | "error" | "teardown";
  const qrScanSession: {
    rafId: number;
    stream: MediaStream | null;
    active: boolean;
    lastFrameAt: number;
    runId: number;
  } = {
    rafId: 0,
    stream: null,
    active: false,
    lastFrameAt: 0,
    runId: 0,
  };

  let qrSupported = false;
  let pageObserver: MutationObserver | null = null;

  const setRecipientQrStatus = (text: string): void => {
    opts.recipientQrStatus.textContent = text;
  };

  const logQr = (event: string): void => {
    log(`qr: ${event}`);
  };

  function setRecipientQrUiState(scanning: boolean): void {
    opts.recipientQrScanBtn.disabled = scanning || !qrSupported;
    opts.recipientQrImageBtn.disabled = scanning;
    opts.recipientQrStopBtn.style.display = scanning ? "" : "none";
  }

  function isUnstableMode(): boolean {
    return currentIdentityMode === "unstable";
  }

  function applyIdentityModeVisuals(): void {
    opts.page.dataset.sealMode = currentIdentityMode;
    opts.mySealBtn.classList.toggle("ws-seal-mode-chip--stable", !isUnstableMode());
    opts.mySealBtn.classList.toggle("ws-seal-mode-chip--unstable", isUnstableMode());
    const modeLabel = isUnstableMode() ? "Unstable seal" : "Stable seal";
    opts.mySealBtn.textContent = modeLabel;
    opts.mySealBtn.setAttribute("aria-label", `${modeLabel}. Click to switch mode.`);
    opts.mySealBtn.setAttribute("aria-pressed", String(isUnstableMode()));
  }

  function loadSavedIdentityMode(): SealIdentityMode {
    const saved = sessionStorage.getItem(SEAL_MODE_SESSION_KEY);
    return saved === "unstable" ? "unstable" : "stable";
  }

  function setIdentityMode(mode: SealIdentityMode): void {
    if (currentIdentityMode === mode) {
      applyIdentityModeVisuals();
      return;
    }
    currentIdentityMode = mode;
    sessionStorage.setItem(SEAL_MODE_SESSION_KEY, mode);
    mySealPublicCode = "";
    opts.mySealInline.textContent = "";
    opts.mySealInline.style.display = "none";
    opts.mySealInlinePanel.style.display = "none";
    syncMySealInlinePanelState();
    applyIdentityModeVisuals();
    log(isUnstableMode() ? "seal mode: unstable (session-tied)" : "seal mode: stable");
  }

  function syncMySealInlinePanelState(): void {
    const expanded = opts.mySealInlinePanel.style.display !== "none";
    opts.mySealBtn.setAttribute("aria-expanded", String(expanded));
    opts.mySealBtn.classList.toggle("ws-seal-mode-chip--active", expanded);
    const modeText = isUnstableMode() ? "unstable" : "stable";
    opts.mySealBtn.title = `switch seal mode (${modeText})`;
  }

  function isSealInlineActiveMode(): boolean {
    return opts.page.dataset.mode === "embed" && opts.page.dataset.carrier === "url";
  }

  function syncSealInlineVisibility(): void {
    if (isSealInlineActiveMode()) {
      if (mySealPublicCode) {
        opts.mySealInlinePanel.style.display = "";
        syncMySealInlinePanelState();
      } else if (!busy) {
        void generateSeal();
      }
      return;
    }
    opts.mySealInlinePanel.style.display = "none";
    syncMySealInlinePanelState();
    if (qrScanSession.active) stopRecipientQrScan("cancelled");
  }

  function toggleIdentityMode(): void {
    const nextMode: SealIdentityMode = currentIdentityMode === "stable" ? "unstable" : "stable";
    setIdentityMode(nextMode);
  }

  function sealQrHintText(): string {
    if (isUnstableMode()) {
      return "tied to session identity, so preserve browser fingerprint.";
    }
    return "encodes the full WS2 public key exactly.";
  }

  function setRecipientFromCandidate(rawValue: string, source: "camera" | "image"): boolean {
    const normalized = normalizeSealCodeInput(rawValue);
    if (!normalized || !isSealCodeValid(normalized)) {
      setRecipientQrStatus("Invalid WS2 key.");
      logQr(`${source} invalid ws2 key`);
      return false;
    }

    opts.recipientSealInput.value = normalized;
    syncCompose();
    setRecipientQrStatus("WS2 key loaded.");
    logQr(`${source} loaded ws2 key`);
    opts.messageInput.focus();
    return true;
  }

  function stopRecipientQrScan(reason: QrScanStopReason = "cancelled"): void {
    qrScanSession.runId += 1;

    if (qrScanSession.rafId) {
      cancelAnimationFrame(qrScanSession.rafId);
      qrScanSession.rafId = 0;
    }

    qrScanSession.active = false;
    qrScanSession.lastFrameAt = 0;

    if (qrScanSession.stream) {
      for (const track of qrScanSession.stream.getTracks()) track.stop();
      qrScanSession.stream = null;
    }

    opts.recipientQrVideo.pause();
    opts.recipientQrVideo.srcObject = null;
    opts.recipientQrPanel.style.display = "none";
    setRecipientQrUiState(false);

    if (reason === "cancelled") {
      setRecipientQrStatus("");
    }
    if (reason === "error") logQr("camera stopped after error");
  }

  async function scanRecipientFromImage(file: File): Promise<void> {
    const decoded = await decodeWs2FromImage(file);
    if (aborted()) return;
    if (!decoded) {
      setRecipientQrStatus("No WS2 key found.");
      logQr("image no ws2 key found");
      return;
    }

    if (setRecipientFromCandidate(decoded.rawValue, "image")) {
      return;
    }

    setRecipientQrStatus("Invalid WS2 key.");
  }

  async function startRecipientQrScan(): Promise<void> {
    if (qrScanSession.active) return;
    const runId = qrScanSession.runId + 1;
    qrScanSession.runId = runId;

    const capability = await getQrScannerCapability();
    if (aborted() || runId !== qrScanSession.runId) return;
    if (!capability.supported) {
      setRecipientQrStatus("Camera unavailable.");
      logQr(`camera unavailable (${capability.reason ?? "unsupported"})`);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setRecipientQrStatus("Camera unavailable.");
      logQr("camera unavailable (getUserMedia unsupported)");
      return;
    }

    const detector = await createQrDetector();
    if (aborted() || runId !== qrScanSession.runId) return;
    if (!detector) {
      setRecipientQrStatus("Camera unavailable.");
      logQr("camera unavailable (detector init failed)");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: getQrCameraConstraints(),
        audio: false,
      });
      if (aborted() || runId !== qrScanSession.runId) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      qrScanSession.stream = stream;

      opts.recipientQrVideo.srcObject = stream;
      await opts.recipientQrVideo.play();
      if (aborted() || runId !== qrScanSession.runId) {
        stopRecipientQrScan("cancelled");
        return;
      }

      qrScanSession.active = true;
      opts.recipientQrPanel.style.display = "";
      setRecipientQrUiState(true);
      setRecipientQrStatus("Scanning…");
      logQr("camera scan started");

      const loop = async (at: number): Promise<void> => {
        if (!qrScanSession.active || aborted() || runId !== qrScanSession.runId) return;
        if (at - qrScanSession.lastFrameAt < getQrScanIntervalMs()) {
          qrScanSession.rafId = requestAnimationFrame((t) => { void loop(t); });
          return;
        }

        qrScanSession.lastFrameAt = at;
        try {
          const detections = await detector.detect(opts.recipientQrVideo);
          if (!qrScanSession.active || aborted() || runId !== qrScanSession.runId) return;
          for (const detection of detections) {
            if (!detection.rawValue) continue;
            if (setRecipientFromCandidate(detection.rawValue, "camera")) {
              stopRecipientQrScan("accepted");
              return;
            }
          }
        } catch {
          stopRecipientQrScan("error");
          setRecipientQrStatus("Scan failed.");
          return;
        }

        qrScanSession.rafId = requestAnimationFrame((t) => { void loop(t); });
      };

      qrScanSession.rafId = requestAnimationFrame((t) => { void loop(t); });
    } catch (e) {
      stopRecipientQrScan("error");
      const msg = e instanceof Error ? e.message : "camera permission denied";
      setRecipientQrStatus("Camera unavailable.");
      logQr(`camera failed (${msg})`);
    }
  }

  /** Guard: true if this instance has been torn down. */
  function aborted(): boolean { return signal.aborted; }

  /* ── Overlay management ────────────────────────────────── */

  function showOverlay(panel: HTMLElement): void {
    opts.soloPanel.style.display = "none";
    for (const p of overlayPanels) p.style.display = p === panel ? "" : "none";
    opts.overlay.style.display = "";
  }

  function hideOverlay(): void {
    opts.overlay.style.display = "none";
    for (const p of overlayPanels) p.style.display = "none";
    opts.soloPanel.style.display = "";
  }

  /* ── Switch to embed/url carrier ───────────────────────── */

  function ensureEmbedUrlMode(): void {
    opts.page.dataset.mode = "embed";
    opts.page.dataset.carrier = "url";
    opts.page.dataset.sealMode = currentIdentityMode;
    sessionStorage.setItem("whisper-mode", "embed");
    sessionStorage.setItem("whisper-carrier", "url");
    opts.page.querySelectorAll<HTMLButtonElement>("[data-whisper-mode]").forEach((btn) => {
      const active = btn.dataset.whisperMode === "embed";
      btn.classList.toggle("whisper-mode-btn--active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    const urlRadio = opts.page.querySelector<HTMLInputElement>('input[name="ws-carrier-type"][value="url"]');
    if (urlRadio) urlRadio.checked = true;
  }

  /* ── Expiry helpers ───────────────────────────────────── */

  function selectedExpiryRadio(): string {
    const checked = opts.expiryGroup.querySelector<HTMLInputElement>('input[name="ws-expiry"]:checked');
    return checked?.value ?? "86400000";
  }

  function isCustomExpiry(): boolean {
    return selectedExpiryRadio() === "custom";
  }

  function getExpiryMs(): number {
    const val = selectedExpiryRadio();
    if (val !== "custom") return parseInt(val, 10);
    const n = Math.max(1, parseInt(opts.expiryCustomVal.value, 10) || 1);
    const unit = parseInt(opts.expiryCustomUnit.value, 10);
    return n * unit;
  }

  function syncExpiryCustom(): void {
    const active = isCustomExpiry();
    opts.expiryCustomWrap.classList.toggle("ws-expiry-custom--active", active);
    opts.expiryCustomVal.tabIndex = active ? 0 : -1;
    opts.expiryCustomUnit.tabIndex = active ? 0 : -1;
  }

  /* ── Compose helpers ──────────────────────────────────── */

  function syncCompose(): void {
    const code = normalizeSealCodeInput(opts.recipientSealInput.value);
    const valid = isSealCodeValid(code);
    const hasMsg = opts.messageInput.value.trim().length > 0;

    if (code.length > 0) {
      if (valid) {
        const recipientRaw = parseSealPublicCode(code);
        const myRaw = mySealPublicCode ? parseSealPublicCode(mySealPublicCode) : null;
        const isSelfSeal = !!recipientRaw && !!myRaw && bytesEqual(recipientRaw, myRaw);
        opts.sealValidation.textContent = isSelfSeal
          ? "\u2713 valid WS2 public key..."
          : "\u2713 valid WS2 public key";
      } else {
        opts.sealValidation.textContent = "\u2717 invalid WS2 public key";
      }
      opts.sealValidation.dataset.valid = String(valid);
    } else {
      opts.sealValidation.textContent = "";
      delete opts.sealValidation.dataset.valid;
    }
    opts.sealItBtn.disabled = !(valid && hasMsg) || busy;
  }

  function syncCharCount(): void {
    opts.charCount.textContent = `${opts.messageInput.value.length.toLocaleString()} / 48,000`;
  }

  function resetComposeFields(): void {
    opts.recipientSealInput.value = "";
    opts.messageInput.value = "";
    opts.extraPasswordInput.value = "";
    opts.sealValidation.textContent = "";
    delete opts.sealValidation.dataset.valid;
    opts.sealedResultWrap.style.display = "none";
    if (qrScanSession.active) stopRecipientQrScan("cancelled");
    syncCharCount();
    syncCompose();
  }

  /* ── Unseal sub-view toggle ───────────────────────────── */

  const unsealSubs = [
    opts.unsealProgress, opts.unsealSuccess, opts.unsealFail,
    opts.unsealExpired, opts.unsealPassword,
  ];

  function showUnsealSub(target: HTMLElement): void {
    for (const s of unsealSubs) s.style.display = s === target ? "" : "none";
  }

  /* ── Generate Seal ────────────────────────────────────── */

  async function generateSeal(): Promise<void> {
    if (busy) return;
    busy = true;
    opts.mySealBtn.disabled = true;
    opts.mySealBtn.classList.add("ws-computing");
    log(`loading ${isUnstableMode() ? "unstable" : "stable"} local key...`);

    try {
      await delay(COMPUTE_MIN_DISPLAY_MS);
      if (aborted()) return;
      const identity = await getOrCreateSealIdentity(currentIdentityMode);
      if (aborted()) return;
      mySealPublicCode = identity.code;

      opts.sealCode.textContent = identity.code;
      try {
        renderSealQrToCanvas(opts.sealQrCanvas, identity.code);
        opts.sealQrStatus.textContent = sealQrHintText();
      } catch {
        opts.sealQrStatus.textContent = "QR preview unavailable in this browser.";
        log("qr preview unavailable");
      }
      opts.mySealInline.textContent = compactSealCode(identity.code);
      opts.mySealInline.style.display = "";
      opts.mySealInline.title = `copy full ${isUnstableMode() ? "unstable" : "stable"} seal`;
      opts.mySealInlinePanel.style.display = "";
      syncMySealInlinePanelState();
      log(`${isUnstableMode() ? "unstable" : "stable"} key loaded: ${compactSealCode(identity.code)}`);
      opts.mySealBtn.classList.remove("ws-computing");
      copyToClipboard(identity.code).then(() => {
        if (aborted()) return;
        copyPulse(opts.mySealBtn);
        copyPulse(opts.mySealInline);
      }).catch(() => {});
    } catch (e) {
      if (aborted()) return;
      log(`error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      busy = false;
      opts.mySealBtn.disabled = false;
      opts.mySealBtn.classList.remove("ws-computing");
    }
  }

  /* ── Seal (encrypt) ───────────────────────────────────── */

  async function doSeal(): Promise<void> {
    if (busy) return;
    busy = true;
    opts.sealItBtn.disabled = true;
    opts.sealItBtn.classList.add("ws-computing");

    const recipient = normalizeSealCodeInput(opts.recipientSealInput.value);
    const message = opts.messageInput.value;
    const expiryMs = getExpiryMs();
    const pw = opts.extraPasswordInput.value || undefined;

    log(`sealing message for recipient key (${message.length.toLocaleString()} chars)`);

    try {
      const payload = await sealMessage(recipient, message, expiryMs, pw);
      if (aborted()) return;
      const url = buildSealUrl(payload);

      // Populate inline result
      opts.sealedUrlInline.textContent = url;

      const expiryText = expiryMs > 0 ? expiryLabel(expiryMs) : "no expiry";
      opts.sealedResultInfo.textContent = `for recipient key \u00B7 ${expiryText} \u00B7 ${url.length.toLocaleString()} chars`;

      if (url.length > URL_WARN_LENGTH) {
        opts.sealedResultWarning.textContent =
          `long url — some apps truncate over ${URL_WARN_LENGTH.toLocaleString()} chars`;
        opts.sealedResultWarning.style.display = "";
      } else {
        opts.sealedResultWarning.style.display = "none";
      }

      opts.sealedResultWrap.style.display = "";
      log(`url generated (${url.length.toLocaleString()} chars)`);

      // Auto-copy
      safeCopy(url, opts.sealItBtn, "Copied!");
    } catch (e) {
      if (aborted()) return;
      log(`seal error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      busy = false;
      opts.sealItBtn.disabled = false;
      opts.sealItBtn.classList.remove("ws-computing");
      syncCompose();
    }
  }

  /* ── Unseal (decrypt) ─────────────────────────────────── */

  async function runUnseal(payload: SealPayload, password?: string): Promise<void> {
    if (busy) return;
    busy = true;
    pendingPayload = payload;
    showOverlay(opts.unsealPhase);
    showUnsealSub(opts.unsealProgress);
    const sealId = payload.rf ? payload.rf.slice(0, 8) : "unknown";
    log(`checking seal ${sealId}...`);

    try {
      const identity = await getExistingSealIdentity(currentIdentityMode);
      if (aborted()) return;
      if (identity) {
        mySealPublicCode = identity.code;
        opts.mySealInline.textContent = compactSealCode(identity.code);
        opts.mySealInline.style.display = "";
        opts.mySealInline.title = `copy full ${isUnstableMode() ? "unstable" : "stable"} seal`;
        log(`${isUnstableMode() ? "unstable" : "stable"} local key: ${compactSealCode(identity.code)}`);
      } else {
        log(`no ${isUnstableMode() ? "unstable" : "stable"} local key found`);
      }

      const result = await unsealMessage(payload, password, currentIdentityMode);
      if (aborted()) return;

      // Populate metadata on all status screens with payload details
      for (const el of [opts.unsealSuccess, opts.unsealExpired, opts.unsealFail, opts.unsealPassword]) {
        populateStatusMeta(el, payload);
      }

      if (result.ok) {
        opts.decryptedMessage.textContent = result.message;
        showUnsealSub(opts.unsealSuccess);
        log("decrypted");
        pendingPayload = null;
        opts.msgCopyBtn.focus();
        return;
      }

      switch (result.reason) {
        case "expired":
          showUnsealSub(opts.unsealExpired);
          log("expired");
          pendingPayload = null;
          break;
        case "password-needed":
          showUnsealSub(opts.unsealPassword);
          log("shared phrase required");
          opts.unsealPwInput.value = "";
          opts.unsealPwInput.focus();
          break;
        case "wrong-seal":
          showUnsealSub(opts.unsealFail);
          log("wrong seal. this message is for a different browser");
          pendingPayload = null;
          break;
        case "identity-missing":
          showUnsealSub(opts.unsealFail);
          log("no local key in this browser");
          pendingPayload = null;
          break;
        case "decrypt-failed":
          showUnsealSub(opts.unsealFail);
          log("decryption failed. wrong browser or corrupted");
          pendingPayload = null;
          break;
      }
    } catch (e) {
      if (aborted()) return;
      showUnsealSub(opts.unsealFail);
      log(`unseal error: ${e instanceof Error ? e.message : "unknown"}`);
      pendingPayload = null;
    } finally {
      busy = false;
      if (!pendingPayload) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
  }

  /* ── Clipboard helper (swallows errors into log) ───────── */

  async function safeCopy(text: string, btn: HTMLButtonElement, label = "Copied!"): Promise<void> {
    try {
      await copyToClipboard(text);
      if (aborted()) return;
      flashText(btn, label);
    } catch (e) {
      if (aborted()) return;
      log(`copy failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  /** Visual pulse on an element to confirm copy — no text change. */
  function copyPulse(el: HTMLElement): void {
    el.classList.remove("ws-copy-pulse");
    // Force reflow so re-adding the class restarts the animation
    void el.offsetWidth;
    el.classList.add("ws-copy-pulse");
  }

  /* ── Event Listeners ──────────────────────────────────── */

  // My Seal button
  opts.mySealBtn.addEventListener("click", () => {
    if (busy) return;
    toggleIdentityMode();
    void generateSeal();
  }, { signal });

  // Inline seal code — click to copy with pulse
  function copySealInline(): void {
    const code = mySealPublicCode;
    if (!code) return;
    copyToClipboard(code).then(() => {
      if (aborted()) return;
      copyPulse(opts.mySealInline);
    }).catch(() => {});
  }
  opts.mySealInline.addEventListener("click", copySealInline, { signal });
  opts.mySealInline.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copySealInline(); }
  }, { signal });

  // My Seal overlay — copy & back (kept for unseal flow)
  opts.sealCopyBtn.addEventListener("click", () => safeCopy(mySealPublicCode, opts.sealCopyBtn), { signal });
  opts.sealBackBtn.addEventListener("click", () => {
    hideOverlay();
  }, { signal });

  // Recipient WS2 QR helpers
  opts.recipientQrScanBtn.addEventListener("click", () => { void startRecipientQrScan(); }, { signal });
  opts.recipientQrImageBtn.addEventListener("click", () => opts.recipientQrFileInput.click(), { signal });
  opts.recipientQrStopBtn.addEventListener("click", () => stopRecipientQrScan("cancelled"), { signal });
  opts.recipientQrFileInput.addEventListener("change", () => {
    const file = opts.recipientQrFileInput.files?.[0];
    opts.recipientQrFileInput.value = "";
    if (!file) return;
    void scanRecipientFromImage(file).catch((e) => {
      const msg = e instanceof Error ? e.message : "unknown";
      setRecipientQrStatus("Scan failed.");
      logQr(`image scan failed (${msg})`);
    });
  }, { signal });

  // Compose — live validation
  opts.recipientSealInput.addEventListener("input", () => {
    const normalized = normalizeSealCodeInput(opts.recipientSealInput.value);
    if (normalized !== opts.recipientSealInput.value) {
      opts.recipientSealInput.value = normalized;
    }
    syncCompose();
  }, { signal });

  // Paste — read clipboard on click, validate, pulse button
  function pulsePaste(cls: string): void {
    opts.recipientPasteBtn.classList.remove("ws-copy-pulse", "ws-reject-pulse");
    void opts.recipientPasteBtn.offsetWidth;
    opts.recipientPasteBtn.classList.add(cls);
  }
  opts.recipientPasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const normalized = normalizeSealCodeInput(text.trim());
      if (isSealCodeValid(normalized)) {
        opts.recipientSealInput.value = normalized;
        syncCompose();
        pulsePaste("ws-copy-pulse");
      } else {
        pulsePaste("ws-reject-pulse");
      }
    } catch {
      pulsePaste("ws-reject-pulse");
    }
  }, { signal });

  opts.messageInput.addEventListener("input", () => { syncCompose(); syncCharCount(); }, { signal });
  opts.sealItBtn.addEventListener("click", () => doSeal(), { signal });

  // Inline sealed URL — click to copy with pulse
  function copySealedUrl(): void {
    const url = opts.sealedUrlInline.textContent ?? "";
    if (!url) return;
    copyToClipboard(url).then(() => {
      if (aborted()) return;
      copyPulse(opts.sealedUrlInline);
    }).catch(() => {});
  }
  opts.sealedUrlInline.addEventListener("click", copySealedUrl, { signal });
  opts.sealedUrlInline.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copySealedUrl(); }
  }, { signal });


  // Expiry — toggle custom fields on radio change + sync initial state
  opts.expiryGroup.addEventListener("change", syncExpiryCustom, { signal });
  syncExpiryCustom();

  // Enter on seal input → focus message
  opts.recipientSealInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); opts.messageInput.focus(); }
  }, { signal });

  // Result overlay
  opts.urlCopyBtn.addEventListener("click", () => safeCopy(opts.sealedUrl.textContent ?? "", opts.urlCopyBtn), { signal });
  opts.resultDoneBtn.addEventListener("click", () => {
    resetComposeFields();
    hideOverlay();
  }, { signal });

  // Unseal overlay
  opts.msgCopyBtn.addEventListener("click", () => safeCopy(opts.decryptedMessage.textContent ?? "", opts.msgCopyBtn), { signal });
  opts.unsealDoneBtn.addEventListener("click", hideOverlay, { signal });
  opts.failBackBtn.addEventListener("click", hideOverlay, { signal });
  opts.expiredBackBtn.addEventListener("click", hideOverlay, { signal });

  // Password paste + submit
  opts.unsealPwPasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        opts.unsealPwInput.value = text;
        opts.unsealPwInput.dispatchEvent(new Event("input", { bubbles: true }));
        flashText(opts.unsealPwPasteBtn, "pasted");
      }
    } catch {
      flashText(opts.unsealPwPasteBtn, "failed");
    }
  }, { signal });
  opts.unsealPwSubmitBtn.addEventListener("click", () => {
    if (pendingPayload && !busy) runUnseal(pendingPayload, opts.unsealPwInput.value);
  }, { signal });
  opts.unsealPwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && pendingPayload && !busy) {
      e.preventDefault();
      runUnseal(pendingPayload, opts.unsealPwInput.value);
    }
  }, { signal });

  /* ── Boot ─────────────────────────────────────────────── */

  currentIdentityMode = loadSavedIdentityMode();
  applyIdentityModeVisuals();
  setRecipientQrUiState(false);

  void getQrScannerCapability().then((capability) => {
    if (aborted()) return;
    qrSupported = capability.supported;
    setRecipientQrUiState(false);
    setRecipientQrStatus("");
    opts.recipientQrScanBtn.title = capability.supported
      ? "scan qr"
      : "camera scan unavailable";
    opts.recipientQrImageBtn.title = "load qr image";
    if (!capability.supported) log(capability.reason ?? "camera qr scan unavailable");
  });

  pageObserver = new MutationObserver(() => {
    syncSealInlineVisibility();
  });
  pageObserver.observe(opts.page, { attributes: true, attributeFilter: ["data-mode", "data-carrier"] });

  // Hide seal overlay when user clicks any mode tab
  opts.page.querySelectorAll<HTMLButtonElement>("[data-whisper-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (opts.overlay.style.display !== "none") {
        hideOverlay();
        busy = false;
        pendingPayload = null;
      }
    }, { signal });
  });
  syncMySealInlinePanelState();
  syncSealInlineVisibility();

  // If URL contains a #ws2: fragment, jump straight to unseal.
  // This handles both initial page load AND mid-session hash changes
  // (e.g. pasting a sealed URL while already on the whisper page).
  // Hash-only changes don't trigger page navigations or astro:after-swap,
  // so hashchange is the correct event to listen for.
  function checkSealFragment(): void {
    const payload = parseSealFragment();
    if (payload) {
      // Reset any in-progress unseal before starting the new one
      if (busy) {
        busy = false;
        pendingPayload = null;
      }
      ensureEmbedUrlMode();
      log("sealed message found in url");
      runUnseal(payload);
    }
  }

  checkSealFragment();
  window.addEventListener("hashchange", checkSealFragment, { signal });

  /* ── Teardown ─────────────────────────────────────────── */

  return () => {
    ac.abort();
    stopRecipientQrScan("teardown");
    pageObserver?.disconnect();
    pageObserver = null;
    cleanupLogger();
    // Reset overlay state so next init starts clean
    hideOverlay();
    pendingPayload = null;
    busy = false;
  };
}
