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
import { encodeHarmonic, decodeHarmonic } from "./live-wasm-audio";
import { dcBlock, inverseDcBlock, wavFromPcm } from "./live-audio-dsp";
import {
  CTRL_OP, VOTE_TOPIC, VoteTopic,
  encodeSeenPayload, decodeSeenPayload,
  encodeReactPayload, decodeReactPayload,
  encodeVotePayload, decodeVotePayload,
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
  normalizeReactionGlyph,
  createReactionComposer,
  type ReactionComposer,
} from "./ui-helpers";
import {
  createQrDetector,
  decodeQrTextFromImage,
  getQrCameraConstraints,
  getQrScanIntervalMs,
  getQrScannerCapability,
  renderQrToCanvas,
} from "./seal-qr";
import { unpackLocalSdp } from "./live-qr-sdp";
import { openDrawSurface, consumeDrawPreview } from "./live-draw";
import { type DrawStreamEvent } from "./live-draw-stream";
import { GlyphStreamDecoder, GLYPH_CHANNELS, GLYPH_CHANNEL_NAMES, type GlyphSeed, type GlyphChannelName } from "./live-wasm-glyph";
import {
  runLiveRendezvous,
  trackerErrorCode,
  type TrackerRelayHandle,
} from "./live-tracker";
import {
  exportGwyphToPngBlob,
  gwyphPngName,
  parseGwyphPayload,
  renderGwyphScene,
  isWhisperGlyph,
  GLYPH_MIME,
  type GlyphPayload,
} from "./live-gwyph";

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
  chatMediaBtn: HTMLButtonElement;
  chatMediaPopover: HTMLElement;
  chatMediaFile: HTMLButtonElement;
  chatMediaDraw: HTMLButtonElement;
  chatPasteBtn: HTMLButtonElement;
  chatMicWrap: HTMLElement;
  chatMicBtn: HTMLButtonElement;
  chatMicCancel: HTMLButtonElement;
  chatMicSend: HTMLButtonElement;
  chatMediaClear: HTMLButtonElement;
  chatMediaAlpha: HTMLButtonElement;
  alphaPanel: HTMLElement;
  alphaAudioTrack: HTMLElement;
  alphaAudioFill: HTMLElement;
  alphaAudioThumb: HTMLElement;
  alphaAudioQValue: HTMLElement;
  alphaOrbitPath: SVGPathElement;
  alphaOrbitGlow: SVGPathElement;
  alphaOrbitGhost: SVGPathElement;
  alphaHint: HTMLElement;
  alphaOrbitWrap: HTMLElement;
  alphaReset: HTMLButtonElement;
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

  /* Relay QR flare handoff (optional — resolver won't block if missing) */
  relayQrToggleBtn?: HTMLButtonElement;
  relayQrPanel?: HTMLElement;
  relayQrCanvas?: HTMLCanvasElement;
  relayQrStatus?: HTMLElement;
  relayQrEmber?: HTMLElement;

  /** TURN pool for bond-seeded relay selection. Passed through to WhisperLiveSession. */
  turnPool?: RTCIceServer[];
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
  chatMediaBtn: "wl-chat-media-btn",
  chatMediaPopover: "wl-media-popover",
  chatMediaFile: "wl-media-file",
  chatMediaDraw: "wl-media-draw",
  chatPasteBtn: "wl-chat-paste-btn",
  chatMicWrap: "wl-chat-mic-wrap",
  chatMicBtn: "wl-chat-mic-btn",
  chatMicCancel: "wl-chat-mic-cancel",
  chatMicSend: "wl-chat-mic-send",
  chatMediaClear: "wl-media-clear",
  chatMediaAlpha: "wl-media-alpha",
  alphaPanel: "wl-alpha-panel",
  alphaAudioTrack: "wl-alpha-audio-track",
  alphaAudioFill: "wl-alpha-audio-fill",
  alphaAudioThumb: "wl-alpha-audio-thumb",
  alphaAudioQValue: "wl-alpha-audio-q-value",
  alphaOrbitPath: "wl-alpha-orbit-path",
  alphaOrbitGlow: "wl-alpha-orbit-glow",
  alphaOrbitGhost: "wl-alpha-orbit-ghost",
  alphaHint: "wl-alpha-hint",
  alphaOrbitWrap: "wl-alpha-orbit-wrap",
  alphaReset: "wl-alpha-reset",
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
  relayQrToggleBtn: "wl-relay-qr-toggle",
  relayQrPanel: "wl-relay-qr-panel",
  relayQrCanvas: "wl-relay-qr-canvas",
  relayQrStatus: "wl-relay-qr-status",
  relayQrEmber: "wl-relay-qr-ember",
} as const;

/* ── Helpers ──────────────────────────────────────────────── */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "unknown";
}

type AudioContextCtor = new () => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const view = window as Window & {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const maybeCtor = view.AudioContext ?? view.webkitAudioContext;
  return maybeCtor ?? null;
}

function createAudioContext(): AudioContext | null {
  const Ctor = getAudioContextCtor();
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function canUseShareSheet(): boolean {
  if (typeof navigator.share !== "function") return false;
  if (typeof navigator.canShare !== "function") return true;
  try {
    return navigator.canShare({ text: "whisper" });
  } catch {
    return false;
  }
}

function getQrCapabilityLabel(reason?: string): string {
  switch (reason) {
    case "qr format not supported":
      return "QR camera scan unavailable here";
    case "qr check failed":
      return "QR camera scan could not be verified here";
    case "qr scan not supported":
    default:
      return "QR camera scan unavailable here";
  }
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

/* ── QR flare handoff ────────────────────────────────────────
 * fragment format: #wl:<base64url(phrase)>. the phrase rides in the URL
 * fragment (never sent to a server, never touches the relay) so scanning
 * the QR both forces live mode and hands over the shared phrase in one
 * shot — see whisper.astro's deep-link script for the decode side. */
function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildWlFlareUrl(phrase: string): string {
  return `${window.location.origin}${window.location.pathname}#wl:${base64UrlEncode(phrase)}`;
}

// in-person mode reuses the exact same "scan a url, the site opens with the
// code" mechanism as the flare, but the fragment carries a packed SDP
// (already base64url, url-safe) instead of a phrase. the role (offer/answer)
// is read from the payload itself, so it is one channel, not two.
function buildWlLocalUrl(payload: string): string {
  return `${window.location.origin}${window.location.pathname}#wl-local:${payload}`;
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
    chatFileInput: inp(I.chatFileInput),
    chatMediaBtn: btn(I.chatMediaBtn), chatMediaPopover: el(I.chatMediaPopover),
    chatMediaFile: btn(I.chatMediaFile), chatMediaDraw: btn(I.chatMediaDraw),
    chatPasteBtn: btn(I.chatPasteBtn),
    chatMicWrap: el(I.chatMicWrap),
    chatMicBtn: btn(I.chatMicBtn), chatMicCancel: btn(I.chatMicCancel), chatMicSend: btn(I.chatMicSend),
    chatMediaClear: btn(I.chatMediaClear),
    chatMediaAlpha: btn(I.chatMediaAlpha),
    alphaPanel: el(I.alphaPanel),
    alphaAudioTrack: el(I.alphaAudioTrack),
    alphaAudioFill: el(I.alphaAudioFill),
    alphaAudioThumb: el(I.alphaAudioThumb),
    alphaAudioQValue: el(I.alphaAudioQValue),
    alphaOrbitPath: root.querySelector<SVGPathElement>(`#${I.alphaOrbitPath}`) as SVGPathElement,
    alphaOrbitGlow: root.querySelector<SVGPathElement>(`#${I.alphaOrbitGlow}`) as SVGPathElement,
    alphaOrbitGhost: root.querySelector<SVGPathElement>(`#${I.alphaOrbitGhost}`) as SVGPathElement,
    alphaHint: el(I.alphaHint),
    alphaOrbitWrap: el(I.alphaOrbitWrap),
    alphaReset: btn(I.alphaReset),
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

  // Relay QR flare handoff elements — optional
  const relayQrToggleBtn = btn(I.relayQrToggleBtn);
  const relayQrPanel = el(I.relayQrPanel);
  const relayQrCanvas = root.querySelector<HTMLCanvasElement>(`#${I.relayQrCanvas}`);
  const relayQrStatus = el(I.relayQrStatus);
  const relayQrEmber = el(I.relayQrEmber);

  return {
    ...r,
    ...(relayAssistToggle ? { relayAssistToggle } : {}),
    ...(relayConnectBtn ? { relayConnectBtn } : {}),
    ...(relayQrToggleBtn ? { relayQrToggleBtn } : {}),
    ...(relayQrPanel ? { relayQrPanel } : {}),
    ...(relayQrCanvas ? { relayQrCanvas } : {}),
    ...(relayQrStatus ? { relayQrStatus } : {}),
    ...(relayQrEmber ? { relayQrEmber } : {}),
  } as WhisperLiveUIOptions;
}

/* ── Init ─────────────────────────────────────────────────── */

export function initWhisperLive(opts: WhisperLiveUIOptions): () => void {
  // ── Shared hold-gesture timing ──
  // unifies the scattered 250ms/300ms hold thresholds used across the media
  // popover, action-drag, mic, and paste-hold gestures into one constant.
  const HOLD_SHORT_MS = 280;   // press-and-hold threshold before a gesture "arms"
  const HOLD_CONFIRM_MS = 500; // hold-to-confirm threshold (mic-cancel first arm)
  const DISARM_MS = 2000;      // armed confirm state auto-reverts after this long
  const ICON_SWAP_MS = 110;    // cross-fade duration for toggle icon swaps
  const RAF_SETTLE_MS = 1000;  // compose-activity rAF loop idles out after this long quiet

  const ac = new AbortController();
  const { signal } = ac;
  const liveSurface = document.getElementById("wl-section");
  let session: WhisperLiveSession | null = null;
  let relayHandle: TrackerRelayHandle | null = null;

  // ── E2E badge live connection stats (path + rtt), polled only while connected ──
  const e2eStatsEl = liveSurface?.querySelector<HTMLElement>(".wl-e2e-tip-stats") ?? null;
  const e2eBadgeEl = liveSurface?.querySelector<HTMLElement>(".wl-e2e-badge") ?? null;
  // in-person mode affordances: the connect row carries a data-local flag
  // (drives the purple QR segment) and the hint swaps its copy.
  const relayConnectRow = liveSurface?.querySelector<HTMLElement>(".wl-relay-connect-row") ?? null;
  const relayHint = liveSurface?.querySelector<HTMLElement>(".wl-relay-hint") ?? null;
  const RELAY_HINT_DEFAULT = relayHint?.textContent ?? "";
  let e2eStatsTimer: ReturnType<typeof setInterval> | null = null;

  function stopE2eStatsPoll(): void {
    if (e2eStatsTimer) { clearInterval(e2eStatsTimer); e2eStatsTimer = null; }
    if (e2eStatsEl) e2eStatsEl.textContent = "";
    if (e2eBadgeEl) delete e2eBadgeEl.dataset.path;
  }
  signal.addEventListener("abort", stopE2eStatsPoll, { once: true });

  async function pollE2eStats(): Promise<void> {
    const activeSession = session;
    if (!activeSession || !e2eStatsEl) return;
    const stats = await activeSession.getConnectionStats();
    // session torn down or state moved on while the stats promise was in flight
    if (session !== activeSession || currentLiveState !== "live") return;
    if (!stats.path) {
      e2eStatsEl.textContent = "";
      if (e2eBadgeEl) delete e2eBadgeEl.dataset.path;
      return;
    }
    const rttPart = stats.rttMs != null ? `${stats.rttMs}ms` : "--";
    e2eStatsEl.textContent = `${stats.path} · ${rttPart}`;
    if (e2eBadgeEl) e2eBadgeEl.dataset.path = stats.path;
  }

  function startE2eStatsPoll(): void {
    stopE2eStatsPoll();
    if (!session || !e2eStatsEl) return; // preview mode (no session) never shows stats
    void pollE2eStats();
    e2eStatsTimer = setInterval(() => { void pollE2eStats(); }, 5000);
  }
  const objectUrls = new Set<string>();
  let busy = false;

  // ── Pre-connection gate ──
  let interacted = false;
  {
    const gateAc = new AbortController();
    signal.addEventListener("abort", () => gateAc.abort(), { once: true });
    const onInteract = () => { interacted = true; gateAc.abort(); };
    for (const e of ["mousemove", "keydown", "touchstart", "pointerdown"] as const)
      document.addEventListener(e, onInteract, { signal: gateAc.signal });
  }
  const honeypot = document.getElementById("wl-session-token") as HTMLInputElement | null;

  function passGate(auto = false): boolean {
    return auto || (interacted && !honeypot?.value && !(navigator as any).webdriver);
  }

  let liveQrSupported = false;
  let liveQrUnavailableLabel = "QR camera scan unavailable here";
  let skippedIceCandidates = 0;

  function revokeObjectUrls(): void {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  const liveCapabilities = {
    clipboardRead: typeof navigator.clipboard?.readText === "function",
    shareSheet: canUseShareSheet(),
    qrImageDecode: typeof createImageBitmap === "function",
    audioContext: getAudioContextCtor() !== null,
  };

  let typingSendTimer: ReturnType<typeof setTimeout> | null = null;
  let peerTypingTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Internal clipboard cache ──
  // browsers (firefox) prompt on programmatic clipboard reads. instead we
  // silently capture text from copy/cut/paste events the user triggers
  // naturally, then the paste button injects from our cache — zero prompts.
  // cache holds either text or files, not both — last write wins.
  let clipText = "";
  let clipFiles: File[] = [];
  let pastePending = false;
  let pasteHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let pasteHoldFired = false; // true when hold already sent — swallow the trailing click

  function cacheClipText(text: string | undefined | null): void {
    if (text && text.trim()) { clipText = text.trim(); clipFiles = []; }
  }

  function cacheClipFiles(files: File[]): void {
    if (files.length) { clipFiles = files; clipText = ""; }
  }

  // capture copy/cut — grab selected text
  document.addEventListener("copy", () => cacheClipText(window.getSelection()?.toString()), { signal });
  document.addEventListener("cut", () => cacheClipText(window.getSelection()?.toString()), { signal });

  // capture paste — grab text and/or files
  document.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data) return;
    const files: File[] = [];
    if (data.items) {
      for (const item of data.items) {
        if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f); }
      }
    }
    if (files.length) cacheClipFiles(files);
    else cacheClipText(data.getData("text/plain"));
  }, { signal, capture: true });

  function clearPasteState(): void {
    pastePending = false;
    opts.chatPasteBtn.removeAttribute("data-pasted");
    if (pasteHoldTimer) { clearTimeout(pasteHoldTimer); pasteHoldTimer = null; }
  }

  function enterPastedState(): void {
    pastePending = true;
    opts.chatPasteBtn.setAttribute("data-pasted", "");
    haptic("copied");
  }

  /** inject cached clipboard content into chat. text goes into the input
   *  field, files get sent directly. falls back to readText() when the
   *  cache is empty — chromium allows it silently, firefox prompts once. */
  /** read clipboard via clipboard.read() — returns files and/or text. */
  async function readClipboardItems(): Promise<{ files: File[]; text: string }> {
    const files: File[] = [];
    let text = "";
    const clip = navigator.clipboard;
    if (typeof clip?.read === "function") {
      try {
        const items = await clip.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith("image/") || type === "application/octet-stream") {
              const blob = await item.getType(type);
              const ext = type.split("/")[1] ?? "bin";
              files.push(new File([blob], `clipboard.${ext}`, { type }));
            } else if (type === "text/plain" && !text) {
              const blob = await item.getType(type);
              text = (await blob.text()).trim();
            }
          }
        }
      } catch { /* denied or empty */ }
    }
    // fallback for text if read() didn't yield any
    if (!files.length && !text && typeof clip?.readText === "function") {
      try { text = (await clip.readText()).trim(); } catch { /* denied */ }
    }
    return { files, text };
  }

  async function pasteFromClipboard(): Promise<void> {
    // prefer internal cache
    if (clipFiles.length) {
      sendFilesToChat(clipFiles, "paste");
      return;
    }
    if (clipText) {
      opts.chatInput.focus();
      opts.chatInput.value = clipText;
      updateControls();
      enterPastedState();
      return;
    }

    // no cache — read clipboard directly (prompts once on firefox)
    const { files, text } = await readClipboardItems();
    if (files.length) {
      cacheClipFiles(files);
      sendFilesToChat(files, "paste");
    } else if (text) {
      cacheClipText(text);
      opts.chatInput.focus();
      opts.chatInput.value = text;
      updateControls();
      enterPastedState();
    }
  }

  // ── Edit Mode ──
  let editingMsgId: number | null = null;
  let preEditInputValue = "";
  let preEditPlaceholder = "";

  // ── Alpha menu state ──
  const AUDIO_Q_DEFAULT = 55;
  let audioQuality = AUDIO_Q_DEFAULT;

  // Action Menu SVGs
  const CHEVRON_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 4l4 4-4 4"/></svg>`;
  const CHECK_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 8.5l2.5 2.5 4.5-4.5"/></svg>`;
  const COPY_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="8" height="10" rx="1.5"/><path d="M3 10V3a1 1 0 011-1h7"/></svg>`;
  const EDIT_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5a1.5 1.5 0 012 2L5 13H3v-2l8.5-8.5z"/></svg>`;

  function exitEditMode(optsMode: { restoreDraft?: boolean } = {}): void {
    if (editingMsgId == null) return;
    const { restoreDraft = true } = optsMode;
    haptic("mode-switch");
    const srcEl = msgById.get(editingMsgId);
    srcEl?.querySelector<HTMLElement>(".wl-msg-text")?.classList.remove("wl-msg--editing");

    // Revert the shared action toggle if it was morphed into the edit icon.
    // (actionToggleBtn is the one shared instance — see the reaction-shelf
    // block below — so this no longer needs to look it up per-message.)
    if (actionToggleBtn.classList.contains("wl-toggle--is-editing")) {
      actionToggleBtn.classList.remove("wl-toggle--is-editing");
      actionToggleBtn.classList.add("wl-toggle--swapping");
      setTimeout(() => {
        actionToggleBtn.innerHTML = CHEVRON_SVG;
        actionToggleBtn.classList.remove("wl-toggle--swapping");
      }, ICON_SWAP_MS);
    }

    if (restoreDraft) {
      opts.chatInput.value = preEditInputValue;
      opts.chatInput.placeholder = preEditPlaceholder;
    } else {
      opts.chatInput.value = "";
      opts.chatInput.placeholder = preEditPlaceholder || "whisper something...";
    }
    chatCompose?.removeAttribute("data-editing");
    editingMsgId = null;
    if (!micSupported) opts.chatMicWrap.setAttribute("data-hidden", "");
    updateControls();
  }

  function handleEdit(targetMsgId: number, newText: string): void {
    const el = msgById.get(targetMsgId);
    if (!el) return;
    const textEl = el.querySelector<HTMLElement>(".wl-msg-text");
    if (!textEl) return;
    textEl.textContent = newText;
    if (!el.querySelector(".wl-msg-edited")) {
      const tag = document.createElement("span");
      tag.className = "wl-msg-edited";
      tag.textContent = "· (edited)";
      // the meta row is one derived line: time text, then the edit tag,
      // then the receipt. appending to the message div instead would land
      // the tag under whatever rendered last (reactions included), which
      // reads as clutter, not metadata.
      const timeEl = el.querySelector<HTMLElement>(".wl-msg-time");
      if (timeEl) timeEl.insertBefore(tag, timeEl.querySelector(".wl-msg-receipt"));
      else el.appendChild(tag);
    }
  }

  // Collapse an action container and sync its toggle button's aria-expanded.
  // Used by per-message closures and the global dismiss handlers below. The
  // toggle button lives outside `c` now (it's a row item, not an overlay
  // child — see the fixed-geometry restructure above), so it's reached via
  // the shared shelf ancestor rather than a descendant query.
  const closeActionContainer = (c: HTMLElement) => {
    c.removeAttribute("data-expanded");
    c.setAttribute("aria-hidden", "true");
    c.querySelectorAll<HTMLElement>("button").forEach(b => b.setAttribute("tabindex", "-1"));
    const shelf = c.closest(".wl-react-shelf");
    shelf?.removeAttribute("data-actions-open");
    shelf?.querySelector<HTMLElement>(".wl-action-btn-toggle")?.setAttribute("aria-expanded", "false");
  };

  const allExpanded = () =>
    opts.chatMessages.querySelectorAll<HTMLElement>(".wl-react-action-container[data-expanded]");

  opts.chatMessages.addEventListener("scroll", () => {
    allExpanded().forEach(closeActionContainer);
  }, { passive: true, signal });

  window.addEventListener("pointerdown", (e) => {
    allExpanded().forEach(c => {
      if (c.contains(e.target as Node)) return;
      // the toggle is a sibling of `c`, not a descendant — exempt it too so
      // tapping it to close doesn't get raced by this outside-tap handler.
      if (c.closest(".wl-react-shelf")?.querySelector(".wl-action-btn-toggle") === e.target) return;
      closeActionContainer(c);
    });
  }, { signal });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") allExpanded().forEach(closeActionContainer);
  }, { signal });


  /** Active-typing debounce scaled to current network. Reads live so it adapts
   *  if the connection shifts (e.g. wifi → cellular). */
  function typingSendDebounce(): number {
    return env.constrainedNetwork ? 6_000 : Math.min(6_000, Math.max(3_000, env.rtt * 4));
  }

  // ── Clear-history (voted operation) ─────────────────────────

  function executeClearHistory(): void {
    // Scope to real message elements — the container also permanently hosts
    // the shared reaction shelf (see below), which isn't a message.
    const msgs = Array.from(opts.chatMessages.querySelectorAll<HTMLElement>(":scope > .wl-msg"));
    if (msgs.length === 0) {
      updateControls();
      return;
    }
    haptic("clear-history");
    if (editingMsgId != null) exitEditMode();
    stopAllAudio();
    closeReactionShelf();
    msgs.forEach((el, i) => el.style.setProperty("--msg-idx", String(Math.min(i, 10))));
    opts.chatMessages.dataset.clearing = "1";
    setTimeout(() => {
      delete opts.chatMessages.dataset.clearing;
      // full teardown of chat state, not just the DOM — same helper the
      // terminal-session paths use, so clearing history never leaves stale
      // msgById/transferCards/object-URL entries behind.
      clearChatArtifacts();
      updateControls();
    }, 320);
  }

  const clearVote = new VoteTopic({
    timeoutMs: 60_000,
    onExecute: executeClearHistory,
    onState: (state) => {
      opts.chatMediaClear.dataset.clearState = state;
      // Show notification dot on media btn when peer requested clear
      if (state === "pending-in") opts.chatMediaBtn.dataset.notify = "";
      else delete opts.chatMediaBtn.dataset.notify;
      updateControls();
    },
  });

  const CF_BTN_LABELS: Record<string, string> = {
    idle: '<span class="cf-btn-verbose">start a </span>campfire',
    "pending-out": '<span class="cf-btn-verbose">campfire </span>vote sent',
    "pending-in": 'campfire invite<span class="cf-btn-verbose"> — press to accept</span>',
  };

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
      opts.funnelCampfireBtn.innerHTML = CF_BTN_LABELS[state] ?? CF_BTN_LABELS.idle;
      updateControls();
    },
  });

  // ── Ctrl dispatch ─────────────────────────────────────────
  // Route inbound ctrl frames to the right handler.
  // Adding a new voted feature = new VoteTopic + two lines here.

  function handleCtrl(opcode: number, payload: Uint8Array): void {
    switch (opcode) {
      case CTRL_OP.VOTE: {
        const vote = decodeVotePayload(payload);
        if (!vote) break;
        if (vote.topic === VOTE_TOPIC.CLEAR) clearVote.receivePeer(vote.round);
        else if (vote.topic === VOTE_TOPIC.CAMPFIRE) campfireVote.receivePeer(vote.round);
        break;
      }
      case CTRL_OP.CANCEL: {
        const vote = decodeVotePayload(payload);
        if (!vote) break;
        if (vote.topic === VOTE_TOPIC.CLEAR) clearVote.receivePeerCancel(vote.round);
        else if (vote.topic === VOTE_TOPIC.CAMPFIRE) campfireVote.receivePeerCancel(vote.round);
        break;
      }
      case CTRL_OP.SEEN: {
        const msgId = decodeSeenPayload(payload);
        if (msgId !== null) markSeen(msgId);
        break;
      }
      case CTRL_OP.REACT: {
        const r = decodeReactPayload(payload);
        if (r) { applyReaction(r.msgId, r.emoji, "peer"); haptic("reaction"); }
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
    if (shelfTarget?.msgId === msgId) updateShelfCaption();
  }

  /** Max distinct emoji reactions tracked per message. Keeps the UI elegant. */
  const MAX_REACTIONS = 5;

  /* ── Shared reaction shelf ───────────────────────────────────────
   * ONE shelf for the whole chat, instead of one per message. It's an
   * absolutely-positioned child of #wl-chat-messages (which is therefore
   * position:relative — see WhisperLiveChat.astro), anchored via inline
   * top/left to whichever bubble was last tapped. Being out of flow means
   * opening it never pushes later messages down and needs neither negative
   * margins nor an overflow-x scroll hack — it scrolls with the message
   * list for free, since it's a normal child of the scrolling element.
   *
   * Fixed geometry: the shelf's outer box is measured once at open (see
   * positionReactionShelf) and never resizes again while open. The button
   * row never wraps (flex-wrap: nowrap) and neither the ⋮ actions nor the
   * mark composer grow it — both open as absolutely-positioned overlays
   * that sit on top of the row instead of pushing it wider. Nothing the
   * user is about to tap may move underneath them.
   */
  interface ShelfTarget {
    msgId: number;
    msgEl: HTMLElement;
    bubbleEl: HTMLElement;
    msgText: string | null; // trimmed bubble text; null hides the action container
    isSelfMsg: boolean;
  }
  let shelfTarget: ShelfTarget | null = null;

  const SHELF_GAP = 6; // px between the bubble edge and the shelf

  const reactionShelf = document.createElement("div");
  reactionShelf.className = "wl-react-shelf";
  reactionShelf.setAttribute("role", "toolbar");
  reactionShelf.setAttribute("aria-label", "React");
  opts.chatMessages.appendChild(reactionShelf);

  // the single fixed-height row: quick-picks, the mark button, the ⋮ toggle.
  // position:relative so the action/composer overlays below can lay
  // themselves over it exactly (inset: 0) without ever affecting its size.
  const shelfRow = document.createElement("div");
  shelfRow.className = "wl-shelf-row";
  reactionShelf.appendChild(shelfRow);

  // quick-pick emoji buttons live in their own wrapper so they can dim as a
  // unit while an overlay is open, independent of the mark/⋮ buttons beside them.
  const quickPicksWrap = document.createElement("div");
  quickPicksWrap.className = "wl-shelf-quickpicks";
  shelfRow.appendChild(quickPicksWrap);

  const reactionComposer: ReactionComposer = createReactionComposer({
    host: reactionShelf,
    signal,
    onCommit: (glyph) => {
      // Composer is a single shared instance — route to whatever the shelf
      // is currently anchored to instead of a message baked in at build time.
      if (!shelfTarget) return;
      toggleSelfReaction(shelfTarget.msgId, glyph);
      rememberReaction(glyph);
      closeReactionShelf();
    },
  });
  // the mark button stays put in the row; its expanding input field is
  // relocated into an overlay further down (composerOverlay) so opening it
  // never grows the row. composer.element (their original shared wrap) is
  // deliberately left unattached — only its two children get mounted, each
  // in its own home. commit/reset/open logic in ui-helpers is untouched.
  shelfRow.appendChild(reactionComposer.button);

  // ── Shared action menu (⋮ → Copy / Edit) ────────────────────────
  // Built once, retargeted on open via configureActionContainer(). Only
  // shown for messages with text; edit only for own text messages.
  // wl-react-action-container is the functional/query class (existing
  // collapse plumbing below matches on it); wl-shelf-overlay is the visual
  // treatment shared with the mark composer's overlay.
  const actionContainer = document.createElement("div");
  actionContainer.className = "wl-react-action-container wl-shelf-overlay wl-shelf-overlay--actions";
  actionContainer.style.display = "none";
  actionContainer.setAttribute("aria-hidden", "true");
  shelfRow.appendChild(actionContainer);

  // the mark composer's expanding field is relocated here — full row width,
  // transform+opacity only, same overlay pattern as the actions panel above.
  const composerOverlay = document.createElement("div");
  composerOverlay.className = "wl-shelf-overlay wl-shelf-overlay--mark";
  composerOverlay.setAttribute("aria-hidden", "true");
  composerOverlay.appendChild(reactionComposer.field);
  // the composer auto-commits on a single glyph, so the drawer needs no
  // confirm — what it needs is an intuitive way back out. same circle
  // anatomy, back semantics. plain click: a back action has no blur to
  // race, and click is the one activation ios safari always delivers.
  const markBackBtn = document.createElement("button");
  markBackBtn.type = "button";
  markBackBtn.className = "wl-react-custom-commit";
  markBackBtn.textContent = "‹";
  markBackBtn.setAttribute("aria-label", "close the mark editor");
  markBackBtn.addEventListener("click", (e) => { e.stopPropagation(); reactionComposer.reset(); }, { signal });
  reactionComposer.field.appendChild(markBackBtn);
  reactionComposer.field.querySelector("input")?.setAttribute("tabindex", "-1");
  shelfRow.appendChild(composerOverlay);

  // sync the composer overlay's a11y/focus state to ui-helpers' own
  // data-glyph-open attribute (set by its internal open()/reset()) without
  // touching that commit/reset/open logic — the attribute is the only hook
  // available from the outside.
  const composerA11yObserver = new MutationObserver(() => {
    const isOpen = reactionShelf.hasAttribute("data-glyph-open");
    composerOverlay.setAttribute("aria-hidden", isOpen ? "false" : "true");
    const input = reactionComposer.field.querySelector<HTMLInputElement>("input");
    if (input) {
      if (isOpen) input.removeAttribute("tabindex");
      else input.setAttribute("tabindex", "-1");
    }
  });
  composerA11yObserver.observe(reactionShelf, { attributes: true, attributeFilter: ["data-glyph-open"] });
  signal.addEventListener("abort", () => composerA11yObserver.disconnect(), { once: true });

  // presence row — the reactions already on this message, shown between the
  // pick row and the status caption. reads left to right as "who is already
  // here", each glyph tinted by whether it is yours; tapping one toggles it.
  // empty (and zero-height) until a message with reactions opens the shelf.
  const shelfReactions = document.createElement("div");
  shelfReactions.className = "wl-shelf-reactions";
  reactionShelf.appendChild(shelfReactions);

  // slim status caption — always present while the shelf is open, part of
  // the geometry measured once at open time. Never appears/disappears on
  // its own; see updateShelfCaption().
  const shelfCaption = document.createElement("div");
  shelfCaption.className = "wl-shelf-caption";
  reactionShelf.appendChild(shelfCaption);

  let actionCollapseTimer: ReturnType<typeof setTimeout> | null = null;
  let actionCopyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  let actionHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let actionDragAborter: AbortController | null = null;
  let actionActivePointerId = -1;
  let actionWasHandledByDrag = false;

  const cancelActionHoldTimer = () => {
    if (actionHoldTimer) { clearTimeout(actionHoldTimer); actionHoldTimer = null; }
  };

  signal.addEventListener("abort", () => {
    if (actionCollapseTimer) { clearTimeout(actionCollapseTimer); actionCollapseTimer = null; }
    if (actionCopyFeedbackTimer) { clearTimeout(actionCopyFeedbackTimer); actionCopyFeedbackTimer = null; }
    cancelActionHoldTimer();
    actionDragAborter?.abort();
    actionDragAborter = null;
  }, { once: true });

  const scheduleActionCollapse = (ms = 5000) => {
    if (actionCollapseTimer) clearTimeout(actionCollapseTimer);
    actionCollapseTimer = setTimeout(() => {
      closeActionContainer(actionContainer);
      actionCollapseTimer = null;
    }, ms);
  };

  const cancelActionCollapse = () => {
    if (actionCollapseTimer) { clearTimeout(actionCollapseTimer); actionCollapseTimer = null; }
  };

  const collapseActions = () => {
    cancelActionCollapse();
    closeActionContainer(actionContainer);
  };

  const actionToggleBtn = document.createElement("button");
  actionToggleBtn.type = "button";
  actionToggleBtn.className = "wl-react-btn wl-action-btn-toggle";
  actionToggleBtn.setAttribute("aria-label", "Message actions");
  actionToggleBtn.setAttribute("aria-expanded", "false");
  actionToggleBtn.innerHTML = CHEVRON_SVG;

  const expandActions = () => {
    // mutual exclusion: the actions panel and the mark composer are both
    // full-row overlays — only one may be visible at a time.
    reactionComposer.reset();
    actionContainer.setAttribute("data-expanded", "");
    actionContainer.setAttribute("aria-hidden", "false");
    actionContainer.querySelectorAll<HTMLElement>("button").forEach(b => b.removeAttribute("tabindex"));
    actionToggleBtn.setAttribute("aria-expanded", "true");
    reactionShelf.setAttribute("data-actions-open", "");
    scheduleActionCollapse();
  };

  // Pause the auto-collapse timer while the pointer is inside the container
  actionContainer.addEventListener("pointerenter", cancelActionCollapse, { signal });
  actionContainer.addEventListener("pointerleave", () => {
    if (actionContainer.hasAttribute("data-expanded")) scheduleActionCollapse(3000);
  }, { signal });

  const handleActionPointerAbort = (e: PointerEvent) => {
    if (e.pointerId !== actionActivePointerId) return;
    cancelActionHoldTimer();
    actionActivePointerId = -1;
    if (actionDragAborter) { actionDragAborter.abort(); actionDragAborter = null; }
  };

  actionToggleBtn.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0 || actionActivePointerId !== -1) return;
    e.preventDefault();
    e.stopPropagation();

    actionActivePointerId = e.pointerId;
    try { actionToggleBtn.setPointerCapture(e.pointerId); } catch { }

    let isDragging = false;
    actionWasHandledByDrag = false;

    if (actionDragAborter) actionDragAborter.abort();
    actionDragAborter = new AbortController();
    const dragSignal = actionDragAborter.signal;

    let dragTarget: HTMLElement | null = null;

    actionHoldTimer = setTimeout(() => {
      isDragging = true;
      if (!actionContainer.hasAttribute("data-expanded")) expandActions();
      haptic("reaction");
      try {
        if (actionToggleBtn.hasPointerCapture(actionActivePointerId)) {
          actionToggleBtn.releasePointerCapture(actionActivePointerId);
        }
      } catch { }
    }, HOLD_SHORT_MS);

    window.addEventListener("pointermove", (mvE: PointerEvent) => {
      if (!isDragging) return;
      actionWasHandledByDrag = true;

      const el = document.elementFromPoint(mvE.clientX, mvE.clientY);
      const btn = el?.closest(".wl-action-split") as HTMLElement | null;

      if (dragTarget !== btn) {
        dragTarget?.classList.remove("wl-action--drag-hover");
        if (btn) {
          btn.classList.add("wl-action--drag-hover");
          haptic("reaction");
        }
        dragTarget = btn;
      }
    }, { signal: dragSignal });

    const finishDrag = (upE: PointerEvent) => {
      if (upE.pointerId !== actionActivePointerId) return;
      cancelActionHoldTimer();
      actionActivePointerId = -1;
      actionDragAborter?.abort();
      actionDragAborter = null;

      if (dragTarget) {
        dragTarget.classList.remove("wl-action--drag-hover");
        if (isDragging) dragTarget.click();
      } else if (isDragging) {
        collapseActions();
      } else {
        // a quick tap. this pointerdown called preventDefault (needed for the
        // press-and-drag gesture), and ios safari refuses to synthesize the
        // compatibility click after a prevented pointerdown, so the click
        // handler below never runs on touch. handle the toggle here and mark
        // it handled so the desktop click (which does fire) doesn't double it.
        actionWasHandledByDrag = true;
        if (actionContainer.hasAttribute("data-expanded")) collapseActions();
        else expandActions();
      }
    };

    window.addEventListener("pointerup", finishDrag, { signal: dragSignal });
    window.addEventListener("pointercancel", handleActionPointerAbort, { signal: dragSignal });
    actionToggleBtn.addEventListener("lostpointercapture", handleActionPointerAbort, { signal: dragSignal });
  }, { signal });

  actionToggleBtn.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    if (actionWasHandledByDrag) {
      actionWasHandledByDrag = false;
      return;
    }
    if (actionContainer.hasAttribute("data-expanded")) {
      collapseActions();
    } else {
      expandActions();
    }
  }, { signal });

  // Cross-fade SVG icon swap: fade out → swap innerHTML → fade back in
  const swapToggleIcon = (newHtml: string) => {
    actionToggleBtn.classList.add("wl-toggle--swapping");
    setTimeout(() => {
      actionToggleBtn.innerHTML = newHtml;
      actionToggleBtn.classList.remove("wl-toggle--swapping");
    }, ICON_SWAP_MS);
  };

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "wl-action-split wl-action-copy-btn";
  copyBtn.setAttribute("aria-label", "Copy message");
  copyBtn.setAttribute("tabindex", "-1"); // not reachable until the overlay opens — see expandActions/closeActionContainer
  copyBtn.innerHTML = COPY_SVG;

  copyBtn.addEventListener("click", async (e: MouseEvent) => {
    e.stopPropagation();
    if (signal.aborted || !shelfTarget?.msgText) return;
    cancelActionCollapse();

    if (actionCopyFeedbackTimer) { clearTimeout(actionCopyFeedbackTimer); actionCopyFeedbackTimer = null; }

    try {
      await copyToClipboard(shelfTarget.msgText);
      haptic("copied");

      collapseActions();
      actionToggleBtn.dataset.copied = "";
      swapToggleIcon(CHECK_SVG);

      actionCopyFeedbackTimer = setTimeout(() => {
        delete actionToggleBtn.dataset.copied;
        swapToggleIcon(CHEVRON_SVG);
        actionCopyFeedbackTimer = null;
      }, 1800);
    } catch {
      collapseActions();
    }
  }, { signal });

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "wl-action-split wl-action-edit-btn";
  editBtn.setAttribute("aria-label", "Edit message");
  editBtn.setAttribute("tabindex", "-1"); // not reachable until the overlay opens — see expandActions/closeActionContainer
  editBtn.innerHTML = EDIT_SVG;

  editBtn.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    if (signal.aborted || !shelfTarget) return;
    const { msgId, msgText } = shelfTarget;
    closeReactionShelf();
    haptic("reaction");

    if (editingMsgId != null) exitEditMode();

    emitCleared();
    preEditInputValue = opts.chatInput.value;
    preEditPlaceholder = opts.chatInput.placeholder;
    editingMsgId = msgId;
    // the mic wrap is hidden entirely when mic capture isn't supported, but it's
    // also the edit-cancel (X) affordance in edit mode — force it visible for the
    // duration of the edit so there's still a way to back out.
    if (!micSupported) opts.chatMicWrap.removeAttribute("data-hidden");

    const srcEl = msgById.get(msgId);
    const targetText = srcEl
      ?.querySelector<HTMLElement>(".wl-msg-text")
      ?.textContent
      ?? msgText
      ?? "";

    opts.chatInput.value = targetText;
    opts.chatInput.placeholder = "editing...";
    opts.chatInput.closest(".wl-chat-compose")?.setAttribute("data-editing", "1");
    srcEl?.querySelector<HTMLElement>(".wl-msg-text")?.classList.add("wl-msg--editing");

    // Morph the toggle button into the edit icon!
    actionToggleBtn.classList.add("wl-toggle--is-editing");
    swapToggleIcon(EDIT_SVG);

    updateControls();
    opts.chatInput.focus();
  }, { signal });

  // actionContainer + composerOverlay were already mounted into shelfRow
  // above (fixed geometry is established before either overlay's contents
  // exist). copyBtn joins the overlay; the toggle is a row item in its own
  // right, not an overlay child, so it stays visible and clickable while
  // the overlay animates on top of the rest of the row.
  actionContainer.appendChild(copyBtn);
  shelfRow.appendChild(actionToggleBtn);

  // mutual exclusion, the other direction: opening the mark composer
  // collapses the actions panel if it happens to be open. (expandActions()
  // above already resets the composer when actions open.)
  reactionComposer.button.addEventListener("click", () => {
    if (actionContainer.hasAttribute("data-expanded")) collapseActions();
  }, { signal });

  /** Retarget the shared action container to the message about to be shown. */
  function configureActionContainer(msgText: string | null, isSelfMsg: boolean): void {
    collapseActions();
    delete actionToggleBtn.dataset.copied;
    actionToggleBtn.classList.remove("wl-toggle--is-editing");
    actionToggleBtn.innerHTML = CHEVRON_SVG;
    if (actionCopyFeedbackTimer) { clearTimeout(actionCopyFeedbackTimer); actionCopyFeedbackTimer = null; }

    // the toggle is a row item now, independent of the overlay it drives —
    // hide it alongside the overlay when there's nothing to act on.
    actionToggleBtn.style.display = msgText ? "" : "none";
    actionContainer.style.display = msgText ? "" : "none";
    if (isSelfMsg) delete actionContainer.dataset.copyOnly;
    else actionContainer.dataset.copyOnly = "";

    if (isSelfMsg) {
      if (editBtn.parentElement !== actionContainer) actionContainer.appendChild(editBtn);
    } else {
      editBtn.remove();
    }
  }

  /** Quick-pick count derived from the space the row actually has, not a
   *  viewport breakpoint. mirrors the shelf css: max-width min(88vw, 22rem),
   *  buttons 1.85rem, gap 0.22rem, mark + toggle reserved, plus padding.
   *  clamped 3..6 so the row is never empty and never crowds. */
  function quickPickLimit(): number {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const shelfMax = Math.min(0.88 * window.innerWidth, 22 * rem);
    const btn = 1.85 * rem;
    const gap = 0.22 * rem;
    const reserved = 2 * (btn + gap) + 0.9 * rem; // mark + toggle + shelf padding
    return Math.max(3, Math.min(6, Math.floor((shelfMax - reserved) / (btn + gap))));
  }

  /** recently used marks, most recent first, deduped, capped. committed
   *  custom glyphs earn one-tap seats in the row instead of vanishing. */
  function recentReactions(): string[] {
    try {
      const raw = localStorage.getItem("wl-recent-reactions");
      if (raw) return (JSON.parse(raw) as string[]).filter((g) => typeof g === "string" && g);
    } catch { /* fall through to legacy */ }
    const legacy = localStorage.getItem("wl-last-reaction");
    return legacy ? [legacy] : [];
  }

  function rememberReaction(glyph: string): void {
    const next = [glyph, ...recentReactions().filter((g) => g !== glyph)].slice(0, 4);
    localStorage.setItem("wl-recent-reactions", JSON.stringify(next));
  }

  /** Rebuild the quick-pick emoji buttons for the message about to be shown.
   *  Cheap enough to redo per-open now that there's only ever one shelf. */
  function rebuildQuickPicks(msgId: number): void {
    while (quickPicksWrap.firstChild) quickPicksWrap.removeChild(quickPicksWrap.firstChild);
    const predefined = ["👍", "👎", "❤️", "😂"];
    for (const raw of recentReactions()) {
      const glyph = normalizeReactionGlyph(raw);
      if (glyph && !predefined.includes(glyph)) predefined.push(glyph);
    }

    const picks = predefined.slice(0, quickPickLimit());

    picks.forEach((emoji) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wl-react-btn";
      btn.textContent = emoji;
      btn.setAttribute("aria-label", `React with ${emoji}`);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSelfReaction(msgId, emoji);
        rememberReaction(emoji);
        closeReactionShelf();
      }, { signal });
      quickPicksWrap.appendChild(btn);
    });
  }

  /** Position the shared shelf against `bubbleEl`, flipping above it when
   *  the bubble sits in the bottom quarter of the visible scroll viewport. */
  function positionReactionShelf(msgEl: HTMLElement, bubbleEl: HTMLElement): void {
    const container = opts.chatMessages;
    const isSelf = msgEl.classList.contains("wl-msg--self");

    // the shelf always opens under the message. that placement is the
    // product: tactile, predictable, the same spot every time. when the
    // bubble is the last message, the shelf extends the scroll overflow
    // and a nudge below reveals it, exactly like the old in-flow strip.
    // rect math against the container, converted into content space via
    // scrollTop: message wrappers are positioned elements themselves, so
    // offsetTop chains stop at .wl-msg and cannot be trusted here. the
    // shelf is a child of the scroll content, so it scrolls for free.
    const shelfH = reactionShelf.offsetHeight;
    const shelfW = reactionShelf.offsetWidth;
    const c = container.getBoundingClientRect();
    const b = bubbleEl.getBoundingClientRect();
    const top = b.bottom - c.top + container.scrollTop + SHELF_GAP;

    const cs = getComputedStyle(container);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    let left = isSelf
      ? b.right - c.left - shelfW
      : b.left - c.left;
    const maxLeft = container.clientWidth - shelfW - padRight;
    left = Math.max(padLeft, Math.min(left, maxLeft));

    reactionShelf.style.top = `${top}px`;
    reactionShelf.style.left = `${left}px`;
    reactionShelf.style.transformOrigin = `top ${isSelf ? "right" : "left"}`;

    // reveal the shelf when it opens past the visible bottom edge. instant,
    // not smooth: the shelf's own entrance is the animation, and easing the
    // viewport underneath it reads as lag on the newest message (the most
    // common reaction target). fenced so the pin listener never mistakes
    // this correction for the user scrolling.
    const shelfBottom = top + shelfH + SHELF_GAP;
    const visibleBottom = container.scrollTop + container.clientHeight;
    if (shelfBottom > visibleBottom) {
      programmaticScrollUntil = performance.now() + 180;
      container.scrollTo({
        top: shelfBottom - container.clientHeight,
        behavior: "auto",
      });
    }
  }

  /** Close the shelf (no-op if nothing is open) and drop the target refs. */
  function closeReactionShelf(): void {
    if (shelfTarget) {
      shelfTarget.msgEl.removeAttribute("data-shelf-open");
      shelfTarget = null;
    }
    reactionComposer.reset();
    collapseActions();
    reactionShelf.classList.remove("wl-react-shelf--open");
  }

  /** Format `bytes` the way the shelf caption wants it: lowercase, one
   *  decimal for kb/mb (e.g. "184 b", "2.1 kb", "4.0 mb") — reuses
   *  formatSize's thresholds/rounding, just cased down. */
  function formatShelfBytes(bytes: number): string {
    return formatSize(bytes).toLowerCase();
  }

  /** Derive the caption text for the currently open shelf target. Self
   *  messages report their own send/delivery lifecycle; peer messages just
   *  confirm receipt. Byte count comes from div.dataset.wlBytes, set once
   *  in addChatMessage(). */
  function formatShelfCaption(target: ShelfTarget): string {
    const bytes = Number(target.msgEl.dataset.wlBytes) || 0;
    const sizeStr = formatShelfBytes(bytes);
    if (!target.isSelfMsg) return `${sizeStr} · received`;

    let state: string;
    if (send.acks.has(target.msgId)) state = "sending";
    else if (target.msgEl.classList.contains("wl-msg--seen")) state = "seen";
    else if (target.msgEl.classList.contains("wl-msg--delivered")) state = "delivered · unseen";
    else state = "sent";
    return `${sizeStr} · ${state}`;
  }

  /** Refresh the caption in place. Called on open, and again from the ack/
   *  seen handlers below so a shelf left open through a state change
   *  (sending → delivered → seen) doesn't go stale. No MutationObserver —
   *  handleAck() and markSeen() are the only two places those classes ever
   *  change, so hooking them directly is cheaper and simpler. */
  function updateShelfCaption(): void {
    if (!shelfTarget) return;
    shelfCaption.textContent = formatShelfCaption(shelfTarget);
  }

  // mirror the target message's reactions into the shelf's presence row: one
  // compact chip per emoji, tinted for who reacted, a count when more than
  // one. tapping toggles yours — the same gesture as the pills below, but
  // reachable without dismissing the shelf.
  function updateShelfReactions(): void {
    shelfReactions.replaceChildren();
    if (!shelfTarget) return;
    const pills = shelfTarget.msgEl.querySelectorAll<HTMLElement>(".wl-msg-reactions .wl-reaction");
    for (const src of pills) {
      const emoji = src.dataset.emoji ?? "";
      if (!emoji) continue;
      const hasSelf = src.dataset.self === "1";
      const hasPeer = src.dataset.peer === "1";
      const n = (hasSelf ? 1 : 0) + (hasPeer ? 1 : 0);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "wl-shelf-react-chip";
      chip.classList.toggle("wl-shelf-react-chip--self", hasSelf);
      chip.classList.toggle("wl-shelf-react-chip--peer", hasPeer);
      const g = document.createElement("span");
      g.className = "wl-reaction-glyph";
      g.textContent = emoji;
      chip.appendChild(g);
      if (n > 1) {
        const c = document.createElement("span");
        c.className = "wl-shelf-react-n";
        c.textContent = String(n);
        chip.appendChild(c);
      }
      const targetId = shelfTarget.msgId;
      chip.addEventListener("click", (e) => { e.stopPropagation(); toggleSelfReaction(targetId, emoji); });
      shelfReactions.appendChild(chip);
    }
    reactionShelf.classList.toggle("wl-react-shelf--has-reactions", shelfReactions.childElementCount > 0);
  }

  /** Open the shelf for `msgEl`, anchored to `bubbleEl`. */
  function openReactionShelf(msgEl: HTMLElement, bubbleEl: HTMLElement): void {
    const msgIdRaw = msgEl.dataset.msgId;
    if (msgIdRaw === undefined) return;
    const msgId = Number(msgIdRaw);

    if (shelfTarget && shelfTarget.msgEl !== msgEl) {
      shelfTarget.msgEl.removeAttribute("data-shelf-open");
    }
    reactionComposer.reset();

    const msgText = bubbleEl.classList.contains("wl-msg-text")
      ? (bubbleEl.textContent?.trim() || null)
      : null;
    const isSelfMsg = msgEl.classList.contains("wl-msg--self");

    rebuildQuickPicks(msgId);
    configureActionContainer(msgText, isSelfMsg);

    shelfTarget = { msgId, msgEl, bubbleEl, msgText, isSelfMsg };
    updateShelfCaption();
    updateShelfReactions();
    positionReactionShelf(msgEl, bubbleEl);

    msgEl.setAttribute("data-shelf-open", "");
    reactionShelf.classList.add("wl-react-shelf--open");
  }

  /** Brief shake/dim pulse on the shelf when a reaction is rejected (cap reached). */
  function pulseReactionShelfCap(): void {
    reactionShelf.classList.remove("wl-react-shelf--capped");
    void reactionShelf.offsetWidth;
    reactionShelf.classList.add("wl-react-shelf--capped");
  }

  // Content reflow (image loads, waveform reveal, etc.) can shift a
  // message's offsetTop after the shelf has already been positioned against
  // it. Rather than chase every possible reflow source, close the shelf
  // whenever the container's own box resizes — #wl-chat-messages hugs its
  // content up to its max-height clamp, so this also catches most in-flow
  // reflows for free, plus viewport/breakpoint changes (the clamp is vw-
  // based). Once scrolling kicks in (container pinned at max-height),
  // further content-only reflow won't retrigger this — accepted as a small,
  // self-healing gap: the shelf just closes a beat early on the next tap.
  const shelfReflowObserver = new ResizeObserver(() => {
    if (shelfTarget) closeReactionShelf();
  });
  shelfReflowObserver.observe(opts.chatMessages);
  signal.addEventListener("abort", () => shelfReflowObserver.disconnect(), { once: true });

  function isTransientDrawPreviewMessage(el: HTMLElement | null | undefined): boolean {
    if (!el) return false;
    if (el.classList.contains("wl-msg--peer-draw-live")) return true;
    if (el.dataset.drawState && el.dataset.drawState !== "sent") return true;
    const drawCard = el.querySelector<HTMLElement>(".wl-msg-peer-draw");
    if (!drawCard) return false;
    // Stream preview is thumb-only; finalized draw cards include a media info bar.
    return !drawCard.querySelector(".wl-media-info");
  }

  function applyReaction(msgId: number, emoji: string, who: "self" | "peer"): void {
    const el = msgById.get(msgId);
    if (!el || !emoji || isTransientDrawPreviewMessage(el)) return;
    const normEmoji = normalizeReactionGlyph(emoji);
    if (!normEmoji) return;
    let bar = el.querySelector<HTMLElement>(".wl-msg-reactions");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "wl-msg-reactions";
      // reactions belong between the bubble and the time/edited row, not after
      // it — the metadata is always the last line under a message.
      const timeEl = el.querySelector<HTMLElement>(".wl-msg-time");
      if (timeEl) el.insertBefore(bar, timeEl);
      else el.appendChild(bar);
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
      // glyph and count live in their own spans so the count can appear and
      // vanish without disturbing the emoji.
      const glyph = document.createElement("span");
      glyph.className = "wl-reaction-glyph";
      glyph.textContent = normEmoji;
      const count = document.createElement("span");
      count.className = "wl-reaction-count";
      count.setAttribute("aria-hidden", "true");
      pill.append(glyph, count);
      pill.addEventListener("click", () => toggleSelfReaction(msgId, normEmoji));
      bar.appendChild(pill);
      // Remove entering class after animation completes so it's reusable
      pill.addEventListener("animationend", () => pill!.classList.remove("wl-reaction--entering"), { once: true });
    }
    pill.dataset[who] = "1";
    updateReactionPill(pill);
    if (shelfTarget?.msgId === msgId) updateShelfReactions();
  }

  function removeReaction(msgId: number, emoji: string, who: "self" | "peer"): void {
    const el = msgById.get(msgId);
    if (!el || isTransientDrawPreviewMessage(el)) return;
    const normEmoji = normalizeReactionGlyph(emoji);
    if (!normEmoji) return;
    const pill = el.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(normEmoji)}"]`);
    if (!pill) return;
    pill.dataset[who] = "0";
    updateReactionPill(pill);
    if (pill.dataset.self === "0" && pill.dataset.peer === "0") pill.remove();
    const bar = el.querySelector(".wl-msg-reactions");
    if (bar && !bar.hasChildNodes()) bar.remove();
    if (shelfTarget?.msgId === msgId) updateShelfReactions();
  }

  function updateReactionPill(pill: HTMLElement): void {
    const hasSelf = pill.dataset.self === "1";
    const hasPeer = pill.dataset.peer === "1";
    pill.classList.toggle("wl-reaction--self", hasSelf);
    pill.classList.toggle("wl-reaction--peer", hasPeer);
    // count = distinct reactors. for 1:1 that is you + them (up to 2); the
    // number only shows once more than one person has reacted, so a single
    // reaction stays a clean glyph. the self ring says which one is yours.
    const n = (hasSelf ? 1 : 0) + (hasPeer ? 1 : 0);
    const countEl = pill.querySelector<HTMLElement>(".wl-reaction-count");
    if (countEl) {
      countEl.textContent = n > 1 ? String(n) : "";
      pill.classList.toggle("wl-reaction--multi", n > 1);
    }
    // an accessible label carries the who/how-many that the visual conveys.
    const emoji = pill.dataset.emoji ?? "";
    pill.setAttribute("aria-label",
      hasSelf && hasPeer ? `${emoji}, you and them` :
      hasSelf ? `${emoji}, you reacted` :
      hasPeer ? `${emoji}, they reacted` : emoji);
  }

  /**
   * Toggle self-reaction on a message. Looks up the existing pill in the DOM —
   * if already reacted, unreacts; otherwise reacts. No pill param needed since
   * we key by emoji string in data-emoji.
   */
  function toggleSelfReaction(msgId: number, emoji: string): void {
    const el = msgById.get(msgId);
    if (!el || isTransientDrawPreviewMessage(el)) return;
    const normEmoji = normalizeReactionGlyph(emoji);
    if (!normEmoji) return;
    const bar = el.querySelector<HTMLElement>(".wl-msg-reactions");
    const pill = bar?.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(normEmoji)}"]`);
    const isUnreact = pill?.dataset.self === "1";
    // A new pill would push the bar past the cap. An existing pill just
    // gaining the self flag is always fine. Check before sending anything
    // so a capped reaction never reaches the peer while staying local-only.
    if (!isUnreact && !pill && bar && bar.children.length >= MAX_REACTIONS) {
      pulseReactionShelfCap();
      return;
    }
    haptic("reaction");
    if (session) {
      // Live: send over the wire
      if (isUnreact) {
        session.sendCtrl(CTRL_OP.UNREACT, encodeReactPayload(msgId, normEmoji));
        removeReaction(msgId, normEmoji, "self");
      } else {
        session.sendCtrl(CTRL_OP.REACT, encodeReactPayload(msgId, normEmoji));
        applyReaction(msgId, normEmoji, "self");
      }
    } else {
      // Preview mode: local-only reaction, no network
      if (isUnreact) removeReaction(msgId, normEmoji, "self");
      else applyReaction(msgId, normEmoji, "self");
    }
  }

  const originalTitle = document.title;
  let unreadCount = 0;
  let hasFocus = document.hasFocus();
  // peer messages that arrived while the tab was hidden or unfocused: their
  // SEEN receipts wait here until attention genuinely returns.
  const pendingSeen = new Set<number>();
  const flushPendingSeen = () => {
    if (document.hidden || !hasFocus || !session || pendingSeen.size === 0) return;
    for (const msgId of pendingSeen) {
      session.sendCtrl(CTRL_OP.SEEN, encodeSeenPayload(msgId));
    }
    pendingSeen.clear();
  };
  type ComposeIntent = "idle" | "connecting" | "ready" | "typing" | "error" | "drop";
  const chatCompose = opts.chatInput.closest<HTMLElement>(".wl-chat-compose");
  let composeIntentTimer: ReturnType<typeof setTimeout> | null = null;
  let composeIntentOverride: ComposeIntent | null = null;
  let composeActivity = 0;
  let composeActivityTarget = 0;
  let composeActivityVelocity = 0;
  let composeActivityRaf = 0;
  let composeActivityLastTick = 0;
  let composeActivitySettledSince = 0; // ts a quiet frame first landed, 0 = still animating
  let composeActivityRafWasRunning = false; // preserved across a document.hidden pause
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
  // the single reconnect seam for the current interruption. one incident = one
  // seam, kept while recovery flaps and settled to a quiet scar on reconnect,
  // instead of stacking a fresh "reconnecting" line on every recovery tick.
  let reconnectSeamEl: HTMLElement | null = null;

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

  /** Push all animation state to CSS custom properties. One place, once per frame.
   *  toFixed replaced with manual rounding (10-50x faster in V8).
   *  Math.min/max/abs replaced with ternaries. */
  const f3 = (v: number) => String(Math.round(v * 1000) * 0.001);
  const f4 = (v: number) => String(Math.round(v * 10000) * 0.0001);

  function syncCSSVars(): void {
    if (!chatCompose) return;
    const s = chatCompose.style;
    const se = send.energy;
    const ti = typing.intensity;

    // compose activity
    const absVel = composeActivityVelocity < 0 ? -composeActivityVelocity : composeActivityVelocity;
    const vel = absVel * 0.18;
    s.setProperty("--wl-activity", f3(composeActivity));
    s.setProperty("--wl-velocity", f3(vel < 1 ? vel : 1));
    s.setProperty("--wl-flow", f3((Math.sin(composeFlow) + 1) * 50) + "%");

    // send energy
    const seFill = se < 1 ? se : 1;
    const rawOv = (se - 1) * 3.3;
    const overflow = rawOv < 0 ? 0 : rawOv < 1 ? rawOv : 1;
    const absSv = send.velocity < 0 ? -send.velocity : send.velocity;
    const svCss = absSv * 0.15;
    s.setProperty("--wl-send-energy", f3(seFill));
    s.setProperty("--wl-send-velocity", f3(svCss < 1 ? svCss : 1));
    s.setProperty("--wl-send-overflow", f3(overflow));

    // typing: position → smoothstep
    const rawPos = 0.5 + typing.amplitude * 0.5 * Math.sin(typing.phase);
    const eased = rawPos * rawPos * (3 - 2 * rawPos);
    s.setProperty("--wl-peer-typing", f3(ti));
    s.setProperty("--wl-typing-pos", f4(eased));

    // typing: width modulation
    const spd = typing.speed;
    const sus = typing.sustain;
    s.setProperty("--wl-typing-width", f3(1 + (1 - spd) * 0.18 + spd * 0.28 + sus * 0.06));
    s.setProperty("--wl-typing-glow", f3(spd * 0.5 + sus * 0.3));

    // cross-system interaction
    const seClamped = se < 1 ? se : 1;
    const interaction = (seClamped > 0.02 && ti > 0.02) ? seClamped * ti : 0;
    s.setProperty("--wl-energy-center", f4(0.5 + (eased - 0.5) * 0.12 * interaction));
    s.setProperty("--wl-typing-squeeze", f3(1 - seClamped * 0.45));
    s.setProperty("--wl-interaction", f3(interaction));
  }

  /** Shared spring integrator: accel = ω²(target - x) − 2ζω·v */
  function springAccel(x: number, v: number, target: number, omega: number, zeta: number): number {
    return omega * omega * (target - x) - 2 * zeta * omega * v;
  }

  function stepComposeActivity(ts: number): void {
    const rawDt = composeActivityLastTick ? (ts - composeActivityLastTick) * 0.001 : 0;
    const dt = rawDt < 0.001 ? (rawDt || 0.016) : (rawDt > 0.04 ? 0.04 : rawDt);
    composeActivityLastTick = ts;

    // ── Compose activity spring (ω=13, ζ=0.72 → ω²=169, 2ζω=18.72) ──
    composeActivityTarget *= 1 - 2.6 * dt; // exp(-2.6dt) linear approx
    if (composeActivityTarget < 0) composeActivityTarget = 0;
    composeActivityVelocity += (169 * (composeActivityTarget - composeActivity) - 18.72 * composeActivityVelocity) * dt;
    composeActivity += composeActivityVelocity * dt;
    if (composeActivity < 0) composeActivity = 0;
    else if (composeActivity > 1) composeActivity = 1;
    composeFlow += dt * (2.4 + composeActivity * 6.2);

    // ── Send energy (RTT-derived physics) ──
    const rttRaw = (send.rtt - 30) * 0.00588; // 1/170
    const rttFactor = rttRaw < 0 ? 0 : rttRaw > 1 ? 1 : rttRaw;

    if (send.phase === "filling") {
      const w = 14 - rttFactor * 4, z = 0.65 + rttFactor * 0.1;
      send.velocity += (w * w * (send.fillTarget - send.energy) - 2 * z * w * send.velocity) * dt;
      send.energy += send.velocity * dt;
    } else if (send.phase === "in-flight") {
      const bp = send.rtt * 1.5;
      const breathPeriod = bp > 120 ? bp : 120;
      const breath = 0.92 + 0.08 * Math.sin((ts - send.inflightStart) / breathPeriod);
      const rate = (10 - rttFactor * 4) * dt;
      send.energy += (breath - send.energy) * (rate < 1 ? rate : 1);
      const decay = 1 - (6 + rttFactor * 4) * dt;
      send.velocity *= decay > 0 ? decay : 0;
    } else if (send.phase === "delivered") {
      const afRaw = (send.ackLatency - 50) * 0.004; // 1/250
      const af = afRaw < 0 ? 0 : afRaw > 1 ? 1 : afRaw;
      const w = 9 - af * 3, z = 0.45 + af * 0.15;
      send.velocity += (w * w * -send.energy - 2 * z * w * send.velocity) * dt;
      send.energy += send.velocity * dt;
      const absE = send.energy < 0 ? -send.energy : send.energy;
      const absV = send.velocity < 0 ? -send.velocity : send.velocity;
      if (absE < 0.005 && absV < 0.005) {
        send.energy = 0; send.velocity = 0; send.phase = "idle";
      }
    }
    if (send.energy < 0) send.energy = 0;
    else if (send.energy > 1.3) send.energy = 1.3;

    // ── Typing indicator (amplitude-modulated pendulum) ──
    const t = typing;
    const tOn = t.target > 0.5;
    const tIdle = t.idle;

    const intensityTarget = tOn ? (tIdle ? 0.45 : 1) : 0;
    const amplitudeTarget = tOn ? (tIdle ? 0.25 : 1) : 0;

    const intRate = (tOn ? 4.5 : 1.8) * dt;
    t.intensity += (intensityTarget - t.intensity) * (intRate < 1 ? intRate : 1);
    if (t.intensity < 0) t.intensity = 0;
    else if (t.intensity > 1) t.intensity = 1;

    const ampRate = (tOn ? 1.4 : 2.8) * dt;
    t.amplitude += (amplitudeTarget - t.amplitude) * (ampRate < 1 ? ampRate : 1);
    if (t.amplitude < 0) t.amplitude = 0;
    else if (t.amplitude > 1) t.amplitude = 1;

    // sustain warmth
    if (tOn) {
      const cap = tIdle ? 0.3 : 1;
      t.sustain += dt * (tIdle ? 0.06 : 0.14);
      if (t.sustain > cap) t.sustain = cap;
    } else {
      t.sustain *= 1 - 0.5 * dt;
    }

    if (t.intensity > 0.01) {
      const pos = 0.5 + t.amplitude * 0.5 * Math.sin(t.phase);
      const diff = pos - 0.5;
      const edgeDist = 1 - (diff < 0 ? -diff : diff) * 2;
      const windDown = 0.3 + t.amplitude * 0.7;
      t.phaseVelocity *= 1 - 3.5 * dt;
      const baseSpeed = tIdle ? 0.7 : 1.8;
      const edgeBoost = tIdle ? 0.4 : 1.4;
      t.phase += dt * ((baseSpeed + edgeDist * edgeBoost) * (1 - send.energy * 0.3) * windDown + t.phaseVelocity);
      const cosP = Math.cos(t.phase);
      t.speed = (cosP < 0 ? -cosP : cosP) * t.amplitude;
    } else {
      t.phaseVelocity = 0; t.amplitude = 0; t.sustain = 0; t.speed = 0;
    }

    syncCSSVars();

    // keep loop alive while anything is in motion
    const absCV = composeActivityVelocity < 0 ? -composeActivityVelocity : composeActivityVelocity;
    const absSV = send.velocity < 0 ? -send.velocity : send.velocity;
    const stillActive = composeActivity > 0.006 || composeActivityTarget > 0.006
      || absCV > 0.006
      || send.energy > 0.006 || absSV > 0.006
      || t.intensity > 0.006 || t.amplitude > 0.006;

    if (stillActive) {
      composeActivitySettledSince = 0;
      composeActivityRaf = requestAnimationFrame(stepComposeActivity);
      return;
    }

    // Quiet frame — hold the loop open for RAF_SETTLE_MS before fully stopping, so a
    // value dithering right at the epsilon boundary doesn't thrash start/stop every
    // few frames. Idle throttle: once settled that long, the rAF loop actually exits.
    if (!composeActivitySettledSince) composeActivitySettledSince = ts;
    if (ts - composeActivitySettledSince < RAF_SETTLE_MS) {
      composeActivityRaf = requestAnimationFrame(stepComposeActivity);
      return;
    }

    // Full reset
    composeActivity = 0; composeActivityTarget = 0; composeActivityVelocity = 0;
    send.energy = 0; send.velocity = 0; send.fillTarget = 0;
    send.phase = "idle"; send.acks.clear(); send.timestamps.clear(); send.peakEnergy = 0;
    t.intensity = 0; t.idle = false; t.phaseVelocity = 0; t.amplitude = 0; t.sustain = 0; t.speed = 0;
    syncCSSVars();
    composeActivityRaf = 0; composeActivityLastTick = 0; composeActivitySettledSince = 0;
  }

  /** Kick the rAF loop if not already running. Single gate for all animation. */
  function ensureRaf(): void {
    if (!composeActivityRaf && chatCompose && !reduceMotion && !document.hidden) {
      composeActivitySettledSince = 0;
      composeActivityRaf = requestAnimationFrame(stepComposeActivity);
    }
  }

  // Pause the loop while the tab is hidden — rAF wouldn't fire anyway on most
  // browsers, but this also stops us burning a stale huge dt on resume, and
  // resumes only if it was actually mid-animation when hidden fired.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      composeActivityRafWasRunning = !!composeActivityRaf;
      if (composeActivityRaf) { cancelAnimationFrame(composeActivityRaf); composeActivityRaf = 0; }
    } else if (composeActivityRafWasRunning) {
      composeActivityRafWasRunning = false;
      composeActivityLastTick = 0;
      ensureRaf();
    }
  }, { signal });

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
    send.fillTarget = Math.min(1, Math.max(send.fillTarget, send.energy) + 0.3); // bigger visual chunk
    send.velocity += 2.0; // Additive click velocity for spamming
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
        if (shelfTarget?.msgId === msgId) updateShelfCaption();
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

    // Check if the ack was successfully deleted (meaning it was actually in flight)
    const wasInFlight = send.acks.delete(msgId);
    if (shelfTarget?.msgId === msgId) updateShelfCaption();

    if (send.acks.size === 0 && send.phase === "in-flight") {
      sendDelivered();
    } else if (wasInFlight && send.phase === "in-flight") {
      // Individual message delivered but others pending. Bounce it visually!
      haptic("msg-sent");
      send.velocity -= 2.5;
      if (typing.intensity > 0.05) {
        const dir = Math.sin(typing.phase) > 0 ? 1 : -1;
        typing.phaseVelocity += dir * (0.8 + send.peakEnergy * 1.5);
      }
      ensureRaf();
    }
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
      if (signal.aborted) return;
      t += 0.12;
      sendProgress(Math.min(1, t));
      if (t < 1) { requestAnimationFrame(step); return; }
      if (myId !== previewSendId) return;
      send.phase = "in-flight";
      send.peakEnergy = send.energy;
      send.inflightStart = Date.now();
      setTimeout(() => {
        if (signal.aborted) return;
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
    // stage mode: the chat takes the theatre, page chrome recedes
    const entering = el === opts.chatSection;
    const wasStaged = document.documentElement.classList.contains("wl-stage");
    document.documentElement.classList.toggle("wl-stage", entering);
    if (entering && !wasStaged) {
      // frame the stage: on desktop the panel sits mid-page, so bring it into view
      // once the stage layout has applied. mobile is position fixed and unaffected.
      requestAnimationFrame(() => {
        liveSurface?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      });
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
    opts.joinQrImageBtn.disabled = busy || scanning || !liveCapabilities.qrImageDecode;
    opts.joinQrStopBtn.style.display = scanning ? "" : "none";
  }

  function setJoinQrStatus(text: string): void {
    opts.joinQrStatus.textContent = text;
  }

  function refreshCapabilityUi(): void {
    opts.joinPasteBtn.title = liveCapabilities.clipboardRead
      ? "Paste offer code from clipboard"
      : "Clipboard paste unavailable here";
    opts.joinPasteBtn.setAttribute("aria-label", opts.joinPasteBtn.title);

    opts.joinQrScanBtn.title = liveQrSupported
      ? "Scan an offer code with your camera"
      : liveQrUnavailableLabel;
    opts.joinQrScanBtn.setAttribute("aria-label", opts.joinQrScanBtn.title);

    opts.joinQrImageBtn.title = liveCapabilities.qrImageDecode
      ? "Load an offer code from an image"
      : "Image QR import unavailable here";
    opts.joinQrImageBtn.setAttribute("aria-label", opts.joinQrImageBtn.title);

    // no share sheet here: hide the Share button rather than relabel it "Copy"
    // next to a real Copy button (that read as a duplicate control)
    for (const [btn, kind] of [
      [opts.offerShareBtn, "offer code"],
      [opts.answerShareBtn, "answer code"],
    ] as const) {
      if (!btn) continue;
      btn.style.display = liveCapabilities.shareSheet ? "" : "none";
      btn.textContent = "Share";
      btn.title = "Share this code using a system share sheet";
      btn.setAttribute("aria-label", `share ${kind}`);
    }

    const micTitle = micSupported
      ? "Record audio message"
      : "Voice recording unavailable here";
    opts.chatMicBtn.title = micTitle;
    opts.chatMicBtn.setAttribute("aria-label", micTitle);
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
    haptic("qr-detected");
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
      liveQrUnavailableLabel = getQrCapabilityLabel(capability.reason);
      refreshCapabilityUi();
      setJoinQrStatus(`${liveQrUnavailableLabel}.`);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setJoinQrStatus("Camera capture unavailable.");
      return;
    }

    const detector = await createQrDetector();
    if (aborted() || runId !== qrScanSession.runId) return;
    if (!detector) {
      setJoinQrStatus(`${liveQrUnavailableLabel}.`);
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
      setJoinQrStatus("Camera access failed.");
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
    opts.joinPasteBtn.disabled = busy || !liveCapabilities.clipboardRead;
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
      // qrArmActive wins over everything else here: while a QR-armed wait
      // is running the button reads "waiting..." (setRelayQrWaiting owns
      // that label) and must stay disabled regardless of busy/flareActive —
      // this line only ever touches .disabled, never the label, so there's
      // no fight between the two.
      opts.relayConnectBtn.disabled = busy || flareActive || qrArmActive;
    }

    if (opts.relayQrToggleBtn) {
      // an empty phrase no longer blocks the toggle: it now MEANS in-person
      // mode (the QR carries a local offer instead of a phrase). only a
      // concurrent manual connect blocks it, and an armed wait keeps it
      // clickable so the panel always stays closable.
      opts.relayQrToggleBtn.disabled = (busy && !qrArmActive);
    }

    if (flareFireBtn) {
      flareFireBtn.disabled = busy || flareActive;
    }
    if (flarePhraseInput) {
      flarePhraseInput.disabled = busy || flareActive;
    }

    opts.funnelCampfireBtn.disabled = true; // hard-disabled for now

    const modeSwitchWrap = modeSwitchBtn?.closest(".wl-mode-switch") as HTMLElement | null;
    if (modeSwitchWrap) {
      modeSwitchWrap.style.display = (busy || hasSession) ? "none" : "";
    }

    const canChat = hasSession || chatVisible;       // preview mode has no session but chat is visible
    opts.chatSendBtn.disabled = busy || !canChat || !hasChatText;
    opts.chatMediaBtn.disabled = busy || !canChat;
    opts.chatPasteBtn.disabled = busy || !canChat;
    opts.chatMicBtn.disabled = editingMsgId != null ? false : (busy || !canChat || !micSupported);
    opts.chatMicCancel.disabled = busy || !canChat || !micSupported;
    opts.chatMicSend.disabled = busy || !canChat || !micSupported;
    // Query real messages directly — the container also permanently hosts
    // the shared reaction shelf, which .children.length would count too.
    const hasChatMessages = opts.chatMessages.querySelector(".wl-msg") !== null;
    opts.chatMediaClear.disabled = busy || !hasChatMessages;

    opts.confirmBtn.disabled = busy || !hasSession;
    opts.rejectBtn.disabled = busy || !hasSession;
    opts.disconnectBtn.disabled = busy || (!hasSession && !chatVisible);
    opts.silentDisconnectBtn.disabled = busy || !hasSession;
    refreshCapabilityUi();
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
  function nudgeAudio(): void {
    // Sound effects are intentionally off — haptics are the primary feedback.
    return;
  }

  /* ── Audio recording (Harmonic codec pipeline) ──────────── */

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

  const HARMONIC_MIME = "audio/x-whisper-harmonic";

  function isWhisperAudioCodec(fileType?: string, fileName?: string): boolean {
    const t = (fileType ?? "").toLowerCase();
    const n = (fileName ?? "").toLowerCase();
    return t === HARMONIC_MIME
      || t.includes("x-whisper")
      || t.includes("whisper-audio")
      || n.endsWith(".wharm");
  }

  // unified file payload access — hides the small/chunked representation split.
  // small files (< 4 MB) arrive as fileData: Uint8Array from single-message decryption.
  // large chunked files arrive as fileBlob: Blob (browser-managed, off JS heap).
  // blob.slice is a zero-copy retype — no data is copied, just a new typed view.

  function hasFilePayload(msg: LiveMessage): boolean {
    return !!(msg.fileData || msg.fileBlob);
  }

  function filePayloadBlob(msg: LiveMessage, type: string): Blob {
    if (msg.fileBlob) return msg.fileBlob.slice(0, msg.fileBlob.size, type);
    return new Blob([msg.fileData!], { type });
  }

  function isRenderableAudioMessage(msg: LiveMessage): boolean {
    // audio codec decoding needs raw bytes — only works with fileData (small single-message files).
    // large chunked audio files fall through to generic download.
    if (msg.type !== "file" || !msg.fileData) return false;
    if (isWhisperGlyph(msg.fileType, msg.fileName)) return false;
    const type = msg.fileType?.toLowerCase() ?? "";
    return type.startsWith("audio/") || isWhisperAudioCodec(msg.fileType, msg.fileName);
  }

  async function downloadGlyphAsPng(glyphBytes: Uint8Array, sourceName: string): Promise<void> {
    const blob = await exportGwyphToPngBlob(glyphBytes);
    if (!blob) {
      appendLog("drawing export failed: unable to render glyph as png");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = gwyphPngName(sourceName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  type MediaKind = "image" | "video" | "glyph";

  /** Extension → MIME fallback for when the peer sends a generic/missing type. */
  const EXT_MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp",
    ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
    mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
    mkv: "video/x-matroska", avi: "video/x-msvideo", m4v: "video/mp4",
  };

  /**
   * Detect whether a file message is renderable media. We don't hardcode a list
   * of "supported" types — anything with an image/* or video/* MIME is attempted,
   * and the browser's own codec support decides whether it can be decoded.
   * An onerror fallback at render time catches anything the browser can't handle.
   */
  function detectMedia(msg: LiveMessage): { kind: MediaKind; mime: string } | null {
    if (msg.type !== "file" || !hasFilePayload(msg)) return null;
    if (isWhisperGlyph(msg.fileType, msg.fileName)) {
      return { kind: "glyph", mime: GLYPH_MIME };
    }
    const t = (msg.fileType ?? "").toLowerCase();
    // Primary: trust the MIME type prefix
    if (t.startsWith("image/")) return { kind: "image", mime: t };
    if (t.startsWith("video/")) return { kind: "video", mime: t };
    // Fallback: infer from extension when MIME is missing or generic
    const ext = (msg.fileName ?? "").toLowerCase().split(".").pop() ?? "";
    const inferred = EXT_MIME[ext];
    if (inferred) {
      const k: MediaKind = inferred.startsWith("image/") ? "image" : "video";
      return { kind: k, mime: inferred };
    }
    return null;
  }

  /* ── Media lightbox ─────────────────────────────────────────────── */
  let lightboxEl: HTMLElement | null = null;
  let lightboxAc: AbortController | null = null;
  let drawSurfaceAc: AbortController | null = null;

  function closeDrawSurface(): void {
    drawSurfaceAc?.abort();
    drawSurfaceAc = null;
  }

  function openManagedDrawSurface(
    cfg: Omit<Parameters<typeof openDrawSurface>[0], "signal">,
    drawCallbacks: Omit<Parameters<typeof openDrawSurface>[1], "onClose">,
    parentSignal: AbortSignal,
  ): void {
    closeDrawSurface();
    const drawAc = new AbortController();
    const drawSignal = drawAc.signal;
    drawSurfaceAc = drawAc;

    const abortDraw = () => drawAc.abort();
    if (parentSignal.aborted || signal.aborted) {
      drawAc.abort();
      drawSurfaceAc = null;
      return;
    }
    parentSignal.addEventListener("abort", abortDraw, { signal: drawSignal });
    signal.addEventListener("abort", abortDraw, { signal: drawSignal });

    openDrawSurface({ ...cfg, signal: drawSignal }, {
      ...drawCallbacks,
      onClose: () => {
        if (drawSurfaceAc === drawAc) drawSurfaceAc = null;
      },
    });
  }

  function openMediaLightbox(
    src: string,
    dlUrl: string,
    fileName: string,
    kind: MediaKind,
    glyph?: GlyphPayload,
    glyphBytes?: Uint8Array,
  ): void {
    // Close any existing lightbox first
    closeMediaLightbox();

    const lbAc = new AbortController();
    const lbSignal = lbAc.signal;

    const overlay = document.createElement("div");
    overlay.className = "wl-lightbox";
    overlay.addEventListener("wheel", (e) => e.preventDefault(), { passive: false, signal: lbSignal });

    const inner = document.createElement("div");
    inner.className = "wl-lightbox-inner";

    if (kind === "image") {
      const img = document.createElement("img");
      img.className = "wl-lightbox-img";
      img.src = src;
      img.alt = fileName;
      img.draggable = false;
      inner.appendChild(img);
    } else if (kind === "video") {
      const video = document.createElement("video");
      video.className = "wl-lightbox-video";
      video.src = src;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      inner.appendChild(video);
    } else {
      const frame = document.createElement("div");
      frame.className = "wl-lightbox-img";
      frame.style.display = "grid";
      frame.style.placeItems = "center";

      const canvas = document.createElement("canvas");
      canvas.className = "wl-peer-draw-inline";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.aspectRatio = `${Math.max(1, glyph?.logicalW ?? 4)} / ${Math.max(1, glyph?.logicalH ?? 3)}`;
      frame.appendChild(canvas);
      inner.appendChild(frame);

      if (glyph) {
        bindGlyphCanvasToHost(canvas, frame, glyph, lbSignal);
      }
    }

    const bar = document.createElement("div");
    bar.className = "wl-lightbox-bar";

    const label = document.createElement("span");
    label.className = "wl-lightbox-name";
    label.textContent = fileName;

    const dlLink = document.createElement("a");
    dlLink.className = "wl-lightbox-dl";
    if (kind === "glyph" && glyphBytes) {
      dlLink.href = "#";
      dlLink.download = gwyphPngName(fileName);
      dlLink.title = "Download PNG";
      dlLink.addEventListener("click", (e) => {
        e.preventDefault();
        void downloadGlyphAsPng(glyphBytes, fileName);
      }, { signal: lbSignal });
    } else {
      dlLink.href = dlUrl;
      dlLink.download = fileName;
      dlLink.title = "Download";
    }
    dlLink.innerHTML = `<svg width="16" height="16" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M3.5 6l3.5 3.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 11h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

    const annotateBtn = document.createElement("button");
    annotateBtn.type = "button";
    annotateBtn.className = "wl-lightbox-annotate";
    annotateBtn.title = "Draw";
    annotateBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    annotateBtn.addEventListener("click", () => {
      if (kind === "glyph" && glyphBytes) {
        openManagedDrawSurface({ mode: "annotate", gwyphBase: glyphBytes, originalName: fileName }, {
          onSend: (r) => sendFileToChat(r.file, "draw"),
          onEvent: (ev) => session?.sendDrawStream(ev),
        }, lbSignal);
        return;
      }
      const mediaEl = inner.querySelector("img, video") as HTMLImageElement | HTMLVideoElement | null;
      if (!mediaEl) return;
      if (mediaEl instanceof HTMLVideoElement) mediaEl.pause();
      openManagedDrawSurface({ mode: "annotate", mediaEl, originalName: fileName }, {
        onSend: (r) => sendFileToChat(r.file, "draw"),
        onEvent: (ev) => session?.sendDrawStream(ev),
      }, lbSignal);
    }, { signal: lbSignal });

    bar.append(label, annotateBtn, dlLink);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "wl-lightbox-close";
    closeBtn.title = "Close";
    closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 4L14 14M14 4L4 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    closeBtn.addEventListener("click", closeMediaLightbox, { signal: lbSignal });

    overlay.append(inner, bar, closeBtn);

    // Backdrop click to close (not clicks on media itself)
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeMediaLightbox();
    }, { signal: lbSignal });

    // Escape to close — document-level, cleaned up by lbAc.abort()
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMediaLightbox(); }
    }, { signal: lbSignal });

    requestAnimationFrame(() => overlay.classList.add("wl-lightbox--open"));

    document.body.appendChild(overlay);
    lightboxEl = overlay;
    lightboxAc = lbAc;
  }

  function closeMediaLightbox(): void {
    if (!lightboxEl) return;
    const el = lightboxEl;
    lightboxEl = null;
    // Abort all lightbox event listeners in one shot
    lightboxAc?.abort();
    lightboxAc = null;
    el.classList.remove("wl-lightbox--open");
    // Release video resources
    const vid = el.querySelector("video");
    if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); }
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => { if (el.parentNode) el.remove(); }, 350);
  }

  /* ── Media message renderer ───────────────────────────────────────
   * Extracted as a self-contained function so future features (PictoChat
   * annotation, drawing overlays, etc.) can extend it by adding children
   * to the returned container or the info bar without touching the main
   * addChatMessage flow.
   *
   * Structure:
   *   .wl-msg-media
   *     .wl-media-thumb          ← click → lightbox
   *       <img> | <video> + .wl-media-play-overlay
   *     .wl-media-info           ← action bar, extensible
   *       .wl-media-name
   *       .wl-media-size
   *       .wl-media-dl           ← download button
   * ─────────────────────────────────────────────────────────────────── */

  function renderGlyphMediaMessage(
    fileName: string,
    fileSize: number | undefined,
    glyph: GlyphPayload,
    glyphBytes: Uint8Array,
    abortSignal: AbortSignal,
    aspectRatioHint?: string,
    drawPreview?: HTMLCanvasElement | null,
  ): HTMLElement {
    const root = document.createElement("div");
    root.className = "wl-msg-media wl-msg-peer-draw";
    root.dataset.drawState = "sent";

    const thumb = document.createElement("div");
    thumb.className = "wl-media-thumb wl-msg-peer-draw-thumb";
    thumb.style.aspectRatio = (aspectRatioHint?.trim() || `${glyph.logicalW} / ${glyph.logicalH}`);

    const canvas = document.createElement("canvas");
    canvas.className = "wl-peer-draw-inline";
    thumb.appendChild(canvas);

    // immediate first frame from draw preview — avoids blank flash before
    // bindGlyphCanvasToHost repaints at proper resolution on next resize
    if (drawPreview) {
      canvas.width = drawPreview.width;
      canvas.height = drawPreview.height;
      const pctx = canvas.getContext("2d");
      if (pctx) pctx.drawImage(drawPreview, 0, 0);
    }

    bindGlyphCanvasToHost(canvas, thumb, glyph, abortSignal);

    thumb.addEventListener("click", () => {
      openMediaLightbox("", "", fileName, "glyph", glyph, glyphBytes);
    }, { signal: abortSignal });

    const infoBar = createMediaInfoBar(fileName, fileSize, "#");
    const dlBtn = infoBar.querySelector<HTMLAnchorElement>(".wl-media-dl");
    if (dlBtn) {
      dlBtn.download = gwyphPngName(fileName);
      dlBtn.title = "Download PNG";
      dlBtn.addEventListener("click", (e) => {
        e.preventDefault();
        void downloadGlyphAsPng(glyphBytes, fileName);
      }, { signal: abortSignal });
    }

    root.append(thumb, infoBar);
    return root;
  }

  function bindGlyphCanvasToHost(
    canvas: HTMLCanvasElement,
    host: HTMLElement,
    glyph: GlyphPayload,
    abortSignal: AbortSignal,
  ): void {
    let rafId = 0;
    let lastOutW = 0;
    let lastOutH = 0;

    const paint = (): void => {
      rafId = 0;
      const dpr = devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width || host.clientWidth || 1));
      const ch = Math.max(1, Math.round(rect.height || host.clientHeight || 1));
      const outW = Math.max(1, Math.round(cw * dpr));
      const outH = Math.max(1, Math.round(ch * dpr));
      if (outW === lastOutW && outH === lastOutH) return;
      lastOutW = outW;
      lastOutH = outH;
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderGwyphScene(ctx, glyph, outW, outH);
    };

    const schedule = (): void => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(paint);
    };

    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => schedule())
      : null;
    ro?.observe(host);
    window.addEventListener("resize", schedule, { signal: abortSignal });
    window.visualViewport?.addEventListener("resize", schedule, { signal: abortSignal });

    abortSignal.addEventListener("abort", () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      ro?.disconnect();
    }, { once: true });

    schedule();
  }

  function renderMediaMessage(msg: LiveMessage, abortSignal: AbortSignal, drawPreview?: HTMLCanvasElement | null): HTMLElement {
    const { kind, mime } = detectMedia(msg)!;
    const fileName = msg.fileName ?? "file";
    // extract fileSize before closures so msg (and msg.fileData) can be GC'd
    // after blob creation — prevents retaining raw file bytes for the DOM lifetime.
    const fileSize = msg.fileSize;

    // glyph decoding needs raw bytes — only possible from fileData (always small)
    if (kind === "glyph" && msg.fileData) {
      const glyphBytes = new Uint8Array(msg.fileData.byteLength);
      glyphBytes.set(msg.fileData);
      const glyph = parseGwyphPayload(glyphBytes);
      if (!glyph) {
        const dlBlob = new Blob([glyphBytes], { type: "application/octet-stream" });
        const dlUrl = URL.createObjectURL(dlBlob);
        objectUrls.add(dlUrl);
        const fallback = document.createElement("div");
        fallback.className = "wl-msg-file";
        const n = document.createElement("span");
        n.className = "wl-msg-file-name";
        n.textContent = fileName;
        const s = document.createElement("span");
        s.className = "wl-msg-file-size";
        s.textContent = fileSize ? formatSize(fileSize) : "";
        const a = document.createElement("a");
        a.className = "wl-msg-file-download";
        a.href = dlUrl;
        a.download = fileName;
        a.textContent = "download";
        fallback.append(n, s, a);
        return fallback;
      }

      return renderGlyphMediaMessage(fileName, fileSize, glyph, glyphBytes, abortSignal, undefined, drawPreview);
    }

    const displayBlob = filePayloadBlob(msg, mime);
    const displayUrl = URL.createObjectURL(displayBlob);
    objectUrls.add(displayUrl);

    const dlBlob = filePayloadBlob(msg, "application/octet-stream");
    const dlUrl = URL.createObjectURL(dlBlob);
    objectUrls.add(dlUrl);

    const root = document.createElement("div");
    root.className = "wl-msg-media";

    // If the browser can't decode the media, degrade to generic file card.
    // Guard against firing on detached elements (e.g. session ended before load).
    const fallbackToFile = () => {
      if (!root.isConnected) return;
      root.className = "wl-msg-file";
      root.textContent = "";
      const n = document.createElement("span");
      n.className = "wl-msg-file-name";
      n.textContent = fileName;
      const s = document.createElement("span");
      s.className = "wl-msg-file-size";
      s.textContent = fileSize ? formatSize(fileSize) : "";
      const a = document.createElement("a");
      a.className = "wl-msg-file-download";
      a.href = dlUrl;
      a.download = fileName;
      a.textContent = "download";
      root.append(n, s, a);
    };

    // ── Thumbnail ──
    const thumb = createMediaThumbnail(kind, displayUrl, fileName, fallbackToFile, abortSignal);
    thumb.addEventListener("click", () => {
      openMediaLightbox(displayUrl, dlUrl, fileName, kind);
    }, { signal: abortSignal });

    // ── Info bar ──
    const infoBar = createMediaInfoBar(fileName, fileSize, dlUrl);

    root.append(thumb, infoBar);
    return root;
  }

  /**
   * Render finalized peer draw content in the regular media-card shell
   * (thumb + info bar), while preserving the streamed thumb geometry/snapshot
   * so the stream->final merge doesn't jump.
   */
  function renderMergedPeerDrawMessage(
    msg: LiveMessage,
    abortSignal: AbortSignal,
    aspectRatioHint?: string,
    previewSnapshot?: HTMLCanvasElement | null,
  ): HTMLElement | null {
    if (msg.type !== "file" || !hasFilePayload(msg)) return null;
    const detected = detectMedia(msg);
    if (!detected) return null;

    const fileName = msg.fileName ?? "file";
    const hintedAspect = (aspectRatioHint ?? "").trim();

    if (detected.kind === "glyph" && msg.fileData) {
      const glyphBytes = new Uint8Array(msg.fileData.byteLength);
      glyphBytes.set(msg.fileData);
      const glyph = parseGwyphPayload(glyphBytes);
      if (!glyph) return null;
      return renderGlyphMediaMessage(fileName, msg.fileSize, glyph, glyphBytes, abortSignal, hintedAspect);
    }

    if (detected.kind !== "image") return null;

    const displayBlob = filePayloadBlob(msg, detected.mime);
    const displayUrl = URL.createObjectURL(displayBlob);
    objectUrls.add(displayUrl);
    const dlBlob = filePayloadBlob(msg, "application/octet-stream");
    const dlUrl = URL.createObjectURL(dlBlob);
    objectUrls.add(dlUrl);

    const root = document.createElement("div");
    root.className = "wl-msg-media wl-msg-peer-draw";
    root.dataset.drawState = "sent";

    const thumb = document.createElement("div");
    thumb.className = "wl-media-thumb wl-msg-peer-draw-thumb";
    if (hintedAspect) thumb.style.aspectRatio = hintedAspect;

    const bgCanvas = document.createElement("canvas");
    bgCanvas.className = "wl-peer-draw-bg";
    bgCanvas.setAttribute("aria-hidden", "true");
    const drawCanvas = document.createElement("canvas");
    drawCanvas.className = "wl-peer-draw-inline";
    drawCanvas.setAttribute("aria-hidden", "true");
    thumb.append(bgCanvas, drawCanvas);

    const paint = (img?: CanvasImageSource): void => {
      const dpr = devicePixelRatio || 1;
      const rect = thumb.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));
      const targetW = Math.max(1, Math.round(cw * dpr));
      const targetH = Math.max(1, Math.round(ch * dpr));

      bgCanvas.width = targetW;
      bgCanvas.height = targetH;
      drawCanvas.width = targetW;
      drawCanvas.height = targetH;

      const bgCtx = bgCanvas.getContext("2d");
      if (!bgCtx) return;
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgCtx.clearRect(0, 0, cw, ch);
      bgCtx.fillStyle = "#1a1a1a";
      bgCtx.fillRect(0, 0, cw, ch);
      if (img) bgCtx.drawImage(img, 0, 0, cw, ch);

      const fgCtx = drawCanvas.getContext("2d");
      if (!fgCtx) return;
      fgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fgCtx.clearRect(0, 0, cw, ch);
    };

    paint(previewSnapshot ?? undefined);
    const img = new Image();
    img.onload = () => {
      if (!hintedAspect && img.naturalWidth > 0 && img.naturalHeight > 0) {
        thumb.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      }
      requestAnimationFrame(() => paint(img));
    };
    img.onerror = () => paint();
    img.src = displayUrl;

    thumb.addEventListener("click", () => {
      openMediaLightbox(displayUrl, dlUrl, fileName, "image");
    }, { signal: abortSignal });

    const infoBar = createMediaInfoBar(fileName, msg.fileSize, dlUrl);
    root.append(thumb, infoBar);
    return root;
  }

  function capturePeerDrawThumbSnapshot(msgEl: HTMLElement | null): HTMLCanvasElement | null {
    if (!msgEl) return null;
    const bg = msgEl.querySelector<HTMLCanvasElement>("canvas.wl-peer-draw-bg");
    const fg = msgEl.querySelector<HTMLCanvasElement>("canvas.wl-peer-draw-inline");
    const source = fg ?? bg;
    if (!source) return null;
    const w = Math.max(1, source.width);
    const h = Math.max(1, source.height);
    const snap = document.createElement("canvas");
    snap.width = w;
    snap.height = h;
    const ctx = snap.getContext("2d");
    if (!ctx) return null;
    if (bg) ctx.drawImage(bg, 0, 0, w, h);
    if (fg) ctx.drawImage(fg, 0, 0, w, h);
    return snap;
  }

  /** Build the thumbnail container for an image or video. */
  /** Clamp a natural media aspect ratio into sane thumbnail bounds and cap upscale of
   *  tiny sources — otherwise a 1x1 image stretches to fill the whole bubble width,
   *  or an extreme-aspect image blows the bubble out into a sliver. object-fit: contain
   *  on the media element then letterboxes any gap between the clamped ratio and the
   *  image's true ratio instead of distorting it. */
  function applyMediaThumbAspect(thumb: HTMLElement, naturalWidth: number, naturalHeight: number): void {
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    const ratio = Math.min(1.9, Math.max(0.6, naturalWidth / naturalHeight));
    thumb.style.setProperty("--wl-media-aspect", String(ratio));
    // never upscale a tiny source beyond ~6x its native size
    thumb.style.setProperty("--wl-media-max-w", `${Math.max(naturalWidth, naturalHeight) * 6}px`);
  }

  function createMediaThumbnail(
    kind: MediaKind, src: string, alt: string, onError: () => void,
    sig: AbortSignal,
  ): HTMLElement {
    const thumb = document.createElement("div");
    thumb.className = "wl-media-thumb";

    if (kind === "image") {
      const img = document.createElement("img");
      img.className = "wl-media-img";
      img.src = src;
      img.alt = alt;
      img.draggable = false;
      img.style.opacity = "0";
      img.addEventListener("load", () => {
        img.style.transition = "opacity 180ms ease";
        img.style.opacity = "1";
        applyMediaThumbAspect(thumb, img.naturalWidth, img.naturalHeight);
      }, { once: true, signal: sig });
      img.addEventListener("error", onError, { once: true, signal: sig });
      thumb.appendChild(img);
    } else {
      const video = document.createElement("video");
      video.className = "wl-media-video";
      video.src = src;
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.draggable = false;
      video.style.opacity = "0";
      video.addEventListener("loadeddata", () => {
        video.style.transition = "opacity 180ms ease";
        video.style.opacity = "1";
        applyMediaThumbAspect(thumb, video.videoWidth, video.videoHeight);
      }, { once: true, signal: sig });
      video.addEventListener("error", onError, { once: true, signal: sig });

      const playOverlay = document.createElement("div");
      playOverlay.className = "wl-media-play-overlay";
      playOverlay.innerHTML = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="13" fill="rgb(0 0 0 / 0.45)" stroke="rgb(255 255 255 / 0.5)" stroke-width="1"/><path d="M11 8.5L20.5 14L11 19.5V8.5Z" fill="rgb(255 255 255 / 0.9)"/></svg>`;

      thumb.append(video, playOverlay);
    }

    return thumb;
  }

  /** Build the info bar beneath the thumbnail (filename, size, download). */
  function createMediaInfoBar(fileName: string, fileSize: number | undefined, dlUrl: string): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "wl-media-info";

    const nameEl = document.createElement("span");
    nameEl.className = "wl-media-name";
    nameEl.textContent = fileName;

    const sizeEl = document.createElement("span");
    sizeEl.className = "wl-media-size";
    sizeEl.textContent = fileSize ? formatSize(fileSize) : "";

    const dlBtn = document.createElement("a");
    dlBtn.className = "wl-media-dl";
    dlBtn.href = dlUrl;
    dlBtn.download = fileName;
    dlBtn.title = "Download";
    dlBtn.innerHTML = `<svg viewBox="0 0 14 14" fill="none"><path d="M7 1v8M3.5 6l3.5 3.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 11h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

    bar.append(nameEl, sizeEl, dlBtn);
    return bar;
  }

  // AudioWorklet-based PTT state
  let recordingStream: MediaStream | null = null;
  let recordingStart = 0;
  let recordingTimer: ReturnType<typeof setInterval> | null = null;
  let activeAudio: { stop: () => void; stopLoop: () => void; btn: HTMLButtonElement; wrap: HTMLElement; redraw: (p: number) => void } | null = null;

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
  let micSourceNode: MediaStreamAudioSourceNode | null = null;
  let micSinkNode: GainNode | null = null;
  let micAnalyserNode: AnalyserNode | null = null;
  let micCaptureWatchdog: ReturnType<typeof setTimeout> | null = null;
  let micRecorder: MediaRecorder | null = null;
  let micRecorderChunks: Blob[] = [];
  // set whenever a recording is silently torn down (cancel, recovery, teardown) so a
  // stopRecording() already in flight (awaiting extraction) knows to drop its result
  // instead of sending stale audio. cleared when a fresh recording actually starts.
  let recordingCancelled = false;

  const micSupported = !!navigator.mediaDevices?.getUserMedia && liveCapabilities.audioContext;
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
            this.port.postMessage(new Float32Array(ch));
          }
          return true;
        }
      }
      registerProcessor('whisper-pcm-capture', WhisperPcmCapture);
    `;
    return URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  }

  let smoothedBass = 0, smoothedMid = 0, smoothedTreble = 0;
  let micGlowRafId: number | null = null;

  function runMicGlowRaf(): void {
    if (!micAnalyserNode || !recordingStream) return;
    micGlowRafId = requestAnimationFrame(runMicGlowRaf);

    const data = new Uint8Array(micAnalyserNode.frequencyBinCount);
    micAnalyserNode.getByteFrequencyData(data);

    let b = 0, m = 0, t = 0;
    for (let i = 0; i <= 1; i++) b += data[i];
    for (let i = 2; i <= 12; i++) m += data[i];
    for (let i = 13; i <= 40; i++) t += data[i];

    const rawBass = Math.min(1, (b / 2) / 255 * 1.5);
    const rawMid = Math.min(1, (m / 11) / 255 * 1.5);
    const rawTreble = Math.min(1, (t / 28) / 255 * 1.5);

    smoothedBass = smoothedBass * 0.7 + rawBass * 0.3;
    smoothedMid = smoothedMid * 0.8 + rawMid * 0.2;
    smoothedTreble = smoothedTreble * 0.85 + rawTreble * 0.15;

    const btn = opts.chatMicBtn;
    if (!btn) return;

    const baseSpread = 2;
    const baseAlpha = 0.15;

    const midSpread = baseSpread + smoothedMid * 6;
    const midAlpha = baseAlpha + smoothedMid * 0.4;
    const layer1 = `0 0 ${midSpread}px ${midSpread + 2}px rgb(var(--chromatic-red) / ${midAlpha})`;

    const trebSpread = 1 + smoothedTreble * 3;
    const trebAlpha = smoothedTreble * 0.6;
    const layer2 = `0 0 ${trebSpread}px ${trebSpread}px rgb(var(--chromatic-red) / ${trebAlpha})`;

    const bassSpread = midSpread + 4 + smoothedBass * 12;
    const bassAlpha = smoothedBass * 0.25;
    const layer3 = `0 0 ${bassSpread}px ${bassSpread}px rgb(var(--chromatic-red) / ${bassAlpha})`;

    btn.style.boxShadow = `${layer1}, ${layer2}, ${layer3}`;
  }

  /** Clear mic button glow. */
  function clearMicGlow(): void {
    if (micGlowRafId) { cancelAnimationFrame(micGlowRafId); micGlowRafId = null; }
    smoothedBass = 0; smoothedMid = 0; smoothedTreble = 0;
    const btn = opts.chatMicBtn;
    if (btn) btn.style.boxShadow = "";
  }

  function startRecorderCapture(stream: MediaStream): void {
    if (typeof MediaRecorder === "undefined") return;
    try {
      const types = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ];
      const mimeType = types.find((t) => {
        try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
      });
      micRecorderChunks = [];
      micRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      micRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) micRecorderChunks.push(ev.data);
      };
      micRecorder.start(250);
    } catch {
      micRecorder = null;
      micRecorderChunks = [];
    }
  }

  function recorderBytesEstimate(): number {
    let total = 0;
    for (const b of micRecorderChunks) total += b.size;
    return total;
  }

  async function extractPcmFromRecorder(): Promise<{ pcm: Float32Array; sampleRate: number } | null> {
    const rec = micRecorder;
    if (!rec) return null;

    const finishDecode = async (): Promise<{ pcm: Float32Array; sampleRate: number } | null> => {
      micRecorder = null;
      const blobs = micRecorderChunks;
      micRecorderChunks = [];
      if (blobs.length === 0) return null;
      try {
        const blob = new Blob(blobs, { type: rec.mimeType || "audio/webm" });
        const ab = await blob.arrayBuffer();
        const actx = createAudioContext();
        if (!actx) return null;
        const decoded = await actx.decodeAudioData(ab.slice(0));
        const pcm = decoded.getChannelData(0).slice();
        const sampleRate = decoded.sampleRate;
        void actx.close();
        return { pcm, sampleRate };
      } catch {
        return null;
      }
    };

    return await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        void finishDecode().then(resolve);
      };
      rec.addEventListener("stop", done, { once: true });
      try {
        if (rec.state !== "inactive") {
          rec.requestData();
          rec.stop();
        } else {
          done();
        }
      } catch {
        done();
      }
      setTimeout(done, 800);
    });
  }

  function startRecording(): void {
    if (!micSupported || micPending || recordingStream) return;

    recordingCancelled = false;
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
      startRecorderCapture(stream);
      // recordingStart set after setup finishes

      // Prefer MediaRecorder pipeline when available — it is generally the most
      // cross-browser reliable capture path. Keep WebAudio path as compatibility
      // fallback only when MediaRecorder cannot start.
      if (!micRecorder) {
        // Fallback: If started without pointer event, create context here (it might be suspended and blocked, but fail gracefully)
        if (!micAudioCtx) micAudioCtx = createAudioContext();
        if (!micAudioCtx) {
          appendLog("mic audio pipeline unavailable here");
          for (const t of stream.getTracks()) t.stop();
          recordingStream = null;
          return;
        }
        if (micAudioCtx.state !== "running") {
          try { await micAudioCtx.resume(); } catch { }
        }

        if (micAudioCtx.state !== "running") {
          appendLog("mic audio blocked by browser. tap mic again after allowing autoplay/audio.");
          for (const t of stream.getTracks()) t.stop();
          recordingStream = null;
          return;
        }

        pcmSampleRate = micAudioCtx.sampleRate;

        micAnalyserNode = micAudioCtx.createAnalyser();
        micAnalyserNode.fftSize = 256;
        micAnalyserNode.smoothingTimeConstant = 0.4;

        runMicGlowRaf();

        // Build AudioContext + worklet
        const blobUrl = getWorkletBlobUrl();
        const ctx = micAudioCtx; // capture local assertion
        try {
          await ctx.audioWorklet.addModule(blobUrl);
          URL.revokeObjectURL(blobUrl);

          const source = ctx.createMediaStreamSource(stream);
          micSourceNode = source; // Prevent GC
          source.connect(micAnalyserNode);
          micWorkletNode = new AudioWorkletNode(ctx, "whisper-pcm-capture");
          micWorkletNode.port.onmessage = (ev) => {
            const payload = ev.data;
            if (payload instanceof Float32Array) {
              pcmChunks.push(payload);
              return;
            }
            // Back-compat with older message shape
            if (payload?.samples instanceof Float32Array) pcmChunks.push(payload.samples);
          };
          source.connect(micWorkletNode);
          // Connect to destination with zero gain — keeps the audio graph alive
          // without audible feedback
          micSinkNode = ctx.createGain();
          micSinkNode.gain.value = 0;
          micWorkletNode.connect(micSinkNode);
          micSinkNode.connect(ctx.destination);

          // Browser-specific guard: some engines create the worklet graph but never
          // deliver frames. If nothing arrives quickly, auto-fallback.
          if (micCaptureWatchdog) { clearTimeout(micCaptureWatchdog); micCaptureWatchdog = null; }
          micCaptureWatchdog = setTimeout(() => {
            micCaptureWatchdog = null;
            if (!recordingStream || pcmChunks.length > 0) return;
            appendLog("mic worklet produced no frames. this browser needs MediaRecorder or a working AudioWorklet path.");
            try { micWorkletNode?.disconnect(); } catch { }
            micWorkletNode = null;
            try { micSourceNode?.disconnect(); } catch { }
            micSourceNode = null;
            try { micSinkNode?.disconnect(); } catch { }
            micSinkNode = null;
            void stopRecording();
          }, 700);
        } catch (e) {
          console.warn("AudioWorklet capture unavailable:", e);
          URL.revokeObjectURL(blobUrl);
          appendLog("mic compatibility capture unavailable here. try a newer browser or one with MediaRecorder support.");
          for (const t of stream.getTracks()) t.stop();
          recordingStream = null;
          if (micAnalyserNode) {
            try { micAnalyserNode.disconnect(); } catch { }
            micAnalyserNode = null;
          }
          clearMicGlow();
          return;
        }
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

      recordingStart = Date.now();

      opts.chatMicWrap.setAttribute("data-recording", "true");
      opts.chatMicCancel.tabIndex = 0;
      opts.chatMicSend.tabIndex = 0;
      opts.chatMicBtn.tabIndex = -1;
      opts.chatInput.disabled = true;
      opts.chatInput.placeholder = "recording... 0:00";

      recordingTimer = setInterval(() => {
        const dur = formatRecordDuration(Date.now() - recordingStart);
        // Byte estimate from whichever capture pipeline is active.
        const totalSamples = pcmChunks.reduce((s, c) => s + c.length, 0);
        const estBytes = totalSamples > 0
          ? Math.ceil(totalSamples / 2)
          : recorderBytesEstimate();
        const size = estBytes > 0 ? ` · ${formatBytes(estBytes)}` : "";
        opts.chatInput.placeholder = `recording... ${dur}${size}`;
      }, 1000);

      if (micDeferred === "send") {
        micDeferred = null;
        // Wait at least a few ms for some samples to arrive before checking the length
        setTimeout(() => stopRecording(), 50);
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
    opts.chatMicCancel.removeAttribute("data-armed");
    opts.chatMicCancel.tabIndex = -1;
    opts.chatMicSend.tabIndex = -1;
    opts.chatMicBtn.tabIndex = 0;
    resetMicState();
    opts.chatInput.disabled = false;
    opts.chatInput.placeholder = "whisper something...";
    clearMicGlow();
  }

  function closeMicAudioContext(): void {
    const ctx = micAudioCtx;
    micAudioCtx = null;
    if (!ctx) return;
    try {
      void ctx.close();
    } catch { /* noop */ }
  }

  function cleanupRecordingStream(): void {
    if (micRecorder) {
      try {
        if (micRecorder.state !== "inactive") micRecorder.stop();
      } catch { }
      micRecorder = null;
    }
    micRecorderChunks = [];
    if (micCaptureWatchdog) {
      clearTimeout(micCaptureWatchdog);
      micCaptureWatchdog = null;
    }
    if (micSinkNode) {
      try { micSinkNode.disconnect(); } catch { }
      micSinkNode = null;
    }
    if (micWorkletNode) {
      try { micWorkletNode.disconnect(); } catch { }
      micWorkletNode = null;
    }
    if (micAnalyserNode) {
      try { micAnalyserNode.disconnect(); } catch { }
      micAnalyserNode = null;
    }
    if (micSourceNode) {
      try { micSourceNode.disconnect(); } catch { }
      micSourceNode = null;
    }
    if (recordingStream) {
      for (const t of recordingStream.getTracks()) t.stop();
      recordingStream = null;
    }
  }

  function stopRecordingSilently(closeAudioContext = false): void {
    recordingCancelled = true;
    teardownRecordingUI();
    pcmChunks = [];
    cleanupRecordingStream();
    if (micPending) micDeferred = "discard";
    if (closeAudioContext) closeMicAudioContext();
  }

  async function stopRecording(): Promise<void> {
    teardownRecordingUI();
    const elapsed = Date.now() - recordingStart;
    const chunks = pcmChunks;
    pcmChunks = [];
    const recovered = await extractPcmFromRecorder();
    cleanupRecordingStream();

    // A cancel (or a recovery-triggered stopRecordingSilently) may have landed while
    // the awaits above were in flight — don't resurrect and send audio for a recording
    // the user already discarded.
    if (recordingCancelled) return;

    // Discard sub-500ms squeaks
    if (elapsed < 500) return;
    if (!recovered && chunks.length === 0) {
      haptic("send-failed");
      appendLog("audio capture failed: no mic samples received");
      pulseComposeIntent("error", 1100);
      return;
    }
    haptic("recording-stop");

    let flat: Float32Array;
    if (recovered) {
      flat = recovered.pcm;
      pcmSampleRate = recovered.sampleRate;
    } else if (chunks.length > 0) {
      // Flatten accumulated 128-sample Float32 chunks into one
      const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
      flat = new Float32Array(totalSamples);
      let off = 0;
      for (const c of chunks) { flat.set(c, off); off += c.length; }
    } else {
      haptic("send-failed");
      appendLog("audio capture failed: no usable samples after extraction");
      pulseComposeIntent("error", 1100);
      return;
    }

    const name = `audio-${Date.now()}.wharm`;

    const encKey = session ? session.audioKey : undefined;

    dcBlock(flat); // remove mic DC bias before encryption
    encodeHarmonic(flat, pcmSampleRate, encKey, { quality: audioQuality }).then((harmonicBytes) => {
      if (!session) {
        const previewMsgId = -(++previewSendId);
        addChatMessage({
          type: "file", direction: "self",
          fileName: name, fileSize: harmonicBytes.length, fileType: HARMONIC_MIME,
          fileData: harmonicBytes, timestamp: Date.now(), msgId: previewMsgId,
        });
        simulateSendEnergy();
        return;
      }
      sendBeginFill();
      session.sendAudio(name, HARMONIC_MIME, harmonicBytes).then((msgId) => {
        if (msgId < 0) {
          send.phase = "delivered"; send.velocity = -4;
          haptic("send-failed");
          appendLog(`audio send skipped: session not ready (${session?.state ?? "unknown"})`);
          pulseComposeIntent("error", 1100);
          return;
        }
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
    stopRecordingSilently();
  }

  /* ── Active audio management ────────────────────────────── */

  function stopAllAudio(): void {
    if (activeAudio) {
      activeAudio.stopLoop();
      activeAudio.stop();
      setPlayIcon(activeAudio.btn, false);
      activeAudio.wrap.removeAttribute("data-playing");
      activeAudio.redraw(0);
      activeAudio = null;
    }
  }

  // ── Ogg/Opus encoder (browser-only, WebCodecs) ───────────────────────────

  /** CRC32 for Ogg pages — poly 0x04C11DB7, non-reflected. */
  function oggCrc32(data: Uint8Array): number {
    let crc = 0;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i] << 24;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 0x80000000) ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
        crc >>>= 0;
      }
    }
    return crc >>> 0;
  }

  function oggPage(packet: Uint8Array, serial: number, seq: number, granule: bigint, flags: number): Uint8Array {
    const segs: number[] = [];
    let rem = packet.length;
    while (rem >= 255) { segs.push(255); rem -= 255; }
    segs.push(rem);
    const hdrLen = 27 + segs.length;
    const page = new Uint8Array(hdrLen + packet.length);
    const dv = new DataView(page.buffer);
    page[0] = 0x4F; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53; // "OggS"
    page[4] = 0; page[5] = flags;
    dv.setBigInt64(6, granule, true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    dv.setUint32(22, 0, true);
    page[26] = segs.length;
    for (let i = 0; i < segs.length; i++) page[27 + i] = segs[i];
    page.set(packet, hdrLen);
    dv.setUint32(22, oggCrc32(page), true);
    return page;
  }

  function opusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
    const out = new Uint8Array(19);
    out.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
    const dv = new DataView(out.buffer);
    out[8] = 1; out[9] = channels;
    dv.setUint16(10, preSkip, true);
    dv.setUint32(12, inputSampleRate, true);
    dv.setInt16(16, 0, true); out[18] = 0;
    return out;
  }

  function opusTags(): Uint8Array {
    // "whisper" as ASCII bytes — avoids TextEncoder allocation
    const vendor = new Uint8Array([0x77, 0x68, 0x69, 0x73, 0x70, 0x65, 0x72]);
    const out = new Uint8Array(8 + 4 + vendor.length + 4);
    out.set([0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // "OpusTags"
    new DataView(out.buffer).setUint32(8, vendor.length, true);
    out.set(vendor, 12);
    return out;
  }

  /**
   * Encode float32 mono PCM → Ogg/Opus bytes using WebCodecs AudioEncoder.
   * Throws if WebCodecs is unavailable (old browsers).
   */
  async function opusFromPcm(pcm: Float32Array, sampleRate: number): Promise<Uint8Array> {
    // AudioEncoder / AudioData are WebCodecs APIs — not in all TypeScript DOM libs.
    // We access them via globalThis to avoid compile errors on older lib versions.
    type AudioEncoderLike = new (init: object) => {
      configure(c: object): void;
      encode(d: object): void;
      flush(): Promise<void>;
      close(): void;
    };
    type AudioDataLike = new (init: object) => { close(): void };
    const AE = (globalThis as Record<string, unknown>)["AudioEncoder"] as AudioEncoderLike | undefined;
    const AD = (globalThis as Record<string, unknown>)["AudioData"] as AudioDataLike | undefined;
    if (!AE || !AD) throw new Error("WebCodecs unavailable");
    const FRAME = 960; // 20 ms @ 48 kHz
    const SERIAL = 0x77685352;
    const frames: Uint8Array[] = [];
    let preSkip = 312;
    await new Promise<void>((resolve, reject) => {
      const enc = new AE({
        output(chunk: { byteLength: number; copyTo(b: Uint8Array): void }, meta: { decoderConfig?: { description?: ArrayBuffer } }) {
          if (frames.length === 0 && meta?.decoderConfig?.description) {
            const desc = new Uint8Array(meta.decoderConfig.description);
            if (desc.length >= 12) preSkip = new DataView(desc.buffer, desc.byteOffset).getUint16(10, true);
          }
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          frames.push(buf);
        },
        error: reject,
      });
      enc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 });
      const n = Math.ceil(pcm.length / FRAME);
      for (let f = 0; f < n; f++) {
        const data = new Float32Array(FRAME);
        data.set(pcm.subarray(f * FRAME, Math.min((f + 1) * FRAME, pcm.length)));
        const ad = new AD({ format: "f32-planar", sampleRate, numberOfFrames: FRAME, numberOfChannels: 1, timestamp: Math.round(f * FRAME * 1_000_000 / sampleRate), data });
        enc.encode(ad);
        ad.close();
      }
      enc.flush().then(() => { enc.close(); resolve(); }).catch(reject);
    });
    const pages: Uint8Array[] = [];
    let seq = 0;
    pages.push(oggPage(opusHead(1, preSkip, sampleRate), SERIAL, seq++, 0n, 0x02));
    pages.push(oggPage(opusTags(), SERIAL, seq++, 0n, 0x00));
    for (let i = 0; i < frames.length; i++) {
      const end = i === frames.length - 1 ? pcm.length : (i + 1) * FRAME;
      const eos = i === frames.length - 1 ? 0x04 : 0x00;
      pages.push(oggPage(frames[i], SERIAL, seq++, BigInt(end + preSkip), eos));
    }
    const total = pages.reduce((s, p) => s + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of pages) { out.set(p, off); off += p.byteLength; }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────

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
    if (raw.length === 0 || numBars <= 0) return new Float32Array(Math.max(0, numBars));

    // Trim tiny edge regions to avoid container/codec priming transients
    // (commonly visible as a single leading spike in otherwise silent clips).
    const edgeTrim = Math.min(Math.floor(raw.length * 0.02), 2048);
    const start = Math.min(edgeTrim, Math.max(0, raw.length - 1));
    const endBound = raw.length - edgeTrim;
    const end = Math.max(start + 1, endBound);
    const src = raw.subarray(start, end);

    if (src.length === 0) return new Float32Array(numBars);

    const blockSize = Math.max(1, Math.floor(src.length / numBars));
    const amps = new Float32Array(numBars);

    // Step 1-2: mean absolute amplitude per block
    let peak = 0;
    for (let i = 0; i < numBars; i++) {
      let sum = 0;
      const off = i * blockSize;
      const stop = Math.min(off + blockSize, src.length);
      for (let j = off; j < stop; j++) sum += Math.abs(src[j]);
      amps[i] = sum / Math.max(1, (stop - off));
      if (amps[i] > peak) peak = amps[i];
    }

    // Near-silence gate for cleaner visual silence on headless/no-input captures.
    if (peak < 0.003) return new Float32Array(numBars);

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
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const headX = clampedProgress * w;
    const hasHead = clampedProgress > 0.001 && clampedProgress < 0.999;

    for (let i = 0; i < n; i++) {
      const x = i * step + (step - bw) / 2;
      const barH = Math.max(WAVE_MIN_H, barHeights[i] * maxH);
      const y = (h - barH) / 2;
      const playedWidth = Math.max(0, Math.min(bw, headX - x));

      // Playhead proximity glow — falls off over ~3 bars
      const barCenterX = x + bw / 2;
      const dist = Math.abs(barCenterX - headX) / Math.max(step, 1);
      const g = hasHead && dist < 3.5 ? (1 - dist / 3.5) * 0.65 : 0;
      if (g > 0) { ctx.shadowColor = glowColor; ctx.shadowBlur = 6 * g; }
      else { ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; }

      ctx.fillStyle = unplayed;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, barH, r);
      ctx.fill();
      if (playedWidth >= bw) {
        ctx.fillStyle = played;
        ctx.beginPath();
        ctx.roundRect(x, y, bw, barH, r);
        ctx.fill();
      } else if (playedWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, playedWidth, barH);
        ctx.clip();
        ctx.fillStyle = played;
        ctx.beginPath();
        ctx.roundRect(x, y, bw, barH, r);
        ctx.fill();
        ctx.restore();
      }
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
    if (editingMsgId != null) return;       // editing — don't leak typing state
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
    if (pastePending) clearPasteState();
    if (!composing) return;
    composing = false;
    if (session) session.sendTyping(COMPOSE_CLEARED);
  }

  /* ── Smart scroll ──────────────────────────────────────── */

  // following the newest message is owned state, not an inference. reading
  // scrollTop at append time races the previous smooth scroll: mid-animation
  // the position looks like the user scrolled away and the follow silently
  // breaks under rapid messages. instead, only a genuine user gesture unpins
  // (wheel up, touch drag), returning to the bottom repins, and programmatic
  // scrolls are fenced so their own scroll events never masquerade as intent.
  let pinnedToBottom = true;
  let programmaticScrollUntil = 0;

  function isNearBottom(): boolean {
    const el = opts.chatMessages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function anchorToBottom(behavior: ScrollBehavior): void {
    programmaticScrollUntil = performance.now() + (behavior === "smooth" ? 700 : 180);
    opts.chatMessages.scrollTo({ top: opts.chatMessages.scrollHeight, behavior });
  }

  opts.chatMessages.addEventListener("wheel", (e) => {
    if (e.deltaY < 0) pinnedToBottom = false;
  }, { passive: true, signal });
  opts.chatMessages.addEventListener("touchmove", () => {
    pinnedToBottom = false;
  }, { passive: true, signal });
  opts.chatMessages.addEventListener("scroll", () => {
    if (performance.now() < programmaticScrollUntil) return;
    pinnedToBottom = isNearBottom();
  }, { passive: true, signal });

  function smartScroll(): void {
    if (pinnedToBottom) anchorToBottom("smooth");
  }

  /* ── Chat rendering ───────────────────────────────────── */

  const chatEmpty = opts.chatMessages.querySelector<HTMLElement>("#wl-chat-empty");

  /** Maps global msgId → message DOM element for ACK delivery, SEEN, and REACT lookups. */
  const msgById = new Map<number, HTMLElement>();

  /* ── Chunked file-transfer progress cards ──────────────────
   * Sends/receives over ~4 MB stream as application-level chunks (see
   * FILE_CHUNK_SIZE in live.ts). While a transfer is in flight we render a
   * live card — name, mono byte counter, energy track, cancel — keyed by
   * transferId. Inbound cards get replaced in place by the real file/media
   * message once the assembled blob arrives (mirrors the peer-draw-preview
   * merge above). Outbound cards settle into a quiet "delivered" mark first,
   * then (see morphOutboundTransferCard) morph into the same download
   * affordance the receiver gets, fed by the retained `file` below — a File
   * is disk-backed, so holding the reference costs nothing regardless of
   * transfer size, unlike keeping the raw bytes.
   */
  interface TransferCardState {
    transferId: number;
    direction: "in" | "out";
    wrapEl: HTMLElement;
    cardEl: HTMLElement;
    bytesEl: HTMLElement;
    trackEl: HTMLElement | null;
    cancelBtn: HTMLButtonElement | null;
    fileName: string;
    totalBytes: number;
    settled: boolean;
    // last cumulative bytesSent applied to this outbound card — lets onSendProgress
    // disambiguate between multiple in-flight sends that happen to share a totalBytes.
    bytesSent: number;
    // outbound only — the local File handle the user picked, retained so the sender
    // can render/download their own completed transfer. never read into memory here;
    // just a reference, released in clearChatArtifacts (see outboundFileRefs).
    file?: File;
  }

  const transferCards = new Map<number, TransferCardState>();

  // outbound transfer cards that are holding a retained File reference, so
  // clearChatArtifacts can null them out and let the underlying handle (and any
  // detached DOM it's still closed over) be garbage collected on chat clear.
  const outboundFileRefs = new Set<TransferCardState>();

  // set immediately before calling session.sendFile(file) and consumed inside the
  // synchronous prefix of onSendStart (which fires before sendFileChunked's first
  // await) — the one hop needed to thread the File from the send entry point into
  // the transfer card it triggers, without changing WhisperLiveSession's callback
  // signature.
  let pendingOutboundFile: File | null = null;

  /** True if any card (either direction) hasn't settled yet — delivered/cancelled cards
   *  are pruned from transferCards as soon as they resolve, so this is just a scan over
   *  whatever's left in flight, never more than a couple of entries in practice. Backs
   *  the beforeunload guard and the screen wake lock. */
  function hasActiveTransfers(): boolean {
    for (const state of transferCards.values()) {
      if (!state.settled) return true;
    }
    return false;
  }

  /* ── Screen wake lock ── keep the display on for the duration of a chunked
   * transfer so a phone screen timeout doesn't stall an in-progress send/receive.
   * Feature-detected (Firefox has no navigator.wakeLock); acquisition failures
   * (e.g. NotAllowedError when the tab isn't visible) are silent no-ops — the
   * transfer still runs, we just can't guarantee the screen stays lit for it.
   */
  let wakeLockSentinel: WakeLockSentinel | null = null;

  async function acquireTransferWakeLock(): Promise<void> {
    if (wakeLockSentinel || !("wakeLock" in navigator)) return;
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (wakeLockSentinel === sentinel) wakeLockSentinel = null;
      }, { signal });
    } catch {
      wakeLockSentinel = null;
    }
  }

  function releaseTransferWakeLock(): void {
    const sentinel = wakeLockSentinel;
    if (!sentinel) return;
    wakeLockSentinel = null; // clear first — guards re-entrant release from the "release" listener above
    sentinel.release().catch(() => {});
  }

  /** Called after any card settles (delivered/cancelled/replaced) — drops the lock
   *  once nothing's left in flight. */
  function maybeReleaseTransferWakeLock(): void {
    if (!hasActiveTransfers()) releaseTransferWakeLock();
  }

  // Wake locks auto-release when the tab is hidden — reclaim it on return if a
  // transfer is still going.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !wakeLockSentinel && hasActiveTransfers()) {
      void acquireTransferWakeLock();
    }
  }, { signal });

  // Warn before leaving mid-transfer — standard cross-browser confirm pattern, browsers
  // render their own generic text so the returnValue string itself is ignored.
  window.addEventListener("beforeunload", (e) => {
    if (!hasActiveTransfers()) return;
    e.preventDefault();
    e.returnValue = "";
  }, { signal });

  function formatTransferBytes(current: number, total: number): string {
    return `${formatSize(current)} / ${formatSize(total)}`;
  }

  /** Build a live progress card and drop it into the chat like a normal message bubble. */
  function buildTransferCard(direction: "in" | "out", transferId: number, fileName: string, totalBytes: number): TransferCardState {
    const wrapEl = document.createElement("div");
    wrapEl.className = `wl-msg wl-msg--${direction === "in" ? "peer" : "self"}`;
    wrapEl.dataset.transferId = String(transferId);

    const cardEl = document.createElement("div");
    cardEl.className = "wl-msg-file wl-msg-transfer";
    cardEl.dataset.transferState = "active";

    const nameEl = document.createElement("span");
    nameEl.className = "wl-msg-file-name";
    nameEl.textContent = fileName;

    const bytesEl = document.createElement("span");
    bytesEl.className = "wl-msg-file-size wl-transfer-bytes";
    bytesEl.textContent = formatTransferBytes(0, totalBytes);

    const trackEl = document.createElement("div");
    trackEl.className = "wl-transfer-track";
    const fillEl = document.createElement("div");
    fillEl.className = "wl-transfer-fill";
    trackEl.appendChild(fillEl);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "wl-transfer-cancel";
    cancelBtn.setAttribute("aria-label", "Cancel transfer");
    cancelBtn.textContent = "×";
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (direction === "in") session?.cancelIncomingTransfer(transferId);
      else session?.cancelFileTransfer(transferId);
    }, { signal });

    cardEl.append(nameEl, bytesEl, trackEl, cancelBtn);
    wrapEl.appendChild(cardEl);

    const timeEl = document.createElement("time");
    timeEl.className = "wl-msg-time";
    const now = Date.now();
    timeEl.dateTime = String(now);
    timeEl.textContent = formatTime(now);
    wrapEl.appendChild(timeEl);

    if (chatEmpty && chatEmpty.parentNode) chatEmpty.remove();
    opts.chatMessages.appendChild(wrapEl);
    if (direction === "out") {
      pinnedToBottom = true;
      requestAnimationFrame(() => anchorToBottom("instant"));
    } else {
      smartScroll();
    }

    const state: TransferCardState = {
      transferId, direction, wrapEl, cardEl, bytesEl, trackEl, cancelBtn,
      fileName, totalBytes, settled: false, bytesSent: 0,
    };
    transferCards.set(transferId, state);
    void acquireTransferWakeLock();
    return state;
  }

  function updateTransferCardProgress(state: TransferCardState, current: number, total: number): void {
    if (state.settled) return;
    const ratio = total > 0 ? Math.min(1, current / total) : 0;
    state.wrapEl.style.setProperty("--wl-transfer-ratio", String(ratio));
    state.bytesEl.textContent = formatTransferBytes(Math.min(current, total), total);
  }

  /** Strip the live progress affordances, leaving whatever settled card state remains. */
  function retireTransferChrome(state: TransferCardState): void {
    state.trackEl?.remove();
    state.cancelBtn?.remove();
    state.trackEl = null;
    state.cancelBtn = null;
  }

  function collapseTransferCancelled(transferId: number): void {
    const state = transferCards.get(transferId);
    if (!state || state.settled) return;
    state.settled = true;
    retireTransferChrome(state);
    state.cardEl.dataset.transferState = "cancelled";
    state.bytesEl.textContent = "transfer cancelled";
    transferCards.delete(transferId);
    maybeReleaseTransferWakeLock();
  }

  /** Re-attach live progress chrome to the settled self-file card that just replaced
   *  the outbound placeholder, so the remaining chunks keep animating it in place. */
  function rehostOutboundTransferChrome(state: TransferCardState, newWrapEl: HTMLElement, newCardEl: HTMLElement): void {
    state.wrapEl = newWrapEl;
    state.cardEl = newCardEl;
    newWrapEl.dataset.transferId = String(state.transferId);
    const bytesEl = newCardEl.querySelector<HTMLElement>(".wl-msg-file-size");
    if (bytesEl) {
      bytesEl.classList.add("wl-transfer-bytes");
      state.bytesEl = bytesEl;
    }
    const trackEl = document.createElement("div");
    trackEl.className = "wl-transfer-track";
    const fillEl = document.createElement("div");
    fillEl.className = "wl-transfer-fill";
    trackEl.appendChild(fillEl);
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "wl-transfer-cancel";
    cancelBtn.setAttribute("aria-label", "Cancel transfer");
    cancelBtn.textContent = "×";
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      session?.cancelFileTransfer(state.transferId);
    }, { signal });
    newCardEl.append(trackEl, cancelBtn);
    state.trackEl = trackEl;
    state.cancelBtn = cancelBtn;
    newCardEl.dataset.transferState = "active";
    updateTransferCardProgress(state, 0, state.totalBytes);
  }

  function settleOutboundTransferDelivered(transferId: number): void {
    const state = transferCards.get(transferId);
    if (!state || state.settled) return;
    state.settled = true;
    retireTransferChrome(state);
    state.cardEl.dataset.transferState = "delivered";
    const badge = document.createElement("span");
    badge.className = "wl-transfer-delivered";
    badge.textContent = "delivered";
    state.cardEl.appendChild(badge);
    transferCards.delete(transferId);
    maybeReleaseTransferWakeLock();
    // give "delivered" a beat to register, then morph into the real download
    // affordance — see morphOutboundTransferCard.
    if (state.file) setTimeout(() => morphOutboundTransferCard(state, badge), 1200);
  }

  /** Lazily save a retained outbound File — the object URL is created on click
   *  rather than up front, so a completed multi-GB transfer never holds a live
   *  blob URL open just in case the sender revisits it. Mirrors downloadGlyphAsPng's
   *  create → click → revoke shape. */
  function downloadRetainedFile(file: File, fileName: string): void {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /** 1.2s after an outbound chunked transfer settles as "delivered", morph the
   *  card's action area into the same download affordance the receiver's finished
   *  card gets for the identical file — reuses detectMedia + renderMediaMessage,
   *  the exact same construction the receive path uses for image/video/glyph, fed
   *  a synthetic self message whose fileBlob is the retained File (a File IS a
   *  Blob, so no bytes are read here). Generic (non-media) files keep the card's
   *  existing name/size row and only grow a download link, matching the class the
   *  receiver's generic-file row uses. The badge fades out, the affordance fades
   *  in — opacity only, so the media case's own thumbnail is the only thing that
   *  grows the card; the generic case swaps in place with no shift at all. */
  function morphOutboundTransferCard(state: TransferCardState, badge: HTMLElement): void {
    const file = state.file;
    if (!file || !state.wrapEl.isConnected) return;

    const msg: LiveMessage = {
      type: "file", direction: "self",
      fileName: state.fileName, fileSize: state.totalBytes, fileType: file.type,
      fileBlob: file, timestamp: Date.now(),
    };
    const isMedia = detectMedia(msg) !== null;

    const buildAffordance = (): HTMLElement => {
      if (isMedia) return renderMediaMessage(msg, signal, null);
      // generic file: same "download" wording/class as the receiver's card, but a
      // lazy click-time object URL instead of an eager one (see downloadRetainedFile).
      const link = document.createElement("a");
      link.className = "wl-msg-file-download";
      link.href = "#";
      link.textContent = "download";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        if (state.file) downloadRetainedFile(state.file, state.fileName);
      }, { signal });
      return link;
    };

    const swapIn = (): void => {
      if (!state.wrapEl.isConnected) return;
      const fresh = buildAffordance();
      if (!reduceMotion) fresh.style.opacity = "0";
      if (isMedia) {
        state.wrapEl.replaceChild(fresh, state.cardEl);
        state.cardEl = fresh;
      } else {
        state.cardEl.appendChild(fresh);
      }
      if (reduceMotion) return;
      fresh.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease" })
        .finished.then(() => { fresh.style.opacity = ""; }).catch(() => { fresh.style.opacity = ""; });
    };

    if (reduceMotion) {
      badge.remove();
      swapIn();
      return;
    }
    const fadeOut = badge.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease", fill: "forwards" });
    fadeOut.finished.then(() => { badge.remove(); swapIn(); }).catch(() => { badge.remove(); swapIn(); });
  }

  function addChatMessage(msg: LiveMessage): void {
    // Hide empty-state hint on first real message
    if (chatEmpty && chatEmpty.parentNode) chatEmpty.remove();

    // consume draw preview early — covers both glyph and annotate paths
    const drawPreview = (msg.direction === "self" && msg.type === "file")
      ? consumeDrawPreview() : null;

    const media = msg.type === "file" ? detectMedia(msg) : null;

    // If a streamed peer preview exists, replace it in-place with the finalized
    // message so it keeps the same visual location in the chat flow.
    // Use session state (drawState === "sent") as the merge signal — it is set
    // by the "end" draw event which always arrives before the file over the
    // same ordered DataChannel. This covers both glyph (blank canvas) and
    // annotation (PNG/JPEG composite) without inspecting the file type.
    const replacePeerPreview =
      msg.direction === "peer"
        && msg.type === "file"
        && !!peerLiveMsgEl
        && peerLiveMsgEl.parentElement === opts.chatMessages
        && (
          peerLiveMsgEl.dataset.drawState === "sent"
          // Backstop for older peers/edge ordering where drawState may miss "sent".
          || isWhisperGlyph(msg.fileType, msg.fileName)
        )
        ? peerLiveMsgEl
        : null;
    // continuity beats ground truth: if the preview thumb never got its
    // inline aspect stamped, fall back to the stroke-space dims the preview
    // actually rendered with, so the final message matches the box it grew
    // from instead of snapping to a differently derived size.
    const replacePeerPreviewAspectRatio =
      (replacePeerPreview?.querySelector<HTMLElement>(".wl-msg-peer-draw-thumb")?.style.aspectRatio ?? "")
      || (replacePeerPreview && peerStrokeSpaceW > 0 && peerStrokeSpaceH > 0
        ? `${peerStrokeSpaceW} / ${peerStrokeSpaceH}`
        : "");
    const replacePeerPreviewSnapshot = capturePeerDrawThumbSnapshot(replacePeerPreview);
    const mergePeerStreamFinal =
      !!replacePeerPreview
      && msg.direction === "peer"
      && msg.type === "file"
      && !!media
      && (media.kind === "glyph" || media.kind === "image");
    const replacePreviewWasNearBottom = replacePeerPreview ? (pinnedToBottom || isNearBottom()) : false;
    if (replacePeerPreview) {
      peerActiveStroke = null;
      peerActivePoints = [];
      peerStrokes = [];
      peerRedoStack = [];
      peerBaseAssembly = null;
      peerStrokeSpaceW = 0;
      peerStrokeSpaceH = 0;
      clearPeerBaseImage();
      peerBgCanvas?.remove();
      peerBgCanvas = null;
      if (peerCanvas) {
        peerCanvas.remove();
        peerCanvas = null;
        peerCtx = null;
      }
      peerLiveMsgEl = null;
      peerLiveTimeEl = null;
    }

    // ── Chunked-transfer card resolution ──
    // Inbound: the assembled file/media message replaces the live progress card.
    // Outbound: the chunk-0 self echo (no fileData — see sendFileChunked) replaces
    // the placeholder card, which then gets its progress chrome re-hosted below.
    // resolve chunked-transfer cards by transferId (set on inbound assemblies and
    // the outbound chunk-0 self-echo — see LiveMessage.transferId); small files sent
    // via sendRaw never get a card, so an absent transferId just falls through to a
    // normal append below.
    const resolvingInboundTransfer =
      msg.direction === "peer" && msg.type === "file" && msg.transferId != null
        ? transferCards.get(msg.transferId) ?? null
        : null;
    const resolvingOutboundTransfer =
      msg.direction === "self" && msg.type === "file" && msg.transferId != null
        ? transferCards.get(msg.transferId) ?? null
        : null;
    const resolvingTransferWasNearBottom = resolvingInboundTransfer ? (pinnedToBottom || isNearBottom()) : false;

    const div = document.createElement("div");
    div.className = `wl-msg wl-msg--${msg.direction}`;

    if (msg.type === "text") {
      const textEl = document.createElement("span");
      textEl.className = "wl-msg-text";
      textEl.textContent = msg.text ?? "";
      div.appendChild(textEl);
    } else if (isRenderableAudioMessage(msg)) {
      const fileData = msg.fileData;
      if (!fileData) return;
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

      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "wl-audio-dl-btn";
      dlBtn.title = "Download as WAV";
      dlBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 1v8M3.5 6l3.5 3.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 11h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

      audioEl.append(playBtn, canvas, durLabel, dlBtn);

      // we don't need a blob URL for custom Harmonic codec playback
      const isWhisperCodec = isWhisperAudioCodec(msg.fileType, msg.fileName);
      const abCopy = new ArrayBuffer(fileData.byteLength);
      new Uint8Array(abCopy).set(fileData);

      let pcmData: Float32Array | null = null;
      let durationSeconds = 0;

      let audioElement: HTMLAudioElement | null = null;
      let opusBlobUrl: string | null = null; // for playback (HTMLAudioElement)
      let wavBlobUrl: string | null = null;  // for download (lossless)
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
        if (isPlaying && durationSeconds > 0 && audioElement) {
          const elapsed = audioElement.currentTime;
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
          if (isWhisperCodec) {
            const decKey = session ? session.audioKey : undefined;
            const decoded = await decodeHarmonic(new Uint8Array(abCopy), decKey);
            if (decoded.tampered) {
              throw new Error("Audio payload failed MAC verification. Packet was tampered with.");
            }
            inverseDcBlock(decoded.pcm); // reconstruct signal prior to encode-side DC block
            pcmData = decoded.pcm;
            durationSeconds = decoded.pcm.length / decoded.sampleRate;

            // WAV — lossless, always available, used for download
            const wav = wavFromPcm(decoded.pcm, decoded.sampleRate);
            wavBlobUrl = URL.createObjectURL(new Blob([wav.buffer.slice(0) as ArrayBuffer], { type: "audio/wav" }));
            objectUrls.add(wavBlobUrl);

            // Opus — for playback; only if the browser can actually play Ogg/Opus.
            // Safari has AudioEncoder but doesn't support the Ogg container, so we
            // must check canPlayType before encoding, not just check for AudioEncoder.
            const canPlayOpus = new Audio().canPlayType("audio/ogg; codecs=opus") !== "";
            if (canPlayOpus) {
              try {
                const opus = await opusFromPcm(decoded.pcm, decoded.sampleRate);
                opusBlobUrl = URL.createObjectURL(new Blob([opus.buffer.slice(0) as ArrayBuffer], { type: "audio/ogg; codecs=opus" }));
                objectUrls.add(opusBlobUrl);
              } catch {
                opusBlobUrl = wavBlobUrl;
              }
            } else {
              opusBlobUrl = wavBlobUrl;
            }
          } else {
            // unused fallback for non-Harmonic audio formats
            const actx = createAudioContext();
            if (!actx) throw new Error("audio decode unavailable");
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
          // Decoding failed — mark the play control unavailable instead of
          // leaving it looking clickable with nothing behind it.
          playBtn.setAttribute("aria-disabled", "true");
          playBtn.title = "audio unavailable";
        }
      });

      // ── HTMLAudioElement Playback ──

      function stopInternal(): void {
        if (audioElement) {
          try { audioElement.pause(); } catch { }
        }
        isPlaying = false;
        // Note: pauseOffset is NOT reset here — callers manage it.
        // stopAllAudio() and onended reset it to 0; pause path preserves it.
      }

      playBtn.addEventListener("click", async () => {
        if (playBtn.getAttribute("aria-disabled") === "true") return; // decode failed
        if (!pcmData || !opusBlobUrl) return; // not decoded yet

        if (isPlaying) {
          if (audioElement) pauseOffset = audioElement.currentTime;
          stopInternal(); // preserves pauseOffset

          stopPlaybackLoop();
          audioEl.removeAttribute("data-playing");
          setPlayIcon(playBtn, false);
          if (activeAudio?.btn === playBtn) activeAudio = null;
          return;
        }

        // Start playback
        stopAllAudio();

        if (!audioElement) {
          audioElement = new Audio(opusBlobUrl);
          audioElement.onended = () => {
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
        }

        // If we reached the end, loop back around
        if (pauseOffset >= durationSeconds - 0.05) pauseOffset = 0;

        audioElement.currentTime = pauseOffset;
        try {
          await audioElement.play();
          isPlaying = true;
          setPlayIcon(playBtn, true);
          audioEl.setAttribute("data-playing", "");
          startPlaybackLoop();
          activeAudio = { stop: stopInternal, stopLoop: stopPlaybackLoop, btn: playBtn, wrap: audioEl, redraw };
        } catch (err) {
          console.error("[whisper] audio playback failed:", err);
          stopInternal();
          setPlayIcon(playBtn, false);
        }
      }, { signal });

      dlBtn.addEventListener("click", async () => {
        if (!isWhisperCodec || dlBtn.disabled || !wavBlobUrl) return;
        dlBtn.disabled = true;
        try {
          const base = msg.fileName?.endsWith(".wharm")
            ? msg.fileName.slice(0, -6)
            : `audio-${msg.timestamp || Date.now()}`;
          const a = document.createElement("a");
          a.style.display = "none";
          a.href = wavBlobUrl;
          a.download = `${base}.wav`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => document.body.removeChild(a), 1000);
        } catch (e) {
          console.error("Failed to export audio for download", e);
        } finally {
          dlBtn.disabled = false;
        }
      }, { signal });

      // Click on waveform canvas to seek (and keep the event from toggling
      // the reaction shelf on the parent message bubble).
      canvas.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!pcmData || !durationSeconds || !audioElement) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        pauseOffset = ratio * durationSeconds;
        audioElement.currentTime = pauseOffset;
        redraw(ratio);
        durLabel.textContent = formatAudioDuration(pauseOffset);
      }, { signal });

      div.appendChild(audioEl);
    } else if (media !== null) {
      const merged = mergePeerStreamFinal
        ? renderMergedPeerDrawMessage(msg, signal, replacePeerPreviewAspectRatio, replacePeerPreviewSnapshot)
        : null;
      if (merged) {
        div.appendChild(merged);
      } else {
        div.appendChild(renderMediaMessage(msg, signal, drawPreview));
      }
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

      if (hasFilePayload(msg)) {
        // always use octet-stream for received files — never let the browser interpret
        // peer-declared MIME types (prevents HTML/SVG/etc. execution via blob URL).
        // the download attribute + file extension ensure the OS opens files correctly.
        const blob = filePayloadBlob(msg, "application/octet-stream");
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
      // connection-lifecycle notices render as a seam in the timeline (a
      // hairline scar across the chat) rather than a floating pill: the
      // interruption is an event that happened to the timeline, not a
      // message inside it. the seam shimmers while recovery is live (css
      // keys off .wl-recovering on the surface) and settles to a quiet
      // scar once the moment passes.
      if (/reconnect/i.test(msg.text ?? "")) {
        div.classList.add("wl-msg--seam");
      }
      div.appendChild(sysEl);
    }

    const timeEl = document.createElement("time");
    timeEl.className = "wl-msg-time";
    timeEl.dateTime = String(msg.timestamp);
    // the timestamp text lives in its own span so the 12h/24h toggle can
    // rewrite it without destroying siblings (the receipt dot lives here too).
    const timeTextEl = document.createElement("span");
    timeTextEl.className = "wl-msg-time-text";
    timeTextEl.textContent = formatTime(msg.timestamp);
    timeEl.appendChild(timeTextEl);
    div.appendChild(timeEl);

    // tiny sent/delivered/seen dot for self text + file bubbles — a subtle
    // status glyph, no checkmarks. wl-msg--delivered / wl-msg--seen classes
    // land on `div` itself (see handleAck / markSeen) and drive its look via CSS.
    // Nested inside timeEl so it sits inline right after the timestamp text.
    if (msg.direction === "self" && (msg.type === "text" || msg.type === "file")) {
      const receiptEl = document.createElement("span");
      receiptEl.className = "wl-msg-receipt";
      receiptEl.setAttribute("aria-hidden", "true");
      timeEl.appendChild(receiptEl);
    }

    if (msg.direction === "peer") hidePeerTyping();

    // draw → message dissolve: cross-fade with the draw overlay's 200 ms
    // opacity transition instead of the default slide-in entrance
    if (drawPreview && !reduceMotion) {
      div.style.animation = "none";
      div.animate(
        [{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "scale(1)" }],
        { duration: 260, delay: 80, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
      );
    }

    if (replacePeerPreview && replacePeerPreview.parentElement === opts.chatMessages) {
      opts.chatMessages.replaceChild(div, replacePeerPreview);
      // the peer's streamed drawing becomes the real message: give the swap
      // the same dissolve the self path gets, so it reads as one continuous
      // object settling rather than a hard node replacement.
      if (mergePeerStreamFinal && !reduceMotion) {
        div.style.animation = "none";
        div.animate(
          [{ opacity: 0.55, transform: "scale(0.985)" }, { opacity: 1, transform: "scale(1)" }],
          { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
        );
      }
    } else if (resolvingInboundTransfer && resolvingInboundTransfer.wrapEl.parentElement === opts.chatMessages) {
      opts.chatMessages.replaceChild(div, resolvingInboundTransfer.wrapEl);
      resolvingInboundTransfer.settled = true;
      transferCards.delete(resolvingInboundTransfer.transferId);
      maybeReleaseTransferWakeLock();
    } else if (resolvingOutboundTransfer && resolvingOutboundTransfer.wrapEl.parentElement === opts.chatMessages) {
      opts.chatMessages.replaceChild(div, resolvingOutboundTransfer.wrapEl);
      const newFileCard = div.querySelector<HTMLElement>(".wl-msg-file");
      if (newFileCard) rehostOutboundTransferChrome(resolvingOutboundTransfer, div, newFileCard);
    } else {
      opts.chatMessages.appendChild(div);
    }

    // Self → sending is following: repin and snap (deferred so layout
    // includes the new node). System/Peer → smooth-follow while pinned.
    if (msg.direction === "self") {
      pinnedToBottom = true;
      requestAnimationFrame(() => anchorToBottom("instant"));
    } else if (msg.direction === "system") {
      smartScroll();
    } else if (
      (replacePeerPreview && replacePreviewWasNearBottom)
      || (resolvingInboundTransfer && resolvingTransferWasNearBottom)
    ) {
      requestAnimationFrame(() => anchorToBottom("instant"));
    } else if (msg.direction === "peer") {
      smartScroll();
    }

    if (msg.msgId !== undefined) {
      div.dataset.msgId = String(msg.msgId);
      // byte count for the reaction shelf's status caption (see
      // formatShelfCaption) — derived once here rather than re-measured at
      // shelf-open time, since msg.text/fileData may already be gone by then.
      if (msg.type === "text") {
        div.dataset.wlBytes = String(new TextEncoder().encode(msg.text ?? "").length);
      } else if (msg.type === "file" && msg.fileSize != null) {
        div.dataset.wlBytes = String(msg.fileSize);
      }
      msgById.set(msg.msgId, div);
      const allowReactions = !isTransientDrawPreviewMessage(div);
      if (allowReactions) {
        // Tap the message bubble to open/close the shared reaction shelf,
        // retargeting it to this message. The shelf itself is built once
        // (see the reaction-shelf block above) — it lives outside the
        // message flow, so opening it here never touches this div's layout.
        div.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          // Ignore clicks on reaction pills (separate, in-bubble, untouched)
          if (target.closest(".wl-reaction")) return;
          // Keep media/audio controls interactive; non-control regions open the shelf.
          if (target.closest(".wl-audio-play-btn")) return;
          if (target.closest(".wl-audio-dl-btn")) return;
          if (target.closest(".wl-msg-file-download")) return;
          // Ignore lightbox/download controls, but allow media info-bar taps
          // (including finalized draw cards) to toggle the reaction shelf.
          if (target.closest(".wl-media-thumb")) return;
          if (target.closest(".wl-media-dl")) return;
          // Ignore clicks on timestamps (which toggle time format)
          if (target.closest(".wl-msg-time")) return;

          if (shelfTarget?.msgEl === div) {
            closeReactionShelf();
          } else {
            const bubbleEl = (div.firstElementChild as HTMLElement | null) ?? div;
            openReactionShelf(div, bubbleEl);
          }
        }, { signal });
      } else {
        div.dataset.reactionsDisabled = "true";
      }
    }

    if (msg.direction === "peer") {
      // Haptic: distinguish text from file/audio messages
      if (msg.type === "file") haptic("file-received");
      else if (msg.type === "text") haptic("msg-received");
      bumpUnread();
      nudgeAudio();
      // honest SEEN: only when the tab is visible AND the window focused —
      // otherwise the receipt would claim eyes that were not here. deferred
      // msgIds flush the moment attention genuinely returns.
      if (msg.msgId !== undefined) {
        if (!document.hidden && hasFocus && session) {
          session.sendCtrl(CTRL_OP.SEEN, encodeSeenPayload(msg.msgId));
        } else {
          pendingSeen.add(msg.msgId);
        }
      }
    }
    updateControls();
  }

  /* ── Remote peer drawing overlay ─────────────────────────────── */

  type PeerPoint = Record<GlyphChannelName, number>;

  interface PeerStrokeRecord {
    points: PeerPoint[];
    color: string;
    width: number;
    tool: "pen" | "eraser";
  }

  interface PeerActiveStroke {
    strokeId: number;
    decoder: GlyphStreamDecoder;
    color: string;
    width: number;
    tool: "pen" | "eraser";
    lastNX: number;   // normalized x (0..1) — canvas-size-independent
    lastNY: number;   // normalized y (0..1)
    lastP: number;
    lastMidNX: number; // normalized mid x
    lastMidNY: number; // normalized mid y
    hasLastMid: boolean;
  }

  let peerCanvas: HTMLCanvasElement | null = null;
  let peerCtx: CanvasRenderingContext2D | null = null;
  let peerBgCanvas: HTMLCanvasElement | null = null;
  let peerLiveMsgEl: HTMLDivElement | null = null;
  let peerLiveTimeEl: HTMLTimeElement | null = null;
  let peerBaseImage: HTMLImageElement | null = null;
  let peerBaseImageUrl: string | null = null;
  let peerBaseLoadToken = 0;
  let peerBaseAssembly: {
    snapshotId: number;
    width: number;
    height: number;
    mime: "image/jpeg" | "image/webp" | "image/png";
    chunkCount: number;
    chunks: Array<Uint8Array | null>;
    received: number;
  } | null = null;
  let peerActiveStroke: PeerActiveStroke | null = null;
  let peerActivePoints: PeerPoint[] = [];
  let peerStrokes: PeerStrokeRecord[] = [];
  let peerRedoStack: PeerStrokeRecord[] = [];
  let peerStrokeSpaceW = 0;
  let peerStrokeSpaceH = 0;
  let peerRafPending = false;
  let peerPreviewResizeObserver: ResizeObserver | null = null;

  function clamp01(v: number): number {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  function isFiniteNorm(v: number): boolean {
    return Number.isFinite(v) && v >= 0 && v <= 1;
  }

  function isFinitePressure(v: number): boolean {
    return Number.isFinite(v) && v >= -0.25 && v <= 1.25;
  }

  function drawPeerBackground(cw: number, ch: number): void {
    if (!peerBgCanvas) return;
    const bgCtx = peerBgCanvas.getContext("2d");
    if (!bgCtx) return;
    bgCtx.clearRect(0, 0, cw, ch);
    bgCtx.fillStyle = "#1a1a1a";
    bgCtx.fillRect(0, 0, cw, ch);
    if (peerBaseImage) {
      bgCtx.drawImage(peerBaseImage, 0, 0, cw, ch);
    }
  }

  function clearPeerBaseImage(): void {
    peerBaseImage = null;
    peerBaseLoadToken++;
    if (peerBaseImageUrl) {
      URL.revokeObjectURL(peerBaseImageUrl);
      peerBaseImageUrl = null;
    }
  }

  function removeLegacyPeerOverlays(): void {
    const legacy = document.querySelectorAll(".wl-peer-draw");
    for (const node of legacy) node.remove();
  }

  function setPeerLiveDrawState(state: "active" | "sent" | "clear" | "idle"): void {
    if (!peerLiveMsgEl) return;
    peerLiveMsgEl.dataset.drawState = state;
    const box = peerLiveMsgEl.querySelector<HTMLElement>(".wl-msg-peer-draw");
    if (box) box.dataset.drawState = state;
  }

  function promotePeerPreviewToMessageShell(): void {
    if (!peerLiveMsgEl) return;
    peerLiveMsgEl.classList.remove("wl-msg--peer-draw-live");
    peerLiveMsgEl.classList.add("wl-msg--peer");
  }

  function ensurePeerCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    removeLegacyPeerOverlays();
    if (!peerCanvas || !peerCtx) {
      if (!peerLiveMsgEl) {
        const div = document.createElement("div");
        div.className = "wl-msg wl-msg--peer wl-msg--peer-draw-live";
        div.dataset.drawState = "idle";

        const media = document.createElement("div");
        media.className = "wl-msg-media wl-msg-peer-draw";
        media.dataset.drawState = "idle";

        const thumb = document.createElement("div");
        thumb.className = "wl-media-thumb wl-msg-peer-draw-thumb";
        media.appendChild(thumb);

        const ts = Date.now();
        const timeEl = document.createElement("time");
        timeEl.className = "wl-msg-time";
        timeEl.dateTime = String(ts);
        timeEl.textContent = formatTime(ts);

        div.append(media, timeEl);
        opts.chatMessages.appendChild(div);
        peerLiveMsgEl = div;
        peerLiveTimeEl = timeEl;
        smartScroll();
      }

      const host = peerLiveMsgEl.querySelector<HTMLElement>(".wl-msg-peer-draw-thumb");
      if (!host) throw new Error("peer draw host missing");
      if (!peerPreviewResizeObserver && typeof ResizeObserver !== "undefined") {
        peerPreviewResizeObserver = new ResizeObserver(() => schedulePeerRerender());
        peerPreviewResizeObserver.observe(host);
      }
      const dpr = devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width));
      const ch = Math.max(1, Math.round(rect.height));
      // If layout hasn't resolved yet (rect = 0), schedule a corrective rerender
      // for the next frame so the canvas gets the right dimensions.
      if (rect.width === 0 || rect.height === 0) {
        schedulePeerRerender();
      }

      peerBgCanvas = document.createElement("canvas");
      peerBgCanvas.className = "wl-peer-draw-bg";
      peerBgCanvas.setAttribute("aria-hidden", "true");

      peerCanvas = document.createElement("canvas");
      peerCanvas.className = "wl-peer-draw-inline";
      peerCanvas.setAttribute("aria-hidden", "true");

      host.appendChild(peerBgCanvas);  // bottom layer first
      host.appendChild(peerCanvas);    // drawing layer on top

      peerBgCanvas.width = peerCanvas.width = Math.max(1, Math.round(cw * dpr));
      peerBgCanvas.height = peerCanvas.height = Math.max(1, Math.round(ch * dpr));

      const peerBgCtx = peerBgCanvas.getContext("2d")!;
      peerBgCtx.scale(dpr, dpr);
      drawPeerBackground(cw, ch);

      peerCtx = peerCanvas.getContext("2d")!;
      peerCtx.scale(dpr, dpr);
    }
    return { canvas: peerCanvas, ctx: peerCtx };
  }

  function peerCanvasW(): number {
    return peerCanvas ? peerCanvas.width / (devicePixelRatio || 1) : window.innerWidth;
  }

  function peerCanvasH(): number {
    return peerCanvas ? peerCanvas.height / (devicePixelRatio || 1) : window.innerHeight;
  }

  function peerStrokeWidthScale(W: number, H: number): number {
    if (peerStrokeSpaceW <= 0 || peerStrokeSpaceH <= 0) return 1;
    const sx = W / peerStrokeSpaceW;
    const sy = H / peerStrokeSpaceH;
    const s = Math.min(sx, sy);
    if (!Number.isFinite(s)) return 1;
    return Math.max(0.08, Math.min(8, s));
  }

  function peerDrawSeg(
    ctx: CanvasRenderingContext2D,
    fromX: number, fromY: number,
    ctrlX: number, ctrlY: number,
    toX: number, toY: number,
    width: number, pressure: number, pressureSens: boolean,
  ): void {
    const w = pressureSens ? width * (0.3 + pressure * 0.7) : width;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.quadraticCurveTo(ctrlX, ctrlY, toX, toY);
    ctx.stroke();
  }

  function peerRenderStroke(
    ctx: CanvasRenderingContext2D,
    stroke: PeerStrokeRecord,
    widthScale: number,
    W: number, H: number,
  ): void {
    if (stroke.points.length === 0) return;
    const baseWidth = Math.max(0.1, stroke.width * widthScale);
    const pressureSens = stroke.tool !== "eraser";
    ctx.save();
    ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const strokeColor = stroke.tool === "eraser" ? "rgba(0,0,0,1)" : stroke.color;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;
    if (stroke.points.length === 1) {
      const pt = stroke.points[0];
      const w = pressureSens ? baseWidth * (0.3 + pt.p * 0.7) : baseWidth;
      ctx.beginPath();
      ctx.arc(pt.x * W, pt.y * H, w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    let midX = 0, midY = 0, hasMid = false;
    for (let i = 1; i < stroke.points.length; i++) {
      const prev = stroke.points[i - 1];
      const cur = stroke.points[i];
      const px = prev.x * W, py = prev.y * H;
      const cx2 = cur.x * W, cy2 = cur.y * H;
      const nmx = (px + cx2) * 0.5, nmy = (py + cy2) * 0.5;
      peerDrawSeg(ctx, hasMid ? midX : px, hasMid ? midY : py, px, py, nmx, nmy, baseWidth, cur.p, pressureSens);
      midX = nmx; midY = nmy; hasMid = true;
    }
    const last = stroke.points[stroke.points.length - 1];
    if (hasMid) {
      peerDrawSeg(ctx, midX, midY, last.x * W, last.y * H, last.x * W, last.y * H, baseWidth, last.p, pressureSens);
    }
    ctx.restore();
  }

  function peerRerender(): void {
    const host = peerLiveMsgEl?.querySelector<HTMLElement>(".wl-msg-peer-draw-thumb");
    if (!peerCanvas || !peerCtx || !host) return;
    const dpr = devicePixelRatio || 1;
    const rect = host.getBoundingClientRect();
    const cw = Math.max(1, Math.round(rect.width));
    const ch = Math.max(1, Math.round(rect.height));
    const targetW = Math.max(1, Math.round(cw * dpr));
    const targetH = Math.max(1, Math.round(ch * dpr));
    if (peerCanvas.width !== targetW || peerCanvas.height !== targetH) {
      peerCanvas.width = targetW;
      peerCanvas.height = targetH;
      peerCtx = peerCanvas.getContext("2d")!;
      peerCtx.scale(dpr, dpr);
    }
    if (peerBgCanvas && (peerBgCanvas.width !== targetW || peerBgCanvas.height !== targetH)) {
      peerBgCanvas.width = targetW;
      peerBgCanvas.height = targetH;
      const bgCtx = peerBgCanvas.getContext("2d")!;
      bgCtx.scale(dpr, dpr);
      drawPeerBackground(cw, ch);
    } else if (peerBgCanvas) {
      drawPeerBackground(cw, ch);
    }
    const W = peerCanvasW();
    const H = peerCanvasH();
    const widthScale = peerStrokeWidthScale(W, H);
    peerCtx.clearRect(0, 0, W, H);
    for (const stroke of peerStrokes) peerRenderStroke(peerCtx, stroke, widthScale, W, H);
    if (peerActiveStroke && peerActivePoints.length > 0) {
      peerRenderStroke(peerCtx, {
        points: peerActivePoints,
        color: peerActiveStroke.color,
        width: peerActiveStroke.width,
        tool: peerActiveStroke.tool,
      }, widthScale, W, H);
    }
  }

  function schedulePeerRerender(): void {
    if (peerRafPending) return;
    peerRafPending = true;
    requestAnimationFrame(() => { peerRafPending = false; peerRerender(); });
  }

  function bringPeerPreviewToBottom(): void {
    if (!peerLiveMsgEl) return;
    const list = opts.chatMessages;
    const alreadyLast = list.lastElementChild === peerLiveMsgEl;
    if (!alreadyLast) {
      list.appendChild(peerLiveMsgEl);
      smartScroll();
    }
  }

  function resetPeerLivePreview(): void {
    peerActiveStroke = null;
    peerActivePoints = [];
    peerStrokes = [];
    peerRedoStack = [];
    peerBaseAssembly = null;
    peerStrokeSpaceW = 0;
    peerStrokeSpaceH = 0;
    clearPeerBaseImage();
    peerBgCanvas?.remove();
    peerBgCanvas = null;
    if (peerCanvas) {
      peerCanvas.remove();
      peerCanvas = null;
      peerCtx = null;
    }
    if (peerLiveMsgEl) {
      peerLiveMsgEl.remove();
      peerLiveMsgEl = null;
      peerLiveTimeEl = null;
    }
    peerPreviewResizeObserver?.disconnect();
    peerPreviewResizeObserver = null;
  }

  function handleRemoteDraw(ev: DrawStreamEvent): void {
    const SCALE = 32767;
    switch (ev.kind) {
      case "begin": {
        if (!isFiniteNorm(ev.start.x) || !isFiniteNorm(ev.start.y) || !isFinitePressure(ev.start.p)) break;
        removeLegacyPeerOverlays();
        ensurePeerCanvas();
        // every begin carries the sender's logical canvas size, so the
        // preview box never depends on the presence event having won the
        // race to the wire (a pointer landing before the sender's mount
        // raf used to ship begin first, leaving the preview at the css 4:3
        // fallback while the final message used the true aspect). presence
        // remains authoritative when it already landed.
        if (peerStrokeSpaceW <= 0 && ev.logicalW > 0 && ev.logicalH > 0) {
          peerStrokeSpaceW = ev.logicalW;
          peerStrokeSpaceH = ev.logicalH;
          const beginThumb = peerLiveMsgEl?.querySelector<HTMLElement>(".wl-msg-peer-draw-thumb");
          if (beginThumb) {
            beginThumb.style.aspectRatio = `${ev.logicalW} / ${ev.logicalH}`;
            schedulePeerRerender();
          }
        }
        bringPeerPreviewToBottom();
        setPeerLiveDrawState("active");
        if (peerLiveTimeEl) {
          const ts = Date.now();
          peerLiveTimeEl.dateTime = String(ts);
          peerLiveTimeEl.textContent = formatTime(ts);
        }
        const sp: GlyphSeed = GLYPH_CHANNEL_NAMES.map(ch => Math.round(clamp01(ev.start[ch]) * SCALE));
        peerActiveStroke = {
          strokeId: ev.strokeId,
          decoder: new GlyphStreamDecoder(sp),
          color: ev.color,
          width: ev.width,
          tool: ev.tool,
          lastNX: ev.start.x,
          lastNY: ev.start.y,
          lastP: clamp01(ev.start.p),
          lastMidNX: 0,
          lastMidNY: 0,
          hasLastMid: false,
        };
        peerActivePoints = [{ ...ev.start, p: clamp01(ev.start.p) }];
        peerRedoStack = [];
        break;
      }
      case "glyph": {
        if (!peerActiveStroke) break;
        if (ev.strokeId !== peerActiveStroke.strokeId) break;
        bringPeerPreviewToBottom();
        ensurePeerCanvas();
        const raw = peerActiveStroke.decoder.decode(ev.data);
        const CH = GLYPH_CHANNELS;
        const limit = raw.length - (raw.length % CH);
        let appended = false;
        for (let i = 0; i < limit; i += CH) {
          // unpack all channels by name
          const pt = {} as Record<string, number>;
          let valid = true;
          for (let c = 0; c < CH; c++) {
            const v = raw[i + c] / SCALE;
            if (!Number.isFinite(v)) { valid = false; break; }
            pt[GLYPH_CHANNEL_NAMES[c]] = clamp01(v);
          }
          if (!valid) continue;
          const nx = pt.x, ny = pt.y, np = pt.p;
          if (!isFiniteNorm(nx) || !isFiniteNorm(ny)) continue;
          peerActivePoints.push(pt as PeerPoint);
          peerActiveStroke.lastMidNX = (peerActiveStroke.lastNX + nx) * 0.5;
          peerActiveStroke.lastMidNY = (peerActiveStroke.lastNY + ny) * 0.5;
          peerActiveStroke.hasLastMid = true;
          peerActiveStroke.lastNX = nx;
          peerActiveStroke.lastNY = ny;
          peerActiveStroke.lastP = np;
          appended = true;
        }
        if (appended) schedulePeerRerender();
        break;
      }
      case "end": {
        if (!peerActiveStroke) break;
        if (ev.strokeId !== peerActiveStroke.strokeId) break;
        bringPeerPreviewToBottom();
        peerStrokes.push({
          points: peerActivePoints.slice(),
          color: peerActiveStroke.color,
          width: peerActiveStroke.width,
          tool: peerActiveStroke.tool,
        });
        peerActivePoints = [];
        peerActiveStroke = null;
        peerRerender();
        setPeerLiveDrawState("sent");
        promotePeerPreviewToMessageShell();
        break;
      }
      case "clear": {
        peerStrokes = [];
        peerRedoStack = [];
        peerActiveStroke = null;
        peerActivePoints = [];
        if (peerCanvas && peerCtx) peerCtx.clearRect(0, 0, peerCanvasW(), peerCanvasH());
        setPeerLiveDrawState("clear");
        break;
      }
      case "undo": {
        if (peerStrokes.length === 0) break;
        peerRedoStack.push(peerStrokes.pop()!);
        peerRerender();
        setPeerLiveDrawState("active");
        break;
      }
      case "redo": {
        if (peerRedoStack.length === 0) break;
        peerStrokes.push(peerRedoStack.pop()!);
        peerRerender();
        setPeerLiveDrawState("active");
        break;
      }
      case "presence":
        if (!ev.active) {
          // the sender's surface closed. if the live preview never got
          // merged into a finalized message (addChatMessage nulls
          // peerLiveMsgEl the moment that merge happens — see
          // replacePeerPreview), it means the sender discarded the drawing
          // without sending: drop the preview entirely rather than leaving
          // a phantom "sent" drawing on screen, and clear peerLiveMsgEl so
          // no later unrelated peer file message can hijack the slot via
          // the isWhisperGlyph backstop. if a merge already happened,
          // peerLiveMsgEl is already null here and this is a harmless
          // no-op — tolerant of presence:false arriving either before or
          // after the sent file, since the two are not ordered relative
          // to each other on the wire.
          resetPeerLivePreview();
        } else {
          removeLegacyPeerOverlays();
          ensurePeerCanvas();
          bringPeerPreviewToBottom();
          setPeerLiveDrawState("active");
          // stamp the thumb with the sender's canvas aspect right away since
          // blank draws have no other dims signal until the stroke settles,
          // and without this the preview defaults to the CSS 4:3 fallback.
          if (ev.logicalW > 0 && ev.logicalH > 0) {
            peerStrokeSpaceW = ev.logicalW;
            peerStrokeSpaceH = ev.logicalH;
            const thumb = peerLiveMsgEl?.querySelector<HTMLElement>(".wl-msg-peer-draw-thumb");
            if (thumb) {
              thumb.style.aspectRatio = `${ev.logicalW} / ${ev.logicalH}`;
              schedulePeerRerender();
            }
          }
        }
        break;
      case "base-start": {
        removeLegacyPeerOverlays();
        ensurePeerCanvas();
        bringPeerPreviewToBottom();
        setPeerLiveDrawState("active");
        // Stamp the thumb with the base image's aspect ratio so the live preview
        // matches the annotation content from the start, rather than defaulting
        // to the 4:3 CSS fallback and then jumping when the sent file arrives.
        if (ev.width > 0 && ev.height > 0) {
          peerStrokeSpaceW = ev.width;
          peerStrokeSpaceH = ev.height;
          const thumb = peerLiveMsgEl?.querySelector<HTMLElement>(".wl-msg-peer-draw-thumb");
          if (thumb) {
            thumb.style.aspectRatio = `${ev.width} / ${ev.height}`;
            schedulePeerRerender();
          }
        }
        peerBaseAssembly = {
          snapshotId: ev.snapshotId,
          width: ev.width,
          height: ev.height,
          mime: ev.mime,
          chunkCount: ev.chunkCount,
          chunks: new Array<Uint8Array | null>(ev.chunkCount).fill(null),
          received: 0,
        };
        break;
      }
      case "base-chunk": {
        if (!peerBaseAssembly || peerBaseAssembly.snapshotId !== ev.snapshotId) break;
        const idx = ev.chunkIndex | 0;
        if (idx < 0 || idx >= peerBaseAssembly.chunkCount) break;
        if (!peerBaseAssembly.chunks[idx]) {
          peerBaseAssembly.chunks[idx] = ev.data.slice();
          peerBaseAssembly.received++;
        }
        break;
      }
      case "base-end": {
        if (!peerBaseAssembly || peerBaseAssembly.snapshotId !== ev.snapshotId) break;
        const assembly = peerBaseAssembly;
        peerBaseAssembly = null;
        if (assembly.received !== assembly.chunkCount) break;
        let total = 0;
        for (const part of assembly.chunks) {
          if (!part) return;
          total += part.length;
        }
        const merged = new Uint8Array(total);
        let off = 0;
        for (const part of assembly.chunks) {
          if (!part) return;
          merged.set(part, off);
          off += part.length;
        }
        const url = URL.createObjectURL(new Blob([merged], { type: assembly.mime }));
        const token = ++peerBaseLoadToken;
        const img = new Image();
        img.onload = () => {
          if (token !== peerBaseLoadToken) {
            URL.revokeObjectURL(url);
            return;
          }
          clearPeerBaseImage();
          peerBaseImage = img;
          peerBaseImageUrl = url;
          peerRerender();
        };
        img.onerror = () => {
          if (token === peerBaseLoadToken) {
            if (peerBaseImageUrl === url) peerBaseImageUrl = null;
            URL.revokeObjectURL(url);
          }
        };
        img.src = url;
        break;
      }
    }
  }

  function syncPeerPreviewLayout(): void {
    if (!peerLiveMsgEl || !peerCanvas) return;
    schedulePeerRerender();
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
    const externalAssistPolicy = (relayActive || flareActive) ? "keep-for-session" : "drop-after-connect";

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
      onSendProgress: (sent, total) => {
        sendProgress(sent / total);
        // onSendProgress is shared between two signals: per-chunk cumulative progress
        // for chunked file sends (total === file.size) and per-wire-frame progress for
        // every message type (total = encrypted frame size, which in practice never
        // equals a real file size). Route cumulative updates to the outbound card with
        // the matching totalBytes; if several in-flight sends happen to share that exact
        // size, each transfer's bytesSent is monotonic, so pick whichever candidate's
        // last known bytesSent sits closest below (never above) the new value.
        let candidate: TransferCardState | null = null;
        for (const state of transferCards.values()) {
          if (state.direction !== "out" || state.settled || state.totalBytes !== total) continue;
          if (state.bytesSent > sent) continue;
          if (!candidate || state.bytesSent > candidate.bytesSent) candidate = state;
        }
        if (candidate) {
          candidate.bytesSent = sent;
          updateTransferCardProgress(candidate, sent, total);
          if (sent >= total) settleOutboundTransferDelivered(candidate.transferId);
        }
      },
      onSendStart: (transferId, fileName, totalBytes) => {
        const card = buildTransferCard("out", transferId, fileName, totalBytes);
        // fires synchronously within sendFileChunked's pre-await prefix, so whatever
        // sendFileToChat staged in pendingOutboundFile right before calling
        // session.sendFile() is still the file for *this* transfer.
        if (pendingOutboundFile) {
          card.file = pendingOutboundFile;
          outboundFileRefs.add(card);
        }
      },
      onReceiveProgress: (transferId, receivedBytes, totalBytes, fileName) => {
        const state = transferCards.get(transferId) ?? buildTransferCard("in", transferId, fileName, totalBytes);
        updateTransferCardProgress(state, receivedBytes, totalBytes);
      },
      onTransferCancelled: (transferId) => {
        collapseTransferCancelled(transferId);
      },
      onConnectionStats: handleConnectionStats,
      onCtrl: handleCtrl,
      onEdit: (id, text) => handleEdit(id, text),
      onDrawStream: (ev) => handleRemoteDraw(ev),
    }, {
      rtcConfig,
      externalAssistPolicy,
      autoConfirmFingerprint: true,
      turnPool: opts.turnPool,
    });
  }

  function attachRelayHandle(handle: TrackerRelayHandle | undefined): void {
    if (relayHandle) relayHandle.destroy();
    relayHandle = handle ?? null;
    if (!relayHandle || !session) return;
    relayHandle.setOnSignal((signal) => {
      void session?.handleRelaySignal(signal);
    });
    session.setRelaySignalSender((signal) => relayHandle?.sendSignal(signal));
  }

  function destroyCurrentSession(): void {
    if (relayHandle) {
      relayHandle.destroy();
      relayHandle = null;
    }
    if (!session) return;
    session.disconnect();
    session = null;
  }

  async function createOfferWithFreshSession(sharedPhrase?: string): Promise<string> {
    destroyCurrentSession();
    session = createSession();
    try {
      return await session.createOffer(sharedPhrase);
    } catch (err) {
      destroyCurrentSession();
      throw err;
    }
  }

  async function acceptOfferWithFreshSession(
    offerCode: string,
    sharedPhrase?: string,
  ): Promise<string> {
    destroyCurrentSession();
    session = createSession();
    try {
      return await session.acceptOffer(offerCode, sharedPhrase);
    } catch (err) {
      destroyCurrentSession();
      throw err;
    }
  }

  function createSingleFlightAcceptHandler(sharedPhrase?: string): (offerCode: string) => Promise<string> {
    let acceptCalled = false;
    return async (offerCode: string): Promise<string> => {
      if (acceptCalled) throw new Error("duplicate-accept");
      acceptCalled = true;
      try {
        return await acceptOfferWithFreshSession(offerCode, sharedPhrase);
      } catch (err) {
        acceptCalled = false;
        throw err;
      }
    };
  }

  function handleStateChange(state: LiveState, detail?: string): void {
    // During relay/flare exchange, suppress intermediate session states that would
    // overwrite the UI. The handler manages the connecting phase display itself
    // and clears the active flag before terminal states fire.
    // a session that actually went live is exempt: its death is a real event
    // that must always run the terminal teardown, no matter what a stale
    // relay/flare flag claims. swallowing it leaves a half-dead session whose
    // state poisons the next connect in the same tab.
    // local (in-person) mode drives the session through offering/answering to
    // build the QR, but the user must stay in the relay panel watching the QR,
    // not get phased into the offer/answer screens. suppress the intermediate
    // states just like the relay/flare paths do; "live" still flows through to
    // open the chat once both sides scan.
    const wasLive = currentLiveState === "live" || currentLiveState === "recovering";
    if ((relayActive || flareActive || localModeActive) && !wasLive) {
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
        // the interruption healed: settle its seam into a quiet, label-less
        // scar (a continuous hairline), and release the ref so a future drop
        // starts a fresh seam instead of reusing this one.
        if (reconnectSeamEl?.isConnected) {
          reconnectSeamEl.classList.add("wl-msg--seam-healed");
          const label = reconnectSeamEl.querySelector<HTMLElement>(".wl-msg-system");
          if (label) label.textContent = "";
        }
        reconnectSeamEl = null;
        opts.chatInput.disabled = false;
        opts.chatInput.placeholder = "whisper something...";
        opts.chatInput.focus();
        opts.fpChip.classList.remove("wl-fp-chip--recovering");
        opts.fpChip.classList.add("wl-fp-chip--verified");
        startE2eStatsPoll();
        break;

      case "silent": {
        stopE2eStatsPoll();
        enterPhase(opts.silentSection, "shared secret ready for Whisper password mode", false, false);
        const secret = session?.getSharedSecret();
        if (secret) opts.silentSecret.textContent = secret;
        break;
      }

      case "recovering":
        stopE2eStatsPoll();
        showPhase(opts.chatSection);
        liveSurface?.classList.add("wl-recovering");
        updateStatus("");
        setLogActive(true);
        stopRecordingSilently(); // mic must not stay hot across a reconnect
        opts.chatSendBtn.disabled = true;
        opts.chatMediaBtn.disabled = true;
        opts.chatInput.disabled = true;
        opts.chatInput.placeholder = "reconnecting...";
        opts.fpChip.classList.remove("wl-fp-chip--verified");
        opts.fpChip.classList.add("wl-fp-chip--recovering");
        // one seam per interruption: while recovery flaps we keep pulsing the
        // existing seam rather than stacking a new line each tick.
        if (!reconnectSeamEl || !reconnectSeamEl.isConnected) {
          addChatMessage({ type: "system", direction: "system", text: "reconnecting…", timestamp: Date.now() });
          const seams = opts.chatMessages.querySelectorAll<HTMLElement>(".wl-msg--seam");
          reconnectSeamEl = seams.length ? seams[seams.length - 1] : null;
        }
        break;

      case "disconnected": {
        stopE2eStatsPoll();
        if (relayHandle) {
          relayHandle.destroy();
          relayHandle = null;
          session?.setRelaySignalSender(null);
        }
        releaseTerminalSessionUi();
        haptic("disconnected");
        const endText = opts.disconnectedSection.querySelector(".wl-end-text");
        if (endText) endText.textContent = detail === "vanished"
          ? "they vanished. no trace remains."
          : "no trace remains.";
        enterPhase(opts.disconnectedSection, "session ended", false, false);
        resetFpChip();
        // the session died here, so its corpse dies here too: destroy it now
        // instead of waiting for the next connect to sweep it up, and drop any
        // stale relay/flare flags so nothing from this session can suppress or
        // color events in the next one. in-flight ack bookkeeping resets with
        // it; session two reuses msgIds from zero and must never compare
        // against session one's numbers.
        destroyCurrentSession();
        relayActive = false;
        flareActive = false;
        send.acks.clear();
        send.timestamps.clear();
        send.phase = "idle";
        break;
      }

      case "error":
        stopE2eStatsPoll();
        if (relayHandle) {
          relayHandle.destroy();
          relayHandle = null;
          session?.setRelaySignalSender(null);
        }
        releaseTerminalSessionUi();
        enterPhase(opts.errorSection, "couldn't connect", false, false);
        opts.errorMessage.textContent = detail ?? "something went wrong";
        resetFpChip();
        break;
    }
  }

  // split into grapheme clusters so multi-codepoint emoji (skin tones,
  // zwj sequences, variation selectors) stay whole.
  const emojiGraphemes = (emoji: string): string[] =>
    emoji ? Array.from(new Intl.Segmenter().segment(emoji), (s) => s.segment) : [];

  // the chip emoji renders one span per grapheme, each tagged with its index
  // and a deterministic scrapbook rotation, so the css can overlap them like
  // stickers (and collapse to a 2x2 grid) as the header narrows, instead of
  // ever wrapping the row.
  function setChipEmoji(emoji: string): void {
    const parts = emojiGraphemes(emoji);
    opts.fpChipEmoji.replaceChildren(
      ...parts.map((glyph, i) => {
        const span = document.createElement("span");
        span.className = "wl-fp-emoji-glyph";
        span.textContent = glyph;
        span.style.setProperty("--i", String(i));
        // alternating, gently varied tilt: -3, 4, -3, 5, ... deterministic.
        const rot = (i % 2 === 0 ? -1 : 1) * (3 + (i % 3));
        span.style.setProperty("--rot", `${rot}deg`);
        return span;
      }),
    );
    opts.fpChipEmoji.dataset.count = String(parts.length);
  }

  function handleFingerprint(emoji: string): void {
    // wrap each emoji in its own span so the verify panel can stagger them in
    opts.fingerprintDisplay.replaceChildren(
      ...emojiGraphemes(emoji).map((glyph) => {
        const span = document.createElement("span");
        span.className = "wl-fingerprint-glyph";
        span.textContent = glyph;
        return span;
      }),
    );
    setChipEmoji(emoji);
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
    setChipEmoji("");
    opts.fpNicknameInput.parentElement?.classList.remove("wl-fp-wrap--editing");
  }

  function handleMessage(msg: LiveMessage): void {
    addChatMessage(msg);
  }

  function clearChatArtifacts(): void {
    if (editingMsgId != null) exitEditMode();
    closeReactionShelf();
    msgById.clear();
    pendingSeen.clear();
    reconnectSeamEl = null;
    transferCards.clear();
    // drop retained outbound File handles so a settled multi-GB transfer's card
    // (and whatever DOM it's still closed over) can be garbage collected once the
    // chat is wiped below — the morph/download closures check state.file first,
    // so nulling it here is enough to disarm them.
    for (const state of outboundFileRefs) state.file = undefined;
    outboundFileRefs.clear();
    // the map was cleared without settling cards, so the wake lock must drop here
    releaseTransferWakeLock();
    revokeObjectUrls();
    clearNode(opts.chatMessages);
    if (chatEmpty) opts.chatMessages.appendChild(chatEmpty);
    // clearNode() wipes every child, including the shared shelf — reseat it.
    opts.chatMessages.appendChild(reactionShelf);
  }

  function releaseTerminalSessionUi(): void {
    if (editingMsgId != null) exitEditMode();
    stopRecordingSilently(true);
    stopAllAudio();
    closeMediaLightbox();
    closeDrawSurface();
    resetPeerLivePreview();
    clearChatArtifacts();
    // a vote (clear or campfire) mid-flight when the session ends is meaningless —
    // there's no peer left to resolve it against.
    clearVote.reset();
    campfireVote.reset();
  }

  /* ── Reset to idle ─────────────────────────────────────── */

  function resetToIdle(): void {
    releaseTerminalSessionUi();
    relayActive = false;
    localModeActive = false;
    localRole = "none";
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
    destroyCurrentSession();
    composing = false;
    send.acks.clear();
    send.timestamps.clear();
    send.phase = "idle";
    stopIdleKeepAlive();
    if (typingSendTimer) { clearTimeout(typingSendTimer); typingSendTimer = null; }
    hidePeerTyping();
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
    opts.funnelCampfireBtn.innerHTML = CF_BTN_LABELS.idle;
    delete opts.funnelCampfireBtn.dataset.voteState;
    setOfferQrExpanded(false);
    setAnswerQrExpanded(false);
    setRelayQrExpanded(false);
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

  /** True while a QR-armed silent relay wait (handleRelayConnect's `silent`
   *  mode, see below) is racing in the background. Blocks a concurrent
   *  manual Connect click on the shared relayAbort/relayActive pair. */
  let qrArmActive = false;
  /** Phrase the relay QR panel last rendered/armed for — lets refreshRelayQr()
   *  skip a redundant re-render+re-arm when the phrase hasn't changed. */
  let qrArmedPhrase = "";
  let relayQrDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let relayQrRearmTimer: ReturnType<typeof setTimeout> | null = null;

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
      lede: "know a phrase, connect at the same time. that's it",
      flareLink: "light a signal flare",
      manualLink: "or connect manually",
      relayAssist: true,
    },
    flare: {
      lede: "light a flare and wait for a signal",
      flareLink: "use relay assist",
      manualLink: "or connect manually",
      relayAssist: true,
    },
    manual: {
      lede: "create a channel or join one",
      flareLink: "light a signal flare",
      manualLink: "use relay assist",
      relayAssist: false,
    },
  };

  function applyModeSwitch(mode: IdleMode): void {
    if (!relayPanel || !manualPanel || !modeSwitchBtn) return;
    currentIdleMode = mode;
    const cfg = IDLE_MODE_CONFIG[mode];

    // Leaving the relay panel also leaves any QR-armed wait behind it
    if (mode !== "relay") setRelayQrExpanded(false);

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
    const code = trackerErrorCode(raw);
    if (code === "peer-not-found") {
      return "couldn't find your peer. make sure you both typed the exact same phrase, then try again at the same time";
    }
    if (code === "relay-unavailable") {
      return "couldn't reach the relay. check your connection and try again, or use manual mode";
    }
    if (code === "handshake-failed") {
      return "handshake failed. try again, or use a different phrase";
    }
    if (code === "flare-relay-dropped") {
      return "relay dropped during connection. try lighting the flare again";
    }
    return raw;
  }

  async function handleRelayConnect(auto = false, relayOpts: { silent?: boolean } = {}): Promise<void> {
    if (!passGate(auto)) return;
    const phrase = opts.phraseInput.value.trim();
    if (!phrase) {
      opts.phraseInput.focus();
      // Brief visual pulse on the phrase input
      opts.phraseInput.classList.add("ws-reject-pulse");
      setTimeout(() => opts.phraseInput.classList.remove("ws-reject-pulse"), 400);
      return;
    }

    const silent = relayOpts.silent ?? false;

    if (!silent) setBusy(true);
    relayActive = true;
    relayAbort = new AbortController();
    const relaySignal = relayAbort.signal;

    if (silent) {
      // QR-armed wait: stay on the relay panel with the QR showing — no
      // phase switch, just the ember pulse (setRelayQrWaiting, below).
      setRelayQrWaiting(true);
    } else {
      showPhase(opts.connectingSection);
      opts.connectingStatus.textContent = "preparing...";
      updateStatus("connecting...");
      setLogActive(true);
    }

    opts.externalAssistToggle.checked = true;
    try {
      const acceptFn = createSingleFlightAcceptHandler(phrase);

      const callbacks = {
        onStatus: (msg: string) => {
          if (aborted()) return;
          if (!silent) opts.connectingStatus.textContent = msg;
          updateStatus(msg);
        },
        onLog: (msg: string) => {
          if (aborted()) return;
          appendLog(msg);
        },
      };

      const result = await runLiveRendezvous({
        mode: "simultaneous",
        phrase,
        createOfferCode: () => createOfferWithFreshSession(phrase),
        acceptOfferCode: acceptFn,
        callbacks,
        signal: relaySignal,
      });

      if (aborted() || !session) return;

      relayActive = false;
      if (silent) {
        // a peer showed up — leave the silent wait and join the normal
        // connecting/verify/chat flow like a manual connect would. Close
        // the qr panel outright (not just the ember/label): the phase is
        // leaving idle for good, the QR must not linger open behind it.
        qrArmActive = false;
        qrArmedPhrase = "";
        setRelayQrWaiting(false);
        closeRelayQrPanel();
        setBusy(true);
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "connecting directly...";
        updateStatus("connecting...");
        setLogActive(true);
      }
      attachRelayHandle(result.relay);

      if (result.role === "offerer" && result.peerAnswerCode) {
        await session.applyAnswer(result.peerAnswerCode);
      }
      if (result.role === "answerer" && session && session.state === "connecting") {
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "connecting directly...";
        updateStatus("connecting...");
      }
    } catch (err) {
      relayActive = false;
      const raw = errMsg(err);
      // the rendezvous race times out after 45s with peer-not-found. while
      // the qr panel is open that timeout is not a failure, it is a lap:
      // the open panel is the user saying keep waiting, so quietly re-arm
      // for another cycle instead of bouncing to the error phase.
      if (silent && !aborted() && raw === "peer-not-found" && relayQrState.value) {
        qrArmActive = false;
        qrArmedPhrase = "";
        destroyCurrentSession();
        relayQrRearmTimer = setTimeout(() => {
          relayQrRearmTimer = null;
          if (relayQrState.value && !qrArmActive) refreshRelayQr();
        }, 400);
        return;
      }
      // any other errored silent wait is genuinely leaving idle (for the
      // error phase), so the panel closes.
      if (silent) { qrArmActive = false; qrArmedPhrase = ""; setRelayQrWaiting(false); closeRelayQrPanel(); }
      if (aborted()) return;
      destroyCurrentSession();
      if (raw === "Aborted") return;
      appendLog(`relay error: ${raw}`);
      lastErrorWasRelay = true;
      handleStateChange("error", friendlyRelayError(raw));
    } finally {
      relayAbort = null;
    }
  }

  /* ── QR flare handoff ──────────────────────────────────────
   * Shows a QR of #wl:<base64url(phrase)> next to the relay phrase field.
   * Scanning it opens live mode on that phrase and auto-fires a relay
   * connect (see whisper.astro's fragment handoff + the sessionStorage
   * consume block near the end of this file's init).
   *
   * On the shower's side this deliberately arms relay's plain
   * "simultaneous" race, not Signal Flare's listener mode. Flare's wait
   * (handleFlareConnect, below) ends in an onPeerArrived confirmation step
   * gated on the Accept/Ignore buttons that live inside the hidden flare
   * panel. Reusing flare's wait half without also reusing its confirmation
   * half would mean either duplicating flare's arrived-state UI here or
   * silently auto-accepting — quietly changing Signal Flare's opt-in
   * security semantics everywhere flare is used. Relay's simultaneous mode
   * already has no confirmation gate; that no-confirmation race IS "QR
   * auto-connects the scanner", so the toggle just arms handleRelayConnect
   * in `silent` mode: same underlying race, no phase switch while waiting.
   */

  /** single source of truth for "a QR-armed wait is live right now": the
   *  breathing ember next to the status line, and the Connect button's own
   *  role — the armed QR IS the pending connect, so the button says so
   *  instead of sitting there reading "Connect" as if nothing's happening.
   *  updateControls only ever touches relayConnectBtn.disabled, never its
   *  label, so there's nothing here for it to fight. */
  function setRelayQrWaiting(waiting: boolean): void {
    // the waiting text itself carries the liveness now: a slow chromatic
    // shimmer instead of a separate blinking dot.
    if (opts.relayQrEmber) opts.relayQrEmber.style.display = "none";
    opts.relayQrStatus?.classList.toggle("wl-qr-waiting-live", waiting);
    if (opts.relayConnectBtn) {
      opts.relayConnectBtn.textContent = waiting ? "waiting..." : "Connect";
      opts.relayConnectBtn.classList.toggle("wl-relay-connect--waiting", waiting);
    }
    // qrArmActive feeds the disabled states in updateControls; resync now
    // rather than waiting for the next unrelated call.
    updateControls();
  }

  function extinguishQrArm(): void {
    const wasActive = qrArmActive;
    qrArmActive = false;
    qrArmedPhrase = "";
    if (relayQrRearmTimer) { clearTimeout(relayQrRearmTimer); relayQrRearmTimer = null; }
    setRelayQrWaiting(false);
    if (wasActive && relayAbort) {
      relayActive = false;
      relayAbort.abort();
      relayAbort = null;
    }
  }

  const relayQrState = { value: false };

  /** shows the qr panel and kicks off its spring-bloom entrance. A double
   *  rAF makes sure the browser paints the collapsed (0fr / opacity 0)
   *  resting state before the --open class flips the transitionable
   *  properties, so the animation actually plays instead of snapping. */
  function openRelayQrPanel(): void {
    const panel = opts.relayQrPanel;
    if (!panel) return;
    panel.classList.remove("wl-relay-qr-panel--open");
    panel.style.display = "";
    panel.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => panel.classList.add("wl-relay-qr-panel--open"));
    });
  }

  /** hides the qr panel instantly (no closing animation, per spec) and
   *  resets every bit of DOM state the toggle/updateControls read, so a
   *  later re-open always starts clean. Doesn't touch relayAbort — callers
   *  that own an in-flight controller (handleRelayConnect's own success/
   *  error branches) are responsible for that themselves. */
  function closeRelayQrPanel(): void {
    relayQrState.value = false;
    const panel = opts.relayQrPanel;
    if (panel) {
      panel.classList.remove("wl-relay-qr-panel--open");
      panel.style.display = "none";
      panel.setAttribute("aria-hidden", "true");
    }
    if (opts.relayQrToggleBtn) opts.relayQrToggleBtn.setAttribute("aria-expanded", "false");
  }

  /** renderQrToCanvas swaps in a saveable <img> and hides the canvas — undo
   *  that so a cleared phrase doesn't leave a stale QR visible above the
   *  "type a phrase first" hint. */
  function clearRelayQrVisual(): void {
    const canvas = opts.relayQrCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = "";
    const img = document.getElementById(`${canvas.id}--img`);
    if (img instanceof HTMLImageElement) img.style.display = "none";
  }

  function refreshRelayQr(): void {
    if (!relayQrState.value || !opts.relayQrPanel) return;
    const phrase = opts.phraseInput.value.trim();
    if (!phrase) {
      // no phrase means in-person mode: same button, same panel, same scan —
      // the QR just carries a local offer and never touches the internet.
      void startLocalQrOffer();
      return;
    }
    setLocalMode(false);
    if (phrase === qrArmedPhrase && qrArmActive) return;

    extinguishQrArm();
    if (opts.relayQrCanvas) {
      try {
        renderQrToCanvas(opts.relayQrCanvas, buildWlFlareUrl(phrase));
        if (opts.relayQrStatus) opts.relayQrStatus.textContent = "scan and connect.";
      } catch {
        if (opts.relayQrStatus) opts.relayQrStatus.textContent = "QR preview unavailable in this browser.";
      }
    }

    qrArmActive = true;
    qrArmedPhrase = phrase;
    void handleRelayConnect(false, { silent: true });
  }

  function scheduleRelayQrRefresh(): void {
    if (!relayQrState.value) return;
    if (relayQrDebounceTimer) clearTimeout(relayQrDebounceTimer);
    relayQrDebounceTimer = setTimeout(() => {
      relayQrDebounceTimer = null;
      refreshRelayQr();
    }, 500);
  }

  /* ── In-person local mode (empty-phrase QR, no server) ────
   * one channel: the QR is a url with a #wl-local:<packed sdp> fragment.
   * the other phone's native camera opens it (or an already-open tab gets a
   * hashchange), the payload's own role byte says offer-or-answer, and the
   * session's local-codec handshake methods do the rest. reuses the relay QR
   * panel, the flare fragment handoff, and renderQrToCanvas untouched. */

  let localModeActive = false;
  // my role in the current in-person exchange. both people start "offering"
  // (each shows their own code); whoever scans the other's offer first
  // commits to "answering" and abandons their own offer. this resolves the
  // symmetric collision where both are showing codes.
  let localRole: "none" | "offering" | "answering" = "none";

  // toggle the visual "local mode" affordances: the purple QR segment and the
  // same-network hint. keyed off a data attribute so the css owns the look.
  function setLocalMode(on: boolean): void {
    if (localModeActive === on) return;
    localModeActive = on;
    if (!on) localRole = "none";
    relayConnectRow?.toggleAttribute("data-local", on);
    if (relayHint) {
      relayHint.textContent = on
        ? "must be on the same network. no greater internet needed."
        : RELAY_HINT_DEFAULT;
    }
  }

  const localConnected = (): boolean => currentLiveState === "live" || currentLiveState === "silent";

  async function startLocalQrOffer(): Promise<void> {
    if (session && localConnected()) return;
    setLocalMode(true);
    localRole = "offering";
    try {
      destroyCurrentSession();
      session = createSession();
      const offer = await session.createLocalOffer();
      const url = buildWlLocalUrl(offer);
      if (opts.relayQrCanvas) { opts.relayQrCanvas.dataset.wlLocalUrl = url; renderQrToCanvas(opts.relayQrCanvas, url); }
      // both people see this. whoever scans the other's code first flips to
      // the answerer and shows a reply; the other then scans that reply.
      if (opts.relayQrStatus) opts.relayQrStatus.textContent = "step 1 · one of you scans the other's code.";
    } catch (err) {
      if (opts.relayQrStatus) opts.relayQrStatus.textContent = "couldn't start in-person mode.";
      appendLog(`local offer failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  // a scanned #wl-local payload: the role byte decides. same handler for
  // cold-load, hot-tab hashchange, and in-app scan — one path.
  async function applyLocalHandoff(payload: string): Promise<void> {
    let kind: "offer" | "answer";
    try {
      kind = unpackLocalSdp(payload).type;
    } catch {
      return; // not a valid local payload
    }
    if (localConnected()) return; // already bonded, ignore stray scans

    if (kind === "answer") {
      // their reply to the offer i am showing. only the offerer applies it.
      if (localRole !== "offering" || !session) return;
      setLocalMode(true);
      try {
        await session.applyLocalAnswer(payload);
        if (opts.relayQrStatus) opts.relayQrStatus.textContent = "connecting…";
      } catch (err) {
        appendLog(`local answer failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
      return;
    }

    // an offer: i become the answerer, even if i was showing my own offer
    // (the symmetric case — both had codes up). abandon my offer, accept
    // theirs, and show the reply for them to scan back.
    if (localRole === "answering") return; // already committed as answerer
    localRole = "answering";
    setLocalMode(true);
    if (opts.relayAssistToggle) { opts.relayAssistToggle.checked = true; applyModeSwitch("relay"); }
    setRelayQrExpanded(true);
    try {
      destroyCurrentSession();
      session = createSession();
      const answer = await session.acceptLocalOffer(payload);
      const url = buildWlLocalUrl(answer);
      if (opts.relayQrCanvas) { opts.relayQrCanvas.dataset.wlLocalUrl = url; renderQrToCanvas(opts.relayQrCanvas, url); }
      // this is the last step: the other phone must scan THIS reply to finish.
      if (opts.relayQrStatus) opts.relayQrStatus.textContent = "step 2 · now have them scan this reply.";
    } catch (err) {
      if (opts.relayQrStatus) opts.relayQrStatus.textContent = "couldn't accept their code.";
      appendLog(`local accept failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  /** the relay toggle is an icon-only glyph button, not the shared
   *  "Show QR"/"Hide QR" text pill (setQrExpanded, used by offer/answer) —
   *  reusing that helper here would stomp the inline <svg> via textContent,
   *  so this is a dedicated open/close pair instead. */
  function setRelayQrExpanded(expanded: boolean): void {
    if (!opts.relayQrPanel || !opts.relayQrToggleBtn) return;
    if (expanded) {
      relayQrState.value = true;
      opts.relayQrToggleBtn.setAttribute("aria-expanded", "true");
      openRelayQrPanel();
      refreshRelayQr();
    } else {
      closeRelayQrPanel();
      extinguishQrArm();
      // closing the panel leaves in-person mode: drop the purple + the hint,
      // and tear down any pending local offer that never completed.
      if (localModeActive && !localConnected()) {
        setLocalMode(false);
        destroyCurrentSession();
      }
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

  async function handleFlareConnect(auto = false): Promise<void> {
    if (!passGate(auto)) return;
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
    const flareSignal = flareAbort.signal;
    setBusy(true);

    // Request notification permission if default
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* noop */ }
    }

    opts.externalAssistToggle.checked = true;

    // if extinguished during the notification permission dialog, bail out
    if (flareSignal.aborted) {
      flareActive = false;
      setBusy(false);
      return;
    }

    try {
      setLogActive(true);
      appendLog("flare preparing...");
      updateStatus("flare is burning");
      setBusy(false);

      // show burning state
      setFlareUiState("burning");
      flareStartTime = Date.now();
      if (flareElapsed) flareElapsed.textContent = "0s";
      flareElapsedTimer = setInterval(() => {
        if (flareElapsed && flareStartTime) {
          flareElapsed.textContent = formatElapsed(Date.now() - flareStartTime);
        }
      }, 1000);

      const acceptFn = createSingleFlightAcceptHandler(phrase);

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

            // tab title notification
            document.title = "someone arrived \u2014 Whisper";

            // browser notification
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

      const result = await runLiveRendezvous({
        mode: "flare-listener",
        phrase,
        acceptOfferCode: acceptFn,
        callbacks,
        signal: flareSignal,
      });

      if (aborted() || !session) return;

      // clear flare state before terminal flow
      flareActive = false;
      if (flareElapsedTimer) { clearInterval(flareElapsedTimer); flareElapsedTimer = null; }
      flareStartTime = 0;
      document.title = originalTitle;
      setFlareUiState("input");

      setBusy(true);
      attachRelayHandle(result.relay);
      showPhase(opts.connectingSection);
      opts.connectingStatus.textContent = "connecting directly...";
      updateStatus("connecting...");
    } catch (err) {
      flareActive = false;
      extinguishFlare();
      if (aborted()) return;
      destroyCurrentSession();
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
      session.sendCtrl(CTRL_OP.CANCEL, encodeVotePayload(VOTE_TOPIC.CAMPFIRE, campfireVote.round));
      return;
    }
    if (campfireVote.localVoted) return;
    session.sendCtrl(CTRL_OP.VOTE, encodeVotePayload(VOTE_TOPIC.CAMPFIRE, campfireVote.round));
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
      void deriveFingerprint(getPreviewSeed()).then((emoji) => {
        handleFingerprint(emoji);
        opts.fpChip.classList.add("wl-fp-chip--verified");

        // Simulate welcome messages in preview mode
        handlePeerCompose(COMPOSE_ACTIVE);
        setTimeout(() => {
          hidePeerTyping();
          const peerPreviewId = -(++previewSendId);
          addChatMessage({ type: "text", direction: "peer", text: "this is a preview chat.\ntip: use shift+enter to send simulated peer messages.", timestamp: Date.now(), msgId: peerPreviewId });
        }, 800 + Math.random() * 600);
      });
      try { opts.chatInput.focus(); } catch { /* noop */ }
    }, { signal });
  }

  opts.phraseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && opts.relayAssistToggle?.checked && !busy && !qrArmActive) {
      e.preventDefault();
      void handleRelayConnect();
    }
  }, { signal });

  // ── QR flare handoff event listeners ──

  if (opts.relayQrToggleBtn) {
    opts.relayQrToggleBtn.addEventListener("click", () => {
      setRelayQrExpanded(!relayQrState.value);
    }, { signal });
  }

  // editing the phrase extinguishes the armed wait immediately; a short
  // debounce then re-renders + re-arms for the new phrase, so the QR stays
  // live without hammering the relay tracker on every keystroke. Also keeps
  // the toggle's empty-phrase disabled state in sync as the user types.
  opts.phraseInput.addEventListener("input", () => {
    updateControls();
    if (!relayQrState.value) return;
    extinguishQrArm();
    scheduleRelayQrRefresh();
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
    if (!passGate()) return;
    const phrase = getActivePhrase() || undefined;
    try {
      const offerCode = await createOfferWithFreshSession(phrase);
      opts.offerCode.textContent = offerCode;
      renderQr(opts.offerQrCanvas, opts.offerQrStatus, "offer", offerCode);
      setOfferQrExpanded(false);
      updateControls();
    } catch (err) {
      appendLog(`offer failed: ${errMsg(err)}`);
      handleStateChange("error", "couldn't create invite, try again");
    }
  }, { signal });

  const copyCode = (el: HTMLElement, btn: HTMLButtonElement, label: string) => {
    btn.addEventListener("click", async () => {
      const code = el.textContent ?? "";
      if (!code) return;
      try { await copyToClipboard(code); haptic("copied"); flashText(btn, "Copied"); appendLog(`${label} copied to clipboard`); }
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
        if (liveCapabilities.shareSheet) {
          await navigator.share({ text: code });
          haptic("copied");
          appendLog(`${label} shared`);
        } else {
          await copyToClipboard(code);
          haptic("copied");
          flashText(btn, "Copied");
          appendLog(`${label} copied to clipboard`);
        }
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
    const raw = opts.answerInput.value.trim();
    if (!raw || !session) {
      opts.answerInput.focus();
      opts.answerInput.classList.add("ws-reject-pulse");
      setTimeout(() => opts.answerInput.classList.remove("ws-reject-pulse"), 400);
      return;
    }
    const code = extractLiveCodeCandidate(raw, "answer");
    if (!code) {
      opts.answerInput.focus();
      opts.answerInput.classList.add("ws-reject-pulse");
      setTimeout(() => opts.answerInput.classList.remove("ws-reject-pulse"), 400);
      return;
    }
    opts.answerInput.value = code;
    try {
      await session.applyAnswer(code);
    } catch (err) {
      appendLog(`answer apply failed: ${errMsg(err)}`);
      handleStateChange("error", "couldn't read reply code, check it and try again");
    }
  }, { signal });

  opts.joinBtn.addEventListener("click", async () => {
    if (!passGate()) return;
    normalizeTypedCodes();
    const raw = opts.joinInput.value.trim();
    if (!raw) {
      opts.joinInput.focus();
      opts.joinInput.classList.add("ws-reject-pulse");
      setTimeout(() => opts.joinInput.classList.remove("ws-reject-pulse"), 400);
      return;
    }
    const offerCode = extractLiveCodeCandidate(raw, "offer");
    if (!offerCode) {
      opts.joinInput.focus();
      opts.joinInput.classList.add("ws-reject-pulse");
      setTimeout(() => opts.joinInput.classList.remove("ws-reject-pulse"), 400);
      setJoinQrStatus("doesn\u2019t look like an invite code");
      return;
    }
    opts.joinInput.value = offerCode;
    const phrase = getActivePhrase() || undefined;
    try {
      const answerCodeStr = await acceptOfferWithFreshSession(offerCode, phrase);
      opts.answerCode.textContent = answerCodeStr;
      renderQr(opts.answerQrCanvas, opts.answerQrStatus, "answer", answerCodeStr);
      setAnswerQrExpanded(false);
      showPhase(opts.answerSection);
      updateStatus("step 2/2: send answer back to the creator");
      setBusy(false);
      updateControls();
    } catch (err) {
      appendLog(`join failed: ${errMsg(err)}`);
      handleStateChange("error", "couldn't read invite code, check it and try again");
    }
  }, { signal });

  opts.confirmBtn.addEventListener("click", () => {
    haptic("confirm");
    session?.confirmFingerprint();
  }, { signal });

  opts.rejectBtn.addEventListener("click", () => {
    haptic("reject");
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
    if (!text) {
      if (editingMsgId != null) exitEditMode();
      return;
    }

    // ── Edit mode: send edit instead of new message
    if (editingMsgId != null) {
      const targetId = editingMsgId;
      exitEditMode({ restoreDraft: false }); // submitted edits should leave compose clean
      if (!session) {
        handleEdit(targetId, text);
        simulateSendEnergy();
        return;
      }
      sendBeginFill();
      try {
        const editMsgId = await session.sendEdit(targetId, text);
        sendInFlight(editMsgId);
      } catch (err) {
        send.phase = "delivered"; send.velocity = -4;
        haptic("send-failed");
        appendLog(`edit failed: ${errMsg(err)}`);
        pulseComposeIntent("error", 1100);
      }
      return;
    }

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
    if (e.key === "Escape" && editingMsgId != null) {
      e.preventDefault();
      exitEditMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
    // Preview mode: Shift+Enter simulates a peer message
    if (e.key === "Enter" && e.shiftKey && !session && !e.isComposing) {
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
      if (!ts) continue;
      // rewrite only the text span: the receipt dot is a sibling inside
      // <time> and must survive the format toggle.
      const textEl = el.querySelector<HTMLElement>(".wl-msg-time-text");
      if (textEl) textEl.textContent = formatTime(ts);
      else el.textContent = formatTime(ts);
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
    if (!liveCapabilities.clipboardRead) {
      pulsePasteState(false);
      appendLog("clipboard paste unavailable here");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      const ok = applyJoinOfferCandidate(text, "paste");
      if (!ok) haptic("send-failed");
      pulsePasteState(ok);
    } catch {
      pulsePasteState(false);
    }
  }, { signal });

  opts.joinQrScanBtn.addEventListener("click", () => {
    void startJoinQrScan();
  }, { signal });

  opts.joinQrImageBtn.addEventListener("click", () => {
    if (!liveCapabilities.qrImageDecode) {
      setJoinQrStatus("Image QR import unavailable.");
      return;
    }
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

  // ── Media button popover (file + draw + clear + alpha) ──────
  // supports: tap to toggle, tap-hold to open then drag-over option + release to pick.
  // alpha submenu opens to the side. dragging onto it preview-opens the panel;
  // dragging away closes it. releasing on it or inside it commits the open state.
  {
    const popover = opts.chatMediaPopover;
    const alphaPanel = opts.alphaPanel;
    const alphaBtn = opts.chatMediaAlpha;
    const options = [opts.chatMediaFile, opts.chatMediaDraw, opts.chatMediaClear, alphaBtn] as const;
    let mediaPopoverOpen = false;
    let alphaPanelOpen = false;
    let onAlphaOpen: (() => void) | null = null;
    let onAlphaClose: (() => void) | null = null;
    let mediaPointerId = -1;
    let mediaHoldTimer: ReturnType<typeof setTimeout> | null = null;
    let mediaDragMode = false;
    let hoveredOption: HTMLButtonElement | null = null;

    function pointInEl(x: number, y: number, el: HTMLElement): boolean {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    function openPopover(): void {
      if (mediaPopoverOpen) return;
      mediaPopoverOpen = true;
      popover.classList.add("--open");
      haptic("mode-switch");
    }

    function closeAlphaPanel(): void {
      if (!alphaPanelOpen) return;
      alphaPanelOpen = false;
      alphaPanel.classList.remove("--open");
      alphaBtn.classList.remove("--active");
      onAlphaClose?.();
    }

    function closePopover(): void {
      if (!mediaPopoverOpen) return;
      closeAlphaPanel();
      mediaPopoverOpen = false;
      popover.classList.remove("--open");
      for (const o of options) o.classList.remove("--hover");
      hoveredOption = null;
    }

    function toggleAlphaPanel(): void {
      if (alphaPanelOpen) { closeAlphaPanel(); return; }
      if (!mediaPopoverOpen) openPopover();
      alphaPanelOpen = true;
      alphaPanel.classList.add("--open");
      alphaBtn.classList.add("--active");
      const jitter = -8 + Math.random() * 16;
      alphaBtn.style.setProperty("--iris-jitter", `${jitter.toFixed(1)}deg`);
      onAlphaOpen?.();
    }

    function pickFile(): void {
      closePopover();
      opts.chatFileInput.click();
    }

    function pickDraw(): void {
      closePopover();
      openManagedDrawSurface({ mode: "blank" }, {
        onSend: (r) => sendFileToChat(r.file, "draw"),
        onEvent: (ev) => session?.sendDrawStream(ev),
      }, signal);
    }

    function pickClear(): void {
      if (opts.chatMediaClear.disabled) return;
      opts.chatMediaClear.click();
    }

    function hitTestOption(x: number, y: number): HTMLButtonElement | null {
      for (const o of options) {
        if (pointInEl(x, y, o)) return o;
      }
      return null;
    }

    // pointer down: start hold timer
    opts.chatMediaBtn.addEventListener("pointerdown", (e) => {
      if (opts.chatMediaBtn.disabled || e.button !== 0) return;
      if (mediaPointerId !== -1) return;
      e.preventDefault();
      mediaPointerId = e.pointerId;
      opts.chatMediaBtn.setPointerCapture(e.pointerId);
      mediaDragMode = false;
      mediaHoldTimer = setTimeout(() => {
        mediaDragMode = true;
        openPopover();
      }, HOLD_SHORT_MS);
    }, { signal });

    // pointer move: highlight option under finger during drag.
    // alpha is special: its panel preview-opens on hover so the user
    // sees it bloom as their finger reaches it.
    opts.chatMediaBtn.addEventListener("pointermove", (e) => {
      if (e.pointerId !== mediaPointerId || !mediaDragMode) return;
      if (e.cancelable) e.preventDefault();
      const hit = hitTestOption(e.clientX, e.clientY);
      if (hit !== hoveredOption) {
        if (hoveredOption) hoveredOption.classList.remove("--hover");
        hoveredOption = hit;
        if (hit) hit.classList.add("--hover");

        // preview-open alpha on hover, close if dragged away
        // (unless pointer is still inside the popover or alpha panel)
        const inSafeZone = pointInEl(e.clientX, e.clientY, popover)
          || (alphaPanelOpen && pointInEl(e.clientX, e.clientY, alphaPanel));
        if (hit === alphaBtn && !alphaPanelOpen) {
          toggleAlphaPanel();
        } else if (hit !== alphaBtn && !inSafeZone && alphaPanelOpen) {
          closeAlphaPanel();
        }
      }
    }, { signal });

    // pointer up: short tap toggles popover, drag-release picks the hovered option
    opts.chatMediaBtn.addEventListener("pointerup", (e) => {
      if (e.pointerId !== mediaPointerId) return;
      if (e.cancelable) e.preventDefault();
      if (mediaHoldTimer) { clearTimeout(mediaHoldTimer); mediaHoldTimer = null; }
      mediaPointerId = -1;

      if (mediaDragMode) {
        const hit = hitTestOption(e.clientX, e.clientY);
        const overAlpha = hit === alphaBtn
          || (alphaPanelOpen && pointInEl(e.clientX, e.clientY, alphaPanel));
        if (hit === opts.chatMediaFile) pickFile();
        else if (hit === opts.chatMediaDraw) pickDraw();
        else if (hit === opts.chatMediaClear) pickClear();
        else if (overAlpha) { /* already open from hover preview */ }
        else closePopover();
      } else {
        if (mediaPopoverOpen) closePopover();
        else openPopover();
      }
    }, { signal });

    // cancel cleans up
    function handleMediaPointerAbort(e: PointerEvent): void {
      if (e.pointerId !== mediaPointerId) return;
      if (mediaHoldTimer) { clearTimeout(mediaHoldTimer); mediaHoldTimer = null; }
      mediaPointerId = -1;
      if (mediaDragMode) closePopover();
    }
    opts.chatMediaBtn.addEventListener("pointercancel", handleMediaPointerAbort, { signal });
    opts.chatMediaBtn.addEventListener("lostpointercapture", handleMediaPointerAbort, { signal });
    opts.chatMediaBtn.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });

    // option clicks (normal tap-then-pick flow)
    opts.chatMediaFile.addEventListener("click", () => pickFile(), { signal });
    opts.chatMediaDraw.addEventListener("click", () => pickDraw(), { signal });
    opts.chatMediaClear.addEventListener("click", () => closePopover(), { signal });
    alphaBtn.addEventListener("click", () => toggleAlphaPanel(), { signal });

    // close popover on outside click
    document.addEventListener("pointerdown", (e) => {
      if (!mediaPopoverOpen) return;
      const t = e.target as Node;
      if (popover.contains(t) || opts.chatMediaBtn.contains(t) || alphaPanel.contains(t)) return;
      closePopover();
    }, { signal });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && mediaPopoverOpen) { closePopover(); e.stopPropagation(); }
    }, { signal });

    // prevent slider interaction from closing the popover
    alphaPanel.addEventListener("pointerdown", (e) => e.stopPropagation(), { signal });

    // ── Alpha panel: audio quality slider ──────────────────
    // physical track has a magnetic detent at q99. q100 is raw/lossless,
    // qualitatively different from q1-99. the track layout:
    //
    //   |---- q1 to q99 (linear) ----|-- detent --|-- q100 --|
    //   0%                          93%          97%        100%
    //
    // vertical drag distance increases precision (fine control).
    // crossing the detent fires haptic feedback.
    // network-adaptive: transition duration scales with env.rtt.
    {
      const track = opts.alphaAudioTrack;
      const fill = opts.alphaAudioFill;
      const thumb = opts.alphaAudioThumb;
      const qLabel = opts.alphaAudioQValue;
      const section = track.closest(".wl-alpha-section") as HTMLElement;
      let sliderPointerId = -1;
      let sliderStartX = 0;
      let sliderStartVal = 0;

      // detent geometry
      const DETENT_START = 0.93;
      const DETENT_END = 0.97;

      function fracToQ(frac: number): number {
        if (frac >= DETENT_END) return 100;
        if (frac >= DETENT_START) return 99;
        return 1 + (frac / DETENT_START) * 98;
      }

      function qToFrac(q: number): number {
        if (q >= 100) return 1;
        return ((q - 1) / 98) * DETENT_START;
      }

      // ── Orbit (harmonic bloom) ──────────────────────────
      // polar flower: r(θ) = 1 + Σ aₙ·cos(pₙ·θ)
      // petal counts are prime so harmonics never align boringly.
      // three SVG layers: ghost (skeleton), glow (halo), line (crisp + traveling gap).
      const orbitPath = opts.alphaOrbitPath;
      const orbitGlow = opts.alphaOrbitGlow;
      const orbitGhost = opts.alphaOrbitGhost;
      const hint = opts.alphaHint;

      // drift speed derived from network RTT + Q value.
      // fast network (50ms RTT) = brisk spin (~12s/rev)
      // slow network (250ms RTT) = lazy drift (~22s/rev)
      // high Q adds a slight boost (stiffer medium = quicker orbit)
      function computeDrift(): number {
        const rttNorm = Math.min(1, Math.max(0, (env.rtt - 50) * 0.005));
        const qBoost = 1 + (audioQuality - 1) * 0.001;
        const period = 12 + rttNorm * 10;
        return (2 * Math.PI) / period * qBoost;
      }
      let driftSpeed = computeDrift();

      function syncOrbitTiming(): void {
        const morphMs = Math.round(250 + Math.min(1, (env.rtt - 50) / 200) * 400);
        section.style.setProperty("--orbit-morph", `${morphMs}ms`);
        driftSpeed = computeDrift();
      }
      syncOrbitTiming();
      try { env.conn?.addEventListener("change", syncOrbitTiming, { signal }); } catch { }

      const HARMONICS = [
        { p: 3,  amp: 0.40, start: 1,  len: 20 },
        { p: 5,  amp: 0.24, start: 18, len: 20 },
        { p: 7,  amp: 0.16, start: 36, len: 20 },
        { p: 11, amp: 0.10, start: 54, len: 20 },
        { p: 13, amp: 0.07, start: 72, len: 27 },
      ];

      const ORBIT_N = 400;
      const ORBIT_S = 0.82;

      function buildFlowerD(q: number, maxLayer: number): string {
        // q100: collapse to horizontal line (same point count for CSS d-path interpolation)
        if (q >= 100) {
          const parts = [`M${(-ORBIT_S).toFixed(3)},0.000`];
          for (let i = 1; i <= ORBIT_N; i++) parts.push(`L${(-ORBIT_S + (2 * ORBIT_S * i) / ORBIT_N).toFixed(3)},0.000`);
          return parts.join("") + "Z";
        }

        let maxR = 0;
        const xs = new Float64Array(ORBIT_N + 1);
        const ys = new Float64Array(ORBIT_N + 1);

        for (let i = 0; i <= ORBIT_N; i++) {
          const theta = (i / ORBIT_N) * Math.PI * 2;
          let r = 1;
          for (let h = 0; h < maxLayer && h < HARMONICS.length; h++) {
            const fade = Math.max(0, Math.min(1, (q - HARMONICS[h].start) / HARMONICS[h].len));
            if (fade > 0) r += HARMONICS[h].amp * fade * Math.cos(HARMONICS[h].p * theta);
          }
          xs[i] = r * Math.cos(theta);
          ys[i] = r * Math.sin(theta);
          if (r > maxR) maxR = r;
        }

        const s = ORBIT_S / maxR;
        const parts = [`M${(xs[0] * s).toFixed(3)},${(ys[0] * s).toFixed(3)}`];
        for (let i = 1; i <= ORBIT_N; i++) parts.push(`L${(xs[i] * s).toFixed(3)},${(ys[i] * s).toFixed(3)}`);
        return parts.join("") + "Z";
      }

      function hintText(q: number): string {
        //                     real measured data:
        if (q >= 100) return "raw - uncompressed float32";       // bypasses pipeline
        if (q >= 90) return "transparent - beats MP3 320k";      // 206 kbps, 88 dB vs 320 kbps, 28 dB
        if (q >= 80) return "studio - full waveform detail";     // 194 kbps, 79 dB
        if (q >= 65) return "high fidelity - rich detail";        // 176 kbps, 65 dB
        if (q >= 50) return "high - reference quality";           // 157 kbps, 52 dB
        if (q >= 35) return "detailed - opus 128k equivalent";   // 146 kbps, 38 dB
        if (q >= 20) return "balanced - opus 64k equivalent";    // 87 kbps, 25 dB
        if (q >= 10) return "lean - efficient encoding";         // 28 kbps, 12 dB
        if (q >= 5) return "compact - phone call quality";        // 10 kbps, near GSM/AMR
        return "minimal - deep compression";                     // ternary signal
      }

      let applyVisuals = (q: number): void => {
        const pct = qToFrac(q) * 100;
        fill.style.width = `${pct}%`;
        thumb.style.left = `${pct}%`;
        section.classList.toggle("--raw", q >= 100);
        qLabel.textContent = q >= 100 ? "raw" : String(q);

        const dFull = buildFlowerD(q, HARMONICS.length);
        orbitPath.setAttribute("d", dFull);
        orbitGlow.setAttribute("d", dFull);
        orbitGhost.setAttribute("d", buildFlowerD(q, 2));

        hint.textContent = hintText(q);
        opts.alphaReset.classList.toggle("--modified", q !== AUDIO_Q_DEFAULT);
        track.setAttribute("aria-valuenow", String(q));
      };

      function setSliderValue(q: number, dragging: boolean): void {
        q = Math.max(1, Math.min(100, Math.round(q)));
        const prev = audioQuality;
        if (q === prev && !dragging) return;
        audioQuality = q;
        applyVisuals(q);
        if (dragging && ((prev < 100 && q >= 100) || (prev >= 100 && q < 100))) {
          haptic("detent");
        }
      }

      applyVisuals(audioQuality);

      // ── Orbit interaction (jelly physics + angular momentum) ──
      // soft body simulation grounded in the harmonic codec's Q parameter.
      // higher Q = stiffer springs, faster wave propagation, crisper wobble.
      // lower Q = gooier, slower, more elastic.
      //
      // battery optimization:
      //   - float32 arrays (halved memory bandwidth vs float64)
      //   - idle detection skips physics + path write when settled
      //   - no toFixed/string allocation in hot path (manual int rounding)
      //   - branch-free neighbor indexing (no modulo)
      //   - rotation-only frames skip the vertex loop entirely
      {
        const orbitSvg = document.getElementById("wl-alpha-orbit") as unknown as SVGSVGElement;
        const orbitContainer = opts.alphaOrbitWrap;

        let angle = 0;
        let angularVel = driftSpeed;

        const V = ORBIT_N + 1;
        const ox = new Float32Array(V);
        const oy = new Float32Array(V);
        const vx = new Float32Array(V);
        const vy = new Float32Array(V);

        // cached base positions (float32 is plenty — SVG rounds to 3 decimals)
        const bx = new Float32Array(V);
        const by = new Float32Array(V);
        let baseDirty = true;
        let verticesSettled = true; // true when no deformation is active

        // Q-derived spring physics (cached, recomputed with base shape)
        let springW2 = 140;
        let springD = 9.5;
        let waveCoupling = 0.17;
        let maxPull = 0.55;

        // curvature-weighted speed map for the traveling dash.
        // precomputed per Q change: speedMap[i] = local flow speed at vertex i.
        // high curvature (petal tips) = slow (honey catching on corners).
        // low curvature (flat stretches) = fast (fluid accelerating through open pipe).
        const speedMap = new Float32Array(V);
        let dashPhase = 0;

        const origApplyVisuals = applyVisuals;
        applyVisuals = (q: number) => { origApplyVisuals(q); baseDirty = true; verticesSettled = false; driftSpeed = computeDrift(); };
        origApplyVisuals(audioQuality);

        function recomputeBase(): void {
          const q = audioQuality;
          let maxR = 0;
          const thetaStep = (Math.PI * 2) / ORBIT_N;
          for (let i = 0; i < V; i++) {
            const theta = i * thetaStep;
            let r = 1;
            for (let h = 0; h < HARMONICS.length; h++) {
              const harm = HARMONICS[h];
              const fade = (q - harm.start) / harm.len;
              if (fade > 0) r += harm.amp * (fade < 1 ? fade : 1) * Math.cos(harm.p * theta);
            }
            const cos = Math.cos(theta), sin = Math.sin(theta);
            bx[i] = r * cos;
            by[i] = r * sin;
            if (r > maxR) maxR = r;
          }
          const s = ORBIT_S / (maxR || 1);
          for (let i = 0; i < V; i++) { bx[i] *= s; by[i] *= s; }

          const qNorm = (q - 1) / 98;
          springW2 = 80 + qNorm * 120;
          springD = 7 + qNorm * 5;
          waveCoupling = 0.08 + qNorm * 0.18;
          maxPull = 0.4 + (1 - qNorm) * 0.3;

          // build curvature-weighted speed map.
          // curvature at vertex i = |cross(v[i-1]→v[i], v[i]→v[i+1])| / (len1 * len2)
          // speed = 1 / (1 + curvature * K) → slow at sharp petal tips, fast on flat arcs
          let totalSpeed = 0;
          for (let i = 0; i < V; i++) {
            const p = i === 0 ? V - 2 : i - 1; // V-1 == 0 (closed), so use V-2
            const n = i === V - 1 ? 1 : i + 1;
            const ax = bx[i] - bx[p], ay = by[i] - by[p];
            const cx = bx[n] - bx[i], cy = by[n] - by[i];
            const cross = ax * cy - ay * cx;
            const len1 = ax * ax + ay * ay;
            const len2 = cx * cx + cy * cy;
            // avoid sqrt: use cross²/(len1*len2) as curvature² proxy, then sqrt once
            const denom = len1 * len2;
            const curv = denom > 1e-10 ? Math.sqrt((cross * cross) / denom) : 0;
            speedMap[i] = 1 / (1 + curv * 8);
            totalSpeed += speedMap[i];
          }
          // normalize so one full loop takes a consistent ~5s regardless of shape complexity
          const norm = V / totalSpeed;
          for (let i = 0; i < V; i++) speedMap[i] *= norm;

          baseDirty = false;
        }

        let ptrX = 0, ptrY = 0, prevPtrX = 0, prevPtrY = 0;
        let ptrDown = false, ptrInside = false;
        let deformRaf = 0, deformLastTick = 0;

        // reuse CTM inverse to avoid allocation per call — cache the 6 matrix elements
        let ctmA = 1, ctmB = 0, ctmC = 0, ctmD = 1, ctmE = 0, ctmF = 0;
        let ctmDirty = true;

        function refreshCtm(): void {
          try {
            const ctm = orbitSvg.getScreenCTM();
            if (ctm) {
              // invert the 2x3 affine matrix inline (no DOMMatrix.inverse() allocation)
              const det = ctm.a * ctm.d - ctm.b * ctm.c;
              if (Math.abs(det) > 1e-6) {
                const invDet = 1 / det;
                ctmA = ctm.d * invDet;
                ctmB = -ctm.b * invDet;
                ctmC = -ctm.c * invDet;
                ctmD = ctm.a * invDet;
                ctmE = (ctm.c * ctm.f - ctm.d * ctm.e) * invDet;
                ctmF = (ctm.b * ctm.e - ctm.a * ctm.f) * invDet;
                ctmDirty = false;
                return;
              }
            }
          } catch { }
          ctmDirty = true;
        }

        function clientToSvg(cx: number, cy: number): [number, number] {
          if (!ctmDirty) return [ctmA * cx + ctmC * cy + ctmE, ctmB * cx + ctmD * cy + ctmF];
          const r = orbitSvg.getBoundingClientRect();
          return [-1.1 + ((cx - r.left) / r.width) * 2.2, -1.1 + ((cy - r.top) / r.height) * 2.2];
        }

        function writeDeformedPath(): void {
          let d = "M" + f3(bx[0] + ox[0]) + "," + f3(by[0] + oy[0]);
          for (let i = 1; i < V; i++) {
            d += "L" + f3(bx[i] + ox[i]) + "," + f3(by[i] + oy[i]);
          }
          d += "Z";
          orbitPath.setAttribute("d", d);
          orbitGlow.setAttribute("d", d);
        }

        function stepDeformation(ts: number): void {
          const rawDt = deformLastTick ? (ts - deformLastTick) * 0.001 : 0.016;
          const dt = rawDt < 0.001 ? 0.001 : rawDt > 0.04 ? 0.04 : rawDt;
          deformLastTick = ts;

          refreshCtm();

          // ── angular dynamics ──
          const isRaw = audioQuality >= 100;
          if (isRaw) {
            const target = Math.round(angle / Math.PI) * Math.PI;
            angularVel += (64 * (target - angle) - 19.2 * angularVel) * dt;
          } else if (ptrDown) {
            const decay = 1 - 2 * dt;
            angularVel *= decay * decay;
          } else {
            const rate = 1.2 * dt;
            angularVel += (driftSpeed - angularVel) * (rate < 1 ? rate : 1);
          }
          if (angularVel > 12.566) angularVel = 12.566;
          else if (angularVel < -12.566) angularVel = -12.566;
          angle += angularVel * dt;
          orbitContainer.style.transform = "rotate(" + f3(angle * 57.2958) + "deg)";

          // raw/reduced: rotation only, no vertex or dash work
          if (reduceMotion || isRaw) {
            if (!verticesSettled) {
              ox.fill(0); oy.fill(0); vx.fill(0); vy.fill(0);
              origApplyVisuals(audioQuality);
              verticesSettled = true;
            }
            deformRaf = requestAnimationFrame(stepDeformation);
            return;
          }

          // ensure base shape + speed map are fresh before any reads
          if (baseDirty) recomputeBase();

          // ── fluid dash (curvature + deformation adaptive) ──
          const phase = dashPhase % 1;
          const di = (phase * ORBIT_N) | 0;
          const localSpeed = speedMap[di];

          // deformation bias: fluid rushes toward stretched regions
          let flowRate = localSpeed;
          if (!verticesSettled) {
            flowRate *= 1 + (ox[di] * ox[di] + oy[di] * oy[di]) * 12;
          }
          dashPhase += dt * 0.2 * flowRate;

          // gap width breathes with curvature: pools at petal tips, narrows on flats
          const gapW = 0.06 + (1 - localSpeed) * 0.12;
          const dashLen = 1 - gapW;
          orbitPath.style.strokeDasharray = f3(dashLen) + " " + f3(gapW);
          orbitPath.style.strokeDashoffset = f3(phase);

          // ghost opacity pulses at the fluid's leading edge
          const leadIdx = ((phase + dashLen) * ORBIT_N) | 0;
          orbitGhost.style.strokeOpacity = f3(0.12 + speedMap[leadIdx < V ? leadIdx : V - 1] * 0.06);

          // ── vertex physics ──
          const interacting = ptrInside || ptrDown;
          if (verticesSettled && !interacting) {
            deformRaf = requestAnimationFrame(stepDeformation);
            return;
          }

          const attract = ptrDown ? 0.15 : 0.04;
          const w2dt = springW2 * dt;
          const ddt = springD * dt;
          const cpl = waveCoupling;
          let energy = 0;

          for (let i = 0; i < V; i++) {
            if (interacting) {
              const ddx = ptrX - bx[i] - ox[i];
              const ddy = ptrY - by[i] - oy[i];
              const dist2 = ddx * ddx + ddy * ddy + 0.01;
              const pull = attract / dist2;
              const cp = pull < maxPull ? pull : maxPull;
              vx[i] += ddx * cp;
              vy[i] += ddy * cp;
            }

            const p = i === 0 ? V - 1 : i - 1;
            const n = i === V - 1 ? 0 : i + 1;
            vx[i] += (ox[p] + ox[n] - 2 * ox[i]) * cpl;
            vy[i] += (oy[p] + oy[n] - 2 * oy[i]) * cpl;
            vx[i] -= w2dt * ox[i] + ddt * vx[i];
            vy[i] -= w2dt * oy[i] + ddt * vy[i];
            ox[i] += vx[i] * dt;
            oy[i] += vy[i] * dt;

            energy += vx[i] * vx[i] + vy[i] * vy[i] + ox[i] * ox[i] + oy[i] * oy[i];
          }

          if (energy < 0.0001 && !interacting) {
            ox.fill(0); oy.fill(0); vx.fill(0); vy.fill(0);
            origApplyVisuals(audioQuality);
            verticesSettled = true;
          } else {
            verticesSettled = false;
            writeDeformedPath();
          }

          deformRaf = requestAnimationFrame(stepDeformation);
        }

        function ensureDeformRaf(): void {
          if (!deformRaf) { deformLastTick = 0; deformRaf = requestAnimationFrame(stepDeformation); }
        }

        function stopDeformRaf(): void {
          if (deformRaf) { cancelAnimationFrame(deformRaf); deformRaf = 0; }
          ox.fill(0); oy.fill(0); vx.fill(0); vy.fill(0);
          orbitContainer.style.transform = "";
          orbitPath.style.strokeDasharray = "";
          orbitPath.style.strokeDashoffset = "";
          orbitGhost.style.strokeOpacity = "";
        }

        onAlphaOpen = ensureDeformRaf;
        onAlphaClose = stopDeformRaf;
        if (alphaPanelOpen) ensureDeformRaf();

        orbitContainer.addEventListener("pointerleave", () => {
          ptrInside = false;
        }, { signal });

        let orbitPointerId = -1;

        orbitContainer.addEventListener("pointerdown", (e) => {
          if (e.button !== 0 || orbitPointerId !== -1) return;
          if (audioQuality >= 100) return; // flat line: no interaction
          e.preventDefault();
          orbitPointerId = e.pointerId;
          orbitContainer.setPointerCapture(e.pointerId);
          ptrDown = true;
          [ptrX, ptrY] = clientToSvg(e.clientX, e.clientY);
          prevPtrX = ptrX; prevPtrY = ptrY;
          haptic("reaction");
        }, { signal });

        orbitContainer.addEventListener("pointermove", (e) => {
          const [sx, sy] = clientToSvg(e.clientX, e.clientY);

          if (e.pointerId === orbitPointerId && ptrDown) {
            // update prev only during active drag — hover moves
            // must not pollute the velocity used for flick on release
            prevPtrX = ptrX; prevPtrY = ptrY;
            ptrX = sx; ptrY = sy;

            // torque from tangential drag (cross product of position × velocity).
            // threshold prevents radial stretches from accumulating spin.
            const dvx = ptrX - prevPtrX;
            const dvy = ptrY - prevPtrY;
            const speed = Math.sqrt(dvx * dvx + dvy * dvy);
            if (speed > 0.003) {
              const torque = ptrX * dvy - ptrY * dvx;
              const dist = Math.sqrt(ptrX * ptrX + ptrY * ptrY) + 0.1;
              angularVel += (torque / dist) * 2.5;
            }
            return;
          }

          // hover (not dragging): update position for soft attraction
          ptrX = sx; ptrY = sy;
          ptrInside = true;
        }, { signal });

        orbitContainer.addEventListener("pointerup", (e) => {
          if (e.pointerId !== orbitPointerId) return;
          orbitPointerId = -1;

          const [upX, upY] = clientToSvg(e.clientX, e.clientY);
          const velX = upX - prevPtrX;
          const velY = upY - prevPtrY;

          // angular flick (normalized by distance from center)
          const dist = Math.sqrt(upX * upX + upY * upY) + 0.1;
          angularVel += ((upX * velY - upY * velX) / dist) * 3;

          // vertex flick: nearby vertices get kicked by pointer momentum
          if ((Math.abs(velX) + Math.abs(velY) > 0.02) && !baseDirty) {
            const fx = velX * 15, fy = velY * 15;
            for (let i = 0; i < V; i++) {
              const ddx = bx[i] + ox[i] - upX;
              const ddy = by[i] + oy[i] - upY;
              const w = 0.25 / (Math.sqrt(ddx * ddx + ddy * ddy) + 0.15);
              vx[i] += fx * w;
              vy[i] += fy * w;
            }
          }

          ptrDown = false;
        }, { signal });

        orbitContainer.addEventListener("lostpointercapture", () => {
          orbitPointerId = -1;
          ptrDown = false;
        }, { signal });

        signal.addEventListener("abort", () => {
          if (deformRaf) { cancelAnimationFrame(deformRaf); deformRaf = 0; }
        }, { once: true });
      }

      track.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || sliderPointerId !== -1) return;
        e.preventDefault();
        e.stopPropagation();
        sliderPointerId = e.pointerId;
        track.setPointerCapture(e.pointerId);
        track.classList.add("--dragging");
        section.classList.add("--dragging");
        qLabel.classList.add("--active");

        const rect = track.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        setSliderValue(fracToQ(frac), true);
        sliderStartX = e.clientX;
        sliderStartVal = audioQuality;
      }, { signal });

      track.addEventListener("pointermove", (e) => {
        if (e.pointerId !== sliderPointerId) return;
        if (e.cancelable) e.preventDefault();

        const rect = track.getBoundingClientRect();
        const vertDist = Math.abs(e.clientY - (rect.top + rect.height / 2));
        const precision = 1 / (1 + vertDist * 0.04);
        track.classList.toggle("--fine", precision < 0.5);

        const dx = e.clientX - sliderStartX;
        const currentFrac = qToFrac(sliderStartVal) + (dx / (rect.width || 1)) * precision;
        setSliderValue(fracToQ(currentFrac), true);
      }, { signal });

      function endSliderDrag(e: PointerEvent): void {
        if (e.pointerId !== sliderPointerId) return;
        sliderPointerId = -1;
        track.classList.remove("--dragging", "--fine");
        section.classList.remove("--dragging");
        qLabel.classList.remove("--active");
      }
      track.addEventListener("pointerup", endSliderDrag, { signal });
      track.addEventListener("pointercancel", endSliderDrag, { signal });
      track.addEventListener("lostpointercapture", endSliderDrag, { signal });

      // keyboard: arrows ±1, page ±10, home/end
      track.tabIndex = 0;
      track.setAttribute("role", "slider");
      track.setAttribute("aria-label", "Audio quality");
      track.setAttribute("aria-valuemin", "1");
      track.setAttribute("aria-valuemax", "100");

      track.addEventListener("keydown", (e) => {
        let delta = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = 1;
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -1;
        else if (e.key === "PageUp") delta = 10;
        else if (e.key === "PageDown") delta = -10;
        else if (e.key === "Home") { setSliderValue(1, false); e.preventDefault(); return; }
        else if (e.key === "End") { setSliderValue(100, false); e.preventDefault(); return; }
        else return;
        e.preventDefault();
        setSliderValue(audioQuality + delta, false);
      }, { signal });

      // mic icon resets to default with smooth slide animation
      opts.alphaReset.addEventListener("click", (e) => {
        e.stopPropagation();
        if (audioQuality === AUDIO_Q_DEFAULT) return;
        track.classList.add("--resetting");
        setSliderValue(AUDIO_Q_DEFAULT, false);
        haptic("mode-switch");
        thumb.addEventListener("transitionend", () => track.classList.remove("--resetting"), { once: true, signal });
      }, { signal });
    }
  }

  // ── Clipboard paste button ──────────────────────────────────
  // first tap: inject cached clipboard into input (text) or send files.
  // second tap (or hold): send text. ctrl+v pastes normally (no auto-send).

  // handle ctrl+v paste — files get sent, text just enters the input normally
  opts.chatInput.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (items) {
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f); }
      }
      if (files.length) {
        e.preventDefault();
        sendFilesToChat(files, "paste");
      }
    }
    // text paste: let the browser handle it naturally, no pasted state
  }, { signal });

  // clear pasted state when user edits the input
  opts.chatInput.addEventListener("input", () => {
    if (pastePending) clearPasteState();
  }, { signal });

  opts.chatPasteBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || opts.chatPasteBtn.disabled) return;
    pasteHoldFired = false;
    if (pastePending) {
      // content already pasted — hold sends immediately
      pasteHoldTimer = setTimeout(() => {
        pasteHoldTimer = null;
        pasteHoldFired = true;
        sendMessage();
        clearPasteState();
      }, HOLD_SHORT_MS);
    }
  }, { signal });

  opts.chatPasteBtn.addEventListener("pointerup", () => {
    if (pasteHoldTimer) { clearTimeout(pasteHoldTimer); pasteHoldTimer = null; }
  }, { signal });

  opts.chatPasteBtn.addEventListener("click", async () => {
    if (pasteHoldFired) { pasteHoldFired = false; return; }
    if (opts.chatPasteBtn.disabled) return;

    if (pastePending) {
      // second tap — send
      sendMessage();
      clearPasteState();
      return;
    }

    // first tap — paste from internal cache or readText fallback
    await pasteFromClipboard();
  }, { signal });

  // Mic button: pointer events for click vs hold detection.
  // - Primary button only (button 0) — ignore right-click, pen eraser, etc.
  // - Pointer ID tracking — ignore multi-touch secondary fingers.
  // - setPointerCapture — pointerup always fires on mic even if finger slides off.
  opts.chatMicBtn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (editingMsgId != null) { exitEditMode(); return; }
    if (opts.chatMicBtn.disabled) return;
    if (micPointerId !== -1) return;           // already tracking a pointer

    // Create and resume AudioContext synchronously with user gesture
    if (!micAudioCtx) micAudioCtx = createAudioContext();
    if (micAudioCtx?.state === "suspended") void micAudioCtx.resume();

    e.preventDefault();
    micPointerId = e.pointerId;
    opts.chatMicBtn.setPointerCapture(e.pointerId);
    micHoldMode = false;
    micDeferred = null;
    micHoldTimer = setTimeout(() => {
      micHoldMode = true;
      startRecording();
    }, HOLD_SHORT_MS);
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
  // show the browser context menu, fighting the hold-to-record gesture.
  opts.chatMicBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); }, { signal });

  // Cancel requires confirmation: first tap arms, second tap (or hold) confirms.
  let cancelArmed = false;
  let cancelArmTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelHoldFired = false; // true when hold already cancelled — swallow the trailing click

  function disarmCancel(): void {
    cancelArmed = false;
    opts.chatMicCancel.removeAttribute("data-armed");
    opts.chatMicCancel.setAttribute("aria-label", "Cancel recording");
    if (cancelArmTimer) { clearTimeout(cancelArmTimer); cancelArmTimer = null; }
    if (cancelHoldTimer) { clearTimeout(cancelHoldTimer); cancelHoldTimer = null; }
  }

  opts.chatMicCancel.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || opts.chatMicCancel.disabled) return;
    cancelHoldFired = false;
    cancelHoldTimer = setTimeout(() => {
      cancelHoldTimer = null;
      cancelHoldFired = true;
      disarmCancel();
      cancelRecording();
    }, cancelArmed ? HOLD_SHORT_MS : HOLD_CONFIRM_MS);
  }, { signal });

  opts.chatMicCancel.addEventListener("pointerup", () => {
    if (cancelHoldTimer) { clearTimeout(cancelHoldTimer); cancelHoldTimer = null; }
  }, { signal });

  opts.chatMicCancel.addEventListener("click", () => {
    if (cancelHoldFired) { cancelHoldFired = false; return; }
    if (!cancelArmed) {
      cancelArmed = true;
      opts.chatMicCancel.setAttribute("data-armed", "");
      opts.chatMicCancel.setAttribute("aria-label", "Tap again to discard recording");
      cancelArmTimer = setTimeout(disarmCancel, DISARM_MS);
      return;
    }
    disarmCancel();
    cancelRecording();
  }, { signal });

  // suppress context menu on cancel button for mobile hold gesture
  opts.chatMicCancel.addEventListener("contextmenu", (e) => { e.preventDefault(); }, { signal });

  opts.chatMicSend.addEventListener("click", () => { disarmCancel(); stopRecording(); }, { signal });

  // Escape cancels recording (any mode) — keyboard is intentional, no confirm needed
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (recordingStream || micPending)) {
      disarmCancel();
      cancelRecording();
    }
  }, { signal });

  opts.chatMediaClear.addEventListener("click", () => {
    if (!session) {
      executeClearHistory();
      return;
    }
    if (clearVote.state === "pending-out") {
      clearVote.cancelLocal();
      session.sendCtrl(CTRL_OP.CANCEL, encodeVotePayload(VOTE_TOPIC.CLEAR, clearVote.round));
      return;
    }
    if (clearVote.localVoted) return;
    session.sendCtrl(CTRL_OP.VOTE, encodeVotePayload(VOTE_TOPIC.CLEAR, clearVote.round));
    clearVote.castLocal();
  }, { signal });

  // ── Shared file-send helper (used by file picker, draw, drag-drop) ──
  async function sendFileToChat(file: File, label = "file"): Promise<void> {
    if (!session) {
      const fileData = new Uint8Array(await file.arrayBuffer());
      const previewMsgId = -(++previewSendId);
      addChatMessage({
        type: "file", direction: "self",
        fileName: file.name, fileSize: file.size, fileType: file.type,
        fileData, timestamp: Date.now(), msgId: previewMsgId,
      });
      simulateSendEnergy();
      return;
    }
    sendBeginFill();
    // staged for onSendStart to pick up if this turns into a chunked transfer —
    // see the comment there. cleared unconditionally below; small/non-chunked
    // sends never consume it (they already carry fileData on their self-echo).
    pendingOutboundFile = file;
    try {
      const msgId = await session.sendFile(file);
      sendInFlight(msgId);
    } catch (err) {
      send.phase = "delivered"; send.velocity = -4;
      haptic("send-failed");
      appendLog(`${label} send failed: ${errMsg(err)}`);
      pulseComposeIntent("error", 1100);
    } finally {
      pendingOutboundFile = null;
    }
  }

  async function sendFilesToChat(files: Iterable<File>, label = "file"): Promise<void> {
    for (const file of files) {
      await sendFileToChat(file, label);
    }
  }

  opts.chatFileInput.addEventListener("change", async () => {
    const files = Array.from(opts.chatFileInput.files ?? []);
    opts.chatFileInput.value = "";
    if (!files.length) return;
    await sendFilesToChat(files);
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
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (!files.length) return;
    haptic("drop");
    await sendFilesToChat(files);
  }, { signal });

  opts.disconnectBtn.addEventListener("click", () => {
    if (session) {
      // haptic("disconnected") fires from session state handler — no double-fire
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
      haptic("copied");
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

  window.addEventListener("focus", () => { hasFocus = true; clearUnread(); flushPendingSeen(); }, { signal });
  window.addEventListener("blur", () => { hasFocus = false; }, { signal });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) flushPendingSeen(); }, { signal });
  window.addEventListener("resize", syncPeerPreviewLayout, { signal });
  window.visualViewport?.addEventListener("resize", syncPeerPreviewLayout, { signal });
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
    setTimeout(() => { if (!aborted()) void handleRelayConnect(true); }, 100);
  }

  // ?auto=1 with ?flare=1 and a phrase → auto-fire flare
  if (urlFlag("auto") && urlFlag("flare") && flarePhraseInput && flarePhraseInput.value.trim()) {
    setTimeout(() => { if (!aborted()) void handleFlareConnect(true); }, 100);
  }

  // QR flare handoff: whisper.astro's deep-link script decodes any
  // #wl:<base64url(phrase)> fragment, forces live mode, and hands the
  // phrase off here through sessionStorage (the fragment is stripped
  // before this module even starts loading, so it can't be read directly).
  // One-shot — removed immediately so a later funnel switch or view-
  // transition re-init never re-fires it. Harmless if empty/undecodable:
  // that just leaves the phrase input blank and live mode already open.
  const applyQrHandoff = (phrase: string): void => {
    if (!phrase || session) return;
    opts.phraseInput.value = phrase;
    if (opts.relayAssistToggle) {
      opts.relayAssistToggle.checked = true;
      applyModeSwitch("relay");
    }
    setTimeout(() => { if (!aborted() && !session) void handleRelayConnect(true); }, 100);
  };

  const qrHandoffPhrase = sessionStorage.getItem("wl-qr-phrase");
  if (qrHandoffPhrase !== null) {
    sessionStorage.removeItem("wl-qr-phrase");
    applyQrHandoff(qrHandoffPhrase.trim());
  }

  // in-person handoff on a cold load (native camera opened a fresh tab): the
  // deep-link script stashed the packed payload; route it the same way a
  // hashchange would. one-shot.
  const localHandoffPayload = sessionStorage.getItem("wl-local-payload");
  if (localHandoffPayload !== null) {
    sessionStorage.removeItem("wl-local-payload");
    setTimeout(() => { if (!aborted()) void applyLocalHandoff(localHandoffPayload); }, 100);
  }

  // a flare can also land on a tab that is already open: qr scanners reuse
  // the existing tab, which only fires hashchange (the deep-link script in
  // whisper.astro runs once at document load and never again). decode the
  // fragment here and run the same one-shot path so a hot tab connects as
  // smoothly as a cold one. a live session wins over an incoming flare.
  window.addEventListener("hashchange", () => {
    const h = window.location.hash;
    // in-person handoff: the payload's role decides offer-vs-answer. crucially
    // this is a hashchange, not a reload, so an offerer's session survives to
    // receive the scanned-back answer.
    if (h.startsWith("#wl-local:")) {
      const payload = h.slice("#wl-local:".length);
      history.replaceState({}, "", window.location.pathname + window.location.search);
      if (aborted()) return;
      void applyLocalHandoff(payload);
      return;
    }
    if (!h.startsWith("#wl:")) return;
    history.replaceState({}, "", window.location.pathname + window.location.search);
    if (aborted() || session) return;
    try {
      const b64 = h.slice(4).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      applyQrHandoff(new TextDecoder().decode(bytes).trim());
    } catch {
      // undecodable fragment: nothing to apply
    }
  }, { signal });

  void getQrScannerCapability().then((capability) => {
    if (aborted()) return;
    liveQrSupported = capability.supported;
    liveQrUnavailableLabel = getQrCapabilityLabel(capability.reason);
    setJoinQrUiState(false);
    refreshCapabilityUi();
  });

  showPhase(opts.liveSection);
  setOfferQrExpanded(false);
  setAnswerQrExpanded(false);
  setRelayQrExpanded(false);
  updateControls();

  // Close any open reaction shelf when clicking outside the chat messages area
  document.addEventListener("click", (e) => {
    if (opts.chatMessages.contains(e.target as Node)) return;
    closeReactionShelf();
  }, { signal });

  /* ── Teardown ───────────────────────────────────────────── */

  return () => {
    ac.abort();
    if (editingMsgId != null) exitEditMode();
    closeDrawSurface();
    resetPeerLivePreview();
    relayActive = false;
    if (relayAbort) {
      relayAbort.abort();
      relayAbort = null;
    }
    extinguishFlare();
    extinguishQrArm();
    if (relayQrDebounceTimer) { clearTimeout(relayQrDebounceTimer); relayQrDebounceTimer = null; }
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
    if (pasteHoldTimer) { clearTimeout(pasteHoldTimer); pasteHoldTimer = null; }
    if (cancelArmTimer) { clearTimeout(cancelArmTimer); cancelArmTimer = null; }
    if (cancelHoldTimer) { clearTimeout(cancelHoldTimer); cancelHoldTimer = null; }
    stopRecordingSilently(true);
    stopAllAudio();
    closeMediaLightbox();
    document.documentElement.classList.remove("wl-stage");
    document.title = originalTitle;
    clearVote.destroy();
    campfireVote.destroy();
    revokeObjectUrls();
    releaseTransferWakeLock();
  };
}
