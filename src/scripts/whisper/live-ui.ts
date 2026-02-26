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
  deriveFingerprint,
  type LiveState,
  type LiveMessage,
} from "./live";
import { encodeAdpcm, decodeAdpcm } from "./live-wasm-audio";
import {
  CTRL_OP, VoteTopic,
  encodeSeenPayload, decodeSeenPayload,
  encodeReactPayload, decodeReactPayload,
} from "./live-ctrl";
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
  haptic,
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
  chatMicWrap: HTMLElement;
  chatMicBtn: HTMLButtonElement;
  chatMicCancel: HTMLButtonElement;
  chatMicSend: HTMLButtonElement;
  chatClearBtn: HTMLButtonElement;
  disconnectBtn: HTMLButtonElement;
  fpChip: HTMLButtonElement;
  fpChipEmoji: HTMLElement;
  fpChipName: HTMLElement;
  fpNicknameInput: HTMLInputElement;

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
  chatMicWrap: "wl-chat-mic-wrap",
  chatMicBtn: "wl-chat-mic-btn",
  chatMicCancel: "wl-chat-mic-cancel",
  chatMicSend: "wl-chat-mic-send",
  chatClearBtn: "wl-chat-clear-btn",
  disconnectBtn: "wl-disconnect",
  fpChip: "wl-fp-chip",
  fpChipEmoji: "wl-fp-chip-emoji",
  fpChipName: "wl-fp-chip-name",
  fpNicknameInput: "wl-fp-nickname",
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

const _storedPref = localStorage.getItem("wl-time-12h");
let use12h = _storedPref !== null
  ? _storedPref === "1"
  : /^h1[12]$/.test(new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle ?? "");

function formatTime(ts: number): string {
  const d = new Date(ts);
  if (use12h) {
    const h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const period = h >= 12 ? "pm" : "am";
    return `${(h % 12 || 12)}:${m} ${period}`;
  }
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

/* ── Preview seed ────────────────────────────────────────── */

/**
 * Stable 32-byte seed tied to this browser profile, persisted in localStorage.
 * Means the preview fingerprint is the same every visit on the same device,
 * derived through the exact same pipeline as a real session fingerprint.
 */
function getPreviewSeed(): Uint8Array {
  const KEY = "wl-preview-seed";
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && stored.length === 64 && /^[0-9a-f]+$/.test(stored)) {
      return new Uint8Array(stored.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    }
  } catch { /* storage unavailable */ }

  const seed = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(seed).map((b) => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(KEY, hex); } catch { /* storage unavailable */ }
  return seed;
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
    chatMicWrap: el(I.chatMicWrap),
    chatMicBtn: btn(I.chatMicBtn), chatMicCancel: btn(I.chatMicCancel), chatMicSend: btn(I.chatMicSend),
    chatClearBtn: btn(I.chatClearBtn),
    disconnectBtn: btn(I.disconnectBtn),
    fpChip: btn(I.fpChip), fpChipEmoji: el(I.fpChipEmoji), fpChipName: el(I.fpChipName),
    fpNicknameInput: inp(I.fpNicknameInput),
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

  /** Active-typing debounce scaled to current network. Reads live so it adapts
   *  if the connection shifts (e.g. wifi → cellular). */
  function typingSendDebounce(): number {
    return env.constrainedNetwork ? 6_000 : Math.min(6_000, Math.max(3_000, env.rtt * 4));
  }

  // ── Clear-history (voted operation) ─────────────────────────

  function executeClearHistory(): void {
    const msgs = Array.from(opts.chatMessages.children) as HTMLElement[];
    if (msgs.length === 0 || (msgs.length === 1 && msgs[0].classList.contains("wl-chat-empty"))) {
      updateControls();
      return;
    }
    haptic("clear-history");
    msgs.forEach((el, i) => el.style.setProperty("--msg-idx", String(Math.min(i, 10))));
    opts.chatMessages.dataset.clearing = "1";
    setTimeout(() => {
      delete opts.chatMessages.dataset.clearing;
      clearNode(opts.chatMessages);
      if (chatEmpty) opts.chatMessages.appendChild(chatEmpty);
      updateControls();
    }, 320);
  }

  const clearVote = new VoteTopic({
    timeoutMs: 60_000,
    onExecute: executeClearHistory,
    onState: (state) => { opts.chatClearBtn.dataset.clearState = state; updateControls(); },
  });

  const campfireVote = new VoteTopic({
    timeoutMs: 60_000,
    onExecute: () => {
      window.dispatchEvent(new CustomEvent("whisper-live-funnel", {
        detail: { mode: "campfire", bootstrap: true },
      }));
      appendLog("campfire vote passed — opening shared campfire session");
    },
    onState: (state) => {
      opts.funnelCampfireBtn.dataset.voteState = state;
      const labels: Record<string, string> = {
        idle: "start a campfire",
        "pending-out": "campfire vote sent",
        "pending-in": "campfire invite — press to accept",
      };
      opts.funnelCampfireBtn.textContent = labels[state] ?? "start a campfire";
      updateControls();
    },
  });

  // ── Ctrl dispatch ─────────────────────────────────────────
  // Route inbound ctrl frames to the right handler.
  // Adding a new voted feature = new VoteTopic + two lines here.

  function handleCtrl(opcode: number, payload: Uint8Array): void {
    switch (opcode) {
      case CTRL_OP.CLEAR_VOTE: clearVote.receivePeer(); break;
      case CTRL_OP.CLEAR_CANCEL: clearVote.cancelPeer(); break;
      case CTRL_OP.CAMPFIRE_VOTE: campfireVote.receivePeer(); break;
      case CTRL_OP.CAMPFIRE_CANCEL: campfireVote.cancelPeer(); break;
      case CTRL_OP.SEEN: {
        const msgId = decodeSeenPayload(payload);
        if (msgId !== null) markSeen(msgId);
        break;
      }
      case CTRL_OP.REACT: {
        const r = decodeReactPayload(payload);
        if (r) applyReaction(r.msgId, r.emoji, "peer");
        break;
      }
      case CTRL_OP.UNREACT: {
        const r = decodeReactPayload(payload);
        if (r) removeReaction(r.msgId, r.emoji, "peer");
        break;
      }
    }
  }

  function markSeen(msgId: number): void {
    const el = msgById.get(msgId);
    if (!el) return;
    el.classList.add("wl-msg--seen");
  }

  /** Max distinct emoji reactions tracked per message. Keeps the UI elegant. */
  const MAX_REACTIONS = 5;

  function applyReaction(msgId: number, emoji: string, who: "self" | "peer"): void {
    const el = msgById.get(msgId);
    if (!el || !emoji) return;
    // Clip to first grapheme cluster — peer could send multi-emoji or malformed string
    const seg = new Intl.Segmenter();
    const firstCluster = seg.segment(emoji)[Symbol.iterator]().next().value?.segment;
    if (!firstCluster) return;
    const normEmoji = firstCluster;
    let bar = el.querySelector<HTMLElement>(".wl-msg-reactions");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "wl-msg-reactions";
      el.appendChild(bar);
    }
    let pill = bar.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(normEmoji)}"]`);
    if (!pill) {
      // Enforce cap: only allow MAX_REACTIONS distinct emojis per message
      if (bar.children.length >= MAX_REACTIONS) return;
      const btn = document.createElement("button");
      btn.type = "button";
      pill = btn;
      pill.className = "wl-reaction wl-reaction--entering";
      pill.dataset.emoji = normEmoji;
      pill.dataset.self = "0";
      pill.dataset.peer = "0";
      pill.textContent = normEmoji;
      pill.addEventListener("click", () => toggleSelfReaction(msgId, normEmoji));
      bar.appendChild(pill);
      // Remove entering class after animation completes so it's reusable
      pill.addEventListener("animationend", () => pill!.classList.remove("wl-reaction--entering"), { once: true });
    }
    pill.dataset[who] = "1";
    updateReactionPill(pill);
  }

  function removeReaction(msgId: number, emoji: string, who: "self" | "peer"): void {
    const el = msgById.get(msgId);
    if (!el) return;
    const pill = el.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(emoji)}"]`);
    if (!pill) return;
    pill.dataset[who] = "0";
    updateReactionPill(pill);
    if (pill.dataset.self === "0" && pill.dataset.peer === "0") pill.remove();
    const bar = el.querySelector(".wl-msg-reactions");
    if (bar && !bar.hasChildNodes()) bar.remove();
  }

  function updateReactionPill(pill: HTMLElement): void {
    const hasSelf = pill.dataset.self === "1";
    const hasPeer = pill.dataset.peer === "1";
    pill.classList.toggle("wl-reaction--self", hasSelf);
    pill.classList.toggle("wl-reaction--peer", hasPeer);
  }

  /**
   * Toggle self-reaction on a message. Looks up the existing pill in the DOM —
   * if already reacted, unreacts; otherwise reacts. No pill param needed since
   * we key by emoji string in data-emoji.
   */
  function toggleSelfReaction(msgId: number, emoji: string): void {
    haptic("reaction");
    const el = msgById.get(msgId);
    const pill = el?.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(emoji)}"]`);
    const isUnreact = pill?.dataset.self === "1";
    if (session) {
      // Live: send over the wire
      if (isUnreact) {
        session.sendCtrl(CTRL_OP.UNREACT, encodeReactPayload(msgId, emoji));
        removeReaction(msgId, emoji, "self");
      } else {
        session.sendCtrl(CTRL_OP.REACT, encodeReactPayload(msgId, emoji));
        applyReaction(msgId, emoji, "self");
      }
    } else {
      // Preview mode: local-only reaction, no network
      if (isUnreact) removeReaction(msgId, emoji, "self");
      else applyReaction(msgId, emoji, "self");
    }
  }

  const originalTitle = document.title;
  let unreadCount = 0;
  let hasFocus = document.hasFocus();
  type ComposeIntent = "idle" | "connecting" | "ready" | "typing" | "error" | "drop";
  const chatCompose = opts.chatInput.closest<HTMLElement>(".wl-chat-compose");
  let composeIntentTimer: ReturnType<typeof setTimeout> | null = null;
  let composeIntentOverride: ComposeIntent | null = null;
  let composeActivity = 0;
  let composeActivityTarget = 0;
  let composeActivityVelocity = 0;
  let composeActivityRaf = 0;
  let composeActivityLastTick = 0;
  let composeFlow = 0;
  // Send energy — 3-phase animation driven by real networking events.
  const send = {
    energy: 0,          // 0→1 visual fill
    velocity: 0,        // spring velocity
    phase: "idle" as "idle" | "filling" | "in-flight" | "delivered",
    fillTarget: 0,      // additive target from onSendProgress
    inflightStart: 0,   // timestamp when data was buffered
    peakEnergy: 0,      // snapshot at delivery for kick scaling
    acks: new Set<number>(),           // message counters awaiting ACK
    timestamps: new Map<number, number>(), // counter → send time
    rtt: 80,            // ms, EMA from ICE stats
    ackLatency: 100,    // ms, EMA of send→ACK round-trip
  };

  // Typing indicator — amplitude-modulated pendulum.
  const typing = {
    intensity: 0,       // 0→1 opacity
    phase: 0,           // oscillator radians
    target: 0,          // 1 when peer is typing or composing
    idle: false,        // true = peer idle with unsent text (gentler animation)
    phaseVelocity: 0,   // external impulse (send ripple kick)
    amplitude: 0,       // 0→1 swing width
    sustain: 0,         // 0→1 warmth from duration
    speed: 0,           // 0→1 instantaneous motion speed
  };
  let currentLiveState: LiveState = "idle";

  /* ── Environment sensing ───────────────────────────────── */
  // Derive behavioral flags from browser signals. These adapt the UX
  // to the user's actual context — network, device, preferences.
  // All reads are behind optional chaining; missing APIs → safe defaults
  // that match the original hardcoded values.

  // Static hardware facts — read once, never change.
  const lightDevice = (navigator.hardwareConcurrency ?? 8) <= 2
    || ((navigator as any).deviceMemory ?? 8) < 2;

  // Network & preferences — can change mid-session.
  // Wrapped in a live-reading object so callers always get current state.
  const env = {
    get conn() {
      return (navigator as any).connection as
        (EventTarget & { effectiveType?: string; rtt?: number; saveData?: boolean }) | undefined;
    },
    /** User explicitly asked their browser to use less data. */
    get saveData(): boolean { return this.conn?.saveData === true; },
    /** Network too slow for ephemeral signals to arrive meaningfully. */
    get constrainedNetwork(): boolean {
      const t = this.conn?.effectiveType;
      return t === "slow-2g" || t === "2g";
    },
    /** Current round-trip estimate, clamped to a usable range.
     *  Default 100ms — moderate, matches the original 3s debounce feel. */
    get rtt(): number {
      return Math.min(2_000, Math.max(50, this.conn?.rtt ?? 100));
    },
    lightDevice,
  };

  // Reduced-motion: composite of explicit preference + device/network.
  // Mutable — reacts to live media-query and connection changes.
  let reduceMotion = lightDevice;
  const motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const syncMotion = () => { reduceMotion = motionMq.matches || env.lightDevice || env.constrainedNetwork; };
  syncMotion();
  motionMq.addEventListener("change", syncMotion, { signal });
  // Connection can change mid-session (wifi → cellular, fast → slow).
  // effectiveType: "slow-2g" | "2g" | "3g" | "4g" (no 5g — fast networks all report 4g).
  // Re-sync reduceMotion so animations stop/resume when the network shifts.
  try { env.conn?.addEventListener("change", syncMotion, { signal }); } catch { }

  /** Push all animation state to CSS custom properties. One place, once per frame. */
  function syncCSSVars(): void {
    if (!chatCompose) return;
    const s = chatCompose.style;
    const se = send.energy;
    const ti = typing.intensity;

    // Compose activity
    s.setProperty("--wl-activity", composeActivity.toFixed(3));
    s.setProperty("--wl-velocity", Math.min(1, Math.abs(composeActivityVelocity) * 0.18).toFixed(3));
    s.setProperty("--wl-flow", `${(((Math.sin(composeFlow) + 1) * 0.5) * 100).toFixed(2)}%`);

    // Send energy: CSS sees 0→1, overflow handles the >1 effects separately
    const seFill = Math.min(1, se);
    const overflow = Math.min(1, Math.max(0, se - 1) * 3.3);
    s.setProperty("--wl-send-energy", seFill.toFixed(3));
    s.setProperty("--wl-send-velocity", Math.min(1, Math.abs(send.velocity) * 0.15).toFixed(3));
    s.setProperty("--wl-send-overflow", overflow.toFixed(3));

    // Typing: position with amplitude → smoothstep
    const rawPos = 0.5 + typing.amplitude * 0.5 * Math.sin(typing.phase);
    const eased = rawPos * rawPos * (3 - 2 * rawPos);
    s.setProperty("--wl-peer-typing", ti.toFixed(3));
    s.setProperty("--wl-typing-pos", eased.toFixed(4));

    // Typing: width modulation (breath at edges, stretch at center, sustain warmth)
    const spd = typing.speed;
    s.setProperty("--wl-typing-width", (1 + (1 - spd) * 0.18 + spd * 0.28 + typing.sustain * 0.06).toFixed(3));
    s.setProperty("--wl-typing-glow", (spd * 0.5 + typing.sustain * 0.3).toFixed(3));

    // Cross-system interaction (clamped energy for typing interaction math)
    const seClamped = Math.min(1, se);
    const interaction = (seClamped > 0.02 && ti > 0.02) ? seClamped * ti : 0;
    s.setProperty("--wl-energy-center", (0.5 + (eased - 0.5) * 0.12 * interaction).toFixed(4));
    s.setProperty("--wl-typing-squeeze", (1 - seClamped * 0.45).toFixed(3));
    s.setProperty("--wl-interaction", interaction.toFixed(3));

    // Suppress border-top when energy bar is active
    s.borderTopColor = se > 0.01 ? "transparent" : "";
  }

  /** Shared spring integrator: accel = ω²(target - x) − 2ζω·v */
  function springAccel(x: number, v: number, target: number, omega: number, zeta: number): number {
    return omega * omega * (target - x) - 2 * zeta * omega * v;
  }

  function stepComposeActivity(ts: number): void {
    const rawDt = composeActivityLastTick ? (ts - composeActivityLastTick) / 1000 : 0;
    const dt = Math.min(0.04, Math.max(0.001, rawDt || (1 / 60)));
    composeActivityLastTick = ts;

    // ── Compose activity spring ──
    composeActivityTarget *= Math.exp(-dt * 2.6);
    composeActivityVelocity += springAccel(composeActivity, composeActivityVelocity, composeActivityTarget, 13, 0.72) * dt;
    composeActivity = Math.max(0, Math.min(1, composeActivity + composeActivityVelocity * dt));
    composeFlow += dt * (2.4 + composeActivity * 6.2);

    // ── Send energy (RTT-derived physics) ──
    const rttFactor = Math.max(0, Math.min(1, (send.rtt - 30) / 170));

    if (send.phase === "filling") {
      const w = 14 - rttFactor * 4, z = 0.65 + rttFactor * 0.1;
      send.velocity += springAccel(send.energy, send.velocity, send.fillTarget, w, z) * dt;
      send.energy += send.velocity * dt;
    } else if (send.phase === "in-flight") {
      const breathPeriod = Math.max(120, send.rtt * 1.5);
      const breath = 0.92 + 0.08 * Math.sin((Date.now() - send.inflightStart) / breathPeriod);
      send.energy += (breath - send.energy) * Math.min(1, (10 - rttFactor * 4) * dt);
      send.velocity *= Math.exp(-dt * (6 + rttFactor * 4));
    } else if (send.phase === "delivered") {
      const af = Math.max(0, Math.min(1, (send.ackLatency - 50) / 250));
      send.velocity += springAccel(send.energy, send.velocity, 0, 9 - af * 3, 0.45 + af * 0.15) * dt;
      send.energy += send.velocity * dt;
      if (send.energy < 0.005 && Math.abs(send.velocity) < 0.005) {
        send.energy = 0; send.velocity = 0; send.phase = "idle";
      }
    }
    // Allow overshoot above 1.0 — heavy spam pools at the edges and compresses back.
    send.energy = Math.max(0, Math.min(1.3, send.energy));

    // ── Typing indicator (amplitude-modulated pendulum) ──
    const t = typing;
    const tOn = t.target > 0.5;
    const tIdle = t.idle;

    // Idle composing: reduced intensity + amplitude targets for a gentle pulse
    const intensityTarget = tOn ? (tIdle ? 0.45 : 1) : 0;
    const amplitudeTarget = tOn ? (tIdle ? 0.25 : 1) : 0;

    // Intensity + amplitude: independent rates so amplitude winds down before opacity fades
    t.intensity += (intensityTarget - t.intensity) * Math.min(1, (tOn ? 4.5 : 1.8) * dt);
    t.intensity = Math.max(0, Math.min(1, t.intensity));
    t.amplitude += (amplitudeTarget - t.amplitude) * Math.min(1, (tOn ? 1.4 : 2.8) * dt);
    t.amplitude = Math.max(0, Math.min(1, t.amplitude));

    // Sustain warmth — idle composing caps lower
    t.sustain = tOn
      ? Math.min(tIdle ? 0.3 : 1, t.sustain + dt * (tIdle ? 0.06 : 0.14))
      : t.sustain * Math.exp(-dt * 0.5);

    if (t.intensity > 0.01) {
      const pos = 0.5 + t.amplitude * 0.5 * Math.sin(t.phase);
      const edgeDist = 1 - Math.abs(pos - 0.5) * 2;
      const windDown = 0.3 + t.amplitude * 0.7;
      t.phaseVelocity *= Math.exp(-dt * 3.5);
      // Idle composing: slower pendulum speed
      const baseSpeed = tIdle ? 0.7 : 1.8;
      const edgeBoost = tIdle ? 0.4 : 1.4;
      t.phase += dt * ((baseSpeed + edgeDist * edgeBoost) * (1 - send.energy * 0.3) * windDown + t.phaseVelocity);
      t.speed = Math.abs(Math.cos(t.phase)) * t.amplitude;
    } else {
      t.phaseVelocity = 0; t.amplitude = 0; t.sustain = 0; t.speed = 0;
    }

    syncCSSVars();

    // Keep loop alive while anything is in motion
    if (composeActivity > 0.006 || composeActivityTarget > 0.006
      || Math.abs(composeActivityVelocity) > 0.006
      || send.energy > 0.006 || Math.abs(send.velocity) > 0.006
      || t.intensity > 0.006 || t.amplitude > 0.006) {
      composeActivityRaf = requestAnimationFrame(stepComposeActivity);
      return;
    }

    // Full reset
    composeActivity = 0; composeActivityTarget = 0; composeActivityVelocity = 0;
    send.energy = 0; send.velocity = 0; send.fillTarget = 0;
    send.phase = "idle"; send.acks.clear(); send.timestamps.clear(); send.peakEnergy = 0;
    t.intensity = 0; t.idle = false; t.phaseVelocity = 0; t.amplitude = 0; t.sustain = 0; t.speed = 0;
    syncCSSVars();
    composeActivityRaf = 0; composeActivityLastTick = 0;
  }

  /** Kick the rAF loop if not already running. Single gate for all animation. */
  function ensureRaf(): void {
    if (!composeActivityRaf && chatCompose && !reduceMotion) {
      composeActivityRaf = requestAnimationFrame(stepComposeActivity);
    }
  }

  function exciteComposeActivity(boost: number): void {
    if (!chatCompose || reduceMotion) return;
    const b = Math.max(0, Math.min(1, boost));
    composeActivityTarget = Math.min(1, composeActivityTarget + b);
    composeActivityVelocity += b * 2.25;
    syncCSSVars();
    ensureRaf();
  }

  // ── Send energy lifecycle ──

  function sendBeginFill(): void {
    if (!chatCompose || reduceMotion) return;
    send.phase = "filling";
    send.fillTarget = Math.min(1, Math.max(send.fillTarget, send.energy) + 0.15);
    send.velocity = Math.max(send.velocity, 2.0 - Math.min(1, send.rtt / 200) * 0.5);
    ensureRaf();
  }

  function sendProgress(fraction: number): void {
    if (send.phase !== "filling") return;
    send.fillTarget = Math.max(send.fillTarget, send.energy + (1 - send.energy) * fraction);
  }

  function sendInFlight(msgId: number): void {
    if (!chatCompose || reduceMotion) return;
    const now = Date.now();
    send.acks.add(msgId);
    send.timestamps.set(msgId, now);
    send.phase = "in-flight";
    send.fillTarget = 1;
    send.inflightStart = now;
    send.peakEnergy = send.energy;
    ensureRaf();
    // Safety: auto-release if ACK never arrives
    setTimeout(() => {
      if (send.acks.delete(msgId) && send.acks.size === 0) {
        send.timestamps.delete(msgId);
        sendDelivered();
      }
    }, 5000);
  }

  function sendDelivered(): void {
    haptic("msg-sent");
    if (!chatCompose || reduceMotion) return;
    send.phase = "delivered";
    const af = Math.min(1, send.ackLatency / 300);
    send.velocity = -((1.8 - af * 0.4) + send.peakEnergy * 2.2);

    // Ripple shoves the typing pendulum outward
    if (typing.intensity > 0.05) {
      const dir = Math.sin(typing.phase) > 0 ? 1 : -1;
      typing.phaseVelocity += dir * (1.2 + send.peakEnergy * 2.0);
    }
    ensureRaf();
  }

  function handleAck(msgId: number): void {
    const sentAt = send.timestamps.get(msgId);
    if (sentAt) {
      send.ackLatency = send.ackLatency * 0.7 + (Date.now() - sentAt) * 0.3;
      send.timestamps.delete(msgId);
    }
    // Mark message as delivered — reuse msgById (ACK arrives for self-sent messages)
    const msgEl = msgById.get(msgId);
    if (msgEl) msgEl.classList.add("wl-msg--delivered");
    send.acks.delete(msgId);
    if (send.acks.size === 0 && send.phase === "in-flight") sendDelivered();
  }

  function handleConnectionStats(stats: { rtt: number; bytesSent: number; bytesReceived: number }): void {
    if (stats.rtt > 0) send.rtt = send.rtt * 0.75 + stats.rtt * 0.25;
  }

  /** Preview mode: simulate the send lifecycle without a real connection.
   *  Negative IDs avoid collisions with real session msgIds (which start at 0+). */
  let previewSendId = 0;
  function simulateSendEnergy(): void {
    if (!chatCompose || reduceMotion) return;
    sendBeginFill();
    const myId = ++previewSendId;
    let t = 0;
    const step = () => {
      t += 0.12;
      sendProgress(Math.min(1, t));
      if (t < 1) { requestAnimationFrame(step); return; }
      if (myId !== previewSendId) return;
      send.phase = "in-flight";
      send.peakEnergy = send.energy;
      send.inflightStart = Date.now();
      setTimeout(() => {
        if (myId === previewSendId && send.phase === "in-flight") sendDelivered();
      }, 100 + Math.random() * 80);
    };
    requestAnimationFrame(step);
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
      liveSurface.classList.remove("wl-preview", "wl-recovering");
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
    if (n.includes("gathering network candidates")) { setConnecting("finding the best direct path..."); updateStatus("checking network paths..."); }
    else if (n.includes("offer code ready")) { updateStatus("step 1/2: send your invite code"); }
    else if (n.includes("answer code ready")) { updateStatus("step 2/2: send your reply code"); }
    else if (n.includes("applying answer code")) { setConnecting("verifying peer reply..."); updateStatus("applying peer reply..."); }
    else if (n.includes("connecting peer-to-peer")) { setConnecting("opening direct channel..."); updateStatus("opening direct channel..."); }
    else if (n.includes("secure channel open")) { setConnecting("starting end-to-end key exchange..."); updateStatus("starting key exchange..."); }
    else if (n.includes("fingerprint:")) { updateStatus("security check: compare emoji with your peer"); }
    else if (n.includes("fingerprint confirmed")) { updateStatus("secure session is live"); }
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

    if (flareFireBtn) {
      flareFireBtn.disabled = busy || flareActive;
    }
    if (flarePhraseInput) {
      flarePhraseInput.disabled = busy || flareActive;
    }

    opts.funnelCampfireBtn.disabled = busy || !chatVisible;

    const modeSwitchWrap = modeSwitchBtn?.closest(".wl-mode-switch") as HTMLElement | null;
    if (modeSwitchWrap) {
      modeSwitchWrap.style.display = (busy || hasSession) ? "none" : "";
    }

    const canChat = hasSession || chatVisible;       // preview mode has no session but chat is visible
    opts.chatSendBtn.disabled = busy || !canChat || !hasChatText;
    opts.chatFileBtn.disabled = busy || !canChat;
    opts.chatMicBtn.disabled = busy || !canChat;
    opts.chatMicCancel.disabled = busy || !canChat;
    opts.chatMicSend.disabled = busy || !canChat;
    const hasChatMessages = opts.chatMessages.children.length > 0
      && !(opts.chatMessages.children.length === 1 && opts.chatMessages.firstElementChild?.classList.contains("wl-chat-empty"));
    opts.chatClearBtn.disabled = busy || !hasChatMessages;

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

  /* ── Peer message nudge ─────────────────────────────────── */

  /**
   * Audio nudge — disabled until sound design is ready.
   * Haptics (haptic("msg-received")) handle the notification feel for now.
   * To re-enable: implement a proper sound here and remove the early return.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let audioCtx: AudioContext | null = null;

  function nudgeAudio(): void {
    // Sound effects are intentionally off — haptics are the primary feedback.
    return;
  }

  /* ── Audio recording (WASM ADPCM pipeline) ──────────────── */

  /** Voice constraints. Mono, 48kHz (if supported). 
   *  We explicitly disable the browser's echo cancellation, noise suppression, 
   *  and AGC. Browser implementations are meant for web-conferencing and often 
   *  cause aggressive robotic artifacts, pumping, and word-chopping. We want 
   *  raw natural sound, conditioned gently by our own WASM pipeline. */
  const VOICE_CONSTRAINTS: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };

  const ADPCM_MIME = "audio/x-whisper-adpcm";

  // AudioWorklet-based PTT state
  let recordingStream: MediaStream | null = null;
  let recordingStart = 0;
  let recordingTimer: ReturnType<typeof setInterval> | null = null;
  let activeAudio: { stop: () => void; btn: HTMLButtonElement; wrap: HTMLElement; redraw: (p: number) => void; raf: number } | null = null;

  // Raw PCM accumulator — filled live while the worklet fires
  let pcmChunks: Float32Array[] = [];
  let pcmSampleRate = 48000;

  // Mic state tracking
  let micPending = false;
  let micHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let micHoldMode = false;
  let micPointerId = -1;
  let micDeferred: "send" | "discard" | null = null;
  let micAudioCtx: AudioContext | null = null;
  let micWorkletNode: AudioWorkletNode | null = null;

  // Dedicated singleton context for playback to prevent recording teardowns from closing it
  let playbackCtx: AudioContext | null = null;

  const micSupported = !!navigator.mediaDevices?.getUserMedia;
  if (!micSupported) opts.chatMicWrap.setAttribute("data-hidden", "");

  function formatRecordDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function formatBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  function resetMicState(): void {
    micHoldMode = false;
    micDeferred = null;
    micPointerId = -1;
    if (micHoldTimer) { clearTimeout(micHoldTimer); micHoldTimer = null; }
  }

  /**
   * Inline AudioWorkletProcessor code as a Blob URL so we need no extra file.
   * The processor forwards each 128-sample Float32 buffer to the main scope
   * via postMessage. No SharedArrayBuffer required — PTT is not latency-critical
   * in the same way as real-time call mode would be.
   */
  function getWorkletBlobUrl(): string {
    const code = `
      class WhisperPcmCapture extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0]?.[0];
          if (ch && ch.length > 0) {
            // Transfer the underlying ArrayBuffer — zero copy
            const copy = ch.slice();
            this.port.postMessage({ samples: copy }, [copy.buffer]);
          }
          return true;
        }
      }
      registerProcessor('whisper-pcm-capture', WhisperPcmCapture);
    `;
    return URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  }

  function startRecording(): void {
    if (!micSupported || micPending || recordingStream) return;

    micPending = true;
    haptic("recording-start");
    navigator.mediaDevices.getUserMedia({ audio: VOICE_CONSTRAINTS }).then(async (stream) => {
      micPending = false;

      if (micDeferred === "discard") {
        micDeferred = null;
        for (const t of stream.getTracks()) t.stop();
        return;
      }

      recordingStream = stream;
      pcmChunks = [];
      recordingStart = Date.now();
      pcmSampleRate = stream.getAudioTracks()[0]?.getSettings().sampleRate ?? 48000;

      // Build AudioContext + worklet
      const blobUrl = getWorkletBlobUrl();
      try {
        micAudioCtx = new AudioContext({ sampleRate: pcmSampleRate });
        await micAudioCtx.audioWorklet.addModule(blobUrl);
        URL.revokeObjectURL(blobUrl);

        const source = micAudioCtx.createMediaStreamSource(stream);
        micWorkletNode = new AudioWorkletNode(micAudioCtx, "whisper-pcm-capture");
        micWorkletNode.port.onmessage = (ev) => {
          if (ev.data?.samples instanceof Float32Array) {
            pcmChunks.push(ev.data.samples);
          }
        };
        source.connect(micWorkletNode);
        // Connect to destination with zero gain — keeps the audio graph alive
        // without audible feedback
        const silentGain = micAudioCtx.createGain();
        silentGain.gain.value = 0;
        micWorkletNode.connect(silentGain);
        silentGain.connect(micAudioCtx.destination);
      } catch (e) {
        // AudioWorklet unavailable (very old browsers) — fall back to ScriptProcessor
        // Note: ScriptProcessorNode is deprecated but still works universally.
        URL.revokeObjectURL(blobUrl);
        const ctx = micAudioCtx ?? new AudioContext({ sampleRate: pcmSampleRate });
        micAudioCtx = ctx;
        const source = ctx.createMediaStreamSource(stream);
        // @ts-ignore – deprecated but universal fallback
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        // @ts-ignore
        proc.onaudioprocess = (ev: AudioProcessingEvent) => {
          const ch = ev.inputBuffer.getChannelData(0);
          pcmChunks.push(ch.slice());
        };
        source.connect(proc);
        proc.connect(ctx.destination);
        micWorkletNode = proc as unknown as AudioWorkletNode;
      }

      // Drive track-ended cleanup
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.addEventListener("ended", () => {
          if (recordingStream) {
            appendLog("mic disconnected — sending recorded audio");
            stopRecording();
          }
        }, { once: true });
      }

      opts.chatMicWrap.setAttribute("data-recording", "true");
      opts.chatMicCancel.tabIndex = 0;
      opts.chatMicSend.tabIndex = 0;
      opts.chatMicBtn.tabIndex = -1;
      opts.chatInput.disabled = true;
      opts.chatInput.placeholder = "recording... 0:00";

      recordingTimer = setInterval(() => {
        const dur = formatRecordDuration(Date.now() - recordingStart);
        // Rough byte estimate: adpcm = numSamples / 2
        const totalSamples = pcmChunks.reduce((s, c) => s + c.length, 0);
        const estBytes = Math.ceil(totalSamples / 2);
        const size = estBytes > 0 ? ` · ${formatBytes(estBytes)}` : "";
        opts.chatInput.placeholder = `recording... ${dur}${size}`;
      }, 1000);

      if (micDeferred === "send") {
        micDeferred = null;
        stopRecording();
      }
    }).catch((err) => {
      micPending = false;
      resetMicState();
      appendLog(`mic access denied: ${errMsg(err)}`);
    });
  }

  /** Shared UI teardown. */
  function teardownRecordingUI(): void {
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
    opts.chatMicWrap.removeAttribute("data-recording");
    opts.chatMicCancel.tabIndex = -1;
    opts.chatMicSend.tabIndex = -1;
    opts.chatMicBtn.tabIndex = 0;
    resetMicState();
    opts.chatInput.disabled = false;
    opts.chatInput.placeholder = "whisper something...";
  }

  function cleanupRecordingStream(): void {
    if (micWorkletNode) {
      try { micWorkletNode.disconnect(); } catch { }
      micWorkletNode = null;
    }
    if (micAudioCtx) {
      micAudioCtx.close().catch(() => { });
      micAudioCtx = null;
    }
    if (recordingStream) {
      for (const t of recordingStream.getTracks()) t.stop();
      recordingStream = null;
    }
  }

  function stopRecording(): void {
    teardownRecordingUI();
    const elapsed = Date.now() - recordingStart;
    const chunks = pcmChunks;
    pcmChunks = [];
    cleanupRecordingStream();

    // Discard sub-500ms squeaks
    if (elapsed < 500 || chunks.length === 0) return;
    haptic("recording-stop");

    // Flatten accumulated 128-sample Float32 chunks into one
    const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
    const flat = new Float32Array(totalSamples);
    let off = 0;
    for (const c of chunks) { flat.set(c, off); off += c.length; }

    const name = `audio-${Date.now()}.wadpcm`;

    encodeAdpcm(flat, pcmSampleRate).then((adpcmBytes) => {
      if (!session) {
        addChatMessage({
          type: "file", direction: "self",
          fileName: name, fileSize: adpcmBytes.length, fileType: ADPCM_MIME,
          fileData: adpcmBytes, timestamp: Date.now(),
        });
        simulateSendEnergy();
        return;
      }
      sendBeginFill();
      session.sendAudio(name, ADPCM_MIME, adpcmBytes).then((msgId) => {
        sendInFlight(msgId);
      }).catch((err) => {
        send.phase = "delivered"; send.velocity = -4;
        haptic("send-failed");
        appendLog(`audio send failed: ${errMsg(err)}`);
        pulseComposeIntent("error", 1100);
      });
    }).catch((err) => {
      appendLog(`audio encode (wasm) failed: ${errMsg(err)}`);
    });
  }

  function cancelRecording(): void {
    haptic("recording-cancel");
    teardownRecordingUI();
    pcmChunks = [];
    cleanupRecordingStream();
    if (micPending) micDeferred = "discard";
  }

  /* ── Active audio management ────────────────────────────── */

  function stopAllAudio(): void {
    if (activeAudio) {
      cancelAnimationFrame(activeAudio.raf);
      activeAudio.stop();
      setPlayIcon(activeAudio.btn, false);
      activeAudio.wrap.removeAttribute("data-playing");
      activeAudio.redraw(0);
      activeAudio = null;
    }
  }

  function formatAudioDuration(seconds: number): string {
    if (!isFinite(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  const PLAY_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><polygon points="4,2 14,8 4,14"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="0.8"/><rect x="9.5" y="2" width="3.5" height="12" rx="0.8"/></svg>';

  function setPlayIcon(btn: HTMLButtonElement, playing: boolean): void {
    btn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  /* ── Waveform extraction & rendering ────────────────────── */

  const WAVE_BAR_W = 3;
  const WAVE_GAP = 2.5;
  const WAVE_MIN_H = 3;

  /** Generate waveform amplitudes directly from decoded PCM float array. */
  function extractWaveformFromPcm(raw: Float32Array, numBars: number): Float32Array {
    const blockSize = Math.max(1, Math.floor(raw.length / numBars));
    const amps = new Float32Array(numBars);

    // Step 1-2: mean absolute amplitude per block
    let peak = 0;
    for (let i = 0; i < numBars; i++) {
      let sum = 0;
      const off = i * blockSize;
      const end = Math.min(off + blockSize, raw.length);
      for (let j = off; j < end; j++) sum += Math.abs(raw[j]);
      amps[i] = sum / (end - off);
      if (amps[i] > peak) peak = amps[i];
    }

    // Step 3: normalise to 0–1
    if (peak > 0) for (let i = 0; i < numBars; i++) amps[i] /= peak;

    // Step 4: sqrt curve — compresses dynamic range
    for (let i = 0; i < numBars; i++) amps[i] = Math.sqrt(amps[i]);

    // Step 5: 3-tap moving-average smooth
    const smoothed = new Float32Array(numBars);
    for (let i = 0; i < numBars; i++) {
      const prev = i > 0 ? amps[i - 1] : amps[i];
      const next = i < numBars - 1 ? amps[i + 1] : amps[i];
      smoothed[i] = prev * 0.2 + amps[i] * 0.6 + next * 0.2;
    }

    return smoothed;
  }

  /** Spring integrator matching the site's compose system: accel = ω²(target-x) − 2ζω·v
   *  ω=14 ζ=0.68 → slightly underdamped for a gentle overshoot on reveal. */
  function springStep(pos: number, vel: number, target: number, dt: number): [number, number] {
    const omega = 14, zeta = 0.68;
    const accel = omega * omega * (target - pos) - 2 * zeta * omega * vel;
    return [pos + (vel + accel * dt) * dt, vel + accel * dt];
  }

  /** Draw waveform bars with playhead glow — evenly spaced across full width. */
  function drawWaveform(
    ctx: CanvasRenderingContext2D, w: number, h: number,
    barHeights: Float32Array, progress: number,
    played: string, unplayed: string, glowColor: string,
  ): void {
    ctx.clearRect(0, 0, w, h);
    const n = barHeights.length;
    if (n === 0) return;
    const step = w / n;
    const bw = Math.max(2, step - WAVE_GAP);
    const maxH = h - 2;
    const r = bw / 2;
    const headIdx = Math.floor(progress * n);
    const hasHead = progress > 0.001 && progress < 0.999;

    for (let i = 0; i < n; i++) {
      const x = i * step + (step - bw) / 2;
      const barH = Math.max(WAVE_MIN_H, barHeights[i] * maxH);
      const y = (h - barH) / 2;
      const isPlayed = (i + 0.5) / n <= progress;

      // Playhead proximity glow — falls off over ~3 bars
      const dist = Math.abs(i - headIdx);
      const g = hasHead && dist < 4 ? (1 - dist / 4) * 0.65 : 0;
      if (g > 0) { ctx.shadowColor = glowColor; ctx.shadowBlur = 6 * g; }
      else { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; }

      ctx.fillStyle = isPlayed ? played : unplayed;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, barH, r);
      ctx.fill();
    }
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
  }

  /* ── Compose state protocol ──────────────────────────────
   *
   * Three states sent as a 1-byte payload on LIVE_MSG.TYPING:
   *   0x00  ACTIVE   keystroke happened (debounced ~3s)
   *   0x01  IDLE     no keystrokes but unsent text remains
   *   0x02  CLEARED  text sent or deleted — hide indicator
   *
   * Send strategy — transitions only, not heartbeats:
   *   active typing  →  0x00 per debounce window (~3s)
   *   stop typing    →  0x01 once, then keepalive every 8s
   *   send / delete  →  0x02 once
   *
   * Receive strategy — hold state, single safety net:
   *   any signal resets a 15s safety timeout
   *   0x02 clears immediately
   */

  const COMPOSE_ACTIVE = 0x00;
  const COMPOSE_IDLE = 0x01;
  const COMPOSE_CLEARED = 0x02;

  const IDLE_KEEPALIVE_MS = 8_000;
  const SAFETY_TIMEOUT_MS = 15_000;

  /* ── Receive ── */

  function handlePeerCompose(state: number): void {
    if (state === COMPOSE_CLEARED) { hidePeerTyping(); return; }

    typing.target = 1;
    typing.idle = state === COMPOSE_IDLE;

    // Active signals nudge the pendulum — keeps it feeling alive between debounces
    if (!typing.idle && typing.amplitude > 0.3) typing.phaseVelocity += 0.3;

    // Every inbound signal resets the single safety timeout
    if (peerTypingTimer) clearTimeout(peerTypingTimer);
    peerTypingTimer = setTimeout(hidePeerTyping, SAFETY_TIMEOUT_MS);

    exciteComposeActivity(typing.idle ? 0.06 : 0.18);
    ensureRaf();
  }

  function hidePeerTyping(): void {
    if (peerTypingTimer) { clearTimeout(peerTypingTimer); peerTypingTimer = null; }
    typing.target = 0;
    typing.idle = false;
  }

  /* ── Send ── */

  let composing = false;
  let idleKeepAlive: ReturnType<typeof setInterval> | null = null;

  function startIdleKeepAlive(): void {
    stopIdleKeepAlive();
    idleKeepAlive = setInterval(() => {
      // Session gone or text cleared while we were idle → clean exit
      if (!session || !composing || !opts.chatInput.value.trim()) {
        emitCleared();
        return;
      }
      session.sendTyping(COMPOSE_IDLE);
    }, IDLE_KEEPALIVE_MS);
  }

  function stopIdleKeepAlive(): void {
    if (idleKeepAlive) { clearInterval(idleKeepAlive); idleKeepAlive = null; }
  }

  function emitTyping(): void {
    if (typingSendTimer || !session) return;
    if (env.saveData || env.constrainedNetwork) return;

    composing = true;
    stopIdleKeepAlive();
    session.sendTyping(COMPOSE_ACTIVE);

    typingSendTimer = setTimeout(() => {
      typingSendTimer = null;
      if (!session) { composing = false; return; }
      if (opts.chatInput.value.trim()) {
        session.sendTyping(COMPOSE_IDLE);
        startIdleKeepAlive();
      } else {
        emitCleared();
      }
    }, typingSendDebounce());

    exciteComposeActivity(0.22);
  }

  function emitCleared(): void {
    stopIdleKeepAlive();
    if (typingSendTimer) { clearTimeout(typingSendTimer); typingSendTimer = null; }
    if (!composing) return;
    composing = false;
    if (session) session.sendTyping(COMPOSE_CLEARED);
  }

  /* ── Smart scroll ──────────────────────────────────────── */

  function isNearBottom(): boolean {
    const el = opts.chatMessages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function smartScroll(): void {
    if (isNearBottom()) {
      opts.chatMessages.scrollTo({
        top: opts.chatMessages.scrollHeight,
        behavior: "smooth",
      });
    }
  }

  /* ── Chat rendering ───────────────────────────────────── */

  const chatEmpty = opts.chatMessages.querySelector<HTMLElement>("#wl-chat-empty");

  /** Maps global msgId → message DOM element for ACK delivery, SEEN, and REACT lookups. */
  const msgById = new Map<number, HTMLElement>();

  function addChatMessage(msg: LiveMessage): void {
    // Hide empty-state hint on first real message
    if (chatEmpty && chatEmpty.parentNode) chatEmpty.remove();

    const div = document.createElement("div");
    div.className = `wl-msg wl-msg--${msg.direction}`;

    if (msg.type === "text") {
      const textEl = document.createElement("span");
      textEl.className = "wl-msg-text";
      textEl.textContent = msg.text ?? "";
      div.appendChild(textEl);
    } else if (msg.type === "file" && msg.fileType?.startsWith("audio/") && msg.fileData) {
      /* ── Inline audio player with waveform ─────────────── */
      const audioEl = document.createElement("div");
      audioEl.className = "wl-msg-audio";

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "wl-audio-play-btn";
      setPlayIcon(playBtn, false);

      const canvas = document.createElement("canvas");
      canvas.className = "wl-audio-wave";

      const durLabel = document.createElement("span");
      durLabel.className = "wl-audio-duration";
      durLabel.textContent = "0:00";

      audioEl.append(playBtn, canvas, durLabel);

      // We don't need a blob URL for custom WASM ADPCM playback
      const isAdpcm = msg.fileType === ADPCM_MIME;
      const abCopy = new ArrayBuffer(msg.fileData.byteLength);
      new Uint8Array(abCopy).set(msg.fileData);

      let pcmData: Float32Array | null = null;
      let durationSeconds = 0;

      let sourceNode: AudioBufferSourceNode | null = null;
      let playbackStartTime = 0;
      let pauseOffset = 0;
      let isPlaying = false;

      let waveform: Float32Array | null = null;
      let barHeights: Float32Array | null = null;   // spring-animated heights
      let barVelocities: Float32Array | null = null;
      let playProgress = 0;
      let playRaf = 0;
      let accentPlayed = "";
      let accentUnplayed = "";
      let accentGlow = "";
      let canvasW = 0;
      let canvasH = 0;
      let ctx2d: CanvasRenderingContext2D | null = null;

      /** Redraw at a given progress (0–1). */
      function redraw(p: number): void {
        playProgress = p;
        if (!ctx2d || !barHeights) return;
        drawWaveform(ctx2d, canvasW, canvasH, barHeights, p, accentPlayed, accentUnplayed, accentGlow);
      }

      /** rAF loop while audio is playing — reads currentTime for smooth sweep. */
      function playbackTick(): void {
        if (isPlaying && durationSeconds > 0) {
          const elapsed = (playbackCtx?.currentTime ?? 0) - playbackStartTime + pauseOffset;
          const p = Math.min(1, Math.max(0, elapsed / durationSeconds));
          redraw(p);
          durLabel.textContent = formatAudioDuration(elapsed);
        }
        playRaf = requestAnimationFrame(playbackTick);
      }

      function startPlaybackLoop(): void {
        cancelAnimationFrame(playRaf);
        playRaf = requestAnimationFrame(playbackTick);
      }

      function stopPlaybackLoop(): void {
        cancelAnimationFrame(playRaf);
        playRaf = 0;
      }

      /** Size the canvas bitmap to match CSS layout (HiDPI-aware). */
      function sizeCanvas(): boolean {
        const dpr = devicePixelRatio || 1;
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        if (cw === 0 || ch === 0) return false;
        canvasW = cw;
        canvasH = ch;
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        ctx2d = canvas.getContext("2d");
        if (ctx2d) ctx2d.scale(dpr, dpr);
        return !!ctx2d;
      }

      /** Read accent color from the resolved CSS custom property. */
      function readColors(): void {
        const raw = getComputedStyle(div).getPropertyValue("--msg-accent").trim();
        accentPlayed = `rgba(${raw}, 0.72)`;
        accentUnplayed = `rgba(${raw}, 0.16)`;
        accentGlow = `rgba(${raw}, 0.55)`;
      }

      /** Spring-animate bars from zero to their waveform targets. */
      function revealWaveform(): void {
        if (!waveform || !ctx2d) return;
        const n = waveform.length;
        barHeights = new Float32Array(n);
        barVelocities = new Float32Array(n);
        const staggerPerBar = 0.008; // seconds between each bar starting
        const t0 = performance.now();
        let prevT = t0;
        const tick = (now: number) => {
          const dt = Math.min((now - prevT) / 1000, 0.04);
          prevT = now;
          const elapsed = (now - t0) / 1000;
          let settled = true;
          for (let i = 0; i < n; i++) {
            const delay = i * staggerPerBar;
            if (elapsed < delay) { settled = false; continue; }
            const target = waveform![i];
            const [np, nv] = springStep(barHeights![i], barVelocities![i], target, dt);
            barHeights![i] = np;
            barVelocities![i] = nv;
            if (Math.abs(np - target) > 0.002 || Math.abs(nv) > 0.05) settled = false;
          }
          drawWaveform(ctx2d!, canvasW, canvasH, barHeights!, playProgress, accentPlayed, accentUnplayed, accentGlow);
          if (!settled) requestAnimationFrame(tick);
          else {
            // Snap to exact targets
            for (let i = 0; i < n; i++) barHeights![i] = waveform![i];
            drawWaveform(ctx2d!, canvasW, canvasH, barHeights!, playProgress, accentPlayed, accentUnplayed, accentGlow);
          }
        };
        requestAnimationFrame(tick);
      }

      // Kick off waveform extraction + canvas init after DOM insertion
      requestAnimationFrame(async () => {
        if (!sizeCanvas()) return;
        readColors();

        const numBars = Math.min(64, Math.max(12, Math.round(canvasW / (WAVE_BAR_W + WAVE_GAP))));
        const ph = new Float32Array(numBars);
        let seed = msg.timestamp & 0xffff;
        for (let i = 0; i < numBars; i++) {
          seed = (seed * 16807 + 7) & 0x7fffffff;
          ph[i] = 0.15 + 0.35 * ((seed & 0xffff) / 0xffff);
        }
        waveform = ph;
        barHeights = new Float32Array(ph);
        barVelocities = new Float32Array(numBars);
        redraw(0);

        try {
          if (isAdpcm) {
            const decoded = await decodeAdpcm(new Uint8Array(abCopy));
            pcmData = decoded.pcm;
            durationSeconds = decoded.pcm.length / decoded.sampleRate;
            // Store sampleRate so the AudioBuffer uses the right rate
            (playBtn as HTMLButtonElement & { _sr: number })._sr = decoded.sampleRate;
          } else {
            // Unused fallback, since we only send ADPCM now
            const actx = new AudioContext();
            const decoded = await actx.decodeAudioData(abCopy.slice(0));
            pcmData = decoded.getChannelData(0);
            durationSeconds = decoded.duration;
            (playBtn as HTMLButtonElement & { _sr: number })._sr = decoded.sampleRate;
            void actx.close();
          }
          durLabel.textContent = formatAudioDuration(durationSeconds);

          waveform = extractWaveformFromPcm(pcmData, numBars);
          revealWaveform();
        } catch {
          // Decoding failed — keep placeholder bars
        }
      });

      // ── WebAudio Playback via AudioContext ──

      function getAudioContext(): AudioContext {
        if (!playbackCtx) playbackCtx = new AudioContext(); // Use browser default sample rate for playback sink
        if (playbackCtx.state === "suspended") playbackCtx.resume();
        return playbackCtx;
      }

      function stopInternal() {
        if (sourceNode) {
          try { sourceNode.stop(); } catch { }
          sourceNode = null;
        }
        isPlaying = false;
        // Note: pauseOffset is NOT reset here — callers manage it.
        // stopAllAudio() and onended reset it to 0; pause path preserves it.
      }

      playBtn.addEventListener("click", () => {
        if (!pcmData) return; // not decoded yet

        if (isPlaying) {
          const ctx = getAudioContext();
          pauseOffset += ctx.currentTime - playbackStartTime;
          stopInternal(); // preserves pauseOffset

          stopPlaybackLoop();
          audioEl.removeAttribute("data-playing");
          setPlayIcon(playBtn, false);
          if (activeAudio?.btn === playBtn) activeAudio = null;
          return;
        }

        // Start playback
        stopAllAudio();
        const ctx = getAudioContext();

        const sr = (playBtn as HTMLButtonElement & { _sr: number })._sr ?? 48000;
        const audioBuf = ctx.createBuffer(1, pcmData.length, sr);
        audioBuf.getChannelData(0).set(pcmData);

        sourceNode = ctx.createBufferSource();
        sourceNode.buffer = audioBuf;
        sourceNode.connect(ctx.destination);

        // If we reached the end, loop back around
        if (pauseOffset >= durationSeconds - 0.05) pauseOffset = 0;

        playbackStartTime = ctx.currentTime;
        sourceNode.start(0, pauseOffset);
        isPlaying = true;

        sourceNode.onended = () => {
          if (!isPlaying) return; // called by manual stop
          pauseOffset = 0; // reset to start on next play
          stopInternal();
          stopPlaybackLoop();
          setPlayIcon(playBtn, false);
          audioEl.removeAttribute("data-playing");
          redraw(0);
          durLabel.textContent = formatAudioDuration(durationSeconds);
          if (activeAudio?.btn === playBtn) activeAudio = null;
        };

        setPlayIcon(playBtn, true);
        audioEl.setAttribute("data-playing", "");
        startPlaybackLoop();
        activeAudio = { stop: stopInternal, btn: playBtn, wrap: audioEl, redraw, raf: playRaf };
      }, { signal });

      // Click on canvas to seek
      canvas.addEventListener("click", (e) => {
        if (!pcmData || !durationSeconds) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        pauseOffset = ratio * durationSeconds;
        redraw(ratio);
        durLabel.textContent = formatAudioDuration(pauseOffset);

        if (isPlaying) {
          // Restart playback at new offset
          playBtn.click(); // stop
          playBtn.click(); // play
        }
      }, { signal });

      div.appendChild(audioEl);
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
        // Always use octet-stream for received files — never let the browser interpret
        // peer-declared MIME types (prevents HTML/SVG/etc. execution via blob URL).
        // The download attribute + file extension ensure the OS opens files correctly.
        const blob = new Blob([ab], { type: "application/octet-stream" });
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
    timeEl.dateTime = String(msg.timestamp);
    timeEl.textContent = formatTime(msg.timestamp);
    div.appendChild(timeEl);

    if (msg.direction === "peer") hidePeerTyping();

    opts.chatMessages.appendChild(div);

    // Self → always snap to bottom (deferred so layout includes the new node)
    // System → smooth-scroll if already near bottom
    // Peer → never auto-scroll
    if (msg.direction === "self") {
      requestAnimationFrame(() => {
        opts.chatMessages.scrollTo({ top: opts.chatMessages.scrollHeight, behavior: "instant" });
      });
    } else if (msg.direction === "system") {
      smartScroll();
    }

    if (msg.msgId !== undefined) {
      div.dataset.msgId = String(msg.msgId);
      msgById.set(msg.msgId, div);

      // ── Reaction shelf — hidden until message is tapped ──
      // The shelf has zero visual presence at rest; CSS transitions it in
      // when data-shelf-open is present on the parent .wl-msg element.
      const shelf = document.createElement("div");
      shelf.className = "wl-react-shelf";
      shelf.setAttribute("role", "toolbar");
      shelf.setAttribute("aria-label", "React");

      // Predefined + last-used quick-picks
      const predefined = ["👍", "👎", "❤️", "😂"];
      const lastUsed = localStorage.getItem("wl-last-reaction");
      if (lastUsed && !predefined.includes(lastUsed)) predefined.push(lastUsed);

      predefined.forEach((emoji) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wl-react-btn";
        btn.textContent = emoji;
        btn.setAttribute("aria-label", `React with ${emoji}`);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleSelfReaction(msg.msgId!, emoji);
          localStorage.setItem("wl-last-reaction", emoji);
          div.removeAttribute("data-shelf-open");
        }, { signal });
        shelf.appendChild(btn);
      });

      // OS emoji picker button + offscreen input
      const emojiBtn = document.createElement("button");
      emojiBtn.type = "button";
      emojiBtn.className = "wl-react-btn wl-react-btn--more";
      emojiBtn.textContent = "＋";
      emojiBtn.setAttribute("aria-label", "Pick any emoji");

      const hiddenInput = document.createElement("input");
      hiddenInput.type = "text";
      hiddenInput.setAttribute("aria-hidden", "true");
      hiddenInput.style.cssText = "position:absolute;left:-9999px;top:-9999px;opacity:0;width:1px;height:1px;";
      hiddenInput.addEventListener("input", (e) => {
        e.stopPropagation();
        const raw = hiddenInput.value;
        hiddenInput.value = "";
        if (!raw || msg.msgId === undefined) return;
        const seg = new Intl.Segmenter().segment(raw.replace(/\s/g, ""));
        const first = seg[Symbol.iterator]().next().value;
        const emoji = first?.segment ?? raw[0];
        if (emoji) {
          toggleSelfReaction(msg.msgId!, emoji);
          localStorage.setItem("wl-last-reaction", emoji);
          div.removeAttribute("data-shelf-open");
        }
      }, { signal });

      emojiBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        hiddenInput.focus();
      }, { signal });

      shelf.appendChild(emojiBtn);
      shelf.appendChild(hiddenInput);
      div.appendChild(shelf);

      // Tap the message bubble to reveal / hide the shelf.
      // One shelf at a time: close the previously open one first.
      div.addEventListener("click", (e) => {
        // Ignore clicks on shelf buttons themselves (handled above)
        if ((e.target as HTMLElement).closest(".wl-react-shelf")) return;
        // Ignore clicks on reaction pills
        if ((e.target as HTMLElement).closest(".wl-reaction")) return;
        const isOpen = div.hasAttribute("data-shelf-open");
        // Close any globally open shelf
        const prev = opts.chatMessages.querySelector("[data-shelf-open]");
        if (prev) prev.removeAttribute("data-shelf-open");
        if (!isOpen) div.setAttribute("data-shelf-open", "");
      }, { signal });
    }

    if (msg.direction === "peer") {
      // Haptic: distinguish text from file/audio messages
      if (msg.type === "file") haptic("file-received");
      else if (msg.type === "text") haptic("msg-received");
      bumpUnread();
      nudgeAudio();
      // Send SEEN immediately if tab is focused.
      if (!document.hidden && msg.msgId !== undefined && session) {
        session.sendCtrl(CTRL_OP.SEEN, encodeSeenPayload(msg.msgId));
      }
    }
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

    // Only log verbose network info in manual mode — relay/flare users don't need to see it
    if (!relayActive && !flareActive) {
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
      onPeerTyping: handlePeerCompose,
      onAck: handleAck,
      onSendProgress: (sent, total) => sendProgress(sent / total),
      onConnectionStats: handleConnectionStats,
      onCtrl: handleCtrl,
    }, {
      rtcConfig,
      autoConfirmFingerprint: true,
    });
  }

  function handleStateChange(state: LiveState, detail?: string): void {
    // During relay/flare exchange, suppress intermediate session states that would
    // overwrite the UI. The handler manages the connecting phase display itself
    // and clears the active flag before terminal states fire.
    if (relayActive || flareActive) {
      const suppressed: readonly LiveState[] = [
        "offering", "waiting-for-answer", "answering", "connecting", "disconnected",
      ];
      if (suppressed.includes(state)) {
        return;
      }
    }

    currentLiveState = state;

    const enterPhase = (el: HTMLElement, status: string, log: boolean, isBusy: boolean) => {
      showPhase(el); updateStatus(status); setLogActive(log); setBusy(isBusy); updateControls();
    };

    switch (state) {
      case "idle":
        enterPhase(opts.liveSection, "", false, false);
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
        // auto-confirmed — stay on connecting screen, transition to live is immediate
        break;

      case "live":
        // 1:1 is always symmetric — both parties are equal.
        // Campfire: founders get elevated weight via setWeights(2, 1, partyCount).
        if (session) clearVote.setWeights(1, 1);
        // Founding 1:1 peers are symmetric hosts: both sides weight 2.
        campfireVote.setWeights(2, 2);
        haptic("connected");
        enterPhase(opts.chatSection, "", false, false);
        liveSurface?.classList.remove("wl-recovering");
        opts.chatInput.disabled = false;
        opts.chatInput.placeholder = "whisper something...";
        opts.chatInput.focus();
        opts.fpChip.classList.remove("wl-fp-chip--recovering");
        opts.fpChip.classList.add("wl-fp-chip--verified");
        break;

      case "silent": {
        enterPhase(opts.silentSection, "shared secret ready for Whisper password mode", false, false);
        const secret = session?.getSharedSecret();
        if (secret) opts.silentSecret.textContent = secret;
        break;
      }

      case "recovering":
        showPhase(opts.chatSection);
        liveSurface?.classList.add("wl-recovering");
        updateStatus("");
        setLogActive(true);
        opts.chatSendBtn.disabled = true;
        opts.chatFileBtn.disabled = true;
        opts.chatInput.disabled = true;
        opts.chatInput.placeholder = "reconnecting...";
        opts.fpChip.classList.remove("wl-fp-chip--verified");
        opts.fpChip.classList.add("wl-fp-chip--recovering");
        addChatMessage({ type: "system", direction: "system", text: "connection interrupted, reconnecting...", timestamp: Date.now() });
        break;

      case "disconnected":
        haptic("disconnected");
        enterPhase(opts.disconnectedSection, "session ended", false, false);
        resetFpChip();
        break;

      case "error":
        enterPhase(opts.errorSection, "couldn't connect", false, false);
        opts.errorMessage.textContent = detail ?? "something went wrong";
        resetFpChip();
        break;
    }
  }

  function handleFingerprint(emoji: string): void {
    opts.fingerprintDisplay.textContent = emoji;
    opts.fpChipEmoji.textContent = emoji;
  }

  let peerNickname = "";

  function applyNickname(name: string): void {
    peerNickname = name.trim();
    if (peerNickname) {
      opts.fpChipName.textContent = peerNickname;
      opts.fpChip.classList.add("wl-fp-chip--named");
    } else {
      opts.fpChipName.textContent = "";
      opts.fpChip.classList.remove("wl-fp-chip--named");
    }
  }

  function resetFpChip(): void {
    opts.fpChip.classList.remove("wl-fp-chip--verified", "wl-fp-chip--recovering");
    applyNickname("");
    opts.fpNicknameInput.value = "";
    opts.fpChipEmoji.textContent = "";
    opts.fpNicknameInput.parentElement?.classList.remove("wl-fp-wrap--editing");
  }

  function handleMessage(msg: LiveMessage): void {
    addChatMessage(msg);
  }

  /* ── Reset to idle ─────────────────────────────────────── */

  function resetToIdle(): void {
    relayActive = false;
    lastErrorWasRelay = false;
    lastErrorWasFlare = false;
    if (relayAbort) {
      relayAbort.abort();
      relayAbort = null;
    }
    extinguishFlare();
    if (qrScanSession.active) {
      stopJoinQrScan("cancelled");
    }
    if (session) {
      session.disconnect();
      session = null;
    }
    composing = false;
    stopIdleKeepAlive();
    if (typingSendTimer) { clearTimeout(typingSendTimer); typingSendTimer = null; }
    hidePeerTyping();
    msgById.clear();
    clearNode(opts.chatMessages);
    // Restore empty-state hint
    if (chatEmpty) opts.chatMessages.appendChild(chatEmpty);
    for (const el of [opts.offerCode, opts.answerCode, opts.fingerprintDisplay,
    opts.silentSecret, opts.joinQrStatus, opts.offerQrStatus,
    opts.answerQrStatus, opts.errorMessage]) el.textContent = "";
    for (const el of [opts.joinInput, opts.answerInput, opts.phraseInput, opts.chatInput]) el.value = "";
    if (manualPhraseInput) manualPhraseInput.value = "";
    if (flarePhraseInput) flarePhraseInput.value = "";
    skippedIceCandidates = 0;
    currentLiveState = "idle";
    clearVote.reset();
    campfireVote.reset();
    opts.funnelCampfireBtn.textContent = "start a campfire";
    delete opts.funnelCampfireBtn.dataset.voteState;
    setOfferQrExpanded(false);
    setAnswerQrExpanded(false);
    resetFpChip();
    showPhase(opts.liveSection);
    if (opts.relayAssistToggle) applyModeSwitch(currentIdleMode);
    updateStatus("");
    setLogActive(false);
    setBusy(false);
    updateControls();
  }

  function handleExternalResetRequest(_event: Event): void {
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

  /* ── Signal Flare ────────────────────────────────────────── */

  let flareActive = false;
  let flareAbort: AbortController | null = null;
  let flarePeerResolve: ((accept: boolean) => void) | null = null;
  let flareStartTime = 0;
  let flareElapsedTimer: ReturnType<typeof setInterval> | null = null;
  let lastErrorWasFlare = false;

  // Cache layout elements inside the idle phase
  const relayPanel = opts.liveSection.querySelector<HTMLElement>("#wl-relay-panel");
  const flarePanel = opts.liveSection.querySelector<HTMLElement>("#wl-flare-panel");
  const manualPanel = opts.liveSection.querySelector<HTMLElement>("#wl-manual-panel");
  const idleLede = opts.liveSection.querySelector<HTMLElement>("#wl-idle-lede");
  const modeSwitchBtn = opts.liveSection.querySelector<HTMLButtonElement>("#wl-mode-switch-btn");
  const flareSwitchBtn = opts.liveSection.querySelector<HTMLButtonElement>("#wl-flare-switch-btn");
  const manualPhraseInput = opts.liveSection.querySelector<HTMLInputElement>("#wl-manual-phrase");
  const flarePhraseInput = opts.liveSection.querySelector<HTMLInputElement>("#wl-flare-phrase");
  const flareFireBtn = opts.liveSection.querySelector<HTMLButtonElement>("#wl-flare-fire");
  const flareBurning = opts.liveSection.querySelector<HTMLElement>("#wl-flare-burning");
  const flareElapsed = opts.liveSection.querySelector<HTMLElement>("#wl-flare-elapsed");
  const flareExtinguishBtn = opts.liveSection.querySelector<HTMLButtonElement>("#wl-flare-extinguish");
  const flareArrived = opts.liveSection.querySelector<HTMLElement>("#wl-flare-arrived");
  const flareAcceptBtn = opts.liveSection.querySelector<HTMLButtonElement>("#wl-flare-accept");
  const flareIgnoreBtn = opts.liveSection.querySelector<HTMLButtonElement>("#wl-flare-ignore");
  const flarePhraseField = opts.liveSection.querySelector<HTMLElement>(".wl-flare-phrase-field");

  type IdleMode = "relay" | "flare" | "manual";
  let currentIdleMode: IdleMode = "relay";

  const IDLE_MODE_CONFIG: Record<IdleMode, {
    lede: string;
    flareLink: string;
    manualLink: string;
    relayAssist: boolean;
  }> = {
    relay: {
      lede: "know a phrase, and connect at the same time. thats it.",
      flareLink: "try a signal flare",
      manualLink: "or connect manually",
      relayAssist: true,
    },
    flare: {
      lede: "fire a flare and wait for a signal",
      flareLink: "try relay assist",
      manualLink: "or connect manually",
      relayAssist: true,
    },
    manual: {
      lede: "encrypted peer-to-peer messaging. create a channel or join one.",
      flareLink: "try a signal flare",
      manualLink: "try relay assist",
      relayAssist: false,
    },
  };

  function applyModeSwitch(mode: IdleMode): void {
    if (!relayPanel || !manualPanel || !modeSwitchBtn) return;
    currentIdleMode = mode;
    const cfg = IDLE_MODE_CONFIG[mode];

    // Panel visibility
    relayPanel.style.display = mode === "relay" ? "" : "none";
    if (flarePanel) flarePanel.style.display = mode === "flare" ? "" : "none";
    manualPanel.style.display = mode === "manual" ? "" : "none";

    // Link labels + hover color via custom property (no selector swaps, no transition hacks)
    if (flareSwitchBtn) {
      flareSwitchBtn.textContent = cfg.flareLink;
      flareSwitchBtn.style.setProperty("--switch-hover", mode === "flare" ? "var(--chromatic-cyan)" : "255 160 40");
    }
    modeSwitchBtn.textContent = cfg.manualLink;
    if (idleLede) idleLede.textContent = cfg.lede;

    // Sync shared state
    opts.externalAssistToggle.checked = cfg.relayAssist;
    if (opts.relayAssistToggle) opts.relayAssistToggle.checked = cfg.relayAssist;
    if (mode === "manual" && manualPhraseInput) {
      manualPhraseInput.value = opts.phraseInput.value;
    }

    updateControls();
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
      appendLog(`relay error: ${raw}`);
      lastErrorWasRelay = true;
      handleStateChange("error", friendlyRelayError(raw));
    } finally {
      relayAbort = null;
    }
  }

  /* ── Signal Flare helpers ─────────────────────────────── */

  function formatElapsed(ms: number): string {
    const total = Math.floor(ms / 1000);
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function setFlareUiState(state: "input" | "burning" | "arrived"): void {
    if (flarePhraseField) flarePhraseField.style.display = state === "input" ? "" : "none";
    if (flareFireBtn) flareFireBtn.style.display = state === "input" ? "" : "none";
    if (flareBurning) flareBurning.style.display = state === "burning" ? "" : "none";
    if (flareArrived) flareArrived.style.display = state === "arrived" ? "" : "none";
  }

  function extinguishFlare(): void {
    flareActive = false;
    if (flareAbort) {
      flareAbort.abort();
      flareAbort = null;
    }
    if (flarePeerResolve) {
      flarePeerResolve(false);
      flarePeerResolve = null;
    }
    if (flareElapsedTimer) {
      clearInterval(flareElapsedTimer);
      flareElapsedTimer = null;
    }
    flareStartTime = 0;
    setFlareUiState("input");
    if (flareElapsed) flareElapsed.textContent = "";
    document.title = originalTitle;
  }

  async function handleFlareConnect(): Promise<void> {
    const phrase = flarePhraseInput?.value.trim() ?? "";
    if (!phrase) {
      flarePhraseInput?.focus();
      if (flarePhraseInput) {
        flarePhraseInput.classList.add("ws-reject-pulse");
        setTimeout(() => flarePhraseInput!.classList.remove("ws-reject-pulse"), 400);
      }
      return;
    }

    flareActive = true;
    flareAbort = new AbortController();
    setBusy(true);

    // Request notification permission if default
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* noop */ }
    }

    opts.externalAssistToggle.checked = true;
    session = createSession();

    try {
      const offerCode = await session.createOffer(phrase);
      if (aborted()) return;

      setLogActive(true);
      appendLog("flare preparing...");
      updateStatus("flare is burning");
      setBusy(false);

      // Show burning state
      setFlareUiState("burning");
      flareStartTime = Date.now();
      if (flareElapsed) flareElapsed.textContent = "0s";
      flareElapsedTimer = setInterval(() => {
        if (flareElapsed && flareStartTime) {
          flareElapsed.textContent = formatElapsed(Date.now() - flareStartTime);
        }
      }, 1000);

      const { maintainFlare } = await import("./live-flare");

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
          updateStatus(msg);
        },
        onLog: (msg: string) => {
          if (aborted()) return;
          appendLog(msg);
        },
        onPeerArrived: (): Promise<boolean> => {
          return new Promise<boolean>((resolve) => {
            flarePeerResolve = resolve;
            setFlareUiState("arrived");

            // Tab title notification
            document.title = "someone arrived \u2014 Whisper";

            // Browser notification
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              try {
                new Notification("Signal Flare", {
                  body: "someone found your flare",
                  tag: "whisper-flare",
                });
              } catch { /* noop */ }
            }
          });
        },
      };

      const result = await maintainFlare(
        phrase, offerCode, acceptFn, callbacks, flareAbort.signal,
      );

      if (aborted()) return;

      // Clear flare state before terminal flow
      flareActive = false;
      if (flareElapsedTimer) { clearInterval(flareElapsedTimer); flareElapsedTimer = null; }
      document.title = originalTitle;

      setBusy(true);
      showPhase(opts.connectingSection);
      opts.connectingStatus.textContent = "connecting directly...";
      updateStatus("connecting...");

      if (result.role === "offerer" && result.peerAnswerCode) {
        await session!.applyAnswer(result.peerAnswerCode);
      }
      if (result.role === "answerer" && session && session.state === "connecting") {
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "connecting directly...";
        updateStatus("connecting...");
      }
    } catch (err) {
      flareActive = false;
      extinguishFlare();
      if (aborted()) return;
      if (session) { session.disconnect(); session = null; }
      const raw = errMsg(err);
      if (raw === "Aborted") return;
      appendLog(`flare error: ${raw}`);
      lastErrorWasFlare = true;
      handleStateChange("error", friendlyRelayError(raw));
    } finally {
      flareAbort = null;
    }
  }

  /* ── Event Listeners ───────────────────────────────────── */

  if (modeSwitchBtn) {
    modeSwitchBtn.addEventListener("click", () => {
      if (currentIdleMode === "manual") {
        // "or use relay assist" → relay
        if (manualPhraseInput) opts.phraseInput.value = manualPhraseInput.value;
        applyModeSwitch("relay");
      } else {
        // "or connect manually" → manual
        applyModeSwitch("manual");
      }
    }, { signal });
  }

  if (flareSwitchBtn) {
    flareSwitchBtn.addEventListener("click", () => {
      if (currentIdleMode === "flare") {
        // "or use relay assist" → relay
        if (flarePhraseInput) opts.phraseInput.value = flarePhraseInput.value;
        applyModeSwitch("relay");
      } else {
        // "or fire a signal flare" → flare
        if (flarePhraseInput) flarePhraseInput.value = opts.phraseInput.value;
        applyModeSwitch("flare");
      }
    }, { signal });
  }

  opts.funnelCampfireBtn.addEventListener("click", () => {
    if (!session) {
      window.dispatchEvent(new CustomEvent("whisper-live-funnel", { detail: { mode: "campfire" } }));
      return;
    }
    if (campfireVote.state === "pending-out") {
      campfireVote.cancelLocal();
      session.sendCtrl(CTRL_OP.CAMPFIRE_CANCEL);
      return;
    }
    if (campfireVote.localVoted) return;
    session.sendCtrl(CTRL_OP.CAMPFIRE_VOTE);
    campfireVote.castLocal();
  }, { signal });

  if (opts.relayConnectBtn) {
    opts.relayConnectBtn.addEventListener("click", () => {
      void handleRelayConnect();
    }, { signal });

    opts.relayConnectBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showPhase(opts.chatSection);
      liveSurface?.classList.add("wl-preview");
      updateStatus("");
      setLogActive(false);
      setBusy(false);
      updateControls();
      void deriveFingerprint(getPreviewSeed()).then((emoji) => {
        handleFingerprint(emoji);
        opts.fpChip.classList.add("wl-fp-chip--verified");
      });
      try { opts.chatInput.focus(); } catch { /* noop */ }
    }, { signal });
  }

  opts.phraseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && opts.relayAssistToggle?.checked && !busy) {
      e.preventDefault();
      void handleRelayConnect();
    }
  }, { signal });

  // ── Flare event listeners ──

  if (flareFireBtn) {
    flareFireBtn.addEventListener("click", () => {
      if (!flareActive) void handleFlareConnect();
    }, { signal });
  }

  if (flarePhraseInput) {
    flarePhraseInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !busy && !flareActive) {
        e.preventDefault();
        void handleFlareConnect();
      }
    }, { signal });
  }

  if (flareExtinguishBtn) {
    flareExtinguishBtn.addEventListener("click", () => {
      extinguishFlare();
      if (session) { session.disconnect(); session = null; }
      updateStatus("");
      setLogActive(false);
      setBusy(false);
      updateControls();
    }, { signal });
  }

  if (flareAcceptBtn) {
    flareAcceptBtn.addEventListener("click", () => {
      if (flarePeerResolve) {
        flarePeerResolve(true);
        flarePeerResolve = null;
      }
      document.title = originalTitle;
    }, { signal });
  }

  if (flareIgnoreBtn) {
    flareIgnoreBtn.addEventListener("click", () => {
      if (flarePeerResolve) {
        flarePeerResolve(false);
        flarePeerResolve = null;
      }
      document.title = originalTitle;
      setFlareUiState("burning");
    }, { signal });
  }

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

  // ── Fingerprint chip — click to edit in place ─────────────
  const fpWrap = opts.fpChip.parentElement!;

  opts.fpChip.addEventListener("click", () => {
    opts.fpNicknameInput.value = peerNickname;
    fpWrap.classList.add("wl-fp-wrap--editing");
    opts.fpNicknameInput.focus();
    opts.fpNicknameInput.select();
  }, { signal });

  opts.fpNicknameInput.addEventListener("input", () => {
    applyNickname(opts.fpNicknameInput.value);
  }, { signal });

  const commitEdit = () => {
    fpWrap.classList.remove("wl-fp-wrap--editing");
  };

  opts.fpNicknameInput.addEventListener("blur", commitEdit, { signal });
  opts.fpNicknameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      if (e.key === "Escape") applyNickname(peerNickname); // revert on escape
      opts.fpNicknameInput.blur();
    }
  }, { signal });

  const sendMessage = async () => {
    const text = opts.chatInput.value.trim();
    if (!text) return;
    opts.chatInput.value = "";
    opts.chatInput.focus();
    emitCleared();
    updateControls();
    if (!session) {
      // Preview mode — simulate the full send lifecycle visually.
      // Assign a synthetic negative msgId so the shelf is built for this message.
      const previewMsgId = -(++previewSendId);
      addChatMessage({ type: "text", direction: "self", text, timestamp: Date.now(), msgId: previewMsgId });
      simulateSendEnergy();
      return;
    }
    // Phase 1: encrypt + buffer begins
    sendBeginFill();
    try {
      const msgId = await session.sendText(text);
      sendInFlight(msgId);
    } catch (err) {
      send.phase = "delivered"; send.velocity = -4;
      haptic("send-failed");
      appendLog(`send failed: ${errMsg(err)}`);
      pulseComposeIntent("error", 1100);
    }
  };

  opts.chatSendBtn.addEventListener("click", sendMessage, { signal });
  opts.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    // Preview mode: Shift+Enter simulates a peer message
    if (e.key === "Enter" && e.shiftKey && !session) {
      e.preventDefault();
      const peerText = opts.chatInput.value.trim();
      opts.chatInput.value = "";
      updateControls();
      handlePeerCompose(COMPOSE_ACTIVE);
      if (peerText) {
        setTimeout(() => {
          hidePeerTyping();
          const peerPreviewId = -(++previewSendId);
          addChatMessage({ type: "text", direction: "peer", text: peerText, timestamp: Date.now(), msgId: peerPreviewId });
        }, 800 + Math.random() * 600);
      }
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
  opts.chatInput.addEventListener("input", () => {
    updateControls();
    if (opts.chatInput.value.trim()) emitTyping();
    else emitCleared();
  }, { signal });

  // Toggle 12h/24h on timestamp tap
  opts.chatMessages.addEventListener("click", (e) => {
    const time = (e.target as HTMLElement).closest<HTMLTimeElement>(".wl-msg-time");
    if (!time) return;
    use12h = !use12h;
    localStorage.setItem("wl-time-12h", use12h ? "1" : "0");
    for (const el of opts.chatMessages.querySelectorAll<HTMLTimeElement>(".wl-msg-time")) {
      const ts = Number(el.dateTime);
      if (ts) el.textContent = formatTime(ts);
    }
  }, { signal });

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

  // Mic button: pointer events for click vs hold detection.
  // - Primary button only (button 0) — ignore right-click, pen eraser, etc.
  // - Pointer ID tracking — ignore multi-touch secondary fingers.
  // - setPointerCapture — pointerup always fires on mic even if finger slides off.
  opts.chatMicBtn.addEventListener("pointerdown", (e) => {
    if (opts.chatMicBtn.disabled || e.button !== 0) return;
    if (micPointerId !== -1) return;           // already tracking a pointer
    e.preventDefault();
    micPointerId = e.pointerId;
    opts.chatMicBtn.setPointerCapture(e.pointerId);
    micHoldMode = false;
    micDeferred = null;
    micHoldTimer = setTimeout(() => {
      micHoldMode = true;
      startRecording();
    }, 300);
  }, { signal });

  opts.chatMicBtn.addEventListener("pointerup", (e) => {
    if (e.pointerId !== micPointerId) return;  // not our pointer
    if (micHoldTimer) { clearTimeout(micHoldTimer); micHoldTimer = null; }
    micPointerId = -1;
    if (!micHoldMode) {
      // Short click — start recording (click-to-toggle mode).
      // Split buttons take over once recording is active.
      if (!recordingStream && !micPending) startRecording();
    } else if (recordingStream) {
      // Release after hold — send
      stopRecording();
    } else if (micPending) {
      // Released before getUserMedia resolved — defer send to when stream arrives
      micDeferred = "send";
    }
  }, { signal });

  // pointercancel + lostpointercapture — clean up if capture is lost unexpectedly
  function handlePointerAbort(e: PointerEvent): void {
    if (e.pointerId !== micPointerId) return;
    if (micHoldTimer) { clearTimeout(micHoldTimer); micHoldTimer = null; }
    micPointerId = -1;
    if (micHoldMode) cancelRecording();
  }
  opts.chatMicBtn.addEventListener("pointercancel", handlePointerAbort, { signal });
  opts.chatMicBtn.addEventListener("lostpointercapture", handlePointerAbort, { signal });

  // Suppress context menu on mic button — long-press on touch would otherwise
  // show the browser context menu, fighting the 300ms hold-to-record gesture.
  opts.chatMicBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); }, { signal });

  // Split button handlers
  opts.chatMicCancel.addEventListener("click", () => cancelRecording(), { signal });
  opts.chatMicSend.addEventListener("click", () => stopRecording(), { signal });

  // Escape cancels recording (any mode)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (recordingStream || micPending)) {
      cancelRecording();
    }
  }, { signal });

  opts.chatClearBtn.addEventListener("click", () => {
    if (!session) {
      executeClearHistory();
      return;
    }
    if (clearVote.state === "pending-out") {
      clearVote.cancelLocal();
      session.sendCtrl(CTRL_OP.CLEAR_CANCEL);
      return;
    }
    if (clearVote.localVoted) return;
    session.sendCtrl(CTRL_OP.CLEAR_VOTE);
    clearVote.castLocal();
  }, { signal });

  opts.chatFileInput.addEventListener("change", async () => {
    const file = opts.chatFileInput.files?.[0];
    if (!file || !session) return;
    opts.chatFileInput.value = "";
    sendBeginFill();
    try {
      const msgId = await session.sendFile(file);
      sendInFlight(msgId);
    } catch (err) {
      send.phase = "delivered"; send.velocity = -4;
      appendLog(`file send failed: ${errMsg(err)}`);
      pulseComposeIntent("error", 1100);
    }
  }, { signal });

  opts.chatMessages.addEventListener("dragover", (e) => {
    e.preventDefault();
    opts.chatMessages.classList.add("wl-chat-drop-active");
    syncComposeIntent();
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
    sendBeginFill();
    try {
      const msgId = await session.sendFile(file);
      sendInFlight(msgId);
    } catch (err) {
      send.phase = "delivered"; send.velocity = -4;
      appendLog(`file send failed: ${errMsg(err)}`);
      pulseComposeIntent("error", 1100);
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
    if (lastErrorWasFlare) {
      const savedPhrase = flarePhraseInput?.value ?? "";
      lastErrorWasFlare = false;
      resetToIdle();
      if (flarePhraseInput) flarePhraseInput.value = savedPhrase;
      applyModeSwitch("flare");
    } else if (lastErrorWasRelay) {
      const savedPhrase = opts.phraseInput.value;
      const relayWasOn = opts.relayAssistToggle?.checked ?? false;
      lastErrorWasRelay = false;
      resetToIdle();
      // Restore phrase and relay toggle so user can just hit Connect again
      opts.phraseInput.value = savedPhrase;
      if (relayWasOn && opts.relayAssistToggle) {
        opts.relayAssistToggle.checked = true;
        applyModeSwitch("relay");
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
    if (opts.relayAssistToggle.checked) applyModeSwitch("relay");
  }

  // ?flare=1 switches to flare mode
  if (urlFlag("flare")) {
    applyModeSwitch("flare");
  }

  // ?phrase= prefills the shared phrase inputs
  const urlPhrase = urlParam("phrase");
  if (urlPhrase) {
    opts.phraseInput.value = urlPhrase;
    if (flarePhraseInput) flarePhraseInput.value = urlPhrase;
  }

  // ?auto=1 with ?relay=1 and a phrase → auto-trigger relay connect
  if (urlFlag("auto") && opts.relayAssistToggle?.checked && !urlFlag("flare") && opts.phraseInput.value.trim()) {
    // Slight delay so the UI has rendered before we start connecting
    setTimeout(() => { if (!aborted()) void handleRelayConnect(); }, 100);
  }

  // ?auto=1 with ?flare=1 and a phrase → auto-fire flare
  if (urlFlag("auto") && urlFlag("flare") && flarePhraseInput && flarePhraseInput.value.trim()) {
    setTimeout(() => { if (!aborted()) void handleFlareConnect(); }, 100);
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

  // Close any open reaction shelf when clicking outside the chat messages area
  document.addEventListener("click", (e) => {
    if (opts.chatMessages.contains(e.target as Node)) return;
    const open = opts.chatMessages.querySelector("[data-shelf-open]");
    if (open) open.removeAttribute("data-shelf-open");
  }, { signal });

  /* ── Teardown ───────────────────────────────────────────── */

  return () => {
    ac.abort();
    relayActive = false;
    if (relayAbort) {
      relayAbort.abort();
      relayAbort = null;
    }
    extinguishFlare();
    stopJoinQrScan("teardown");
    if (session) {
      session.disconnect();
      session = null;
    }
    composing = false;
    stopIdleKeepAlive();
    if (typingSendTimer) { clearTimeout(typingSendTimer); typingSendTimer = null; }
    if (peerTypingTimer) { clearTimeout(peerTypingTimer); peerTypingTimer = null; }
    if (composeIntentTimer) { clearTimeout(composeIntentTimer); composeIntentTimer = null; }
    if (composeActivityRaf) { cancelAnimationFrame(composeActivityRaf); composeActivityRaf = 0; }
    cancelRecording();
    stopAllAudio();
    document.title = originalTitle;
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  };
}
