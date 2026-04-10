/**
 * Whisper Live — peer-to-peer encrypted ephemeral communication.
 *
 * No relay servers. No accounts. No trace.
 *
 * Connections use WebRTC DataChannels (DTLS-encrypted at the transport layer).
 * STUN is used only for NAT traversal. It never sees message content.
 * On top of the DTLS transport, messages are protected by:
 *   - ECDH P-256 key exchange (ephemeral, wiped after derivation)
 *   - Full Double Ratchet forward secrecy (Signal protocol pattern)
 *   - AES-256-GCM per-message encryption (32-byte keys, derived nonces with 4-byte random salt)
 *   - Whisper Loop (Kizuna membrane): unified ratchet+codec, HKDF+AES-CTR symmetric chain
 *     the ratchet IS the codec — compressed traffic is opaque without the chain key.
 * SDP offers/answers are compressed and exchanged manually (no signaling server).
 */

import {
  WhisperEngine,
  randomBytes,
  concatBytes,
  toHex,
  sha256,
  toArrayBuffer,
} from "./wasm";
import {
  TE,
  TD,
  hkdf,
  aesGcmEncrypt,
  aesGcmDecrypt,
  kdfChainDirect,
  compressP256,
  decompressP256,
  importCtrlKey,
  sealCtrl,
  openCtrl,
} from "./live-crypto";

import {
  type LoopState,
  loopInit,
  loopStep,
  loopEncode,
  loopDecode,
  loopWipe,
  loopExpand,
} from "./live-loop";
import { sdpToCode, codeToSdp, canonicalizeSdpForTranscript } from "./live-sdp";
import { CTRL_OP, encodeCtrl, decodeCtrl, decodeStreamState } from "./live-ctrl";
import {
  type DrawStreamEvent,
  DrawStreamTracker,
  decodeDrawStreamEvent,
  encodeDrawStreamEvent,
} from "./live-draw-stream";

import {
  type RatchetState,
  generateDHKeyPair,
  dhRatchetStep,
  initRatchetAsOfferer,
  initRatchetAsReceiver,
} from "./live-ratchet";

import {
  HEADER_SIZE,
  HEADER_SIZE_COMPACT,
  LIVE_FLAG_SAME_KEY,
  buildHeader,
  buildNonce,
  parseHeader,
  encodeFilePlaintext,
  decodeFilePlaintext,
  encodeFilePartPlaintext,
  decodeFilePartPlaintext,
  type FilePartHeader,
} from "./live-wire";

import {
  BUFFERED_AMOUNT_LOW,
  estimateChunkedPrefixedSize,
  iterateChunksPrefixed,
  ChunkAssembler,
} from "./live-chunking";

import { createMinimalPNGCarrier } from "./live-carrier";
import {
  derivePhraseRoot,
  derivePhraseScopedKey,
  deriveHandshakeTranscriptHash,
  deriveSessionRoot,
  deriveKizunaWitness,
  deriveConfirmContextHash,
  buildConfirmProof,
  verifyConfirmProof,
  deriveSilentKey,
  deriveAudioKey,
  deriveCtrlKey,
  type HandshakeRole,
} from "./live-handshake";
import type { TrackerRelaySignal } from "./live-tracker";

/* ── Types ──── */

export type LiveState =
  | "idle"
  | "offering"
  | "waiting-for-answer"
  | "answering"
  | "connecting"
  | "handshaking"
  | "verifying"
  | "live"
  | "silent"
  | "recovering"
  | "disconnected"
  | "error";

export type TransportMode = "naked" | "dressed" | "silent";

export interface LiveMessage {
  type: "text" | "file" | "system";
  direction: "self" | "peer" | "system";
  /**
   * Global session message ID — unique across both directions for the entire session.
   * Offerer's messages: 0, 2, 4… Answerer's messages: 1, 3, 5…
   * Zero wire overhead — derived from per-side send/recv totals + role.
   */
  msgId?: number;
  text?: string;
  fileName?: string;
  fileSize?: number;
  /** file payload for small single-message files (< 4 MB). */
  fileData?: Uint8Array;
  /** file payload for large chunked transfers — assembled from per-chunk Blobs
   *  so the data lives in browser blob storage (can swap to disk), not JS heap.
   *  consumers should prefer the filePayloadBlob() helper over reading these directly. */
  fileBlob?: Blob;
  fileType?: string;
  timestamp: number;
}

export interface ConnectionStats {
  rtt: number;
  bytesSent: number;
  bytesReceived: number;
}

export interface WhisperLiveCallbacks {
  onStateChange: (state: LiveState, detail?: string) => void;
  onFingerprint: (emoji: string) => void;
  onMessage: (msg: LiveMessage) => void;
  onLog: (line: string) => void;
  /** When set and flags & 0x02 (campfire bit), decrypted plaintext is forwarded here instead of onMessage. */
  onRawDecrypted?: (plaintext: Uint8Array) => void;
  /** Peer compose state. 0x00 = actively typing, 0x01 = idle with unsent text, 0x02 = cleared. */
  onPeerTyping?: (state: number) => void;
  /** A message we sent was successfully decrypted by the peer. msgId identifies which message. */
  onAck?: (msgId: number) => void;
  /** Progress during chunked send (file transfers). */
  onSendProgress?: (bytesSent: number, totalBytes: number) => void;
  /** Periodic connection quality stats (fires each heartbeat cycle). */
  onConnectionStats?: (stats: ConnectionStats) => void;
  /** Incoming control frame from peer. */
  onCtrl?: (opcode: number, payload: Uint8Array) => void;
  /** Parsed live-draw stream event from peer. */
  onDrawStream?: (event: DrawStreamEvent) => void;
  /** Peer's audio/video/screen stream state changed. */
  onStreamState?: (audio: boolean, video: boolean, screen: boolean) => void;
  /** A message was edited (by self or peer). */
  onEdit?: (targetMsgId: number, newText: string, direction: "self" | "peer") => void;
}

export interface WhisperLiveSessionOptions {
  /**
   * RTCPeerConnection configuration.
   * Default is "local-only" (no STUN/TURN) to avoid any external network assist.
   */
  rtcConfig?: RTCConfiguration;

  /**
   * Controls whether external assist is dropped after connection setup.
   * Defaults to "drop-after-connect" for current behavior.
   */
  externalAssistPolicy?: "drop-after-connect" | "keep-for-session";

  /**
   * When true, automatically calls confirmFingerprint() upon reaching "verifying" state.
   * Used for programmatic neighbor connections in Campfire mode where Root has already
   * verified the topology.
   */
  autoConfirmFingerprint?: boolean;

  /**
   * TURN server pool for bond-seeded relay selection.
   * When a sharedPhrase is provided and this array is non-empty,
   * both peers independently select the same TURN server via HKDF(phrase).
   * ICE still prefers direct P2P — TURN fires only as a silent fallback.
   */
  turnPool?: RTCIceServer[];
}

/* ── Visual Fingerprint ──── */

export const FINGERPRINT_EMOJI = [
  // forest & nature
  "\u{1F332}", // evergreen tree
  "\u{1F333}", // deciduous tree
  "\u{1F344}", // mushroom
  "\u{1F33F}", // herb
  "\u{1F343}", // leaves
  "\u{1F341}", // maple leaf
  "\u{1F342}", // fallen leaf
  "\u{1F33E}", // sheaf of rice
  "\u{1F330}", // chestnut
  "\u{1F338}", // cherry blossom
  "\u{1F339}", // rose
  "\u{1F33B}", // sunflower
  "\u{1F331}", // seedling
  "\u{1FAB6}", // feather
  "\u{1F340}", // four leaf clover
  // fantasy & sky
  "\u{1F52E}", // crystal ball
  "\u{1FA84}", // magic wand
  "\u{2728}",  // sparkles
  "\u{1F4AB}", // dizzy
  "\u{1F31F}", // glowing star
  "\u{2B50}",  // star
  "\u{1F319}", // crescent moon
  "\u{1F315}", // full moon
  "\u{1F311}", // new moon
  "\u{1F525}", // fire
  "\u{1F48E}", // gem
  "\u{1F30A}", // wave
  "\u{26A1}",  // lightning
  "\u{2744}\uFE0F",  // snowflake
  "\u{1F308}", // rainbow
  // knightly & castle
  "\u{1F3F0}", // castle
  "\u{2694}\uFE0F",  // crossed swords
  "\u{1F6E1}\uFE0F", // shield
  "\u{1F5E1}\uFE0F", // dagger
  "\u{1F3F9}", // bow and arrow
  "\u{1F5DD}\uFE0F", // old key
  "\u{1F4DC}", // scroll
  "\u{1FA99}", // coin
  "\u{1F56F}\uFE0F", // candle
  "\u{269C}\uFE0F",  // fleur-de-lis
  // creatures
  "\u{1F98A}", // fox
  "\u{1F43A}", // wolf
  "\u{1F99D}", // raccoon
  "\u{1F408}\u200D\u{2B1B}", // black cat
  "\u{1F409}", // dragon
  "\u{1F984}", // unicorn
  "\u{1F989}", // owl
  "\u{1F987}", // bat
  "\u{1F98C}", // deer
  "\u{1F407}", // rabbit
  "\u{1F994}", // hedgehog
  "\u{1F9A2}", // swan
  "\u{1F41D}", // bee
  "\u{1F40C}", // snail
  "\u{1F40D}", // snake
  // hearts
  "\u{1F49C}", // purple heart
  "\u{1F5A4}", // black heart
  "\u{1F496}", // sparkling heart
  "\u{1F49D}", // heart with ribbon
  // other
  "\u{1F1E8}\u{1F1E6}", // canada
  "\u{1F5FF}", // moai (stonehenge)
  "\u{1F484}", // lipstick
  "\u{1FAB7}", // biting lip
  "\u{1F346}", // eggplant
  "\u{1F351}", // peach
  "\u{1F34E}", // apple
  "\u{1F349}", // watermelon
];

const TURN_KDF_INFO_PHRASE = TE.encode("whisper-turn-v1");
const TURN_KDF_INFO_BOND = TE.encode("whisper-turn-bond-v1");
const STUN_KDF_INFO_PHRASE = TE.encode("whisper-stun-v1");
const ZERO_SALT_32 = new Uint8Array(32);

async function selectTurnServer(phraseRoot: Uint8Array, pool: RTCIceServer[]): Promise<RTCIceServer> {
  const indexBytes = await derivePhraseScopedKey(phraseRoot, "turn-select", 4, TURN_KDF_INFO_PHRASE);
  const idx = new DataView(indexBytes.buffer, indexBytes.byteOffset).getUint32(0, false) % pool.length;
  return pool[idx];
}

/** Count individual URLs across an array of RTCIceServer objects. */
function countIceUrls(servers: RTCIceServer[]): number {
  let n = 0;
  for (const s of servers) {
    n += Array.isArray(s.urls) ? s.urls.length : 1;
  }
  return n;
}

/**
 * Select STUN servers from the pool, keeping total URL count ≤ maxUrls.
 * Browsers (Chrome, Firefox) warn/slow down ICE when ≥ 5 STUN/TURN URLs
 * are configured — they count individual URLs, not RTCIceServer objects.
 */
async function selectStunServers(
  phraseRoot: Uint8Array | null, pool: RTCIceServer[], maxUrls: number,
): Promise<RTCIceServer[]> {
  if (countIceUrls(pool) <= maxUrls) return pool;
  if (!phraseRoot) {
    // no phrase root — take objects from the front until we hit the limit
    const out: RTCIceServer[] = [];
    let urls = 0;
    for (const s of pool) {
      const c = Array.isArray(s.urls) ? s.urls.length : 1;
      if (urls + c > maxUrls) continue;
      out.push(s);
      urls += c;
    }
    return out;
  }

  // deterministic shuffle seeded by phrase, then greedily fill up to maxUrls
  const seedBytes = await derivePhraseScopedKey(phraseRoot, "stun-select", 4, STUN_KDF_INFO_PHRASE);
  const seed = new DataView(seedBytes.buffer, seedBytes.byteOffset).getUint32(0, false);
  const indices = Array.from({ length: pool.length }, (_, i) => i);
  // Fisher-Yates with seed-derived offsets
  for (let i = indices.length - 1; i > 0; i--) {
    const j = (seed + i * 2654435761) % (i + 1); // Knuth multiplicative hash mix
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const out: RTCIceServer[] = [];
  let urls = 0;
  for (const idx of indices) {
    const s = pool[idx];
    const c = Array.isArray(s.urls) ? s.urls.length : 1;
    if (urls + c > maxUrls) continue;
    out.push(s);
    urls += c;
  }
  return out;
}

export async function deriveFingerprint(sharedSecret: Uint8Array): Promise<string> {
  const hash = await sha256(concatBytes(TE.encode("whisper-fp-v1"), sharedSecret));
  const n = FINGERPRINT_EMOJI.length;
  const pool = Array.from({ length: n }, (_, i) => i);
  let result = "";
  for (let i = 0; i < 4; i++) {
    // 2 hash bytes per pick → 16-bit range (65536), bias < 1 in 6500
    const v = (hash[i * 2] << 8) | hash[i * 2 + 1];
    const j = i + (v % (n - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    result += FINGERPRINT_EMOJI[pool[i]];
  }
  return result;
}

/* ── WhisperLiveSession ──── */

/** Local-only ICE. No STUN/TURN — no metadata leaves the device. Default. */
export const WHISPER_LIVE_RTC_LOCAL_ONLY: RTCConfiguration = {
  iceServers: [],
};

/**
 * Public STUN (opt-in). Each entry is contacted in parallel.
 * Diverse ports (80, 443, 3478, 10000, 19302) and providers maximise the
 * chance of punching through restrictive firewalls. All servers verified live.
 */
export const WHISPER_LIVE_RTC_PUBLIC_STUN: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.nextcloud.com:443" },                          // :443 — open source, privacy-focused
    { urls: "stun:meet-jit-si-turnrelay.jitsi.net:443" },             // :443 — WebRTC-native, 8x8-backed
    { urls: "stun:stun.relay.metered.ca:80" },                        // :80  — commercial, verified
    { urls: "stun:stun.sipgate.net:10000" },                          // :10000 — German telco, 20yr uptime
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302",
             "stun:stun2.l.google.com:19302", "stun:stun3.l.google.com:19302",
             "stun:stun4.l.google.com:19302"] },                      // :19302 — Google, 5 endpoints
    { urls: "stun:stun.cloudflare.com:3478" },                        // :3478  — Cloudflare, privacy-respecting
    { urls: "stun:global.stun.twilio.com:3478" },                     // :3478  — Twilio, major telecom
    { urls: "stun:turn.matrix.org:3478" },                            // :3478  — Matrix Foundation, nonprofit
  ],
  iceCandidatePoolSize: 1,
};

/**
 * Relay-only. Forces all traffic through a TURN server; peer IPs are never exposed.
 * Requires a TURN entry in turnPool, e.g. `turns:host:443?transport=tcp`.
 */
export const WHISPER_LIVE_RTC_STEALTH: RTCConfiguration = {
  iceTransportPolicy: "relay",
  iceServers: [],
  iceCandidatePoolSize: 0,
};

const ICE_GATHER_TIMEOUT = 8_000;         // max wait for ICE candidate gathering
const ICE_GATHER_SETTLE_MS = 1_500;       // stop once candidates have gone quiet long enough
const ICE_GATHER_TIMEOUT_ASSIST = 15_000; // public STUN needs a wider ceiling than local-only
const HEARTBEAT_INTERVAL = 15_000;        // send ping every 15s
const HEARTBEAT_TIMEOUT = 45_000;         // drop peer after 45s silence

const LIVE_MSG = {
  KEY_EXCHANGE: 0x10,
  RATCHET_INIT: 0x11,
  ENCRYPTED: 0x20,
  FINGERPRINT_CONFIRMED: 0x30,
  FINGERPRINT_REJECTED: 0x31,
  PING: 0x40,
  PONG: 0x41,
  TYPING: 0x42,
  ACK: 0x43,
  CTRL: 0x50,
  SEALED: 0x51,
} as const;

const LIVE_FLAG = {
  FILE: 0x01,
  CAMPFIRE: 0x02,
  FILE_PART: 0x04, // application-level multi-part file chunk
  EDIT: 0x10,      // [targetMsgId:4B LE][new text:UTF-8]
} as const;
/** Each application-layer file chunk is this many bytes of raw file data. */
const FILE_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
const SEND_PROGRESS_INTERVAL_MS = 48;

function errorMessage(err: unknown, fallback = "unknown"): string {
  return err instanceof Error ? err.message : fallback;
}

const VALID_TRANSITIONS: Record<LiveState, readonly LiveState[]> = {
  "idle": ["offering", "answering", "error"],
  "offering": ["waiting-for-answer", "error", "disconnected"],
  "waiting-for-answer": ["connecting", "error", "disconnected"],
  "answering": ["connecting", "error", "disconnected"],
  "connecting": ["handshaking", "error", "disconnected"],
  "handshaking": ["verifying", "error", "disconnected"],
  "verifying": ["live", "silent", "error", "disconnected"],
  "live": ["silent", "recovering", "disconnected", "error"],
  "silent": ["live", "recovering", "disconnected", "error"],
  "recovering": ["live", "silent", "disconnected", "error"],
  "disconnected": ["idle"],
  "error": ["idle"],
};

/** State for a multi-part file transfer being received.
 *  chunks are stored as Blobs so the browser can swap them to disk —
 *  keeps JS heap bounded regardless of file size. */
interface IncomingFileTransfer {
  fileName: string;
  fileType: string;
  totalSize: number;
  totalChunks: number;
  chunks: Map<number, Blob>;
  receivedBytes: number;
  firstMsgId: number;
}

export class WhisperLiveSession {
  private _state: LiveState = "idle";
  private _destroyed = false;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ratchetState: RatchetState | null = null;
  private sharedSecret: Uint8Array | null = null;
  private silentKey: Uint8Array | null = null;
  private audioKeyBytes: Uint8Array | null = null;
  private ctrlChainSend: Uint8Array | null = null;
  private ctrlChainRecv: Uint8Array | null = null;
  private ctrlSendCounter = 0;
  private ctrlRecvCounter = 0;
  private consecutiveDecryptFailures = 0;
  /** PBKDF2-stretched phrase root (wipeable bytes, never store the raw string). */
  private phraseRoot: Uint8Array | null = null;
  private transportMode: TransportMode = "naked";
  private assembler = new ChunkAssembler();
  private incomingFiles = new Map<number, IncomingFileTransfer>();
  private engine: WhisperEngine | null = null;
  private isOfferer = false;
  /** Total messages sent this session — never resets unlike ratchet nSend. */
  private nSentTotal = 0;
  /** Total messages received this session — mirrors peer's nSentTotal. */
  private nRecvTotal = 0;
  private nextDrawStreamSeq = 0;
  private drawStreamSendQueue: Promise<void> = Promise.resolve();
  private drawStreamRecvTracker = new DrawStreamTracker();

  // Pubkey dedup — track last sent/received DH pubkey to elide from compact headers
  private lastSentPubKeyHex = "";
  private lastRecvPubKeyHex = "";

  // Kizuna membrane loop states — one per direction, reinit on each DH ratchet step.
  private loopStateSend: LoopState | null = null;
  private loopStateRecv: LoopState | null = null;
  private skippedLoopKeys: Map<string, Uint8Array> = new Map();

  /** Ephemeral ECDH private key — exists only during handshake, then wiped */
  private ephPrivateKey: CryptoKey | null = null;
  private localEphPublicKey: Uint8Array | null = null;
  private transcriptHash: Uint8Array | null = null;
  private kizunaWitness: Uint8Array | null = null;
  private confirmContextHash: Uint8Array | null = null;
  private pendingPeerConfirmProof: Uint8Array | null = null;
  private ratchetInitReceived = false;
  /** The ratchet pubkey we sent in our RATCHET_INIT — stays fixed even after dhRatchetStep regenerates dhSelf. */
  private ratchetInitSentPubKey: Uint8Array | null = null;
  private localConfirmRequested = false;
  private localConfirmSent = false;
  private remoteConfirmVerified = false;

  /** Resolves when local ephemeral key generation is complete */
  private keyReady: Promise<void> = Promise.resolve();

  /** Serializes async message handling to prevent ratchet state races */
  private msgQueue: Promise<void> = Promise.resolve();
  /** Serializes async sends to prevent chain key reuse */
  private sendQueue: Promise<void> = Promise.resolve();
  /** Serializes encrypted send/receive ratchet mutations across both directions. */
  private ratchetOpQueue: Promise<void> = Promise.resolve();

  // Heartbeat
  private heartbeatSend: ReturnType<typeof setInterval> | null = null;
  private heartbeatCheck: ReturnType<typeof setInterval> | null = null;
  private lastPongReceived = 0;

  // Handshake timeout — reuses HEARTBEAT_TIMEOUT; cancelled on confirmFingerprint or cleanup
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  // Nudge timer — logs "awaiting fingerprint confirmation" if the user hasn't acted after 8s
  private fingerprintNudgeTimer: ReturnType<typeof setTimeout> | null = null;

  // Connection recovery
  private stateBeforeRecovery: "live" | "silent" | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartAttempted = false;

  // Setup grace period (wait for peer to complete out-of-band code exchange)
  private connectingGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private connectingGraceDone = false;
  private iceRetryInterval: ReturnType<typeof setInterval> | null = null;
  private setupRestartPending = false;
  private liveRestartPending = false;
  private relaySignalSender: ((signal: TrackerRelaySignal) => void) | null = null;
  private pendingRelaySignals: TrackerRelaySignal[] = [];
  private pendingRemoteIce: (RTCIceCandidateInit | null)[] = [];

  // External assist (STUN) lifecycle
  private externalAssistPolicy: "drop-after-connect" | "keep-for-session";
  private externalAssistDropped = false;

  // Auto-confirm fingerprint (Campfire programmatic connections)
  private autoConfirm: boolean;

  // Callbacks
  onStateChange: WhisperLiveCallbacks["onStateChange"];
  onFingerprint: WhisperLiveCallbacks["onFingerprint"];
  onMessage: WhisperLiveCallbacks["onMessage"];
  onLog: WhisperLiveCallbacks["onLog"];
  onRawDecrypted: WhisperLiveCallbacks["onRawDecrypted"];
  onPeerTyping: WhisperLiveCallbacks["onPeerTyping"];
  onAck: WhisperLiveCallbacks["onAck"];
  onSendProgress: WhisperLiveCallbacks["onSendProgress"];
  onConnectionStats: WhisperLiveCallbacks["onConnectionStats"];
  onCtrl: WhisperLiveCallbacks["onCtrl"];
  onDrawStream: WhisperLiveCallbacks["onDrawStream"];
  onStreamState: WhisperLiveCallbacks["onStreamState"];
  onEdit: WhisperLiveCallbacks["onEdit"];

  // Tab-aware heartbeat
  private tabHidden = false;
  private visibilityHandler: (() => void) | null = null;

  // Connection stats polling
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  // Recovery send queue — holds jobs until session returns to live
  private recoveryResolve: (() => void) | null = null;

  // Send rate shaping: decaying burst level, threshold 15, decay τ=4s, ceil 2s.
  private burstLevel = 0;
  private burstLastSend = 0;

  private rtcConfig: RTCConfiguration;
  private turnPool: RTCIceServer[] = [];
  private turnInjected = false;
  private sessionGeneration = 0;

  constructor(callbacks: WhisperLiveCallbacks, options: WhisperLiveSessionOptions = {}) {
    this.onStateChange = callbacks.onStateChange;
    this.onFingerprint = callbacks.onFingerprint;
    this.onMessage = callbacks.onMessage;
    this.onLog = callbacks.onLog;
    this.onRawDecrypted = callbacks.onRawDecrypted;
    this.onPeerTyping = callbacks.onPeerTyping;
    this.onAck = callbacks.onAck;
    this.onSendProgress = callbacks.onSendProgress;
    this.onConnectionStats = callbacks.onConnectionStats;
    this.onCtrl = callbacks.onCtrl;
    this.onDrawStream = callbacks.onDrawStream;
    this.onStreamState = callbacks.onStreamState;
    this.onEdit = callbacks.onEdit;
    this.rtcConfig = options.rtcConfig ?? WHISPER_LIVE_RTC_LOCAL_ONLY;
    this.externalAssistPolicy = options.externalAssistPolicy ?? "drop-after-connect";
    this.autoConfirm = options.autoConfirmFingerprint ?? false;
    this.turnPool = options.turnPool ?? [];
  }

  private hasExternalAssistConfigured(): boolean {
    if (this.turnInjected) return true;
    const servers = this.rtcConfig.iceServers;
    return Array.isArray(servers) && servers.length > 0;
  }

  private async buildRtcConfig(): Promise<RTCConfiguration> {
    const hasTurn = this.turnPool.length > 0 && !!this.phraseRoot;
    // browsers warn at ≥ 5 URLs; reserve 1 slot for TURN when applicable
    const maxStunUrls = hasTurn ? 3 : 4;

    let iceServers = this.rtcConfig.iceServers ?? [];
    if (countIceUrls(iceServers) > maxStunUrls) {
      iceServers = await selectStunServers(this.phraseRoot, iceServers, maxStunUrls);
    }

    if (!hasTurn) {
      return {
        ...this.rtcConfig,
        iceServers,
      };
    }

    const turn = await selectTurnServer(this.phraseRoot!, this.turnPool);
    this.turnInjected = true;
    return {
      ...this.rtcConfig,
      iceServers: [...iceServers, turn],
    };
  }

  private dropExternalAssist(pc: RTCPeerConnection): void {
    if (this.externalAssistPolicy === "keep-for-session") return;
    if (this.externalAssistDropped) return;
    if (!this.hasExternalAssistConfigured()) return;
    this.externalAssistDropped = true;

    try {
      if (typeof pc.setConfiguration !== "function") {
        this.onLog("external assist could not be disabled. setConfiguration unavailable");
        return;
      }

      const current = (typeof pc.getConfiguration === "function") ? pc.getConfiguration() : {};
      pc.setConfiguration({ ...current, iceServers: [] });
    } catch (err) {
      this.onLog(`external assist disable failed: ${errorMessage(err)}`);
    }
  }

  get state(): LiveState { return this._state; }

  /** Whether this side created the session (offerer). Cryptographically established during handshake. */
  get isHost(): boolean { return this.isOfferer; }

  /** Retrieve a purpose-derived 128-bit key for the WebAssembly audio codec. */
  get audioKey(): Uint32Array | undefined {
    if (!this.audioKeyBytes) return undefined;
    // Return a copy — prevents external code from holding a reference to wipeable memory
    return new Uint32Array(this.audioKeyBytes.buffer.slice(
      this.audioKeyBytes.byteOffset, this.audioKeyBytes.byteOffset + 16,
    ));
  }

  private setState(state: LiveState, detail?: string): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.includes(state)) return;
    this._state = state;
    this.onStateChange(state, detail);
    if ((state === "live" || state === "silent" || state === "disconnected" || state === "error") && this.recoveryResolve) {
      const resolve = this.recoveryResolve;
      this.recoveryResolve = null;
      resolve();
    }
  }

  private send(type: number, payload?: Uint8Array): void {
    if (this.dc?.readyState !== "open") return;
    if (!payload) { this.dc.send(new Uint8Array([type])); return; }
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = type;
    msg.set(payload, 1);
    this.dc.send(msg);
  }

  private sealedSendQueue: Promise<void> = Promise.resolve();

  /** Send a frame sealed with the CTRL cipher. Serialized to preserve counter order. */
  private sendSealed(type: number, payload?: Uint8Array): void {
    if (!this.ctrlChainSend) return; // drop — never send CTRL/ACK/TYPING in plaintext
    if (this.ctrlSendCounter >= 0xFFFFFFFF) return; // nonce space exhausted — drop silently
    const inner = payload
      ? (() => { const b = new Uint8Array(1 + payload.length); b[0] = type; b.set(payload, 1); return b; })()
      : new Uint8Array([type]);
    const dirBit = this.isOfferer ? 0 : 1;
    const counter = this.ctrlSendCounter++;
    this.sealedSendQueue = this.sealedSendQueue
      .then(async () => {
        if (!this.dc || this.dc.readyState !== "open" || !this.ctrlChainSend) return;
        const [newChain, msgKey] = await kdfChainDirect(this.ctrlChainSend);
        const aad = this.ctrlChainSend.slice();  // capture old chain key as AAD before wipe
        this.ctrlChainSend.fill(0);
        this.ctrlChainSend = newChain;
        const ck = await importCtrlKey(msgKey);
        msgKey.fill(0);
        let sealed: Uint8Array;
        try {
          sealed = await sealCtrl(ck, inner, counter, dirBit, aad);
        } finally {
          aad.fill(0);  // always wipe — even if sealCtrl throws
        }
        if (this.dc?.readyState === "open") {
          const wire = new Uint8Array(1 + sealed.length);
          wire[0] = LIVE_MSG.SEALED;
          wire.set(sealed, 1);
          this.dc.send(wire);
        }
      })
      .catch(() => {});
  }

  /* ── Offer/Answer Lifecycle ─────────────────────────────── */

  private async initSession(sharedPhrase?: string, asOfferer = true): Promise<void> {
    this._destroyed = false;
    this.sessionGeneration++;
    this.externalAssistDropped = false;
    this.turnInjected = false;
    this.connectingGraceDone = false;
    this.resetSessionState();
    // Derive phraseRoot immediately so the raw string never persists in session state.
    // phraseRoot is a wipeable Uint8Array — the string leaves scope and is GC'd.
    if (sharedPhrase) {
      this.phraseRoot = await derivePhraseRoot(sharedPhrase);
    } else {
      this.phraseRoot = null;
    }
    this.isOfferer = asOfferer;
  }

  private wipeBytes(bytes: Uint8Array | null): void {
    if (bytes) bytes.fill(0);
  }

  private isSessionCurrent(generation: number): boolean {
    return !this._destroyed && this.sessionGeneration === generation;
  }

  private cloneLoopState(state: LoopState): LoopState {
    return {
      chain: state.chain.slice(),
      countsBitM: state.countsBitM.slice(),
      countsBit1: state.countsBit1.slice(),
      countsBitX: state.countsBitX.slice(),
      step: state.step,
    };
  }

  private wipeLoopState(state: LoopState | null): void {
    if (!state) return;
    loopWipe(state);
  }

  private cloneSkippedLoopKeys(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const [key, value] of this.skippedLoopKeys.entries()) out.set(key, value.slice());
    return out;
  }

  private wipeSkippedLoopKeys(map: Map<string, Uint8Array>): void {
    for (const mk of map.values()) mk.fill(0);
    map.clear();
  }

  private cloneRatchetState(state: RatchetState): RatchetState {
    const skippedKeys = new Map<string, Uint8Array>();
    for (const [key, value] of state.skippedKeys.entries()) skippedKeys.set(key, value.slice());
    return {
      rootKey: state.rootKey.slice(),
      dhSelf: {
        publicKey: state.dhSelf.publicKey.slice(),
        privateKey: state.dhSelf.privateKey,
      },
      dhPeer: state.dhPeer ? state.dhPeer.slice() : null,
      dhPeerHex: state.dhPeerHex,
      chainKeySend: state.chainKeySend ? state.chainKeySend.slice() : null,
      chainKeyRecv: state.chainKeyRecv ? state.chainKeyRecv.slice() : null,
      nSend: state.nSend,
      nRecv: state.nRecv,
      prevChainLength: state.prevChainLength,
      skippedKeys,
    };
  }

  private wipeRatchetState(state: RatchetState | null): void {
    if (!state) return;
    state.rootKey.fill(0);
    if (state.chainKeySend) state.chainKeySend.fill(0);
    if (state.chainKeyRecv) state.chainKeyRecv.fill(0);
    if (state.dhPeer) state.dhPeer.fill(0);
    state.dhSelf.publicKey.fill(0);
    for (const mk of state.skippedKeys.values()) mk.fill(0);
    state.skippedKeys.clear();
  }

  private async buildLoopStateFromChainKey(chainKey: Uint8Array): Promise<LoopState> {
    const expanded = await loopExpand(chainKey);
    try {
      return loopInit(expanded);
    } finally {
      expanded.fill(0);
    }
  }

  private async loopStatesFromRatchetState(state: RatchetState): Promise<{ send: LoopState | null; recv: LoopState | null }> {
    return {
      send: state.chainKeySend ? await this.buildLoopStateFromChainKey(state.chainKeySend) : null,
      recv: state.chainKeyRecv ? await this.buildLoopStateFromChainKey(state.chainKeyRecv) : null,
    };
  }

  private async skipMessagesWithLoopState(
    ratchetState: RatchetState,
    loopStateRecv: LoopState,
    skippedLoopKeys: Map<string, Uint8Array>,
    until: number,
  ): Promise<LoopState> {
    if (until - ratchetState.nRecv > 256) throw new Error("Too many skipped messages");
    const pubHex = ratchetState.dhPeerHex;
    let current = loopStateRecv;
    while (ratchetState.nRecv < until) {
      const counter = ratchetState.nRecv;
      const { next, messageKey } = await loopStep(current);
      skippedLoopKeys.set(`${pubHex}:${counter}`, messageKey);
      loopWipe(current);
      current = next;
      ratchetState.nRecv++;
    }
    return current;
  }

  private takeSkippedLoopKey(
    skippedLoopKeys: Map<string, Uint8Array>,
    pubHex: string,
    nr: number,
  ): Uint8Array | null {
    const key = `${pubHex}:${nr}`;
    const mk = skippedLoopKeys.get(key);
    if (!mk) return null;
    skippedLoopKeys.delete(key);
    return mk;
  }

  private commitReceiveState(
    ratchetState: RatchetState,
    loopStateSend: LoopState | null,
    loopStateRecv: LoopState | null,
    skippedLoopKeys: Map<string, Uint8Array>,
    lastRecvPubKeyHex: string,
  ): void {
    this.wipeLoopState(this.loopStateSend);
    this.wipeLoopState(this.loopStateRecv);
    this.wipeSkippedLoopKeys(this.skippedLoopKeys);
    this.wipeRatchetState(this.ratchetState);

    this.ratchetState = ratchetState;
    this.loopStateSend = loopStateSend;
    this.loopStateRecv = loopStateRecv;
    this.skippedLoopKeys = skippedLoopKeys;
    this.lastRecvPubKeyHex = lastRecvPubKeyHex;
  }

  private async withRatchetLock<T>(op: () => Promise<T>): Promise<T> {
    const prior = this.ratchetOpQueue;
    let release!: () => void;
    this.ratchetOpQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await op();
    } finally {
      release();
    }
  }

  private replacePendingPeerConfirmProof(proof: Uint8Array | null): void {
    this.wipeBytes(this.pendingPeerConfirmProof);
    this.pendingPeerConfirmProof = proof;
  }

  private clearHandshakeArtifacts(): void {
    this.wipeBytes(this.transcriptHash);
    this.transcriptHash = null;
    this.wipeBytes(this.kizunaWitness);
    this.kizunaWitness = null;
    this.wipeBytes(this.confirmContextHash);
    this.confirmContextHash = null;
    this.replacePendingPeerConfirmProof(null);
    this.wipeBytes(this.localEphPublicKey);
    this.localEphPublicKey = null;
    this.ratchetInitReceived = false;
    this.wipeBytes(this.ratchetInitSentPubKey);
    this.ratchetInitSentPubKey = null;
    this.localConfirmRequested = false;
    this.localConfirmSent = false;
    this.remoteConfirmVerified = false;
  }

  private clearIncomingFiles(): void {
    for (const transfer of this.incomingFiles.values()) {
      transfer.chunks.clear();
    }
    this.incomingFiles.clear();
  }

  private resetSessionState(): void {
    this.nSentTotal = 0;
    this.nRecvTotal = 0;
    this.nextDrawStreamSeq = 0;
    this.drawStreamRecvTracker = new DrawStreamTracker();
    this.ctrlSendCounter = 0;
    this.ctrlRecvCounter = 0;
    this.lastSentPubKeyHex = "";
    this.lastRecvPubKeyHex = "";
    this.sealedSendQueue = Promise.resolve();
    this.msgQueue = Promise.resolve();
    this.sendQueue = Promise.resolve();
    this.drawStreamSendQueue = Promise.resolve();
    this.lastPongReceived = 0;
    this.assembler.reset();
    this.clearIncomingFiles();
    this.clearHandshakeArtifacts();
  }

  private ownRole(): HandshakeRole {
    return this.isOfferer ? "offerer" : "answerer";
  }

  private peerRole(): HandshakeRole {
    return this.isOfferer ? "answerer" : "offerer";
  }

  private async buildTranscriptHash(peerPubKeyRaw: Uint8Array): Promise<Uint8Array> {
    const localSdp = this.pc?.localDescription?.sdp;
    const remoteSdp = this.pc?.remoteDescription?.sdp;
    if (!localSdp || !remoteSdp || !this.localEphPublicKey) {
      throw new Error("handshake transcript incomplete");
    }
    const offerSdp = this.isOfferer ? localSdp : remoteSdp;
    const answerSdp = this.isOfferer ? remoteSdp : localSdp;
    const offererEphemeralKey = this.isOfferer ? this.localEphPublicKey : peerPubKeyRaw;
    const answererEphemeralKey = this.isOfferer ? peerPubKeyRaw : this.localEphPublicKey;
    return deriveHandshakeTranscriptHash({
      offerSdpBytes: canonicalizeSdpForTranscript(offerSdp, "offer"),
      answerSdpBytes: canonicalizeSdpForTranscript(answerSdp, "answer"),
      offererEphemeralKey,
      answererEphemeralKey,
    });
  }

  private async updateConfirmContext(): Promise<void> {
    if (!this.sharedSecret || !this.transcriptHash || !this.kizunaWitness || !this.ratchetState?.dhPeer) return;
    if (!this.ratchetInitSentPubKey) return;
    // Use the keys exchanged via RATCHET_INIT, NOT the current dhSelf (which may have
    // been regenerated by dhRatchetStep). Both sides know each other's RATCHET_INIT key.
    const ownInitKey = this.ratchetInitSentPubKey;
    const peerInitKey = this.ratchetState.dhPeer;
    const offererRatchetKey = this.isOfferer ? ownInitKey : peerInitKey;
    const answererRatchetKey = this.isOfferer ? peerInitKey : ownInitKey;
    this.wipeBytes(this.confirmContextHash);
    this.confirmContextHash = await deriveConfirmContextHash({
      transcriptHash: this.transcriptHash,
      offererRatchetKey,
      answererRatchetKey,
      kizunaWitness: this.kizunaWitness,
    });
    if (this.localConfirmRequested && !this.localConfirmSent) {
      await this.sendLocalConfirmProof();
    }
    if (this.pendingPeerConfirmProof) {
      const pending = this.pendingPeerConfirmProof;
      this.pendingPeerConfirmProof = null;
      await this.handlePeerConfirmProof(pending);
    }
  }

  private maybeEnterLive(): void {
    if (this._state !== "verifying") return;
    if (!this.localConfirmSent || !this.remoteConfirmVerified) return;
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
    if (this.fingerprintNudgeTimer) { clearTimeout(this.fingerprintNudgeTimer); this.fingerprintNudgeTimer = null; }
    this.startHeartbeat();
    this.setState(this.transportMode === "silent" ? "silent" : "live");
  }

  private async sendLocalConfirmProof(): Promise<void> {
    if (this.localConfirmSent || this._state !== "verifying") return;
    if (!this.sharedSecret || !this.confirmContextHash) return;
    const proof = await buildConfirmProof(this.sharedSecret, this.confirmContextHash, this.ownRole());
    this.localConfirmSent = true;
    this.send(LIVE_MSG.FINGERPRINT_CONFIRMED, proof);
    proof.fill(0);
    this.maybeEnterLive();
  }

  private async handlePeerConfirmProof(proof: Uint8Array): Promise<void> {
    try {
      if (proof.length !== 16) {
        this.onLog("invalid confirmation proof length");
        this.setState("error", "connection confirmation failed");
        this.cleanupConnection();
        return;
      }
      if (!this.sharedSecret || !this.confirmContextHash) {
        this.replacePendingPeerConfirmProof(proof.slice());
        return;
      }
      const valid = await verifyConfirmProof(proof, this.sharedSecret, this.confirmContextHash, this.peerRole());
      if (!valid) {
        this.onLog("peer confirmation proof mismatch, aborting");
        this.setState("error", "handshake proof mismatch, reconnect to continue");
        this.cleanupConnection();
        return;
      }
      this.remoteConfirmVerified = true;
      this.onLog("peer confirmed fingerprint");
      this.maybeEnterLive();
    } finally {
      proof.fill(0);
    }
  }

  /** Peer A: create an offer code. */
  async createOffer(sharedPhrase?: string): Promise<string> {
    await this.initSession(sharedPhrase, true);
    this.setState("offering");
    this.onLog("creating offer...");

    this.pc = new RTCPeerConnection(await this.buildRtcConfig());

    this.setupPeerConnection(this.pc);

    this.dc = this.pc.createDataChannel("whisper", {
      ordered: true,
    });
    this.setupDataChannel(this.dc);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.onLog("gathering network candidates...");
    await this.waitForICE();

    const code = await sdpToCode(this.pc.localDescription!.sdp, "offer", this.phraseRoot ?? undefined);

    this.onLog(`offer code ready${this.phraseRoot ? " (sealed)" : ""}`);
    this.setState("waiting-for-answer");

    return code;
  }

  /** Peer A: apply the answer code from Peer B. */
  async applyAnswer(answerCode: string): Promise<void> {
    if (!this.pc) throw new Error("No connection, create offer first");

    this.onLog("applying answer code...");
    const sdp = await codeToSdp(answerCode, "answer", this.phraseRoot ?? undefined);
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    await this.flushPendingRemoteIce();
    this.emitRelaySignal({ kind: "answer-ack" });
    this.setState("connecting");
    this.onLog("connecting peer-to-peer...");
  }

  /** Peer B: accept an offer code, return an answer code. */
  async acceptOffer(offerCode: string, sharedPhrase?: string): Promise<string> {
    await this.initSession(sharedPhrase, false);
    this.setState("answering");
    this.onLog("accepting offer code...");

    const offerSDP = await codeToSdp(offerCode, "offer", this.phraseRoot ?? undefined);

    this.pc = new RTCPeerConnection(await this.buildRtcConfig());
    this.setupPeerConnection(this.pc);

    this.pc.ondatachannel = (event) => {
      this.dc = event.channel;
      this.setupDataChannel(this.dc);
    };

    await this.pc.setRemoteDescription({ type: "offer", sdp: offerSDP });
    await this.flushPendingRemoteIce();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.onLog("gathering network candidates...");
    await this.waitForICE();

    const answerCode = await sdpToCode(this.pc.localDescription!.sdp, "answer", this.phraseRoot ?? undefined);

    this.onLog(`answer code ready${this.phraseRoot ? " (sealed)" : ""}`);
    this.setState("connecting");
    this.onLog("connecting peer-to-peer...");

    return answerCode;
  }

  /** Wait for ICE gathering to complete or timeout. */
  private waitForICE(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.pc) { resolve(); return; }
      const pc = this.pc;
      const maxWait = this.hasExternalAssistConfigured() ? ICE_GATHER_TIMEOUT_ASSIST : ICE_GATHER_TIMEOUT;
      let lastCandidateAt = Date.now();

      const logGatherResult = () => {
        const sdp = pc.localDescription?.sdp ?? "";
        const types = [...sdp.matchAll(/typ (\w+)/g)].map(m => m[1]);
        const uniqueTypes = [...new Set(types)];
        this.onLog(`gathered ${types.length} network path(s): ${uniqueTypes.join(", ") || "none"}`);
        if (!types.includes("srflx") && this.hasExternalAssistConfigured())
          this.onLog("no server-reflexive candidates found, cross-network connection may fail");
        if (types.length === 0)
          this.onLog("no network paths found, connection may fail");
      };

      const candidateCount = (): number => {
        const sdp = pc.localDescription?.sdp ?? "";
        return [...sdp.matchAll(/^a=candidate:/gm)].length;
      };

      const hasUsefulCandidates = (): boolean => {
        const sdp = pc.localDescription?.sdp ?? "";
        return / typ (host|srflx|relay)\b/.test(sdp);
      };

      if (pc.iceGatheringState === "complete") {
        logGatherResult();
        resolve();
        return;
      }

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(settlePoll);
        pc.removeEventListener("icecandidate", onIceCandidate);
        pc.onicegatheringstatechange = null;
        logGatherResult();
        resolve();
      };

      const onIceCandidate = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) lastCandidateAt = Date.now();
      };

      pc.addEventListener("icecandidate", onIceCandidate);

      const settlePoll = setInterval(() => {
        if (settled) return;
        if (pc.iceGatheringState === "complete") {
          done();
          return;
        }
        if (!hasUsefulCandidates()) return;
        if (candidateCount() === 0) return;
        if (Date.now() - lastCandidateAt < ICE_GATHER_SETTLE_MS) return;
        this.onLog("path discovery settled, proceeding with gathered candidates");
        done();
      }, 250);

      const timer = setTimeout(() => {
        this.onLog("path discovery timed out, proceeding with what we have");
        done();
      }, maxWait);

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") done();
      };
    });
  }

  /* ── Peer Connection ─────────────────────────────────────── */

  /** Whether we're in a pre-live setup state where ICE failures are expected. */
  private isSetupState(): boolean {
    return this._state === "connecting" || this._state === "answering" ||
      this._state === "waiting-for-answer" || this._state === "offering";
  }

  /** Start the grace period for setup ICE failures (both offerer and answerer). */
  private startConnectingGrace(pc: RTCPeerConnection): void {
    if (this.connectingGraceDone) return;
    if (this.connectingGraceTimer) return;
    this.connectingGraceDone = true;
    this.onLog("negotiating connection, waiting for peer to finish exchange...");

    // On the answerer side, ICE can enter "failed" before the offerer has applied
    // the answer and started its own checks — an inherent race in non-trickle exchange.
    // Re-applying the remote offer nudges the ICE agent to retry. Our local credentials
    // are unchanged (createAnswer is never called again), so the offerer's checks remain
    // valid. The guard on rd.type ensures this is a no-op on the offerer side.
    this.iceRetryInterval = setInterval(() => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
        return;
      }
      if (s === "failed" || s === "disconnected") {
        const rd = pc.remoteDescription;
        if (rd) pc.setRemoteDescription(rd).catch(() => { /* non-fatal */ });
      }
    }, 8_000);

    this.connectingGraceTimer = setTimeout(() => {
      this.connectingGraceTimer = null;
      if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
      if (this.isLiveState() || this._state === "disconnected" || this._state === "error") return;
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") return;
      this.onLog(`connection failed after waiting period (ICE: ${pc.iceConnectionState})`);
      this.setState("error", "couldn't reach your peer. make sure both sides have external assist enabled if connecting across networks.");
      this.cleanupConnection();
    }, HEARTBEAT_TIMEOUT);
  }

  private setupPeerConnection(pc: RTCPeerConnection): void {
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.emitRelaySignal({ kind: "ice", candidate: event.candidate.toJSON() });
      } else {
        this.emitRelaySignal({ kind: "ice", candidate: null });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;

      if (s === "checking") return;

      if (s === "disconnected") {
        if (this.isLiveState()) {
          this.stateBeforeRecovery = this._state as "live" | "silent";
          this.setState("recovering");
          this.onLog("connection interrupted, attempting recovery...");
          if (this.isOfferer && this.relaySignalSender && !this.liveRestartPending) {
            void this.maybeSignalIceRestart(pc, true);
          }
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;
            if (this._state === "recovering") {
              this.onLog("recovery timeout, peer unreachable");
              this.setState("disconnected", "vanished");
              this.cleanupConnection();
            }
          }, HEARTBEAT_TIMEOUT);
        }
        return;
      }

      if (s === "failed") {
        if (this.isSetupState()) void this.maybeSignalIceRestart(pc);
        if ((this.isLiveState() || this._state === "recovering") && !this.iceRestartAttempted) {
          this.iceRestartAttempted = true;
          this.onLog("connection failed, waiting for path to recover...");
          if (this.isOfferer && this.relaySignalSender && !this.liveRestartPending) {
            void this.maybeSignalIceRestart(pc, true);
          }
          if (this._state !== "recovering") {
            this.stateBeforeRecovery = this._state as "live" | "silent";
            this.setState("recovering");
          }
        } else if (this.isSetupState()) {
          this.startConnectingGrace(pc);
        } else if (this._state === "recovering") {
          this.onLog("peer left, session over");
          this.setState("disconnected", "vanished");
          this.cleanupConnection();
        } else {
          this.onLog("connection failed, could not reach peer");
          this.setState("error", "couldn't reach your peer. try again, or ask them to retry at the same time.");
          this.cleanupConnection();
        }
        return;
      }

      if (s === "connected" || s === "completed") {
        if (s === "connected") this.onLog("connected to peer");
        this.iceRestartAttempted = false;
        this.liveRestartPending = false;
        if (this.connectingGraceTimer) { clearTimeout(this.connectingGraceTimer); this.connectingGraceTimer = null; }
        if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
        this.connectingGraceDone = false;
        if (!this.isSetupState()) this.dropExternalAssist(pc);
        if (this._state === "recovering" && this.stateBeforeRecovery) {
          if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
          const returnState = this.stateBeforeRecovery;
          this.stateBeforeRecovery = null;
          this.onLog("connection recovered");
          this.setState(returnState);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        if (!this.isSetupState()) this.dropExternalAssist(pc);
      }
      if (s === "failed") {
        if (this._state === "recovering" || this._state === "error" || this._state === "disconnected") return;
        if (this.connectingGraceTimer) return;
        if (this.isSetupState()) {
          this.startConnectingGrace(pc);
          return;
        }
        this.onLog("peer left, session over");
        this.setState("disconnected", "vanished");
        this.cleanupConnection();
      }
    };
  }

  setRelaySignalSender(sender: ((signal: TrackerRelaySignal) => void) | null): void {
    this.relaySignalSender = sender;
    if (!sender) return;
    while (this.pendingRelaySignals.length) sender(this.pendingRelaySignals.shift()!);
  }

  async handleRelaySignal(signal: TrackerRelaySignal): Promise<void> {
    switch (signal.kind) {
      case "answer-ack":
        this.onLog("peer received our answer");
        return;
      case "ice":
        if (!this.pc || !this.pc.remoteDescription) {
          this.pendingRemoteIce.push(signal.candidate);
          return;
        }
        await this.applyRemoteIceCandidate(signal.candidate);
        return;
      case "restart-offer":
        await this.handleRemoteRestartOffer(signal.code);
        return;
      case "restart-answer":
        await this.handleRemoteRestartAnswer(signal.code);
        return;
    }
  }

  private emitRelaySignal(signal: TrackerRelaySignal): void {
    const isRestartSignal = signal.kind === "restart-offer" || signal.kind === "restart-answer";
    if (!this.isSetupState() && !isRestartSignal && this._state !== "live" && this._state !== "silent" && this._state !== "recovering") return;
    if (!isRestartSignal && !this.isSetupState()) return;
    if (this.relaySignalSender) {
      this.relaySignalSender(signal);
    } else {
      this.pendingRelaySignals.push(signal);
    }
  }

  private async applyRemoteIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!this.pc) return;
    try {
      if (candidate === null) await this.pc.addIceCandidate();
      else await this.pc.addIceCandidate(candidate);
    } catch (err) {
      this.onLog(`remote candidate rejected: ${errorMessage(err)}`);
    }
  }

  private async flushPendingRemoteIce(): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) return;
    while (this.pendingRemoteIce.length) {
      await this.applyRemoteIceCandidate(this.pendingRemoteIce.shift() ?? null);
    }
  }

  private async maybeSignalIceRestart(pc: RTCPeerConnection, liveRecovery = false): Promise<void> {
    if (!this.relaySignalSender || !this.isOfferer) return;
    if (liveRecovery) {
      if (this.liveRestartPending) return;
      this.liveRestartPending = true;
    } else {
      if (this.setupRestartPending) return;
      this.setupRestartPending = true;
    }
    let signaled = false;
    try {
      this.onLog(liveRecovery ? "recovery: requesting fresh network paths" : "retrying connection with fresh network paths...");
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await this.waitForICE();
      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) return;
      const code = await sdpToCode(localSdp, "offer", this.phraseRoot ?? undefined);
      this.emitRelaySignal({ kind: "restart-offer", code });
      signaled = true;
      if (liveRecovery) this.onLog("recovery: waiting for peer restart answer");
    } catch (err) {
      this.onLog(`restart signaling failed: ${errorMessage(err)}`);
    } finally {
      if (!liveRecovery) this.setupRestartPending = false;
      else if (!signaled) this.liveRestartPending = false;
    }
  }

  private async handleRemoteRestartOffer(code: string): Promise<void> {
    if (!this.pc || this.isOfferer) return;
    this.onLog("recovery: applying fresh network paths");
    const sdp = await codeToSdp(code, "offer", this.phraseRoot ?? undefined);
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    await this.flushPendingRemoteIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForICE();
    const localSdp = this.pc.localDescription?.sdp;
    if (!localSdp) return;
    const answerCode = await sdpToCode(localSdp, "answer", this.phraseRoot ?? undefined);
    this.emitRelaySignal({ kind: "restart-answer", code: answerCode });
  }

  private async handleRemoteRestartAnswer(code: string): Promise<void> {
    if (!this.pc || !this.isOfferer) return;
    this.onLog("recovery: applying fresh network paths");
    const sdp = await codeToSdp(code, "answer", this.phraseRoot ?? undefined);
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    await this.flushPendingRemoteIce();
  }

  /* ── DataChannel ────────────────────────────────────────── */

  private setupDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;

    dc.onopen = () => {
      this.onLog("secure channel open, starting key exchange");
      if (this.pc) this.dropExternalAssist(this.pc);
      this.setState("handshaking");
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        if (this._state === "handshaking" || this._state === "verifying") {
          this.onLog("handshake timeout, key exchange took too long");
          this.setState("error", "connection took too long, try again");
          this.cleanupConnection();
        }
      }, HEARTBEAT_TIMEOUT);
      this.performKeyExchange();
    };

    dc.onclose = () => {
      if (this.isLiveState() || this._state === "recovering") {
        this.onLog("peer disconnected");
        this.setState("disconnected", "vanished");
        this.cleanupConnection();
      } else if (this._state === "verifying" || this._state === "handshaking") {
        this.onLog("peer disconnected");
        this.setState("disconnected");
        this.cleanupConnection();
      }
    };

    dc.onerror = (event) => {
      const msg = (event as ErrorEvent).message ?? "unknown";
      this.onLog(`channel error: ${msg}`);
      if (this._state === "handshaking" || this._state === "connecting") {
        this.setState("error", "connection interrupted, try again");
        this.cleanupConnection();
      }
    };

    dc.onmessage = (event) => {
      this.msgQueue = this.msgQueue.then(() => {
        if (this._destroyed) return;
        return this.handleRawMessage(event.data);
      }).catch((err) => {
        if (!this._destroyed) this.onLog(`message error: ${errorMessage(err)}`);
      });
    };
  }

  /* ── Key Exchange ───────────────────────────────────────── */

  /**
   * ECDH key exchange over the DataChannel.
   * Protocol:
  *   [LIVE_MSG.KEY_EXCHANGE] + publicKey (65B)     → key exchange message
  *   [LIVE_MSG.RATCHET_INIT] + ratchetPubKey (65B) → ratchet init (offerer sends initial DH pubkey)
  *   [LIVE_MSG.ENCRYPTED] + encryptedMessage        → encrypted chat message
  *   [LIVE_MSG.FINGERPRINT_CONFIRMED]               → fingerprint confirmed
  *   [LIVE_MSG.FINGERPRINT_REJECTED]                → fingerprint rejected
  *   [LIVE_MSG.PING]                                → ping (heartbeat)
  *   [LIVE_MSG.PONG]                                → pong (heartbeat reply)
   */
  private async performKeyExchange(): Promise<void> {
    const generation = this.sessionGeneration;
    this.keyReady = (async () => {
      try {
        const keyPair = await crypto.subtle.generateKey(
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveBits"],
        );

        const pubKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
        const pubKeyCompressed = compressP256(pubKeyRaw);
        pubKeyRaw.fill(0);
        if (!this.isSessionCurrent(generation)) {
          pubKeyCompressed.fill(0);
          return;
        }
        this.localEphPublicKey = pubKeyCompressed;
        if (!this.dc || this.dc.readyState !== "open") {
          this.onLog("key exchange aborted, channel not available");
          return;
        }
        this.send(LIVE_MSG.KEY_EXCHANGE, pubKeyCompressed);

        this.ephPrivateKey = keyPair.privateKey;
      } catch (err) {
        if (!this.isSessionCurrent(generation)) return;
        this.onLog(`key exchange failed: ${errorMessage(err, "unknown error")}`);
        this.setState("error", "couldn't establish encryption, try again");
        this.cleanupConnection();
      }
    })();
  }

  private async handleKeyExchangeMessage(peerPubKeyRaw: Uint8Array): Promise<void> {
    if (this._state !== "handshaking") return;
    const generation = this.sessionGeneration;
    try {
      await this.keyReady;
      if (!this.isSessionCurrent(generation)) return;
      if (!this.ephPrivateKey) throw new Error("No ephemeral private key");

      // peer sends compressed (33B) — WebCrypto importKey("raw") needs uncompressed (65B)
      const peerPubUncompressed = peerPubKeyRaw.length === 33 ? decompressP256(peerPubKeyRaw) : peerPubKeyRaw;
      const peerPubKey = await crypto.subtle.importKey(
        "raw", toArrayBuffer(peerPubUncompressed), { name: "ECDH", namedCurve: "P-256" }, false, [],
      );
      const sharedBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: peerPubKey }, this.ephPrivateKey, 256,
      );
      if (!this.isSessionCurrent(generation)) return;
      const ecdhSecret = new Uint8Array(sharedBits);

      this.ephPrivateKey = null;

      const transcriptHash = await this.buildTranscriptHash(peerPubKeyRaw);
      const sharedSecret = await deriveSessionRoot(ecdhSecret, transcriptHash, this.phraseRoot);
      ecdhSecret.fill(0);
      if (!this.isSessionCurrent(generation)) {
        transcriptHash.fill(0);
        sharedSecret.fill(0);
        return;
      }
      // phraseRoot is no longer needed — wipe the stretched phrase key
      this.wipeBytes(this.phraseRoot);
      this.phraseRoot = null;

      this.sharedSecret = sharedSecret;
      // Derive purpose-specific keys so the session root is never directly exposed
      this.silentKey = await deriveSilentKey(sharedSecret);
      this.audioKeyBytes = await deriveAudioKey(sharedSecret);
      const ctrlRoot = await deriveCtrlKey(sharedSecret);
      const chainA = await hkdf(ctrlRoot, ZERO_SALT_32, TE.encode("ctrl-send"), 32);
      const chainB = await hkdf(ctrlRoot, ZERO_SALT_32, TE.encode("ctrl-recv"), 32);
      ctrlRoot.fill(0);
      this.ctrlChainSend = this.isOfferer ? chainA : chainB;
      this.ctrlChainRecv = this.isOfferer ? chainB : chainA;
      this.wipeBytes(this.transcriptHash);
      this.transcriptHash = transcriptHash;
      this.wipeBytes(this.kizunaWitness);
      this.kizunaWitness = await deriveKizunaWitness(sharedSecret);

      const fingerprint = await deriveFingerprint(sharedSecret);
      this.onLog(`fingerprint: ${fingerprint}`);
      this.onFingerprint(fingerprint);
      this.fingerprintNudgeTimer = setTimeout(() => {
        this.fingerprintNudgeTimer = null;
        if (this.isSessionCurrent(generation) && this._state === "verifying") this.onLog("awaiting fingerprint confirmation");
      }, 8000);

      if (this.isOfferer) {
        const dhSelf = await generateDHKeyPair();
        if (!this.isSessionCurrent(generation)) return;
        this.ratchetState = await initRatchetAsOfferer(sharedSecret, dhSelf);
        this.ratchetInitSentPubKey = dhSelf.publicKey.slice();

        if (this.dc && this.dc.readyState === "open") {
          this.send(LIVE_MSG.RATCHET_INIT, dhSelf.publicKey);
        }
      }

      this.setState("verifying");

      // Auto-confirm is deferred to handleRatchetInit — chain keys aren't ready yet.
    } catch (err) {
      if (!this.isSessionCurrent(generation)) return;
      this.onLog(`key derivation failed: ${errorMessage(err, "unknown error")}`);
      this.setState("error", "couldn't establish encryption, try again");
      this.cleanupConnection();
    }
  }

  private async handleRatchetInit(peerRatchetPubKey: Uint8Array): Promise<void> {
    if (this._state !== "handshaking" && this._state !== "verifying") return;
    if (!this.sharedSecret) return;
    const generation = this.sessionGeneration;

    // Guard: only accept one RATCHET_INIT per handshake. A duplicate would
    // overwrite (answerer) or desync (offerer) the ratchet state. Reject silently.
    if (this.ratchetInitReceived) return;
    this.ratchetInitReceived = true;

    if (!this.isOfferer) {
      this.ratchetState = await initRatchetAsReceiver(this.sharedSecret, peerRatchetPubKey);
      if (!this.isSessionCurrent(generation) || !this.ratchetState) return;

      // chainKeyRecv is null until first DH step — only init send side now.
      this.loopStateSend = await this.buildLoopStateFromChainKey(this.ratchetState.chainKeySend!);

      this.ratchetInitSentPubKey = this.ratchetState.dhSelf.publicKey.slice();

      if (this.dc && this.dc.readyState === "open") {
        this.send(LIVE_MSG.RATCHET_INIT, this.ratchetState.dhSelf.publicKey);
        this.onLog("kizuna membrane sealed");
      }

      await this.updateConfirmContext();

      if (this.autoConfirm && this._state === "verifying") {
        this.confirmFingerprint();
      }
    } else {
      if (this.ratchetState) {
        await dhRatchetStep(this.ratchetState, peerRatchetPubKey);
        if (!this.isSessionCurrent(generation)) return;

        // both chain keys are now set after the DH step — init both loop states.
        await this.loopReinitFromChainKeys();
        this.onLog("kizuna membrane sealed");
        await this.updateConfirmContext();
        // Confirm only after dhRatchetStep — chainKeySend is now initialized.
        if (this.autoConfirm && this._state === "verifying") {
          this.confirmFingerprint();
        }
      }
    }
  }

  /* ── Message Handling ───────────────────────────────────── */

  private async handleRawMessage(data: ArrayBuffer | string): Promise<void> {
    if (typeof data === "string") return; // We only handle binary

    const bytes = new Uint8Array(data);
    if (bytes.length === 0) return;

    const type = bytes[0];

    switch (type) {
      case LIVE_MSG.KEY_EXCHANGE:
        await this.handleKeyExchangeMessage(bytes.subarray(1));
        break;
      case LIVE_MSG.RATCHET_INIT:
        await this.handleRatchetInit(bytes.subarray(1));
        break;
      case LIVE_MSG.ENCRYPTED:
        await this.handleEncryptedMessage(bytes.subarray(1));
        break;
      case LIVE_MSG.FINGERPRINT_CONFIRMED:
        await this.handlePeerConfirmProof(bytes.subarray(1));
        break;
      case LIVE_MSG.FINGERPRINT_REJECTED:
        this.onLog("peer rejected fingerprint, aborting");
        this.setState("error", "peer rejected fingerprint, possible interception");
        this.cleanupConnection();
        break;
      case LIVE_MSG.PING:
        this.lastPongReceived = Date.now();
        this.send(LIVE_MSG.PONG);
        break;
      case LIVE_MSG.PONG:
        this.lastPongReceived = Date.now();
        break;
      case LIVE_MSG.TYPING:
      case LIVE_MSG.ACK:
      case LIVE_MSG.CTRL:
        // Reject plaintext CTRL/ACK/TYPING — these must arrive via SEALED (0x51).
        // Accepting plaintext would let an attacker inject fake ACKs, reactions, or votes.
        break;
      case LIVE_MSG.SEALED:
        await this.handleSealedMessage(bytes.subarray(1));
        break;
      default:
        this.onLog(`unknown message type: 0x${type.toString(16)}`);
    }
  }

  private async handleSealedMessage(ciphertext: Uint8Array): Promise<void> {
    if (!this.ctrlChainRecv) return;
    if (ciphertext.length < 5) return; // minimum: 1B inner type + 4B tag
    try {
      const dirBit = this.isOfferer ? 1 : 0; // peer's direction is opposite
      const [newChain, msgKey] = await kdfChainDirect(this.ctrlChainRecv);
      const aad = this.ctrlChainRecv.slice();  // capture old chain key as AAD before wipe
      const ck = await importCtrlKey(msgKey);
      msgKey.fill(0);
      let inner: Uint8Array;
      try {
        inner = await openCtrl(ck, ciphertext, this.ctrlRecvCounter, dirBit, aad);
      } catch (e) {
        // decrypt failed — wipe speculative chain, leave current chain intact
        newChain.fill(0);
        aad.fill(0);
        throw e;
      }
      aad.fill(0);
      // commit: decrypt succeeded, advance chain
      this.ctrlChainRecv.fill(0);
      this.ctrlChainRecv = newChain;
      this.ctrlRecvCounter++;
      if (inner.length === 0) return;
      // Reconstruct as if it were a raw frame and re-dispatch
      const innerType = inner[0];
      const innerPayload = inner.subarray(1);
      switch (innerType) {
        case LIVE_MSG.TYPING:
          if (this.onPeerTyping) this.onPeerTyping(innerPayload.length >= 1 ? innerPayload[0] : 0x00);
          break;
        case LIVE_MSG.ACK: {
          if (innerPayload.length >= 4 && this.onAck) {
            const msgId = new DataView(innerPayload.buffer, innerPayload.byteOffset, 4).getUint32(0, true);
            this.onAck(msgId);
          }
          break;
        }
        case LIVE_MSG.CTRL: {
          const frame = decodeCtrl(innerPayload);
          if (frame) {
            if (this.onCtrl) this.onCtrl(frame.opcode, frame.payload);
            if (frame.opcode === CTRL_OP.STREAM_STATE && this.onStreamState) {
              const state = decodeStreamState(frame.payload);
              if (state) this.onStreamState(state.audio, state.video, state.screen);
            }
            if (frame.opcode === CTRL_OP.DRAW_STREAM && this.onDrawStream) {
              const drawEvent = decodeDrawStreamEvent(frame.payload);
              if (drawEvent) {
                const applied = this.drawStreamRecvTracker.apply(drawEvent);
                if (applied.applied) {
                  this.onDrawStream(drawEvent);
                }
              }
            }
          }
          break;
        }
        default:
          this.onLog(`unknown sealed inner type: 0x${innerType.toString(16)}`);
      }
    } catch {
      this.onLog("sealed frame decryption failed");
    }
  }

  private async handleEncryptedMessage(wireData: Uint8Array): Promise<void> {
    const complete = this.assembler.feed(wireData);
    if (!complete) return; // Still waiting for more chunks

    if (!this.ratchetState) return;
    const generation = this.sessionGeneration;

    const isCompact = (complete[0] & LIVE_FLAG_SAME_KEY) !== 0;
    const headerSize = isCompact ? HEADER_SIZE_COMPACT : HEADER_SIZE;
    if (complete.length < headerSize + 16) return; // header + minimum AES-GCM tag

    try {
      this.onLog("recv: acquiring lock");
      await this.withRatchetLock(async () => {
        this.onLog("recv: lock acquired");
        const header = parseHeader(complete);
        const ratchetState = this.cloneRatchetState(this.ratchetState!);
        let loopStateSend = this.loopStateSend ? this.cloneLoopState(this.loopStateSend) : null;
        let loopStateRecv = this.loopStateRecv ? this.cloneLoopState(this.loopStateRecv) : null;
        const skippedLoopKeys = this.cloneSkippedLoopKeys();

        // Resolve pubkey: compact headers use cached peer key
        let pubKeyHex: string;
        if (header.pubKey) {
          pubKeyHex = toHex(header.pubKey);
        } else {
          pubKeyHex = this.lastRecvPubKeyHex;
          if (!pubKeyHex) return; // no cached key — can't process
        }

        // try loop-derived skipped key first (defense-in-depth; never fires with ordered SCTP).
        let messageKey = this.takeSkippedLoopKey(skippedLoopKeys, pubKeyHex, header.counter);
        let didDHRatchet = false;

        if (!messageKey) {
          // check if this is a new DH ratchet key
          if (pubKeyHex !== ratchetState.dhPeerHex) {
            if (!header.pubKey) return; // DH ratchet needs the actual key bytes
            // new DH ratchet — skip remaining messages in current receive chain
            if (ratchetState.chainKeyRecv && loopStateRecv) {
              loopStateRecv = await this.skipMessagesWithLoopState(ratchetState, loopStateRecv, skippedLoopKeys, header.prevChainLen);
            }
            await dhRatchetStep(ratchetState, header.pubKey.slice());
            // reinit both loop states from the new DH-derived chain keys
            const reinit = await this.loopStatesFromRatchetState(ratchetState);
            loopStateSend = reinit.send;
            loopStateRecv = reinit.recv;
            didDHRatchet = true;
          }

          // advance loop and ratchet counter to the message's position
          // (with ordered SCTP, skip count is always 0 — loop body never executes)
          if (!loopStateRecv) throw new Error("No receiving loop state");
          loopStateRecv = await this.skipMessagesWithLoopState(ratchetState, loopStateRecv, skippedLoopKeys, header.counter);

          // derive this message's key via loopStep — speculative until decrypt succeeds
          const stepResult = await loopStep(loopStateRecv);
          loopWipe(loopStateRecv);
          loopStateRecv = stepResult.next;
          messageKey = stepResult.messageKey;
          ratchetState.nRecv++;
        }

        const aad = complete.subarray(0, headerSize);
        const peerDirBit = this.isOfferer ? 1 : 0;
        const nonce = buildNonce(header.counter, peerDirBit, header.salt);
        let compressedPayload: Uint8Array;
        try {
          compressedPayload = await aesGcmDecrypt(messageKey, header.ciphertext, nonce, aad);
        } catch (decryptErr) {
          messageKey.fill(0);
          // if a DH ratchet step was performed and decrypt still fails, the ratchet
          // is structurally broken (mismatched keys). deterministic — disconnect.
          if (didDHRatchet) {
            this.onLog("decryption failed, encryption state unrecoverable. disconnecting");
            this.setState("error", "session got out of sync, reconnect to continue");
            this.cleanupConnection();
            return;
          }
          throw decryptErr;
        }
        messageKey.fill(0);

        // decompress: first 4 bytes are decodedLen (LE uint32), rest is loop-encoded plaintext
        if (compressedPayload.length < 4) throw new Error("ciphertext too short");
        const decodedLen = new DataView(
          compressedPayload.buffer, compressedPayload.byteOffset,
        ).getUint32(0, true);
        // Sanity bound — even with chunked reassembly, no single message should decode
        // to more than 64 MB. Prevents a compromised peer from forcing a huge allocation.
        if (decodedLen > 64 * 1024 * 1024) throw new Error("decodedLen exceeds safety limit");
        const compressed = compressedPayload.subarray(4);

        if (!loopStateRecv) throw new Error("No receiving loop state after step");
        const { decoded: plaintext, next: afterDecode } = loopDecode(loopStateRecv, compressed, decodedLen);
        // note: loopDecode's `next` shares state.chain by reference (spread copy).
        // wiping loopStateRecv here would zero afterDecode.chain — skip the wipe.
        // the old state is local and will be garbage collected.
        loopStateRecv = afterDecode;

        if (!this.isSessionCurrent(generation)) {
          this.wipeRatchetState(ratchetState);
          this.wipeLoopState(loopStateSend);
          this.wipeLoopState(loopStateRecv);
          this.wipeSkippedLoopKeys(skippedLoopKeys);
          return;
        }

        this.commitReceiveState(ratchetState, loopStateSend, loopStateRecv, skippedLoopKeys, pubKeyHex);
        this.onLog(`recv: committed, nRecv=${this.ratchetState!.nRecv}, DH=${didDHRatchet}`);
        if (didDHRatchet) this.onLog("bond renewed");

        this.consecutiveDecryptFailures = 0; // reset on successful decrypt+decompress

        const msgId = this.nRecvTotal * 2 + (this.isOfferer ? 1 : 0);
        this.nRecvTotal++;

        const ackPayload = new Uint8Array(4);
        new DataView(ackPayload.buffer).setUint32(0, msgId, true);
        this.sendSealed(LIVE_MSG.ACK, ackPayload);

        const isEdit     = (header.flags & LIVE_FLAG.EDIT) !== 0;
        if (isEdit) {
          if (plaintext.length < 5) return; // 4B id + at least 1B text
          const targetId = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0, true);
          // Security: peer can only edit their own messages (parity check)
          const peerParity = this.isOfferer ? 1 : 0;
          if ((targetId & 1) !== peerParity) return;
          this.onEdit?.(targetId, TD.decode(plaintext.subarray(4)), "peer");
          return;
        }

        const isCampfire = (header.flags & LIVE_FLAG.CAMPFIRE) !== 0;
        const isFile     = (header.flags & LIVE_FLAG.FILE) !== 0;
        const isFilePart = (header.flags & LIVE_FLAG.FILE_PART) !== 0;

        if (isCampfire && this.onRawDecrypted) {
          this.onRawDecrypted(plaintext);
          return;
        }

        if (isFilePart) {
          this.handleFilePartMessage(plaintext, msgId);
        } else if (isFile) {
          const { fileName, fileType, fileBytes } = decodeFilePlaintext(plaintext);
          this.onMessage({
            type: "file",
            direction: "peer",
            msgId,
            fileName,
            fileSize: fileBytes.length,
            fileData: fileBytes,
            fileType,
            timestamp: Date.now(),
          });
        } else {
          this.onMessage({
            type: "text",
            direction: "peer",
            msgId,
            text: TD.decode(plaintext),
            timestamp: Date.now(),
          });
        }
      });
    } catch (err) {
      this.consecutiveDecryptFailures++;
      this.onLog(`decrypt failed: ${errorMessage(err)}`);
      if (this.consecutiveDecryptFailures >= 3) {
        this.onLog("3 consecutive decryption failures, possible desync or tampering. disconnecting");
        this.setState("error", "session got out of sync, reconnect to continue");
        this.cleanupConnection();
      }
    }
  }

  /** Accumulate one FILE_PART chunk. Emits onMessage when the last chunk arrives. */
  private handleFilePartMessage(plaintext: Uint8Array, msgId: number): void {
    let part: FilePartHeader;
    try {
      part = decodeFilePartPlaintext(plaintext);
    } catch (err) {
      this.onLog(`file part decode error: ${errorMessage(err)}`);
      return;
    }
    const { transferId, chunkIndex, totalChunks, totalFileSize, fileName, fileType, chunkData } = part;

    let transfer = this.incomingFiles.get(transferId);
    if (!transfer) {
      if (chunkIndex !== 0) {
        // Chunk 0 carries the metadata — if it arrives out of order we can't reconstruct.
        // With ordered SCTP DataChannels this should never happen in practice.
        this.onLog(`file part: received chunk ${chunkIndex} before chunk 0 (transfer ${transferId})`);
        return;
      }
      transfer = {
        fileName: fileName ?? "file",
        fileType: fileType ?? "",
        totalSize: totalFileSize,
        totalChunks,
        chunks: new Map(),
        receivedBytes: 0,
        firstMsgId: msgId,
      };
      this.incomingFiles.set(transferId, transfer);
    }

    if (chunkIndex >= transfer.totalChunks || transfer.chunks.has(chunkIndex)) return; // out-of-range or duplicate

    // store as Blob so the browser can swap to disk — keeps JS heap bounded
    // regardless of total file size (each chunk is ~4 MB, freed after Blob wraps it).
    transfer.chunks.set(chunkIndex, new Blob([chunkData]));
    transfer.receivedBytes += chunkData.length;

    if (transfer.chunks.size < transfer.totalChunks) return; // still waiting

    // all chunks received — assemble into a single Blob (no JS heap copy).
    this.incomingFiles.delete(transferId);
    const ordered: Blob[] = [];
    for (let i = 0; i < transfer.totalChunks; i++) ordered.push(transfer.chunks.get(i)!);
    const assembled = new Blob(ordered, { type: transfer.fileType || "application/octet-stream" });
    transfer.chunks.clear(); // release individual chunk Blobs

    this.onMessage({
      type: "file",
      direction: "peer",
      msgId: transfer.firstMsgId,
      fileName: transfer.fileName,
      fileSize: transfer.totalSize,
      fileBlob: assembled,
      fileType: transfer.fileType,
      timestamp: Date.now(),
    });
  }

  /* ── Kizuna membrane helpers ─────────────────────────────── */

  private async ratchetTurnSelection(): Promise<void> {
    try {
      if (!this.pc || !this.turnPool.length || !this.ratchetState) return;
      const indexBytes = await hkdf(
        this.ratchetState.rootKey,
        ZERO_SALT_32,
        TURN_KDF_INFO_BOND,
        4,
      );
      const idx = new DataView(indexBytes.buffer, indexBytes.byteOffset).getUint32(0, false) % this.turnPool.length;
      const turn = this.turnPool[idx];
      const current = typeof this.pc.getConfiguration === "function" ? this.pc.getConfiguration() : {};
      this.pc.setConfiguration({ ...current, iceServers: [turn] });
    } catch { /* setConfiguration unavailable or SubtleCrypto error — non-fatal */ }
  }

  // reinitialize both loop states from the current ratchet chain keys after each DH step.
  private async loopReinitFromChainKeys(): Promise<void> {
    if (!this.ratchetState) return;
    if (this.loopStateSend) { loopWipe(this.loopStateSend); this.loopStateSend = null; }
    if (this.loopStateRecv) { loopWipe(this.loopStateRecv); this.loopStateRecv = null; }
    if (this.ratchetState.chainKeySend) {
      this.loopStateSend = await this.buildLoopStateFromChainKey(this.ratchetState.chainKeySend);
    }
    if (this.ratchetState.chainKeyRecv) {
      this.loopStateRecv = await this.buildLoopStateFromChainKey(this.ratchetState.chainKeyRecv);
    }
    // reselect TURN only when external assist survives post-establishment.
    // if drop-after-connect (default), dropExternalAssist already
    // cleared iceServers — setConfiguration would be pointless.
    if (this.turnPool.length && this.externalAssistPolicy === "keep-for-session") void this.ratchetTurnSelection();
  }

  // advance the receive loop state and ratchet counter to `until`, storing
  // loop-derived message keys for potential out-of-order delivery.
  /* ── Sending ────────────────────────────────────────────── */

  /** Signal compose state. 0x00 = actively typing, 0x01 = idle with unsent text. */
  sendTyping(state: number = 0x00): void {
    if (!this.isLiveState()) return;
    this.sendSealed(LIVE_MSG.TYPING, new Uint8Array([state]));
  }

  /** Send a control frame to the peer. */
  sendCtrl(opcode: number, payload?: Uint8Array): void {
    if (!this.isLiveState()) return;
    this.sendSealed(LIVE_MSG.CTRL, encodeCtrl(opcode, payload));
  }

  /** Update peer on our stream state. bit0=audio, bit1=video, bit2=screen, 0x00=off. */
  sendStreamState(flags: number): void {
    if (!this.isLiveState()) return;
    this.sendCtrl(CTRL_OP.STREAM_STATE, new Uint8Array([flags & 0xFF]));
  }

  /** Send a live draw stream event to the peer over CTRL transport. */
  sendDrawStream(event: Omit<DrawStreamEvent, "seq">): void {
    if (!this.isLiveState()) return;
    const fullEvent = { ...event, seq: this.nextDrawStreamSeq++ } as DrawStreamEvent;
    const payload = encodeCtrl(CTRL_OP.DRAW_STREAM, encodeDrawStreamEvent(fullEvent));

    this.drawStreamSendQueue = this.drawStreamSendQueue
      .then(async () => {
        const dc = this.dc;
        if (!dc || dc.readyState !== "open" || !this.isLiveState()) return;
        if (dc.bufferedAmount > BUFFERED_AMOUNT_LOW) {
          try { await this.waitForDrain(); } catch { return; }
        }
        if (!this.dc || this.dc.readyState !== "open" || !this.isLiveState()) return;
        this.sendSealed(LIVE_MSG.CTRL, payload);
      })
      .catch((err) => {
        this.onLog(`draw stream send failed: ${errorMessage(err)}`);
      });
  }

  /** Wait for recovery to complete before sending. Returns false if destroyed. */
  private isLiveState(): boolean {
    return this._state === "live" || this._state === "silent";
  }

  private waitForRecovery(): Promise<boolean> {
    if (this.isLiveState()) return Promise.resolve(true);
    if (this._state !== "recovering") return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      // Chain onto any existing waiter
      const prev = this.recoveryResolve;
      this.recoveryResolve = () => {
        if (prev) prev();
        resolve(this.isLiveState() && !this._destroyed);
      };
    });
  }

  /** Decaying burst delay: 0 below threshold, exponential curve above. */
  private burstDelay(): number {
    const now = Date.now();
    if (this.burstLastSend) this.burstLevel *= Math.exp(-(now - this.burstLastSend) / 4_000);
    this.burstLastSend = now;
    const excess = ++this.burstLevel - 15;
    return excess > 0 ? 2_000 * (1 - Math.exp(-excess / 5)) : 0;
  }

  /** Enqueue a send job — serializes through sendQueue so ratchet state is never concurrent. */
  private enqueueSend(job: () => Promise<void>, skipBurst = false): Promise<void> {
    const wrapped = async () => {
      if (!skipBurst) {
        const delay = this.burstDelay();
        if (delay > 1) await new Promise<void>((r) => setTimeout(r, delay));
      }
      await job().catch((err) => {
        const msg = errorMessage(err);
        this.onLog(`send failed: ${msg}`);
        this.onMessage({ type: "system", direction: "system", text: `message not sent: ${msg}`, timestamp: Date.now() });
      });
    };
    this.sendQueue = this.sendQueue.then(wrapped);
    return this.sendQueue;
  }

  /** Guard: wait through recovery, then verify we can send. */
  private async canSend(): Promise<boolean> {
    if (this._state === "recovering" && !await this.waitForRecovery()) return false;
    return this.isLiveState() && !!this.dc && !!this.ratchetState;
  }

  async sendText(text: string): Promise<number> {
    let sentMsgId = -1;
    await this.enqueueSend(async () => {
      if (!await this.canSend()) return;
      const msgId = await this.encryptAndSend(TE.encode(text), 0x00);
      if (msgId < 0) return;
      sentMsgId = msgId;
      this.onMessage({ type: "text", direction: "self", msgId, text, timestamp: Date.now() });
    });
    return sentMsgId;
  }

  async sendEdit(targetMsgId: number, newText: string): Promise<number> {
    let sentMsgId = -1;
    await this.enqueueSend(async () => {
      if (!await this.canSend()) return;
      const textBytes = TE.encode(newText);
      const payload = new Uint8Array(4 + textBytes.length);
      new DataView(payload.buffer).setUint32(0, targetMsgId, true);
      payload.set(textBytes, 4);
      const msgId = await this.encryptAndSend(payload, LIVE_FLAG.EDIT);
      if (msgId < 0) return;
      sentMsgId = msgId;
      this.onEdit?.(targetMsgId, newText, "self");
    });
    return sentMsgId;
  }

  async sendFile(file: File): Promise<number> {
    // Large files: split into application-level chunks so the sender never
    // needs more than one chunk (~4 MB) in memory at a time.
    if (file.size > FILE_CHUNK_SIZE) {
      return this.sendFileChunked(file);
    }

    const fileBytes = new Uint8Array(await file.arrayBuffer());
    let sentMsgId = -1;
    await this.enqueueSend(async () => {
      if (!await this.canSend()) return;
      if (this.transportMode === "dressed") {
        sentMsgId = await this.sendFileDressed(file.name, file.type, fileBytes);
        return;
      }
      const plaintext = encodeFilePlaintext(file.name, file.type, fileBytes);
      const msgId = await this.encryptAndSend(plaintext, LIVE_FLAG.FILE);
      if (msgId < 0) return;
      sentMsgId = msgId;
      this.onMessage({
        type: "file", direction: "self",
        msgId, fileName: file.name, fileSize: fileBytes.length, fileType: file.type,
        fileData: fileBytes,
        timestamp: Date.now(),
      });
    });
    return sentMsgId;
  }

  /** Send a large file as sequential application-level 4 MB chunks.
   *  Each chunk is independently encrypted. The sender only holds one chunk
   *  in memory at a time — peak allocation is O(chunk) not O(file). */
  private async sendFileChunked(file: File): Promise<number> {
    const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE);
    const transferIdBytes = randomBytes(4);
    const transferId = new DataView(transferIdBytes.buffer).getUint32(0, true);
    let firstMsgId = -1;
    let bytesSent = 0;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * FILE_CHUNK_SIZE;
      const end = Math.min(start + FILE_CHUNK_SIZE, file.size);
      // file.slice() reads only this byte range — does not load the whole file.
      const chunkBytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
      const chunkIdx = i;
      const chunkLen = chunkBytes.length;

      // Chunked file transfer = single user action — skip rate shaping
      await this.enqueueSend(async () => {
        if (!await this.canSend()) return;
        const plaintext = encodeFilePartPlaintext(
          transferId, chunkIdx, totalChunks, file.size, chunkBytes,
          chunkIdx === 0 ? file.name : undefined,
          chunkIdx === 0 ? file.type : undefined,
        );
        const msgId = await this.encryptAndSend(plaintext, LIVE_FLAG.FILE_PART);
        if (msgId < 0) return;
        if (chunkIdx === 0) {
          firstMsgId = msgId;
          // Show self-entry immediately. fileData is omitted — we don't keep
          // 500 MB of our own file in memory just for a self-view download link.
          this.onMessage({
            type: "file", direction: "self",
            msgId, fileName: file.name, fileSize: file.size, fileType: file.type,
            timestamp: Date.now(),
          });
        }
        bytesSent += chunkLen;
        if (this.onSendProgress) this.onSendProgress(bytesSent, file.size);
      }, true);
    }
    return firstMsgId;
  }

  /** Send an audio recording as a file message, keeping bytes for self-playback.
   *  Always uses raw file wire — skips dressed mode (stego wraps audio in a PNG
   *  carrier which destroys playback and adds pointless overhead). */
  async sendAudio(fileName: string, fileType: string, audioBytes: Uint8Array): Promise<number> {
    let sentMsgId = -1;
    await this.enqueueSend(async () => {
      if (!await this.canSend()) return;
      const plaintext = encodeFilePlaintext(fileName, fileType, audioBytes);
      const msgId = await this.encryptAndSend(plaintext, LIVE_FLAG.FILE);
      if (msgId < 0) return;
      sentMsgId = msgId;
      this.onMessage({
        type: "file", direction: "self",
        msgId, fileName, fileSize: audioBytes.length, fileType,
        fileData: audioBytes,
        timestamp: Date.now(),
      });
    });
    return sentMsgId;
  }

  /** Send raw plaintext with custom flags. Used by CampfireNode for pairwise channels. */
  async sendEncryptedRaw(plaintext: Uint8Array, flags: number): Promise<void> {
    await this.enqueueSend(async () => {
      if (!await this.canSend()) return;
      await this.encryptAndSend(plaintext, flags);
    }, true);
  }

  private async sendFileDressed(
    fileName: string, fileType: string, fileBytes: Uint8Array,
  ): Promise<number> {
    if (!this.engine) this.engine = new WhisperEngine();
    const carrier = createMinimalPNGCarrier();

    try {
      let password: string;
      if (this.sharedSecret) {
        const stegoKey = await hkdf(this.sharedSecret, ZERO_SALT_32, TE.encode("whisper-stego"), 16);
        password = toHex(stegoKey);
        stegoKey.fill(0);
      } else {
        password = "whisper-dressed";
      }

      const payloadFile = new File([toArrayBuffer(fileBytes)], fileName, { type: fileType });
      const carrierFile = new File([toArrayBuffer(carrier)], "carrier.png", { type: "image/png" });

      const result = await this.engine.embedFile(carrierFile, payloadFile, password, {
        preferInertSpace: false,
        maxCandidates: 1,
        onlyDecodeHere: false,
        allowTailFallback: true,
      });

      // Send the dressed carrier as a file message
      const dressedBytes = new Uint8Array(await result.outputFile.arrayBuffer());
      const plaintext = encodeFilePlaintext(result.outputName, result.outputType, dressedBytes);
      const msgId = await this.encryptAndSend(plaintext, LIVE_FLAG.FILE);

      this.onMessage({
        type: "file",
        direction: "self",
        msgId,
        fileName: fileName,
        fileSize: fileBytes.length,
        fileType: fileType,
        fileData: fileBytes,
        timestamp: Date.now(),
      });

      this.onLog(`sent ${fileName} (embedded in carrier)`);
      return msgId;
    } catch (err) {
      this.onLog(`steganography failed, sending directly: ${errorMessage(err)}`);
      const msgId = await this.encryptAndSend(encodeFilePlaintext(fileName, fileType, fileBytes), LIVE_FLAG.FILE);
      this.onMessage({ type: "file", direction: "self", msgId, fileName, fileSize: fileBytes.length, fileType, fileData: fileBytes, timestamp: Date.now() });
      return msgId;
    }
  }

  private waitForDrain(): Promise<void> {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return Promise.reject(new Error("channel closed"));
    if (dc.bufferedAmount <= BUFFERED_AMOUNT_LOW) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onLow = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error("channel closed")); };
      const cleanup = () => {
        dc.removeEventListener("bufferedamountlow", onLow);
        dc.removeEventListener("close", onClose);
      };
      dc.addEventListener("bufferedamountlow", onLow, { once: true });
      dc.addEventListener("close", onClose, { once: true });
    });
  }

  private async encryptAndSend(plaintext: Uint8Array, flags: number): Promise<number> {
    this.onLog(`send: acquiring lock (queue depth: ${this.nSentTotal})`);
    return this.withRatchetLock(async () => {
      this.onLog("send: lock acquired");
      if (!this.ratchetState || !this.dc) return -1;

      if (!this.loopStateSend) {
        throw new Error("No sending loop state, ratchet not fully initialized");
      }

      if (this.ratchetState.nSend >= 0xFFFFFFFF) {
        throw new Error("Message counter exhausted — session must be restarted");
      }

      const msgId = this.nSentTotal * 2 + (this.isOfferer ? 0 : 1);
      this.nSentTotal++;

      // derive message key via loopStep (advances chain, primes counts)
      const { next: nextLoopSend, messageKey } = await loopStep(this.loopStateSend);
      loopWipe(this.loopStateSend);
      this.loopStateSend = nextLoopSend;

      // compress plaintext with the loop codec (advances counts).
      // raw = true means encoded is the original data (zero-copy pass-through
      // for large payloads that won't compress). the 0xFF raw marker is fused
      // into the allocation below instead of being copied separately.
      const { encoded, raw, next: afterEncode } = loopEncode(this.loopStateSend, plaintext);
      this.loopStateSend = afterEncode;

      // build pre-encryption payload: [decodedLen:4B LE][encoded with mode prefix]
      let compressedPayload: Uint8Array;
      if (raw) {
        // fuse [decodedLen][0xFF][data] — one allocation, one memcpy
        compressedPayload = new Uint8Array(5 + encoded.length);
        new DataView(compressedPayload.buffer).setUint32(0, encoded.length, true);
        compressedPayload[4] = 0xFF;
        compressedPayload.set(encoded, 5);
      } else {
        // encoded already has [mode][compressedBits], prepend decodedLen
        compressedPayload = new Uint8Array(4 + encoded.length);
        new DataView(compressedPayload.buffer).setUint32(0, plaintext.length, true);
        compressedPayload.set(encoded, 4);
      }

      const salt = randomBytes(4);
      const counter = this.ratchetState.nSend;
      const prevChainLen = this.ratchetState.prevChainLength;
      const dirBit = this.isOfferer ? 0 : 1;
      const nonce = buildNonce(counter, dirBit, salt);
      const pubKeyHex = toHex(this.ratchetState.dhSelf.publicKey);
      const sameKey = pubKeyHex === this.lastSentPubKeyHex;

      const header = buildHeader(
        sameKey ? (flags | LIVE_FLAG_SAME_KEY) : flags,
        this.ratchetState.dhSelf.publicKey,
        counter,
        prevChainLen,
        salt,
      );
      this.lastSentPubKeyHex = pubKeyHex;

      const ciphertext = await aesGcmEncrypt(messageKey, compressedPayload, nonce, header);
      messageKey.fill(0);

      this.ratchetState.nSend++;
      this.onLog(`send: encrypted, nSend=${this.ratchetState.nSend}, releasing lock`);

      // pass [header, ciphertext] as separate parts — the iterator reads across
      // them with a cursor, avoiding a full-payload concat allocation.
      const wireLen = header.length + ciphertext.length;
      const totalBytes = estimateChunkedPrefixedSize(wireLen);
      let bytesSent = 0;
      let lastProgressEmit = 0;
      for (const chunk of iterateChunksPrefixed([header, ciphertext], LIVE_MSG.ENCRYPTED)) {
        if (this.dc.bufferedAmount > BUFFERED_AMOUNT_LOW) {
          try { await this.waitForDrain(); } catch { return msgId; } // channel closed during drain
        }
        if (!this.dc || this.dc.readyState !== "open") return msgId;
        this.dc.send(chunk);
        bytesSent += chunk.byteLength;
        if (this.onSendProgress) {
          const now = performance.now();
          if (bytesSent >= totalBytes || now - lastProgressEmit >= SEND_PROGRESS_INTERVAL_MS) {
            this.onSendProgress(bytesSent, totalBytes);
            lastProgressEmit = now;
          }
        }
      }
      return msgId;
    });
  }

  /* ── Trust ──────────────────────────────────────────────── */

  confirmFingerprint(): void {
    if (this._state !== "verifying") return;
    this.localConfirmRequested = true;
    this.sendQueue = this.sendQueue.then(() => this.sendLocalConfirmProof()).catch((err) => {
      if (this._destroyed) return;
      this.onLog(`confirmation failed: ${errorMessage(err)}`);
      this.setState("error", "connection confirmation failed");
      this.cleanupConnection();
    });
  }

  rejectFingerprint(): void {
    if (this._state !== "verifying") return;
    if (this.fingerprintNudgeTimer) { clearTimeout(this.fingerprintNudgeTimer); this.fingerprintNudgeTimer = null; }

    this.send(LIVE_MSG.FINGERPRINT_REJECTED);
    this.setState("error", "fingerprint mismatch, possible interception");
    this.cleanupConnection();
  }

  /* ── Transport ──────────────────────────────────────────── */

  setTransport(mode: TransportMode): void {
    this.transportMode = mode;

    if (mode === "silent" && this._state === "live") {
      this.setState("silent");
    } else if (mode !== "silent" && this._state === "silent") {
      this.setState("live");
    }
  }

  /** Get a purpose-derived key for Silent mode (Whisper solo password). Isolated from the session root. */
  getSharedSecret(): string | null {
    if (!this.silentKey) return null;
    return toHex(this.silentKey);
  }

  /* ── Teardown ───────────────────────────────────────────── */

  disconnect(): void {
    this.setState("disconnected");
    this.cleanupConnection();
  }

  /* ── Heartbeat ─────────────────────────────────────────── */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongReceived = Date.now();

    this.heartbeatSend = setInterval(() => {
      this.send(LIVE_MSG.PING);
    }, HEARTBEAT_INTERVAL);

    this.heartbeatCheck = setInterval(() => {
      if (this._state === "recovering" || this._destroyed) return;
      // Widen timeout when tab is hidden — browsers throttle timers to ≥1min
      const timeout = this.tabHidden ? HEARTBEAT_TIMEOUT * 2 : HEARTBEAT_TIMEOUT;
      if (Date.now() - this.lastPongReceived > timeout) {
        this.onLog("heartbeat timeout, peer unresponsive");
        this.setState("disconnected", "vanished");
        this.cleanupConnection();
      }
    }, HEARTBEAT_INTERVAL);

    this.visibilityHandler = () => {
      this.tabHidden = document.hidden;
      if (!document.hidden) {
        this.lastPongReceived = Math.max(this.lastPongReceived, Date.now() - HEARTBEAT_TIMEOUT + 5_000);
        this.send(LIVE_MSG.PING);
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);

    this.startStatsPoll();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatSend) { clearInterval(this.heartbeatSend); this.heartbeatSend = null; }
    if (this.heartbeatCheck) { clearInterval(this.heartbeatCheck); this.heartbeatCheck = null; }
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.stopStatsPoll();
  }

  /* ── Connection Stats ───────────────────────────────────── */

  private startStatsPoll(): void {
    this.stopStatsPoll();
    if (!this.onConnectionStats || !this.pc) return;
    this.statsTimer = setInterval(() => { void this.pollStats(); }, HEARTBEAT_INTERVAL);
  }

  private stopStatsPoll(): void {
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
  }

  private async pollStats(): Promise<void> {
    if (!this.pc || !this.onConnectionStats) return;
    try {
      const stats = await this.pc.getStats();
      for (const report of stats.values()) {
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          this.onConnectionStats({
            rtt: report.currentRoundTripTime != null ? report.currentRoundTripTime * 1000 : -1,
            bytesSent: report.bytesSent ?? 0,
            bytesReceived: report.bytesReceived ?? 0,
          });
          break;
        }
      }
    } catch { /* stats unavailable */ }
  }

  /* ── Cleanup ─────────────────────────────────────────────── */

  private cleanupConnection(): void {
    if (this._destroyed) return; // re-entrancy guard
    this._destroyed = true;

    this.stopHeartbeat();
    const clr = (t: ReturnType<typeof setTimeout> | null) => { if (t) clearTimeout(t); };
    clr(this.handshakeTimer); this.handshakeTimer = null;
    clr(this.fingerprintNudgeTimer); this.fingerprintNudgeTimer = null;
    clr(this.recoveryTimer); this.recoveryTimer = null;
    clr(this.connectingGraceTimer); this.connectingGraceTimer = null;
    if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
    this.connectingGraceDone = false;
    this.stateBeforeRecovery = null;
    this.iceRestartAttempted = false;
    this.setupRestartPending = false;
    this.liveRestartPending = false;
    this.externalAssistDropped = false;
    this.turnInjected = false;
    this.relaySignalSender = null;
    this.pendingRelaySignals.length = 0;
    this.pendingRemoteIce.length = 0;

    const { dc, pc } = this;
    this.dc = this.pc = null;

    if (dc) {
      dc.onopen = dc.onclose = dc.onerror = dc.onmessage = null;
      try { dc.close(); } catch { /* ignore */ }
    }
    if (pc) {
      pc.onicecandidate = pc.oniceconnectionstatechange = pc.onconnectionstatechange = null;
      pc.onicegatheringstatechange = pc.ondatachannel = null;
      try { pc.close(); } catch { /* ignore */ }
    }

    if (this.loopStateSend) { loopWipe(this.loopStateSend); this.loopStateSend = null; }
    if (this.loopStateRecv) { loopWipe(this.loopStateRecv); this.loopStateRecv = null; }
    for (const mk of this.skippedLoopKeys.values()) mk.fill(0);
    this.skippedLoopKeys.clear();

    if (this.ratchetState) {
      this.ratchetState.rootKey.fill(0);
      if (this.ratchetState.chainKeySend) this.ratchetState.chainKeySend.fill(0);
      if (this.ratchetState.chainKeyRecv) this.ratchetState.chainKeyRecv.fill(0);
      if (this.ratchetState.dhPeer) this.ratchetState.dhPeer.fill(0);
      this.ratchetState.dhSelf.publicKey.fill(0);
      for (const mk of this.ratchetState.skippedKeys.values()) mk.fill(0);
      this.ratchetState.skippedKeys.clear();
      this.ratchetState = null;
    }

    if (this.sharedSecret) {
      this.sharedSecret.fill(0);
      this.sharedSecret = null;
    }
    this.wipeBytes(this.silentKey);
    this.silentKey = null;
    this.wipeBytes(this.audioKeyBytes);
    this.audioKeyBytes = null;
    this.wipeBytes(this.ctrlChainSend); this.ctrlChainSend = null;
    this.wipeBytes(this.ctrlChainRecv); this.ctrlChainRecv = null;
    this.ctrlSendCounter = 0;
    this.ctrlRecvCounter = 0;
    this.lastSentPubKeyHex = "";
    this.lastRecvPubKeyHex = "";
    this.clearHandshakeArtifacts();

    this.wipeBytes(this.phraseRoot);
    this.phraseRoot = null;
    this.consecutiveDecryptFailures = 0;
    this.assembler.reset();
    this.clearIncomingFiles();

    if (this.recoveryResolve) {
      const resolve = this.recoveryResolve;
      this.recoveryResolve = null;
      resolve();
    }

    this.ephPrivateKey = null;
    this.keyReady = Promise.resolve();
  }
}
