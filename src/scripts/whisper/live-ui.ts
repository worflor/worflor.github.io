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
  funnelCampfireBtn: HTMLButtonElement;

  /* Offering phase */
  offerSection: HTMLElement;
  offerCode: HTMLElement;
  offerCopyBtn: HTMLButtonElement;
  offerShareBtn: HTMLButtonElement;
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
  answerShareBtn: HTMLButtonElement;
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

const WHISPER_LIVE_IDS = {
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
  funnelCampfireBtn: "wl-funnel-campfire",
  offerSection: "wl-offer-section",
  offerCode: "wl-offer-code",
  offerCopyBtn: "wl-offer-copy",
  offerShareBtn: "wl-offer-share",
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
  answerShareBtn: "wl-answer-share",
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

/* ── Helpers ──────────────────────────────────────────────── */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "unknown";
}

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
  const I = WHISPER_LIVE_IDS;
  const el = (id: string) => q(root, id);
  const btn = (id: string) => asButton(el(id));
  const inp = (id: string) => asInput(el(id));

  const r = {
    page: el("whisper-page"), logOutput: asPre(el("whisper-log-output")),
    logDot: el("whisper-log-dot"), liveStatusLine: el("wl-status-line"),
    liveSection: el(I.liveSection), createBtn: btn(I.createBtn),
    joinInput: inp(I.joinInput), joinBtn: btn(I.joinBtn), joinPasteBtn: btn(I.joinPasteBtn),
    joinQrScanBtn: btn(I.joinQrScanBtn), joinQrImageBtn: btn(I.joinQrImageBtn),
    joinQrFileInput: inp(I.joinQrFileInput), joinQrStopBtn: btn(I.joinQrStopBtn),
    joinQrPanel: el(I.joinQrPanel), joinQrStatus: el(I.joinQrStatus),
    joinQrVideo: root.querySelector<HTMLVideoElement>(`#${I.joinQrVideo}`),
    phraseInput: inp(I.phraseInput), externalAssistToggle: inp(I.externalAssistToggle),
    funnelCampfireBtn: btn(I.funnelCampfireBtn),
    offerSection: el(I.offerSection), offerCode: el(I.offerCode),
    offerCopyBtn: btn(I.offerCopyBtn), offerBackBtn: btn(I.offerBackBtn),
    offerShareBtn: btn(I.offerShareBtn),
    offerQrToggleBtn: btn(I.offerQrToggleBtn), offerQrPanel: el(I.offerQrPanel),
    offerQrCanvas: root.querySelector<HTMLCanvasElement>(`#${I.offerQrCanvas}`),
    offerQrStatus: el(I.offerQrStatus), answerInput: inp(I.answerInput), answerApplyBtn: btn(I.answerApplyBtn),
    answerSection: el(I.answerSection), answerCode: el(I.answerCode),
    answerCopyBtn: btn(I.answerCopyBtn), answerQrToggleBtn: btn(I.answerQrToggleBtn),
    answerShareBtn: btn(I.answerShareBtn),
    answerQrPanel: el(I.answerQrPanel),
    answerQrCanvas: root.querySelector<HTMLCanvasElement>(`#${I.answerQrCanvas}`),
    answerQrStatus: el(I.answerQrStatus),
    connectingSection: el(I.connectingSection), connectingStatus: el(I.connectingStatus),
    verifySection: el(I.verifySection), fingerprintDisplay: el(I.fingerprintDisplay),
    confirmBtn: btn(I.confirmBtn), rejectBtn: btn(I.rejectBtn),
    chatSection: el(I.chatSection), chatMessages: el(I.chatMessages),
    chatInput: inp(I.chatInput), chatSendBtn: btn(I.chatSendBtn),
    chatFileInput: inp(I.chatFileInput), chatFileBtn: btn(I.chatFileBtn),
    disconnectBtn: btn(I.disconnectBtn),
    silentSection: el(I.silentSection), silentSecret: el(I.silentSecret),
    silentCopyBtn: btn(I.silentCopyBtn), silentDisconnectBtn: btn(I.silentDisconnectBtn),
    disconnectedSection: el(I.disconnectedSection), newSessionBtn: btn(I.newSessionBtn),
    errorSection: el(I.errorSection), errorMessage: el(I.errorMessage), errorRetryBtn: btn(I.errorRetryBtn),
  };

  // All required elements must be present
  for (const v of Object.values(r)) {
    if (v == null) return null;
    if (v instanceof NodeList && v.length === 0) return null;
  }

  // Relay assist elements — optional
  const relayAssistToggle = inp(I.relayAssistToggle);
  const relayConnectBtn = btn(I.relayConnectBtn);

  return {
    ...r,
    ...(relayAssistToggle ? { relayAssistToggle } : {}),
    ...(relayConnectBtn ? { relayConnectBtn } : {}),
  } as WhisperLiveUIOptions;
}

/* ── Init ─────────────────────────────────────────────────── */

export function initWhisperLive(opts: WhisperLiveUIOptions): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  const liveSurface = document.getElementById("wl-section");
  let session: WhisperLiveSession | null = null;
  const objectUrls = new Set<string>();
  let busy = false;
  let liveQrSupported = false;
  let skippedIceCandidates = 0;

  let typingSendTimer: ReturnType<typeof setTimeout> | null = null;
  let peerTypingTimer: ReturnType<typeof setTimeout> | null = null;
  const TYPING_SEND_DEBOUNCE = 3_000;
  const TYPING_DISPLAY_TIMEOUT = 4_000;

  const originalTitle = document.title;
  let unreadCount = 0;
  let hasFocus = document.hasFocus();
  type ComposeIntent = "idle" | "connecting" | "ready" | "typing" | "sending" | "success" | "error" | "drop";
  const chatCompose = opts.chatInput.closest<HTMLElement>(".wl-chat-compose");
  let composeIntentTimer: ReturnType<typeof setTimeout> | null = null;
  let composeIntentOverride: ComposeIntent | null = null;
  let composeActivity = 0;
  let composeActivityTarget = 0;
  let composeActivityVelocity = 0;
  let composeActivityRaf = 0;
  let composeActivityLastTick = 0;
  let composeFlow = 0;
  let currentLiveState: LiveState = "idle";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function syncComposeActivityVar(): void {
    if (!chatCompose) return;
    chatCompose.style.setProperty("--wl-activity", composeActivity.toFixed(3));
    chatCompose.style.setProperty("--wl-velocity", Math.min(1, Math.abs(composeActivityVelocity) * 0.18).toFixed(3));
    chatCompose.style.setProperty("--wl-flow", `${(((Math.sin(composeFlow) + 1) * 0.5) * 100).toFixed(2)}%`);
  }

  function stepComposeActivity(ts: number): void {
    const rawDt = composeActivityLastTick ? (ts - composeActivityLastTick) / 1000 : 0;
    const dt = Math.min(0.04, Math.max(0.001, rawDt || (1 / 60)));
    composeActivityLastTick = ts;

    // Exponentially decay target energy so motion naturally settles.
    composeActivityTarget *= Math.exp(-dt * 2.6);

    // 2nd-order spring dynamics (mass-spring-damper).
    const omega = 13;   // natural frequency
    const zeta = 0.72;  // damping ratio (under-damped, pleasant overshoot)
    const accel = (omega * omega * (composeActivityTarget - composeActivity))
      - (2 * zeta * omega * composeActivityVelocity);

    composeActivityVelocity += accel * dt;
    composeActivity += composeActivityVelocity * dt;
    composeActivity = Math.max(0, Math.min(1, composeActivity));

    // Procedural phase progression tied to current energy.
    composeFlow += dt * (2.4 + (composeActivity * 6.2));
    syncComposeActivityVar();

    if (
      composeActivity > 0.006
      || composeActivityTarget > 0.006
      || Math.abs(composeActivityVelocity) > 0.006
    ) {
      composeActivityRaf = requestAnimationFrame(stepComposeActivity);
      return;
    }

    composeActivity = 0;
    composeActivityTarget = 0;
    composeActivityVelocity = 0;
    syncComposeActivityVar();
    composeActivityRaf = 0;
    composeActivityLastTick = 0;
  }

  function exciteComposeActivity(boost: number): void {
    if (!chatCompose || reduceMotion) return;
    const b = Math.max(0, Math.min(1, boost));
    composeActivityTarget = Math.min(1, composeActivityTarget + b);
    composeActivityVelocity += b * 2.25;
    syncComposeActivityVar();
    if (!composeActivityRaf) {
      composeActivityRaf = requestAnimationFrame(stepComposeActivity);
    }
  }

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

  function applyPhaseVisibility(el: HTMLElement): void {
    for (const phase of allPhases) {
      phase.style.display = phase === el ? "" : "none";
    }
    if (liveSurface) {
      liveSurface.classList.toggle("wl-connected", el === opts.chatSection);
    }
  }

  function showPhase(el: HTMLElement): void {
    if (qrScanSession.active && el !== opts.liveSection) {
      stopJoinQrScan("cancelled");
    }

    applyPhaseVisibility(el);
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

  function setQrExpanded(
    expanded: boolean, panel: HTMLElement, btn: HTMLButtonElement, stateRef: { value: boolean },
  ): void {
    stateRef.value = expanded;
    panel.style.display = expanded ? "" : "none";
    btn.textContent = expanded ? "Hide QR" : "Show QR";
    btn.setAttribute("aria-expanded", String(expanded));
  }
  const offerQrState = { value: false };
  const answerQrState = { value: false };
  const setOfferQrExpanded = (v: boolean) => setQrExpanded(v, opts.offerQrPanel, opts.offerQrToggleBtn, offerQrState);
  const setAnswerQrExpanded = (v: boolean) => setQrExpanded(v, opts.answerQrPanel, opts.answerQrToggleBtn, answerQrState);

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

  function renderQr(canvas: HTMLCanvasElement, status: HTMLElement, kind: LiveQrKind, code: string): void {
    try {
      renderQrToCanvas(canvas, buildLiveQrPayload(kind, code));
      status.textContent = `scan to auto-fill the ${kind} code.`;
    } catch { status.textContent = "QR preview unavailable in this browser."; }
  }

  /* ── Log ──────────────────────────────────────────────── */

  function setConnecting(text: string): void {
    if (opts.connectingSection.style.display !== "none") {
      opts.connectingStatus.textContent = text;
    }
  }

  function updateProgressFromLog(line: string): void {
    const n = line.toLowerCase();
    if (n.includes("gathering network candidates"))    { setConnecting("finding the best direct path..."); updateStatus("checking network paths..."); }
    else if (n.includes("offer code ready"))           { updateStatus("step 1/2: send your invite code"); }
    else if (n.includes("answer code ready"))          { updateStatus("step 2/2: send your reply code"); }
    else if (n.includes("applying answer code"))       { setConnecting("verifying peer reply..."); updateStatus("applying peer reply..."); }
    else if (n.includes("connecting peer-to-peer"))    { setConnecting("opening direct channel..."); updateStatus("opening direct channel..."); }
    else if (n.includes("secure channel open"))        { setConnecting("starting end-to-end key exchange..."); updateStatus("starting key exchange..."); }
    else if (n.includes("fingerprint:"))               { updateStatus("security check: compare emoji with your peer"); }
    else if (n.includes("fingerprint confirmed"))      { updateStatus("secure session is live"); }
  }

  function appendLog(line: string): void {
    if (line.startsWith("ICE candidate:")) {
      skippedIceCandidates += 1;
      return;
    }

    if (line.startsWith("gathered ") && skippedIceCandidates > 0) {
      appendToLog(opts.logOutput, `network candidates collected (${skippedIceCandidates} checks)`);
      skippedIceCandidates = 0;
    }

    appendToLog(opts.logOutput, line);
    updateProgressFromLog(line);
  }

  function setLogActive(active: boolean): void {
    setLogDotActive(opts.logDot, active);
  }

  function updateStatus(text: string): void {
    opts.liveStatusLine.textContent = text;
    opts.liveStatusLine.classList.remove("whisper-status--ready");
  }

  function syncComposeIntent(): void {
    if (!chatCompose) return;
    if (composeIntentOverride) {
      chatCompose.dataset.intent = composeIntentOverride;
      return;
    }

    const hasText = opts.chatInput.value.trim().length > 0;
    let intent: ComposeIntent = "idle";

    if (opts.chatSection.style.display === "none") intent = "idle";
    else if (opts.chatMessages.classList.contains("wl-chat-drop-active")) intent = "drop";
    else if (
      busy
      || currentLiveState === "offering"
      || currentLiveState === "answering"
      || currentLiveState === "connecting"
      || currentLiveState === "handshaking"
      || currentLiveState === "recovering"
      || currentLiveState === "verifying"
    ) intent = "connecting";
    else if (currentLiveState === "error") intent = "error";
    else if (currentLiveState === "live") intent = hasText ? "typing" : "ready";

    chatCompose.dataset.intent = intent;
  }

  function pulseComposeIntent(intent: ComposeIntent, ms: number): void {
    composeIntentOverride = intent;
    syncComposeIntent();
    if (composeIntentTimer) clearTimeout(composeIntentTimer);
    composeIntentTimer = setTimeout(() => {
      composeIntentOverride = null;
      composeIntentTimer = null;
      syncComposeIntent();
    }, ms);
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
    const chatVisible = opts.chatSection.style.display !== "none";

    opts.createBtn.disabled = busy;
    opts.joinBtn.disabled = busy || !joinHasCode;
    opts.joinPasteBtn.disabled = busy;
    opts.answerApplyBtn.disabled = busy || !hasSession || !answerHasCode;

      opts.externalAssistToggle.disabled = busy || hasSession;

    opts.offerCopyBtn.disabled = (opts.offerCode.textContent ?? "").trim().length === 0;
    if (opts.offerShareBtn) {
      opts.offerShareBtn.disabled = (opts.offerCode.textContent ?? "").trim().length === 0;
    }
    opts.offerBackBtn.disabled = busy;
    opts.answerCopyBtn.disabled = (opts.answerCode.textContent ?? "").trim().length === 0;
    if (opts.answerShareBtn) {
      opts.answerShareBtn.disabled = (opts.answerCode.textContent ?? "").trim().length === 0;
    }
    const hasOffer = (opts.offerCode.textContent ?? "").trim().length > 0;
    const hasAnswer = (opts.answerCode.textContent ?? "").trim().length > 0;
    opts.offerQrToggleBtn.disabled = !hasOffer;
    opts.answerQrToggleBtn.disabled = !hasAnswer;

    if (!hasOffer && offerQrState.value) setOfferQrExpanded(false);
    if (!hasAnswer && answerQrState.value) setAnswerQrExpanded(false);

    if (!qrScanSession.active) {
      setJoinQrUiState(false);
    }

    if (opts.relayConnectBtn) {
      opts.relayConnectBtn.disabled = busy;
    }

    opts.funnelCampfireBtn.disabled = busy || !chatVisible;

    const modeSwitchWrap = modeSwitchBtn?.closest(".wl-mode-switch") as HTMLElement | null;
    if (modeSwitchWrap) {
      modeSwitchWrap.style.display = (busy || hasSession) ? "none" : "";
    }

    opts.chatSendBtn.disabled = busy || !hasSession || !hasChatText;
    opts.chatFileBtn.disabled = busy || !hasSession;

    opts.confirmBtn.disabled = busy || !hasSession;
    opts.rejectBtn.disabled = busy || !hasSession;
    opts.disconnectBtn.disabled = busy || (!hasSession && !chatVisible);
    opts.silentDisconnectBtn.disabled = busy || !hasSession;
    syncComposeIntent();
  }

  /* ── Tab title / unread ───────────────────────────────── */

  function bumpUnread(): void {
    if (hasFocus) return;
    unreadCount++;
    document.title = `(${unreadCount}) ${originalTitle}`;
  }

  function clearUnread(): void {
    unreadCount = 0;
    document.title = originalTitle;
  }

  /* ── Typing indicator ──────────────────────────────────── */

  function showPeerTyping(): void {
    let indicator = opts.chatMessages.querySelector<HTMLElement>(".wl-typing-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "wl-typing-indicator wl-msg wl-msg--peer";
      indicator.textContent = "...";
      opts.chatMessages.appendChild(indicator);
      smartScroll();
    }
    // Reset auto-clear timer
    if (peerTypingTimer) clearTimeout(peerTypingTimer);
    peerTypingTimer = setTimeout(hidePeerTyping, TYPING_DISPLAY_TIMEOUT);
    exciteComposeActivity(0.18);
  }

  function hidePeerTyping(): void {
    if (peerTypingTimer) { clearTimeout(peerTypingTimer); peerTypingTimer = null; }
    const indicator = opts.chatMessages.querySelector(".wl-typing-indicator");
    if (indicator) indicator.remove();
  }

  function emitTyping(): void {
    if (typingSendTimer || !session) return;
    session.sendTyping();
    typingSendTimer = setTimeout(() => { typingSendTimer = null; }, TYPING_SEND_DEBOUNCE);
    exciteComposeActivity(0.22);
  }

  /* ── Smart scroll ──────────────────────────────────────── */

  function isNearBottom(): boolean {
    const el = opts.chatMessages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function smartScroll(): void {
    if (isNearBottom()) {
      opts.chatMessages.scrollTop = opts.chatMessages.scrollHeight;
    }
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

    if (msg.direction === "peer") hidePeerTyping();

    opts.chatMessages.appendChild(div);
    smartScroll();

    if (msg.direction === "peer") bumpUnread();
  }

  /* ── Session creation ─────────────────────────────────── */

  function urlParam(key: string): string {
    try { return new URLSearchParams(window.location.search).get(key) ?? ""; } catch { return ""; }
  }
  function urlFlag(key: string): boolean {
    const v = urlParam(key).toLowerCase();
    return v === "1" || v === "true";
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
      onPeerTyping: showPeerTyping,
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

    currentLiveState = state;

    const wasRecovering = previousState === "recovering";
    previousState = state;

    const enterPhase = (el: HTMLElement, status: string, log: boolean, isBusy: boolean) => {
      showPhase(el); updateStatus(status); setLogActive(log); setBusy(isBusy); updateControls();
    };

    switch (state) {
      case "idle":
        enterPhase(opts.liveSection, "ready to connect", false, false);
        break;

      case "offering":
        enterPhase(opts.connectingSection, "step 1/2: creating your invite", true, true);
        opts.connectingStatus.textContent = "creating your invite code...";
        break;

      case "waiting-for-answer":
        enterPhase(opts.offerSection, "step 1/2: send invite, then wait for reply", false, false);
        setTimeout(() => { try { opts.answerInput.focus(); } catch { /* noop */ } }, 0);
        break;

      case "answering":
        enterPhase(opts.connectingSection, "step 1/2: reading invite", true, true);
        opts.connectingStatus.textContent = "creating your reply code...";
        break;

      case "connecting":
        enterPhase(opts.connectingSection, "connecting directly...", true, true);
        opts.connectingStatus.textContent = "connecting directly...";
        break;

      case "handshaking":
        enterPhase(opts.connectingSection, "starting encryption...", true, true);
        opts.connectingStatus.textContent = "starting end-to-end encryption...";
        break;

      case "verifying":
        enterPhase(opts.verifySection, "security check: compare emoji with your peer", false, false);
        break;

      case "live":
        enterPhase(opts.chatSection, "secure session live · end-to-end encrypted", false, false);
        opts.liveStatusLine.classList.add("whisper-status--ready");
        opts.chatInput.disabled = false;
        opts.chatInput.placeholder = "type a message";
        opts.chatInput.focus();
        addChatMessage({
          type: "system", direction: "system",
          text: wasRecovering ? "reconnected" : "connected. messages are end-to-end encrypted",
          timestamp: Date.now(),
        });
        break;

      case "silent": {
        enterPhase(opts.silentSection, "shared secret ready for Whisper password mode", false, false);
        const secret = session?.getSharedSecret();
        if (secret) opts.silentSecret.textContent = secret;
        break;
      }

      case "recovering":
        showPhase(opts.chatSection);
        updateStatus("reconnecting...");
        setLogActive(true);
        opts.chatSendBtn.disabled = true;
        opts.chatFileBtn.disabled = true;
        opts.chatInput.disabled = true;
        addChatMessage({ type: "system", direction: "system", text: "connection interrupted, reconnecting...", timestamp: Date.now() });
        break;

      case "disconnected":
        enterPhase(opts.disconnectedSection, "session ended", false, false);
        break;

      case "error":
        enterPhase(opts.errorSection, "couldn't connect", false, false);
        opts.errorMessage.textContent = detail ?? "something went wrong";
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
    for (const el of [opts.offerCode, opts.answerCode, opts.fingerprintDisplay,
                       opts.silentSecret, opts.joinQrStatus, opts.offerQrStatus,
                       opts.answerQrStatus, opts.errorMessage]) el.textContent = "";
    for (const el of [opts.joinInput, opts.answerInput, opts.phraseInput, opts.chatInput]) el.value = "";
    if (manualPhraseInput) manualPhraseInput.value = "";
    skippedIceCandidates = 0;
    currentLiveState = "idle";
    setOfferQrExpanded(false);
    setAnswerQrExpanded(false);
    showPhase(opts.liveSection);
    if (opts.relayAssistToggle) applyRelayToggle(opts.relayAssistToggle.checked);
    updateStatus("ready to connect");
    setLogActive(false);
    setBusy(false);
    updateControls();
  }

  function handleExternalResetRequest(event: Event): void {
    const custom = event as CustomEvent<{ reason?: string }>;
    if (opts.page.dataset.mode !== "live") return;
    if (busy) return;

    const alreadyAtLanding = !session && opts.liveSection.style.display !== "none";
    if (alreadyAtLanding) return;

    resetToIdle();
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
      if (idleLede) idleLede.textContent = "type the same phrase on both sides and connect at the same time. that's it.";
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
        const offerCode = await session.createOffer(phrase);
      if (aborted()) return;

      opts.connectingStatus.textContent = "connecting to relay...";

      const { exchangeViaTracker } = await import("./live-tracker");

      let acceptCalled = false;
      const acceptFn = async (peerOfferCode: string): Promise<string> => {
        if (acceptCalled) throw new Error("duplicate-accept");
        acceptCalled = true;
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

      relayActive = false;

      if (result.role === "offerer" && result.peerAnswerCode) {
        await session!.applyAnswer(result.peerAnswerCode);
      }
      if (result.role === "answerer" && session && session.state === "connecting") {
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "connecting directly...";
        updateStatus("connecting...");
      }
    } catch (err) {
      relayActive = false;
      if (aborted()) return;
      if (session) { session.disconnect(); session = null; }
      const raw = errMsg(err);
      appendLog(`relay: ${raw}`);
      lastErrorWasRelay = true;
      handleStateChange("error", friendlyRelayError(raw));
    } finally {
      relayAbort = null;
    }
  }

  /* ── Event Listeners ───────────────────────────────────── */

  if (modeSwitchBtn && opts.relayAssistToggle) {
    modeSwitchBtn.addEventListener("click", () => {
      const next = !opts.relayAssistToggle!.checked;
      opts.relayAssistToggle!.checked = next;
      if (next && manualPhraseInput) {
        opts.phraseInput.value = manualPhraseInput.value;
      }
      applyRelayToggle(next);
    }, { signal });
  }

  opts.funnelCampfireBtn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("whisper-live-funnel", { detail: { mode: "campfire" } }));
  }, { signal });

  if (opts.relayConnectBtn) {
    opts.relayConnectBtn.addEventListener("click", () => {
      void handleRelayConnect();
    }, { signal });

    opts.relayConnectBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showPhase(opts.chatSection);
      updateStatus("chat preview · not connected");
      setLogActive(false);
      setBusy(false);
      updateControls();
      try { opts.chatInput.focus(); } catch { /* noop */ }
    }, { signal });
  }

  opts.phraseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && opts.relayAssistToggle?.checked && !busy) {
      e.preventDefault();
      void handleRelayConnect();
    }
  }, { signal });

  opts.createBtn.addEventListener("click", async () => {
    session = createSession();
    const phrase = getActivePhrase() || undefined;
    try {
      const offerCode = await session.createOffer(phrase);
      opts.offerCode.textContent = offerCode;
      renderQr(opts.offerQrCanvas, opts.offerQrStatus, "offer", offerCode);
      setOfferQrExpanded(false);
      updateControls();
    } catch (err) {
      const msg = errMsg(err);
      appendLog(`offer failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  const copyCode = (el: HTMLElement, btn: HTMLButtonElement, label: string) => {
    btn.addEventListener("click", async () => {
      const code = el.textContent ?? "";
      if (!code) return;
      try { await copyToClipboard(code); flashText(btn, "Copied"); appendLog(`${label} copied to clipboard`); }
      catch { appendLog("copy failed"); }
    }, { signal });
  };
  copyCode(opts.offerCode, opts.offerCopyBtn, "offer code");
  copyCode(opts.answerCode, opts.answerCopyBtn, "answer code");

  const shareCode = (el: HTMLElement, btn: HTMLButtonElement | undefined, label: string) => {
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const code = (el.textContent ?? "").trim();
      if (!code) return;
      try {
        if (navigator.share) {
          await navigator.share({ text: code });
        } else {
          await copyToClipboard(code);
          flashText(btn, "Copied");
        }
        appendLog(`${label} shared`);
      } catch {
        appendLog("share cancelled or unavailable");
      }
    }, { signal });
  };

  shareCode(opts.offerCode, opts.offerShareBtn, "offer code");
  shareCode(opts.answerCode, opts.answerShareBtn, "answer code");

  opts.offerBackBtn.addEventListener("click", resetToIdle, { signal });

  opts.answerApplyBtn.addEventListener("click", async () => {
    normalizeTypedCodes();
    const code = opts.answerInput.value.trim();
    if (!code || !session) return;
    try {
      await session.applyAnswer(code);
    } catch (err) {
      const msg = errMsg(err);
      appendLog(`answer apply failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  opts.joinBtn.addEventListener("click", async () => {
    normalizeTypedCodes();
    const offerCode = opts.joinInput.value.trim();
    if (!offerCode) return;
    session = createSession();
    const phrase = getActivePhrase() || undefined;
    try {
      const answerCodeStr = await session.acceptOffer(offerCode, phrase);
      opts.answerCode.textContent = answerCodeStr;
      renderQr(opts.answerQrCanvas, opts.answerQrStatus, "answer", answerCodeStr);
      setAnswerQrExpanded(false);
      showPhase(opts.answerSection);
      updateStatus("step 2/2: send answer back to the creator");
      setBusy(false);
      updateControls();
    } catch (err) {
      const msg = errMsg(err);
      appendLog(`join failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  opts.confirmBtn.addEventListener("click", () => {
    session?.confirmFingerprint();
  }, { signal });

  opts.rejectBtn.addEventListener("click", () => {
    session?.rejectFingerprint();
  }, { signal });

  const sendMessage = async () => {
    const text = opts.chatInput.value.trim();
    if (!text || !session) return;
    opts.chatInput.value = "";
    updateControls();
    pulseComposeIntent("sending", 500);
    exciteComposeActivity(0.45);
    try {
      await session.sendText(text);
      pulseComposeIntent("success", 700);
      exciteComposeActivity(0.35);
    } catch (err) {
      appendLog(`send failed: ${errMsg(err)}`);
      pulseComposeIntent("error", 1100);
      exciteComposeActivity(0.4);
    }
  };

  opts.chatSendBtn.addEventListener("click", sendMessage, { signal });
  opts.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, { signal });

  const enterSubmit = (input: HTMLInputElement, btn: HTMLButtonElement) => {
    input.addEventListener("input", () => { normalizeTypedCodes(); updateControls(); }, { signal });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!btn.disabled) btn.click();
    }, { signal });
  };
  enterSubmit(opts.joinInput, opts.joinBtn);
  enterSubmit(opts.answerInput, opts.answerApplyBtn);
  opts.chatInput.addEventListener("input", () => { updateControls(); emitTyping(); }, { signal });

  if (chatCompose) {
    chatCompose.style.setProperty("--wl-activity", "0");
    const syncComposeState = () => {
      const hasValue = opts.chatInput.value.trim().length > 0;
      chatCompose.classList.toggle("wl-chat-input-has-value", hasValue);
      syncComposeIntent();
      if (hasValue) exciteComposeActivity(0.12);
    };
    syncComposeState();
    opts.chatInput.addEventListener("input", syncComposeState, { signal });
  }

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

  for (const [btn, state, setFn] of [
    [opts.offerQrToggleBtn, offerQrState, setOfferQrExpanded],
    [opts.answerQrToggleBtn, answerQrState, setAnswerQrExpanded],
  ] as const) {
    btn.addEventListener("click", () => { if (!btn.disabled) setFn(!state.value); }, { signal });
  }

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
      appendLog(`file send failed: ${errMsg(err)}`);
    }
  }, { signal });

  opts.chatMessages.addEventListener("dragover", (e) => {
    e.preventDefault();
    opts.chatMessages.classList.add("wl-chat-drop-active");
    syncComposeIntent();
    exciteComposeActivity(0.2);
  }, { signal });

  opts.chatMessages.addEventListener("dragleave", () => {
    opts.chatMessages.classList.remove("wl-chat-drop-active");
    syncComposeIntent();
  }, { signal });

  opts.chatMessages.addEventListener("drop", async (e) => {
    e.preventDefault();
    opts.chatMessages.classList.remove("wl-chat-drop-active");
    syncComposeIntent();
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (!file || !session) return;
    try {
      await session.sendFile(file);
      pulseComposeIntent("success", 700);
      exciteComposeActivity(0.36);
    } catch (err) {
      appendLog(`file send failed: ${errMsg(err)}`);
      pulseComposeIntent("error", 1100);
      exciteComposeActivity(0.42);
    }
  }, { signal });

  opts.disconnectBtn.addEventListener("click", () => {
    if (session) {
      session.disconnect();
      return;
    }
    if (opts.chatSection.style.display !== "none") {
      resetToIdle();
    }
  }, { signal });

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

  opts.newSessionBtn.addEventListener("click", resetToIdle, { signal });

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

  window.addEventListener("focus", () => { hasFocus = true; clearUnread(); }, { signal });
  window.addEventListener("blur", () => { hasFocus = false; }, { signal });
  window.addEventListener("whisper-live-reset-request", handleExternalResetRequest as EventListener, { signal });

  /* -- Initial state ---------------------------------------- */

  // Optional URL param prefill for convenience; UI remains the primary control.
  if (urlParam("ice").toLowerCase() === "stun" || urlFlag("stun")) {
    opts.externalAssistToggle.checked = true;
  }

  // Sync relay UI on init — covers default checked, browser form restore, and ?relay=1
  if (opts.relayAssistToggle) {
    if (urlFlag("relay")) opts.relayAssistToggle.checked = true;
    if (opts.relayAssistToggle.checked) applyRelayToggle(true);
  }

  // ?phrase= prefills the shared phrase input
  const urlPhrase = urlParam("phrase");
  if (urlPhrase) {
    opts.phraseInput.value = urlPhrase;
  }

  // ?auto=1 with ?relay=1 and a phrase → auto-trigger relay connect
  if (urlFlag("auto") && opts.relayAssistToggle?.checked && opts.phraseInput.value.trim()) {
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
    if (typingSendTimer) { clearTimeout(typingSendTimer); typingSendTimer = null; }
    if (peerTypingTimer) { clearTimeout(peerTypingTimer); peerTypingTimer = null; }
    if (composeIntentTimer) { clearTimeout(composeIntentTimer); composeIntentTimer = null; }
    if (composeActivityRaf) { cancelAnimationFrame(composeActivityRaf); composeActivityRaf = 0; }
    document.title = originalTitle;
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  };
}
