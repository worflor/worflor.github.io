/**
 * Whisper Live — UI layer.
 *
 * Bridges WhisperLiveSession to the DOM. Follows the same pattern as whisper-ui.ts:
 * resolveWhisperLiveUIOptions() → initWhisperLive(opts) → returns teardown function.
 */

import {
  WhisperLiveSession,
  WHISPER_LIVE_RTC_LOCAL_ONLY,
  WHISPER_LIVE_RTC_PUBLIC_STUN,
  type LiveState,
  type LiveMessage,
  type TransportMode,
} from "./live";
import {
  q,
  asInput,
  asButton,
  asPre,
  clearNode,
  formatSize,
  copyToClipboard,
  flashText,
  appendToLog,
  setLogDotActive,
} from "./ui-helpers";
import {
  createQrDetector,
  decodeQrTextFromImage,
  getQrCameraConstraints,
  getQrScanIntervalMs,
  getQrScannerCapability,
  renderQrToCanvas,
} from "./seal-qr";

/* ── Interface & IDs ──────────────────────────────────────── */

export interface WhisperLiveUIOptions {
  page: HTMLElement;
  logOutput: HTMLPreElement;
  logDot: HTMLElement;
  liveStatusLine: HTMLElement;

  /* Connection phase */
  liveSection: HTMLElement;
  createBtn: HTMLButtonElement;
  joinInput: HTMLInputElement;
  joinBtn: HTMLButtonElement;
  joinPasteBtn: HTMLButtonElement;
  joinQrScanBtn: HTMLButtonElement;
  joinQrImageBtn: HTMLButtonElement;
  joinQrFileInput: HTMLInputElement;
  joinQrStopBtn: HTMLButtonElement;
  joinQrPanel: HTMLElement;
  joinQrStatus: HTMLElement;
  joinQrVideo: HTMLVideoElement;
  phraseInput: HTMLInputElement;
  externalAssistToggle: HTMLInputElement;

  /* Offering phase */
  offerSection: HTMLElement;
  offerCode: HTMLElement;
  offerCopyBtn: HTMLButtonElement;
  offerBackBtn: HTMLButtonElement;
  offerQrToggleBtn: HTMLButtonElement;
  offerQrPanel: HTMLElement;
  offerQrCanvas: HTMLCanvasElement;
  offerQrStatus: HTMLElement;
  answerInput: HTMLInputElement;
  answerApplyBtn: HTMLButtonElement;

  /* Answering phase */
  answerSection: HTMLElement;
  answerCode: HTMLElement;
  answerCopyBtn: HTMLButtonElement;
  answerQrToggleBtn: HTMLButtonElement;
  answerQrPanel: HTMLElement;
  answerQrCanvas: HTMLCanvasElement;
  answerQrStatus: HTMLElement;

  /* Connecting/handshaking phase */
  connectingSection: HTMLElement;
  connectingStatus: HTMLElement;

  /* Verify phase */
  verifySection: HTMLElement;
  fingerprintDisplay: HTMLElement;
  confirmBtn: HTMLButtonElement;
  rejectBtn: HTMLButtonElement;

  /* Chat phase */
  chatSection: HTMLElement;
  chatMessages: HTMLElement;
  chatInput: HTMLInputElement;
  chatSendBtn: HTMLButtonElement;
  chatFileInput: HTMLInputElement;
  chatFileBtn: HTMLButtonElement;
  transportRadios: NodeListOf<HTMLInputElement>;
  disconnectBtn: HTMLButtonElement;

  /* Silent phase */
  silentSection: HTMLElement;
  silentSecret: HTMLElement;
  silentCopyBtn: HTMLButtonElement;
  silentDisconnectBtn: HTMLButtonElement;

  /* Disconnected phase */
  disconnectedSection: HTMLElement;
  newSessionBtn: HTMLButtonElement;

  /* Error phase */
  errorSection: HTMLElement;
  errorMessage: HTMLElement;
  errorRetryBtn: HTMLButtonElement;

  /* Relay assist (optional — resolver won't block if missing) */
  relayAssistToggle?: HTMLInputElement;
  relayConnectBtn?: HTMLButtonElement;
}

export const WHISPER_LIVE_IDS = {
  liveSection: "wl-idle-phase",
  createBtn: "wl-create",
  joinInput: "wl-join-input",
  joinBtn: "wl-join",
  joinPasteBtn: "wl-join-paste",
  joinQrScanBtn: "wl-join-qr-scan",
  joinQrImageBtn: "wl-join-qr-image",
  joinQrFileInput: "wl-join-qr-file",
  joinQrStopBtn: "wl-join-qr-stop",
  joinQrPanel: "wl-join-qr-panel",
  joinQrStatus: "wl-join-qr-status",
  joinQrVideo: "wl-join-qr-video",
  phraseInput: "wl-phrase",
  externalAssistToggle: "wl-external-assist",
  offerSection: "wl-offer-section",
  offerCode: "wl-offer-code",
  offerCopyBtn: "wl-offer-copy",
  offerBackBtn: "wl-offer-back",
  offerQrToggleBtn: "wl-offer-qr-toggle",
  offerQrPanel: "wl-offer-qr-panel",
  offerQrCanvas: "wl-offer-qr-canvas",
  offerQrStatus: "wl-offer-qr-status",
  answerInput: "wl-answer-input",
  answerApplyBtn: "wl-answer-apply",
  answerSection: "wl-answer-section",
  answerCode: "wl-answer-code",
  answerCopyBtn: "wl-answer-copy",
  answerQrToggleBtn: "wl-answer-qr-toggle",
  answerQrPanel: "wl-answer-qr-panel",
  answerQrCanvas: "wl-answer-qr-canvas",
  answerQrStatus: "wl-answer-qr-status",
  connectingSection: "wl-connecting-section",
  connectingStatus: "wl-connecting-status",
  verifySection: "wl-verify-section",
  fingerprintDisplay: "wl-fingerprint",
  confirmBtn: "wl-confirm",
  rejectBtn: "wl-reject",
  chatSection: "wl-chat-section",
  chatMessages: "wl-chat-messages",
  chatInput: "wl-chat-input",
  chatSendBtn: "wl-chat-send",
  chatFileInput: "wl-chat-file-input",
  chatFileBtn: "wl-chat-file-btn",
  disconnectBtn: "wl-disconnect",
  silentSection: "wl-silent-section",
  silentSecret: "wl-silent-secret",
  silentCopyBtn: "wl-silent-copy",
  silentDisconnectBtn: "wl-silent-disconnect",
  disconnectedSection: "wl-disconnected-section",
  newSessionBtn: "wl-new-session",
  errorSection: "wl-error-section",
  errorMessage: "wl-error-message",
  errorRetryBtn: "wl-error-retry",
  relayAssistToggle: "wl-relay-assist",
  relayConnectBtn: "wl-relay-connect",
} as const;

/* ── DOM Helpers ──────────────────────────────────────────── */

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

type LiveQrKind = "offer" | "answer";
const LIVE_QR_PREFIX = "WLV1";
const LIVE_CODE_MIN_LEN = 48;

function buildLiveQrPayload(kind: LiveQrKind, code: string): string {
  return `${LIVE_QR_PREFIX}:${kind}:${code}`;
}

function extractLiveCodeCandidate(raw: string, expectedKind?: LiveQrKind): string | null {
  const text = raw.trim();
  if (!text) return null;

  const prefixed = text.match(/WLV1:(offer|answer):([A-Za-z0-9_-]{16,})/i);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase() as LiveQrKind;
    if (expectedKind && kind !== expectedKind) return null;
    return prefixed[2];
  }

  if (text.length >= LIVE_CODE_MIN_LEN && /^[A-Za-z0-9_-]+$/.test(text)) {
    return text;
  }

  const fallback = text.match(/[A-Za-z0-9_-]{48,}/);
  if (!fallback) return null;
  return fallback[0];
}

/* ── Resolve ──────────────────────────────────────────────── */

export function resolveWhisperLiveUIOptions(root: ParentNode = document): WhisperLiveUIOptions | null {
  const IDS = WHISPER_LIVE_IDS;

  const page = q(root, "whisper-page");
  const logOutput = asPre(q(root, "whisper-log-output"));
  const logDot = q(root, "whisper-log-dot");
  const liveStatusLine = q(root, "wl-status-line");

  const liveSection = q(root, IDS.liveSection);
  const createBtn = asButton(q(root, IDS.createBtn));
  const joinInput = asInput(q(root, IDS.joinInput));
  const joinBtn = asButton(q(root, IDS.joinBtn));
  const joinPasteBtn = asButton(q(root, IDS.joinPasteBtn));
  const joinQrScanBtn = asButton(q(root, IDS.joinQrScanBtn));
  const joinQrImageBtn = asButton(q(root, IDS.joinQrImageBtn));
  const joinQrFileInput = asInput(q(root, IDS.joinQrFileInput));
  const joinQrStopBtn = asButton(q(root, IDS.joinQrStopBtn));
  const joinQrPanel = q(root, IDS.joinQrPanel);
  const joinQrStatus = q(root, IDS.joinQrStatus);
  const joinQrVideo = root.querySelector<HTMLVideoElement>(`#${IDS.joinQrVideo}`);
  const phraseInput = asInput(q(root, IDS.phraseInput));
  const externalAssistToggle = asInput(q(root, IDS.externalAssistToggle));

  const offerSection = q(root, IDS.offerSection);
  const offerCode = q(root, IDS.offerCode);
  const offerCopyBtn = asButton(q(root, IDS.offerCopyBtn));
  const offerBackBtn = asButton(q(root, IDS.offerBackBtn));
  const offerQrToggleBtn = asButton(q(root, IDS.offerQrToggleBtn));
  const offerQrPanel = q(root, IDS.offerQrPanel);
  const offerQrCanvas = root.querySelector<HTMLCanvasElement>(`#${IDS.offerQrCanvas}`);
  const offerQrStatus = q(root, IDS.offerQrStatus);
  const answerInput = asInput(q(root, IDS.answerInput));
  const answerApplyBtn = asButton(q(root, IDS.answerApplyBtn));

  const answerSection = q(root, IDS.answerSection);
  const answerCode = q(root, IDS.answerCode);
  const answerCopyBtn = asButton(q(root, IDS.answerCopyBtn));
  const answerQrToggleBtn = asButton(q(root, IDS.answerQrToggleBtn));
  const answerQrPanel = q(root, IDS.answerQrPanel);
  const answerQrCanvas = root.querySelector<HTMLCanvasElement>(`#${IDS.answerQrCanvas}`);
  const answerQrStatus = q(root, IDS.answerQrStatus);

  const connectingSection = q(root, IDS.connectingSection);
  const connectingStatus = q(root, IDS.connectingStatus);

  const verifySection = q(root, IDS.verifySection);
  const fingerprintDisplay = q(root, IDS.fingerprintDisplay);
  const confirmBtn = asButton(q(root, IDS.confirmBtn));
  const rejectBtn = asButton(q(root, IDS.rejectBtn));

  const chatSection = q(root, IDS.chatSection);
  const chatMessages = q(root, IDS.chatMessages);
  const chatInput = asInput(q(root, IDS.chatInput));
  const chatSendBtn = asButton(q(root, IDS.chatSendBtn));
  const chatFileInput = asInput(q(root, IDS.chatFileInput));
  const chatFileBtn = asButton(q(root, IDS.chatFileBtn));
  const transportRadios = root.querySelectorAll<HTMLInputElement>('input[name="wl-transport"]');
  const disconnectBtn = asButton(q(root, IDS.disconnectBtn));

  const silentSection = q(root, IDS.silentSection);
  const silentSecret = q(root, IDS.silentSecret);
  const silentCopyBtn = asButton(q(root, IDS.silentCopyBtn));
  const silentDisconnectBtn = asButton(q(root, IDS.silentDisconnectBtn));

  const disconnectedSection = q(root, IDS.disconnectedSection);
  const newSessionBtn = asButton(q(root, IDS.newSessionBtn));

  const errorSection = q(root, IDS.errorSection);
  const errorMessage = q(root, IDS.errorMessage);
  const errorRetryBtn = asButton(q(root, IDS.errorRetryBtn));

  // Relay assist elements — queried separately, not required
  const relayAssistToggle = asInput(q(root, IDS.relayAssistToggle));
  const relayConnectBtn = asButton(q(root, IDS.relayConnectBtn));

  if (
    !page || !logOutput || !logDot || !liveStatusLine ||
    !liveSection || !createBtn || !joinInput || !joinBtn || !joinPasteBtn || !joinQrScanBtn || !joinQrImageBtn ||
    !joinQrFileInput || !joinQrStopBtn || !joinQrPanel || !joinQrStatus || !joinQrVideo || !phraseInput || !externalAssistToggle ||
    !offerSection || !offerCode || !offerCopyBtn || !offerBackBtn || !offerQrToggleBtn || !offerQrPanel || !offerQrCanvas || !offerQrStatus || !answerInput || !answerApplyBtn ||
    !answerSection || !answerCode || !answerCopyBtn || !answerQrToggleBtn || !answerQrPanel || !answerQrCanvas || !answerQrStatus ||
    !connectingSection || !connectingStatus ||
    !verifySection || !fingerprintDisplay || !confirmBtn || !rejectBtn ||
    !chatSection || !chatMessages || !chatInput || !chatSendBtn ||
    !chatFileInput || !chatFileBtn || !disconnectBtn ||
    !silentSection || !silentSecret || !silentCopyBtn || !silentDisconnectBtn ||
    !disconnectedSection || !newSessionBtn ||
    !errorSection || !errorMessage || !errorRetryBtn ||
    transportRadios.length === 0
  ) {
    return null;
  }

  return {
    page, logOutput, logDot, liveStatusLine,
    liveSection, createBtn, joinInput, joinBtn, joinPasteBtn, joinQrScanBtn, joinQrImageBtn,
    joinQrFileInput, joinQrStopBtn, joinQrPanel, joinQrStatus, joinQrVideo, phraseInput, externalAssistToggle,
    offerSection, offerCode, offerCopyBtn, offerBackBtn, offerQrToggleBtn, offerQrPanel, offerQrCanvas, offerQrStatus, answerInput, answerApplyBtn,
    answerSection, answerCode, answerCopyBtn, answerQrToggleBtn, answerQrPanel, answerQrCanvas, answerQrStatus,
    connectingSection, connectingStatus,
    verifySection, fingerprintDisplay, confirmBtn, rejectBtn,
    chatSection, chatMessages, chatInput, chatSendBtn,
    chatFileInput, chatFileBtn, transportRadios, disconnectBtn,
    silentSection, silentSecret, silentCopyBtn, silentDisconnectBtn,
    disconnectedSection, newSessionBtn,
    errorSection, errorMessage, errorRetryBtn,
    ...(relayAssistToggle ? { relayAssistToggle } : {}),
    ...(relayConnectBtn ? { relayConnectBtn } : {}),
  };
}

/* ── Init ─────────────────────────────────────────────────── */

export function initWhisperLive(opts: WhisperLiveUIOptions): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  let session: WhisperLiveSession | null = null;
  const objectUrls = new Set<string>();
  let busy = false;
  let liveQrSupported = false;
  let offerQrExpanded = false;
  let answerQrExpanded = false;

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

  /* ── Phase management ─────────────────────────────────── */

  const allPhases = [
    opts.liveSection,
    opts.offerSection,
    opts.answerSection,
    opts.connectingSection,
    opts.verifySection,
    opts.chatSection,
    opts.silentSection,
    opts.disconnectedSection,
    opts.errorSection,
  ];

  function showPhase(el: HTMLElement): void {
    if (qrScanSession.active && el !== opts.liveSection) {
      stopJoinQrScan("cancelled");
    }
    for (const phase of allPhases) {
      phase.style.display = phase === el ? "" : "none";
    }
  }

  function pulsePasteState(ok: boolean): void {
    opts.joinPasteBtn.classList.remove("ws-copy-pulse", "ws-reject-pulse");
    void opts.joinPasteBtn.offsetWidth;
    opts.joinPasteBtn.classList.add(ok ? "ws-copy-pulse" : "ws-reject-pulse");
  }

  function setJoinQrUiState(scanning: boolean): void {
    opts.joinQrScanBtn.disabled = busy || scanning || !liveQrSupported;
    opts.joinQrImageBtn.disabled = busy || scanning;
    opts.joinQrStopBtn.style.display = scanning ? "" : "none";
  }

  function setJoinQrStatus(text: string): void {
    opts.joinQrStatus.textContent = text;
  }

  function setOfferQrExpanded(expanded: boolean): void {
    offerQrExpanded = expanded;
    opts.offerQrPanel.style.display = expanded ? "" : "none";
    opts.offerQrToggleBtn.textContent = expanded ? "Hide QR" : "Show QR";
    opts.offerQrToggleBtn.setAttribute("aria-expanded", String(expanded));
  }

  function setAnswerQrExpanded(expanded: boolean): void {
    answerQrExpanded = expanded;
    opts.answerQrPanel.style.display = expanded ? "" : "none";
    opts.answerQrToggleBtn.textContent = expanded ? "Hide QR" : "Show QR";
    opts.answerQrToggleBtn.setAttribute("aria-expanded", String(expanded));
  }

  function aborted(): boolean {
    return signal.aborted;
  }

  function applyJoinOfferCandidate(raw: string, source: "camera" | "image" | "paste"): boolean {
    const code = extractLiveCodeCandidate(raw, "offer");
    if (!code) {
      setJoinQrStatus(source === "paste" ? "No offer code found." : "Offer QR not recognized.");
      return false;
    }
    opts.joinInput.value = code;
    updateControls();
    setJoinQrStatus("Offer code loaded.");
    if (source !== "camera") {
      try { opts.joinBtn.focus(); } catch { /* noop */ }
    }
    return true;
  }

  function normalizeTypedCodes(): void {
    const joinNormalized = extractLiveCodeCandidate(opts.joinInput.value, "offer");
    if (joinNormalized && joinNormalized !== opts.joinInput.value.trim()) {
      opts.joinInput.value = joinNormalized;
    }

    const answerNormalized = extractLiveCodeCandidate(opts.answerInput.value, "answer");
    if (answerNormalized && answerNormalized !== opts.answerInput.value.trim()) {
      opts.answerInput.value = answerNormalized;
    }
  }

  function stopJoinQrScan(reason: QrScanStopReason = "cancelled"): void {
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

    opts.joinQrVideo.pause();
    opts.joinQrVideo.srcObject = null;
    opts.joinQrPanel.style.display = "none";
    setJoinQrUiState(false);

    if (reason === "cancelled") {
      setJoinQrStatus("");
    }
  }

  async function scanJoinFromImage(file: File): Promise<void> {
    const decoded = await decodeQrTextFromImage(file);
    if (aborted()) return;
    if (!decoded) {
      setJoinQrStatus("No offer code found.");
      return;
    }
    if (!applyJoinOfferCandidate(decoded.rawValue, "image")) {
      setJoinQrStatus("Offer QR not recognized.");
    }
  }

  async function startJoinQrScan(): Promise<void> {
    if (qrScanSession.active) return;
    const runId = qrScanSession.runId + 1;
    qrScanSession.runId = runId;

    const capability = await getQrScannerCapability();
    if (aborted() || runId !== qrScanSession.runId) return;
    if (!capability.supported) {
      setJoinQrStatus("Camera unavailable.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setJoinQrStatus("Camera unavailable.");
      return;
    }

    const detector = await createQrDetector();
    if (aborted() || runId !== qrScanSession.runId) return;
    if (!detector) {
      setJoinQrStatus("Camera unavailable.");
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
      opts.joinQrVideo.srcObject = stream;
      await opts.joinQrVideo.play();
      if (aborted() || runId !== qrScanSession.runId) {
        stopJoinQrScan("cancelled");
        return;
      }

      qrScanSession.active = true;
      opts.joinQrPanel.style.display = "";
      setJoinQrUiState(true);
      setJoinQrStatus("Scanning…");

      const loop = async (at: number): Promise<void> => {
        if (!qrScanSession.active || aborted() || runId !== qrScanSession.runId) return;
        if (at - qrScanSession.lastFrameAt < getQrScanIntervalMs()) {
          qrScanSession.rafId = requestAnimationFrame((t) => { void loop(t); });
          return;
        }

        qrScanSession.lastFrameAt = at;
        try {
          const detections = await detector.detect(opts.joinQrVideo);
          if (!qrScanSession.active || aborted() || runId !== qrScanSession.runId) return;
          for (const detection of detections) {
            if (!detection.rawValue) continue;
            if (applyJoinOfferCandidate(detection.rawValue, "camera")) {
              stopJoinQrScan("accepted");
              return;
            }
          }
        } catch {
          stopJoinQrScan("error");
          setJoinQrStatus("Scan failed.");
          return;
        }

        qrScanSession.rafId = requestAnimationFrame((t) => { void loop(t); });
      };

      qrScanSession.rafId = requestAnimationFrame((t) => { void loop(t); });
    } catch {
      stopJoinQrScan("error");
      setJoinQrStatus("Camera unavailable.");
    }
  }

  function renderOfferQr(code: string): void {
    try {
      renderQrToCanvas(opts.offerQrCanvas, buildLiveQrPayload("offer", code));
      opts.offerQrStatus.textContent = "scan to auto-fill the offer code.";
    } catch {
      opts.offerQrStatus.textContent = "QR preview unavailable in this browser.";
    }
  }

  function renderAnswerQr(code: string): void {
    try {
      renderQrToCanvas(opts.answerQrCanvas, buildLiveQrPayload("answer", code));
      opts.answerQrStatus.textContent = "scan to auto-fill the answer code.";
    } catch {
      opts.answerQrStatus.textContent = "qr preview unavailable in this browser.";
    }
  }

  /* ── Log ──────────────────────────────────────────────── */

  function appendLog(line: string): void {
    appendToLog(opts.logOutput, line);
  }

  function setLogActive(active: boolean): void {
    setLogDotActive(opts.logDot, active);
  }

  function updateStatus(text: string): void {
    opts.liveStatusLine.textContent = text;
    opts.liveStatusLine.classList.remove("whisper-status--ready");
  }

  function setBusy(next: boolean): void {
    busy = next;
    updateControls();
  }

  function updateControls(): void {
    const joinHasCode = opts.joinInput.value.trim().length > 0;
    const answerHasCode = opts.answerInput.value.trim().length > 0;
    const hasChatText = opts.chatInput.value.trim().length > 0;
    const hasSession = session !== null;

    opts.createBtn.disabled = busy;
    opts.joinBtn.disabled = busy || !joinHasCode;
    opts.joinPasteBtn.disabled = busy;
    opts.answerApplyBtn.disabled = busy || !hasSession || !answerHasCode;

    // STUN toggle — only visible in manual mode
    opts.externalAssistToggle.disabled = busy || hasSession;

    opts.offerCopyBtn.disabled = (opts.offerCode.textContent ?? "").trim().length === 0;
    opts.offerBackBtn.disabled = busy;
    opts.answerCopyBtn.disabled = (opts.answerCode.textContent ?? "").trim().length === 0;
    const hasOffer = (opts.offerCode.textContent ?? "").trim().length > 0;
    const hasAnswer = (opts.answerCode.textContent ?? "").trim().length > 0;
    opts.offerQrToggleBtn.disabled = !hasOffer;
    opts.answerQrToggleBtn.disabled = !hasAnswer;

    if (!hasOffer && offerQrExpanded) setOfferQrExpanded(false);
    if (!hasAnswer && answerQrExpanded) setAnswerQrExpanded(false);

    if (!qrScanSession.active) {
      setJoinQrUiState(false);
    }

    if (opts.relayConnectBtn) {
      opts.relayConnectBtn.disabled = busy;
    }

    // Hide mode switch when busy or mid-session
    const modeSwitchWrap = modeSwitchBtn?.closest(".wl-mode-switch") as HTMLElement | null;
    if (modeSwitchWrap) {
      modeSwitchWrap.style.display = (busy || hasSession) ? "none" : "";
    }

    opts.chatSendBtn.disabled = busy || !hasSession || !hasChatText;
    opts.chatFileBtn.disabled = busy || !hasSession;

    opts.confirmBtn.disabled = busy || !hasSession;
    opts.rejectBtn.disabled = busy || !hasSession;
    opts.disconnectBtn.disabled = busy || !hasSession;
    opts.silentDisconnectBtn.disabled = busy || !hasSession;
  }

  /* ── Chat rendering ───────────────────────────────────── */

  function addChatMessage(msg: LiveMessage): void {
    const div = document.createElement("div");
    div.className = `wl-msg wl-msg--${msg.direction}`;

    if (msg.type === "text") {
      const textEl = document.createElement("span");
      textEl.className = "wl-msg-text";
      textEl.textContent = msg.text ?? "";
      div.appendChild(textEl);
    } else if (msg.type === "file") {
      const fileEl = document.createElement("div");
      fileEl.className = "wl-msg-file";

      const nameEl = document.createElement("span");
      nameEl.className = "wl-msg-file-name";
      nameEl.textContent = msg.fileName ?? "file";

      const sizeEl = document.createElement("span");
      sizeEl.className = "wl-msg-file-size";
      sizeEl.textContent = msg.fileSize ? formatSize(msg.fileSize) : "";

      fileEl.append(nameEl, sizeEl);

      // Download link if we have file data (peer messages)
      if (msg.fileData) {
        const ab = new ArrayBuffer(msg.fileData.byteLength);
        new Uint8Array(ab).set(msg.fileData);
        const blob = new Blob([ab], { type: msg.fileType ?? "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        objectUrls.add(url);

        const link = document.createElement("a");
        link.className = "wl-msg-file-download";
        link.href = url;
        link.download = msg.fileName ?? "file";
        link.textContent = "download";
        fileEl.appendChild(link);
      }

      div.appendChild(fileEl);
    } else if (msg.type === "system") {
      const sysEl = document.createElement("span");
      sysEl.className = "wl-msg-system";
      sysEl.textContent = msg.text ?? "";
      div.appendChild(sysEl);
    }

    const timeEl = document.createElement("time");
    timeEl.className = "wl-msg-time";
    timeEl.textContent = formatTime(msg.timestamp);
    div.appendChild(timeEl);

    opts.chatMessages.appendChild(div);
    opts.chatMessages.scrollTop = opts.chatMessages.scrollHeight;
  }

  /* ── Session creation ─────────────────────────────────── */

  function getExternalAssistDefaultFromUrl(): boolean {
    try {
      const params = new URLSearchParams(window.location.search);
      const ice = (params.get("ice") || "").toLowerCase();
      const stunFlag = (params.get("stun") || "").toLowerCase();
      return ice === "stun" || stunFlag === "1" || stunFlag === "true";
    } catch {
      return false;
    }
  }

  function getRelayAssistDefaultFromUrl(): boolean {
    try {
      const params = new URLSearchParams(window.location.search);
      const relay = (params.get("relay") || "").toLowerCase();
      return relay === "1" || relay === "true";
    } catch {
      return false;
    }
  }

  function getPhraseFromUrl(): string {
    try {
      return new URLSearchParams(window.location.search).get("phrase") || "";
    } catch {
      return "";
    }
  }

  function getAutoConnectFromUrl(): boolean {
    try {
      const params = new URLSearchParams(window.location.search);
      const auto = (params.get("auto") || "").toLowerCase();
      return auto === "1" || auto === "true";
    } catch {
      return false;
    }
  }

  function createSession(): WhisperLiveSession {
    const externalAssist = opts.externalAssistToggle.checked;
    const rtcConfig = externalAssist ? WHISPER_LIVE_RTC_PUBLIC_STUN : WHISPER_LIVE_RTC_LOCAL_ONLY;

    // Only log verbose network info in manual mode — relay users don't need to see it
    if (!relayActive) {
      if (externalAssist) {
        appendLog("external assist enabled. helps connect across different networks");
      } else {
        appendLog("local-only mode. enable external assist if connecting across networks fails");
      }
    }

    return new WhisperLiveSession({
      onStateChange: handleStateChange,
      onFingerprint: handleFingerprint,
      onMessage: handleMessage,
      onLog: appendLog,
    }, {
      rtcConfig,
    });
  }

  let previousState: LiveState = "idle";

  function handleStateChange(state: LiveState, detail?: string): void {
    // During relay exchange, suppress intermediate session states that would
    // overwrite the relay UI. The relay handler manages the connecting phase
    // display itself and clears relayActive before terminal states fire.
    if (relayActive) {
      const suppressed: readonly LiveState[] = [
        "offering", "waiting-for-answer", "answering", "connecting", "disconnected",
      ];
      if (suppressed.includes(state)) {
        previousState = state;
        return;
      }
    }

    const wasRecovering = previousState === "recovering";
    previousState = state;

    switch (state) {
      case "idle":
        showPhase(opts.liveSection);
        updateStatus("ready to connect");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;

      case "offering":
        setLogActive(true);
        updateStatus("preparing...");
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "creating offer...";
        setBusy(true);
        break;

      case "waiting-for-answer":
        showPhase(opts.offerSection);
        updateStatus("share your offer, then paste their reply");
        setLogActive(false);
        setBusy(false);
        updateControls();
        setTimeout(() => {
          try { opts.answerInput.focus(); } catch { /* noop */ }
        }, 0);
        break;

      case "answering":
        setLogActive(true);
        updateStatus("preparing...");
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "creating answer...";
        setBusy(true);
        break;

      case "connecting":
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "connecting...";
        updateStatus("connecting...");
        setLogActive(true);
        setBusy(true);
        break;

      case "handshaking":
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "securing the channel...";
        updateStatus("encrypting...");
        setBusy(true);
        break;

      case "verifying":
        showPhase(opts.verifySection);
        updateStatus("verify this matches your peer's screen");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;

      case "live":
        showPhase(opts.chatSection);
        updateStatus("connected. end-to-end encrypted");
        opts.liveStatusLine.classList.add("whisper-status--ready");
        setLogActive(false);
        opts.chatInput.disabled = false;
        setBusy(false);
        updateControls();
        opts.chatInput.focus();
        if (wasRecovering) {
          addChatMessage({
            type: "system", direction: "system",
            text: "reconnected",
            timestamp: Date.now(),
          });
        } else {
          addChatMessage({
            type: "system", direction: "system",
            text: "connected. messages are end-to-end encrypted",
            timestamp: Date.now(),
          });
        }
        break;

      case "silent": {
        showPhase(opts.silentSection);
        const secret = session?.getSharedSecret();
        if (secret) {
          opts.silentSecret.textContent = secret;
        }
        updateStatus("shared secret ready for Whisper password mode");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;
      }

      case "recovering":
        showPhase(opts.chatSection);
        updateStatus("reconnecting...");
        setLogActive(true);
        opts.chatSendBtn.disabled = true;
        opts.chatFileBtn.disabled = true;
        opts.chatInput.disabled = true;
        addChatMessage({
          type: "system", direction: "system",
          text: "connection interrupted, reconnecting...",
          timestamp: Date.now(),
        });
        break;

      case "disconnected":
        showPhase(opts.disconnectedSection);
        updateStatus("session ended");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;

      case "error":
        showPhase(opts.errorSection);
        opts.errorMessage.textContent = detail ?? "something went wrong";
        updateStatus("couldn't connect");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;
    }
  }

  function handleFingerprint(emoji: string): void {
    opts.fingerprintDisplay.textContent = emoji;
  }

  function handleMessage(msg: LiveMessage): void {
    addChatMessage(msg);
  }

  /* ── Reset to idle ─────────────────────────────────────── */

  function resetToIdle(): void {
    relayActive = false;
    lastErrorWasRelay = false;
    if (relayAbort) {
      relayAbort.abort();
      relayAbort = null;
    }
    if (qrScanSession.active) {
      stopJoinQrScan("cancelled");
    }
    if (session) {
      session.disconnect();
      session = null;
    }
    clearNode(opts.chatMessages);
    opts.offerCode.textContent = "";
    opts.answerCode.textContent = "";
    opts.joinInput.value = "";
    opts.answerInput.value = "";
    opts.phraseInput.value = "";
    if (manualPhraseInput) manualPhraseInput.value = "";
    opts.chatInput.value = "";
    opts.fingerprintDisplay.textContent = "";
    opts.silentSecret.textContent = "";
    opts.joinQrStatus.textContent = "";
    opts.offerQrStatus.textContent = "";
    opts.answerQrStatus.textContent = "";
    setOfferQrExpanded(false);
    setAnswerQrExpanded(false);
    opts.errorMessage.textContent = "";
    showPhase(opts.liveSection);
    // Re-sync relay/manual panel visibility
    if (opts.relayAssistToggle) applyRelayToggle(opts.relayAssistToggle.checked);
    updateStatus("ready to connect");
    setLogActive(false);
    setBusy(false);
    updateControls();
  }

  /* ── Relay assist ────────────────────────────────────────── */

  let relayAbort: AbortController | null = null;
  /** While true, handleStateChange suppresses intermediate session states
   *  that would overwrite the relay UI. Terminal states (handshaking,
   *  verifying, live, error) still flow through. */
  let relayActive = false;
  /** Set when the last error came from relay flow — error retry preserves phrase. */
  let lastErrorWasRelay = false;

  // Cache layout elements inside the idle phase
  const relayPanel = opts.liveSection.querySelector<HTMLElement>("#wl-relay-panel");
  const manualPanel = opts.liveSection.querySelector<HTMLElement>("#wl-manual-panel");
  const idleLede = opts.liveSection.querySelector<HTMLElement>("#wl-idle-lede");
  const modeSwitchBtn = opts.liveSection.querySelector<HTMLButtonElement>("#wl-mode-switch-btn");
  const manualPhraseInput = opts.liveSection.querySelector<HTMLInputElement>("#wl-manual-phrase");

  function applyRelayToggle(checked: boolean): void {
    if (!relayPanel || !manualPanel || !modeSwitchBtn) return;

    if (checked) {
      relayPanel.style.display = "";
      manualPanel.style.display = "none";
      modeSwitchBtn.textContent = "or connect manually";
      if (idleLede) idleLede.textContent = "type the same phrase on both sides and connect. that's it.";
      opts.externalAssistToggle.checked = true;
      updateControls();
    } else {
      relayPanel.style.display = "none";
      manualPanel.style.display = "";
      modeSwitchBtn.textContent = "or use relay assist";
      if (idleLede) idleLede.textContent = "encrypted peer-to-peer messaging. create a channel or join one.";
      // Sync phrase from relay input to manual input
      if (manualPhraseInput) manualPhraseInput.value = opts.phraseInput.value;
      updateControls();
    }
  }

  /** Get the phrase from the active mode's input. */
  function getActivePhrase(): string {
    if (opts.relayAssistToggle?.checked) return opts.phraseInput.value.trim();
    return manualPhraseInput?.value.trim() ?? "";
  }

  /** Map internal error codes to friendly messages. */
  function friendlyRelayError(raw: string): string {
    if (raw.includes("peer-not-found")) {
      return "couldn't find your peer. make sure you both typed the exact same phrase, then try again at the same time";
    }
    if (raw.includes("relay-unavailable")) {
      return "couldn't reach the relay. check your connection and try again, or use manual mode";
    }
    if (raw.includes("handshake-failed")) {
      return "handshake failed. try again, or use a different phrase";
    }
    return raw;
  }

  async function handleRelayConnect(): Promise<void> {
    const phrase = opts.phraseInput.value.trim();
    if (!phrase) {
      opts.phraseInput.focus();
      // Brief visual pulse on the phrase input
      opts.phraseInput.classList.add("ws-reject-pulse");
      setTimeout(() => opts.phraseInput.classList.remove("ws-reject-pulse"), 400);
      return;
    }

    setBusy(true);
    relayActive = true;
    relayAbort = new AbortController();

    showPhase(opts.connectingSection);
    opts.connectingStatus.textContent = "preparing...";
    updateStatus("connecting...");
    setLogActive(true);

    opts.externalAssistToggle.checked = true;
    session = createSession();

    try {
      // Session fires offering → waiting-for-answer internally;
      // relayActive suppresses their UI side-effects
      const offerCode = await session.createOffer(phrase);
      if (aborted()) return;

      opts.connectingStatus.textContent = "connecting to relay...";

      const { exchangeViaTracker } = await import("./live-tracker");

      // If we become the answerer, tear down the pre-created session
      // and build a fresh one around the peer's offer
      const acceptFn = async (peerOfferCode: string): Promise<string> => {
        if (session) { session.disconnect(); session = null; }
        session = createSession();
        return session.acceptOffer(peerOfferCode, phrase);
      };

      const callbacks = {
        onStatus: (msg: string) => {
          if (aborted()) return;
          opts.connectingStatus.textContent = msg;
          updateStatus(msg);
        },
        onLog: (msg: string) => {
          if (aborted()) return;
          appendLog(msg);
        },
      };

      const result = await exchangeViaTracker(
        phrase, offerCode, acceptFn, callbacks, relayAbort.signal,
      );

      if (aborted()) return;

      // Relay done — hand control back to session state machine
      relayActive = false;

      if (result.role === "offerer" && result.peerAnswerCode) {
        await session!.applyAnswer(result.peerAnswerCode);
      }
      // Answerer: session may have already progressed past connecting
      // (DataChannel can open instantly on same-machine). Only touch UI
      // if the session is still waiting.
      if (result.role === "answerer" && session && session.state === "connecting") {
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "connecting directly...";
        updateStatus("connecting...");
      }
    } catch (err) {
      relayActive = false;
      if (aborted()) return;
      if (session) { session.disconnect(); session = null; }
      const raw = err instanceof Error ? err.message : "unknown error";
      appendLog(`relay: ${raw}`);
      lastErrorWasRelay = true;
      handleStateChange("error", friendlyRelayError(raw));
    } finally {
      relayAbort = null;
    }
  }

  /* ── Event Listeners ───────────────────────────────────── */

  // Mode switch button — toggles between relay and manual
  if (modeSwitchBtn && opts.relayAssistToggle) {
    modeSwitchBtn.addEventListener("click", () => {
      const next = !opts.relayAssistToggle!.checked;
      opts.relayAssistToggle!.checked = next;
      // Sync phrase between inputs before toggling
      if (next && manualPhraseInput) {
        opts.phraseInput.value = manualPhraseInput.value;
      }
      applyRelayToggle(next);
      // Focus the active mode's input
      if (next) {
        opts.phraseInput.focus();
      } else {
        manualPhraseInput?.focus();
      }
    }, { signal });
  }

  // Relay connect button
  if (opts.relayConnectBtn) {
    opts.relayConnectBtn.addEventListener("click", () => {
      void handleRelayConnect();
    }, { signal });
  }

  // Enter key on phrase input → trigger relay connect when relay is active
  opts.phraseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && opts.relayAssistToggle?.checked && !busy) {
      e.preventDefault();
      void handleRelayConnect();
    }
  }, { signal });

  // Create channel (offerer)
  opts.createBtn.addEventListener("click", async () => {
    session = createSession();
    const phrase = getActivePhrase() || undefined;
    try {
      const offerCode = await session.createOffer(phrase);
      opts.offerCode.textContent = offerCode;
      renderOfferQr(offerCode);
      setOfferQrExpanded(false);
      updateControls();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      appendLog(`offer failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  // Copy offer code
  opts.offerCopyBtn.addEventListener("click", async () => {
    const code = opts.offerCode.textContent ?? "";
    if (!code) return;
    try {
      await copyToClipboard(code);
      flashText(opts.offerCopyBtn, "Copied");
      appendLog("offer code copied to clipboard");
    } catch {
      appendLog("copy failed");
    }
  }, { signal });

  // Back from create/offer phase
  opts.offerBackBtn.addEventListener("click", () => {
    resetToIdle();
  }, { signal });

  // Apply answer code (offerer)
  opts.answerApplyBtn.addEventListener("click", async () => {
    normalizeTypedCodes();
    const code = opts.answerInput.value.trim();
    if (!code || !session) return;
    try {
      await session.applyAnswer(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      appendLog(`answer apply failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  // Join channel (answerer) — paste offer code
  opts.joinBtn.addEventListener("click", async () => {
    normalizeTypedCodes();
    const offerCode = opts.joinInput.value.trim();
    if (!offerCode) return;
    session = createSession();
    const phrase = getActivePhrase() || undefined;
    try {
      const answerCodeStr = await session.acceptOffer(offerCode, phrase);
      opts.answerCode.textContent = answerCodeStr;
      renderAnswerQr(answerCodeStr);
      setAnswerQrExpanded(false);
      showPhase(opts.answerSection);
      updateStatus("step 2/2: send answer back to the creator");
      setBusy(false);
      updateControls();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      appendLog(`join failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  // Copy answer code (answerer)
  opts.answerCopyBtn.addEventListener("click", async () => {
    const code = opts.answerCode.textContent ?? "";
    if (!code) return;
    try {
      await copyToClipboard(code);
      flashText(opts.answerCopyBtn, "Copied");
      appendLog("answer code copied to clipboard");
    } catch {
      appendLog("copy failed");
    }
  }, { signal });

  // Confirm fingerprint
  opts.confirmBtn.addEventListener("click", () => {
    session?.confirmFingerprint();
  }, { signal });

  // Reject fingerprint
  opts.rejectBtn.addEventListener("click", () => {
    session?.rejectFingerprint();
  }, { signal });

  // Send text message
  const sendMessage = async () => {
    const text = opts.chatInput.value.trim();
    if (!text || !session) return;
    opts.chatInput.value = "";
    updateControls();
    try {
      await session.sendText(text);
    } catch (err) {
      appendLog(`send failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  };

  opts.chatSendBtn.addEventListener("click", sendMessage, { signal });
  opts.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, { signal });

  // Keep button states in sync with inputs
  opts.joinInput.addEventListener("input", () => {
    normalizeTypedCodes();
    updateControls();
  }, { signal });
  opts.joinInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!opts.joinBtn.disabled) {
      opts.joinBtn.click();
    }
  }, { signal });

  opts.answerInput.addEventListener("input", () => {
    normalizeTypedCodes();
    updateControls();
  }, { signal });
  opts.answerInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!opts.answerApplyBtn.disabled) {
      opts.answerApplyBtn.click();
    }
  }, { signal });
  opts.chatInput.addEventListener("input", updateControls, { signal });

  // Join niceties: clipboard + QR camera/image
  opts.joinPasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const ok = applyJoinOfferCandidate(text, "paste");
      pulsePasteState(ok);
    } catch {
      pulsePasteState(false);
    }
  }, { signal });

  opts.joinQrScanBtn.addEventListener("click", () => {
    void startJoinQrScan();
  }, { signal });

  opts.joinQrImageBtn.addEventListener("click", () => {
    opts.joinQrFileInput.click();
  }, { signal });

  opts.joinQrStopBtn.addEventListener("click", () => {
    stopJoinQrScan("cancelled");
  }, { signal });

  opts.joinQrFileInput.addEventListener("change", () => {
    const file = opts.joinQrFileInput.files?.[0];
    opts.joinQrFileInput.value = "";
    if (!file) return;
    void scanJoinFromImage(file).catch(() => {
      setJoinQrStatus("Scan failed.");
    });
  }, { signal });

  opts.offerQrToggleBtn.addEventListener("click", () => {
    if (opts.offerQrToggleBtn.disabled) return;
    setOfferQrExpanded(!offerQrExpanded);
  }, { signal });

  opts.answerQrToggleBtn.addEventListener("click", () => {
    if (opts.answerQrToggleBtn.disabled) return;
    setAnswerQrExpanded(!answerQrExpanded);
  }, { signal });

  // Send file
  opts.chatFileBtn.addEventListener("click", () => {
    opts.chatFileInput.click();
  }, { signal });

  opts.chatFileInput.addEventListener("change", async () => {
    const file = opts.chatFileInput.files?.[0];
    if (!file || !session) return;
    opts.chatFileInput.value = "";
    try {
      await session.sendFile(file);
    } catch (err) {
      appendLog(`file send failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, { signal });

  // File drag-and-drop on chat
  opts.chatMessages.addEventListener("dragover", (e) => {
    e.preventDefault();
    opts.chatMessages.classList.add("wl-chat-drop-active");
  }, { signal });

  opts.chatMessages.addEventListener("dragleave", () => {
    opts.chatMessages.classList.remove("wl-chat-drop-active");
  }, { signal });

  opts.chatMessages.addEventListener("drop", async (e) => {
    e.preventDefault();
    opts.chatMessages.classList.remove("wl-chat-drop-active");
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (!file || !session) return;
    try {
      await session.sendFile(file);
    } catch (err) {
      appendLog(`file send failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, { signal });

  // Transport mode selector
  opts.transportRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked && session) {
        session.setTransport(radio.value as TransportMode);
      }
    }, { signal });
  });

  // Disconnect
  opts.disconnectBtn.addEventListener("click", () => {
    session?.disconnect();
  }, { signal });

  // Silent mode copy + disconnect
  opts.silentCopyBtn.addEventListener("click", async () => {
    const secret = opts.silentSecret.textContent ?? "";
    if (!secret) return;
    try {
      await copyToClipboard(secret);
      flashText(opts.silentCopyBtn, "Copied");
      appendLog("shared secret copied to clipboard");
    } catch {
      appendLog("copy failed");
    }
  }, { signal });

  opts.silentDisconnectBtn.addEventListener("click", () => {
    session?.disconnect();
  }, { signal });

  // New session
  opts.newSessionBtn.addEventListener("click", resetToIdle, { signal });

  // Error retry — preserve phrase and relay state when retrying from a relay error
  opts.errorRetryBtn.addEventListener("click", () => {
    if (lastErrorWasRelay) {
      const savedPhrase = opts.phraseInput.value;
      const relayWasOn = opts.relayAssistToggle?.checked ?? false;
      lastErrorWasRelay = false;
      resetToIdle();
      // Restore phrase and relay toggle so user can just hit Connect again
      opts.phraseInput.value = savedPhrase;
      if (relayWasOn && opts.relayAssistToggle) {
        opts.relayAssistToggle.checked = true;
        applyRelayToggle(true);
      }
    } else {
      resetToIdle();
    }
  }, { signal });

  /* -- Initial state ---------------------------------------- */

  // Optional URL param prefill for convenience; UI remains the primary control.
  if (getExternalAssistDefaultFromUrl()) {
    opts.externalAssistToggle.checked = true;
  }

  // Sync relay UI on init — covers default checked, browser form restore, and ?relay=1
  if (opts.relayAssistToggle) {
    if (getRelayAssistDefaultFromUrl()) opts.relayAssistToggle.checked = true;
    if (opts.relayAssistToggle.checked) applyRelayToggle(true);
  }

  // ?phrase= prefills the shared phrase input
  const urlPhrase = getPhraseFromUrl();
  if (urlPhrase) {
    opts.phraseInput.value = urlPhrase;
  }

  // ?auto=1 with ?relay=1 and a phrase → auto-trigger relay connect
  if (getAutoConnectFromUrl() && opts.relayAssistToggle?.checked && opts.phraseInput.value.trim()) {
    // Slight delay so the UI has rendered before we start connecting
    setTimeout(() => { if (!aborted()) void handleRelayConnect(); }, 100);
  }

  void getQrScannerCapability().then((capability) => {
    if (aborted()) return;
    liveQrSupported = capability.supported;
    setJoinQrUiState(false);
    if (!capability.supported) {
      opts.joinQrScanBtn.title = "Camera QR scan unavailable in this browser";
    }
  });

  showPhase(opts.liveSection);
  setOfferQrExpanded(false);
  setAnswerQrExpanded(false);
  updateControls();

  /* ── Teardown ───────────────────────────────────────────── */

  return () => {
    ac.abort();
    relayActive = false;
    if (relayAbort) {
      relayAbort.abort();
      relayAbort = null;
    }
    stopJoinQrScan("teardown");
    if (session) {
      session.disconnect();
      session = null;
    }
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  };
}
