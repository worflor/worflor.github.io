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
  fileData?: Uint8Array;
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
   * When true (default), if `rtcConfig` includes ICE servers we will disable them
   * after establishment (DataChannel open / connected). This keeps external assist
   * scoped to connection setup only.
   */
  externalAssistEstablishmentOnly?: boolean;

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
const ZERO_SALT_32 = new Uint8Array(32);

async function selectTurnServer(phraseRoot: Uint8Array, pool: RTCIceServer[]): Promise<RTCIceServer> {
  const indexBytes = await derivePhraseScopedKey(phraseRoot, "turn-select", 4, TURN_KDF_INFO_PHRASE);
  const idx = new DataView(indexBytes.buffer, indexBytes.byteOffset).getUint32(0, false) % pool.length;
  return pool[idx];
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

/**
 * Default: local-only ICE.
 * This prevents accidental metadata leakage to public STUN servers.
 * Users can opt-in to STUN via UI/URL wiring by passing `rtcConfig`.
 */
export const WHISPER_LIVE_RTC_LOCAL_ONLY: RTCConfiguration = {
  iceServers: [],
};

/** STUN config (opt-in). Multiple servers for redundancy.
 *  Port-443 servers are listed first — 443/TCP is the least-blocked port globally
 *  and passes through most restrictive firewalls. Standard 3478 servers are fallback. */
export const WHISPER_LIVE_RTC_PUBLIC_STUN: RTCConfiguration = {
  iceServers: [
    {
      urls: [
        "stun:stun.nextcloud.com:443",       // port 443 — passes most firewalls
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun.cloudflare.com:3478",
      ]
    },
  ],
  // Keep pre-gathering modest to reduce load on shared STUN infra.
  // This remains a good reliability/latency balance for chat setup.
  iceCandidatePoolSize: 1,
};

/**
 * Stealth / relay-only config.
 * Forces ALL traffic through a TURN relay (iceTransportPolicy: "relay").
 * No direct P2P — peer IPs are never exposed; data exits only via TURN.
 * Requires a TURN server in turnPool using `turns:host:443?transport=tcp`
 * so traffic is indistinguishable from HTTPS on port 443.
 * Will fail to connect if no TURN server is reachable.
 */
export const WHISPER_LIVE_RTC_STEALTH: RTCConfiguration = {
  iceTransportPolicy: "relay",
  iceServers: [], // TURN injected at connect time from turnPool
  iceCandidatePoolSize: 0,
};

// Timeout for ICE gathering (ms)
const ICE_GATHER_TIMEOUT = 8000;

const HEARTBEAT_INTERVAL = 15_000;        // send ping every 15s
const HEARTBEAT_TIMEOUT = 45_000;        // drop peer after 45s silence

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

/** State for a multi-part file transfer being received. */
interface IncomingFileTransfer {
  fileName: string;
  fileType: string;
  totalSize: number;
  totalChunks: number;
  chunks: Map<number, Uint8Array>;
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

  // External assist (STUN) lifecycle
  private externalAssistEstablishmentOnly: boolean;
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
    this.externalAssistEstablishmentOnly = options.externalAssistEstablishmentOnly ?? true;
    this.autoConfirm = options.autoConfirmFingerprint ?? false;
    this.turnPool = options.turnPool ?? [];
  }

  private hasExternalAssistConfigured(): boolean {
    if (this.turnInjected) return true;
    const servers = this.rtcConfig.iceServers;
    return Array.isArray(servers) && servers.length > 0;
  }

  private async buildRtcConfig(): Promise<RTCConfiguration> {
    if (!this.turnPool.length || !this.phraseRoot) return this.rtcConfig;
    const turn = await selectTurnServer(this.phraseRoot, this.turnPool);
    this.turnInjected = true;
    return {
      ...this.rtcConfig,
      iceServers: [...(this.rtcConfig.iceServers ?? []), turn],
    };
  }

  private dropExternalAssist(pc: RTCPeerConnection): void {
    if (!this.externalAssistEstablishmentOnly) return;
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
      for (const chunk of transfer.chunks.values()) {
        chunk.fill(0);
      }
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

      const logGatherResult = () => {
        const sdp = this.pc?.localDescription?.sdp ?? "";
        const types = [...sdp.matchAll(/typ (\w+)/g)].map(m => m[1]);
        const uniqueTypes = [...new Set(types)];
        this.onLog(`gathered ${types.length} network path(s): ${uniqueTypes.join(", ") || "none"}`);
        if (!types.includes("srflx") && this.hasExternalAssistConfigured())
          this.onLog("no relay candidates found, external assist may be unavailable");
        if (types.length === 0)
          this.onLog("no network paths found, connection may fail");
      };

      if (this.pc.iceGatheringState === "complete") {
        logGatherResult();
        resolve();
        return;
      }

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pc) this.pc.onicegatheringstatechange = null;
        logGatherResult();
        resolve();
      };

      const timer = setTimeout(() => {
        this.onLog("path discovery timed out, proceeding with what we have");
        done();
      }, ICE_GATHER_TIMEOUT);

      this.pc.onicegatheringstatechange = () => {
        if (this.pc?.iceGatheringState === "complete") done();
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
    if (this.connectingGraceTimer) return; // already running
    this.connectingGraceDone = true;
    this.onLog("negotiating connection, waiting for peer to finish exchange...");

    // Re-apply remote description periodically to re-arm ICE agent for
    // incoming connectivity checks from the peer.
    this.iceRetryInterval = setInterval(() => {
      if (!this.pc) return;
      const s = this.pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
        return;
      }
      if (s === "failed" || s === "disconnected") {
        const rd = this.pc.remoteDescription;
        if (rd) {
          this.pc.setRemoteDescription(rd).catch((e) => {
            this.onLog(`negotiation re-arm failed: ${e instanceof Error ? e.message : "unknown"}`);
          });
        }
      }
    }, 8_000);

    this.connectingGraceTimer = setTimeout(() => {
      this.connectingGraceTimer = null;
      if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
      if (this.isLiveState() ||
        this._state === "disconnected" || this._state === "error") return;
      // Check current state — ICE may have recovered during the wait
      const iceState = pc.iceConnectionState;
      if (iceState === "connected" || iceState === "completed") return;
      this.onLog("connection failed after waiting period");
      this.setState("error", "couldn't reach your peer. make sure both sides have external assist enabled if connecting across networks.");
      this.cleanupConnection();
    }, HEARTBEAT_TIMEOUT);
  }

  private setupPeerConnection(pc: RTCPeerConnection): void {
    pc.onicecandidate = (_event) => {
      // Per-candidate logs omitted; summary logged after gathering completes
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;

      if (s === "checking") return;

      if (s === "disconnected") {
        if (this.isLiveState()) {
          this.stateBeforeRecovery = this._state as "live" | "silent";
          this.setState("recovering");
          this.onLog("connection interrupted, attempting recovery...");
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
        if ((this.isLiveState() || this._state === "recovering") && !this.iceRestartAttempted) {
          this.iceRestartAttempted = true;
          this.onLog("connection failed, attempting restart...");
          if (this._state !== "recovering") {
            this.stateBeforeRecovery = this._state as "live" | "silent";
            this.setState("recovering");
          }
          this.attemptIceRestart(pc);
        } else if (this.isSetupState()) {
          this.startConnectingGrace(pc);
        } else if (this._state === "recovering") {
          this.onLog("peer left, session over");
          this.setState("disconnected", "vanished");
          this.cleanupConnection();
        } else {
          this.onLog("connection failed, could not reach peer");
          this.setState("error", "couldn't reach your peer. make sure both sides have external assist enabled if connecting across networks.");
          this.cleanupConnection();
        }
        return;
      }

      if (s === "connected" || s === "completed") {
        if (s === "connected") this.onLog("connected to peer");
        this.iceRestartAttempted = false;
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

  /**
   * ICE restart limitation: only the offerer can create a new offer with
   * iceRestart. The answerer can only call restartIce() to signal the browser,
   * but without a signaling channel the new offer/answer cannot be exchanged.
   * This means ICE restarts only work if the network path recovers on its own.
   */
  private attemptIceRestart(pc: RTCPeerConnection): void {
    if (this.isOfferer) {
      // Offerer: create new offer with iceRestart flag
      pc.createOffer({ iceRestart: true })
        .then((offer) => pc.setLocalDescription(offer))
        .catch((err) => {
          this.onLog(`restart failed: ${errorMessage(err)}`);
          this.setState("disconnected", "vanished");
          this.cleanupConnection();
        });
    } else {
      // Answerer: restartIce() signals the browser to expect a new offer
      pc.restartIce();
      this.onLog("restart requested, waiting for path to recover");
    }
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
        this.localEphPublicKey = pubKeyCompressed;
        if (!this.dc || this.dc.readyState !== "open") {
          this.onLog("key exchange aborted, channel not available");
          return;
        }
        this.send(LIVE_MSG.KEY_EXCHANGE, pubKeyCompressed);

        this.ephPrivateKey = keyPair.privateKey;
      } catch (err) {
        this.onLog(`key exchange failed: ${errorMessage(err, "unknown error")}`);
        this.setState("error", "couldn't establish encryption, try again");
      }
    })();
  }

  private async handleKeyExchangeMessage(peerPubKeyRaw: Uint8Array): Promise<void> {
    if (this._state !== "handshaking") return;
    try {
      await this.keyReady;
      if (!this.ephPrivateKey) throw new Error("No ephemeral private key");

      // peer sends compressed (33B) — WebCrypto importKey("raw") needs uncompressed (65B)
      const peerPubUncompressed = peerPubKeyRaw.length === 33 ? decompressP256(peerPubKeyRaw) : peerPubKeyRaw;
      const peerPubKey = await crypto.subtle.importKey(
        "raw", toArrayBuffer(peerPubUncompressed), { name: "ECDH", namedCurve: "P-256" }, false, [],
      );
      const sharedBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: peerPubKey }, this.ephPrivateKey, 256,
      );
      const ecdhSecret = new Uint8Array(sharedBits);

      this.ephPrivateKey = null;

      const transcriptHash = await this.buildTranscriptHash(peerPubKeyRaw);
      const sharedSecret = await deriveSessionRoot(ecdhSecret, transcriptHash, this.phraseRoot);
      ecdhSecret.fill(0);
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
        if (this._state === "verifying") this.onLog("awaiting fingerprint confirmation");
      }, 8000);

      if (this.isOfferer) {
        const dhSelf = await generateDHKeyPair();
        this.ratchetState = await initRatchetAsOfferer(sharedSecret, dhSelf);
        this.ratchetInitSentPubKey = dhSelf.publicKey.slice();

        if (this.dc && this.dc.readyState === "open") {
          this.send(LIVE_MSG.RATCHET_INIT, dhSelf.publicKey);
        }
      }

      this.setState("verifying");

      // Auto-confirm is deferred to handleRatchetInit — chain keys aren't ready yet.
    } catch (err) {
      this.onLog(`key derivation failed: ${errorMessage(err, "unknown error")}`);
      this.setState("error", "couldn't establish encryption, try again");
    }
  }

  private async handleRatchetInit(peerRatchetPubKey: Uint8Array): Promise<void> {
    if (this._state !== "handshaking" && this._state !== "verifying") return;
    if (!this.sharedSecret) return;

    // Guard: only accept one RATCHET_INIT per handshake. A duplicate would
    // overwrite (answerer) or desync (offerer) the ratchet state. Reject silently.
    if (this.ratchetInitReceived) return;
    this.ratchetInitReceived = true;

    if (!this.isOfferer) {
      this.ratchetState = await initRatchetAsReceiver(this.sharedSecret, peerRatchetPubKey);

      // chainKeyRecv is null until first DH step — only init send side now.
      this.loopStateSend = loopInit(await loopExpand(this.ratchetState.chainKeySend!));

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

    const isCompact = (complete[0] & LIVE_FLAG_SAME_KEY) !== 0;
    const headerSize = isCompact ? HEADER_SIZE_COMPACT : HEADER_SIZE;
    if (complete.length < headerSize + 16) return; // header + minimum AES-GCM tag

    try {
      const header = parseHeader(complete);

      // Resolve pubkey: compact headers use cached peer key
      let pubKeyHex: string;
      if (header.pubKey) {
        pubKeyHex = toHex(header.pubKey);
        this.lastRecvPubKeyHex = pubKeyHex;
      } else {
        pubKeyHex = this.lastRecvPubKeyHex;
        if (!pubKeyHex) return; // no cached key — can't process
      }

      // try loop-derived skipped key first (defense-in-depth; never fires with ordered SCTP).
      let messageKey = this.tryLoopSkippedKey(pubKeyHex, header.counter);
      let didDHRatchet = false;
      let nextLoopRecv: LoopState | undefined;

      if (!messageKey) {
        // check if this is a new DH ratchet key
        if (pubKeyHex !== this.ratchetState.dhPeerHex) {
          if (!header.pubKey) return; // DH ratchet needs the actual key bytes
          // new DH ratchet — skip remaining messages in current receive chain
          if (this.ratchetState.chainKeyRecv && this.loopStateRecv) {
            await this.skipMessagesWithLoop(header.prevChainLen);
          }
          await dhRatchetStep(this.ratchetState, header.pubKey);
          // reinit both loop states from the new DH-derived chain keys
          await this.loopReinitFromChainKeys();
          this.onLog("bond renewed");
          didDHRatchet = true;
        }

        // advance loop and ratchet counter to the message's position
        // (with ordered SCTP, skip count is always 0 — loop body never executes)
        await this.skipMessagesWithLoop(header.counter);

        if (!this.loopStateRecv) throw new Error("No receiving loop state");

        // derive this message's key via loopStep — speculative, not committed yet
        const stepResult = await loopStep(this.loopStateRecv);
        nextLoopRecv = stepResult.next;
        messageKey = stepResult.messageKey;
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
        // non-DH path: wipe speculative loop state, leave current state intact
        if (nextLoopRecv) loopWipe(nextLoopRecv);
        throw decryptErr;
      }
      messageKey.fill(0);

      // commit loop state — decrypt succeeded
      if (nextLoopRecv && this.loopStateRecv) {
        loopWipe(this.loopStateRecv);
        this.loopStateRecv = nextLoopRecv;
        this.ratchetState.nRecv++;
      }

      // decompress: first 4 bytes are decodedLen (LE uint32), rest is loop-encoded plaintext
      if (compressedPayload.length < 4) throw new Error("ciphertext too short");
      const decodedLen = new DataView(
        compressedPayload.buffer, compressedPayload.byteOffset,
      ).getUint32(0, true);
      // Sanity bound — even with chunked reassembly, no single message should decode
      // to more than 64 MB. Prevents a compromised peer from forcing a huge allocation.
      if (decodedLen > 64 * 1024 * 1024) throw new Error("decodedLen exceeds safety limit");
      const compressed = compressedPayload.subarray(4);

      if (!this.loopStateRecv) throw new Error("No receiving loop state after step");
      const { decoded: plaintext, next: afterDecode } = loopDecode(this.loopStateRecv, compressed, decodedLen);
      this.loopStateRecv = afterDecode;

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
        firstMsgId: msgId,
      };
      this.incomingFiles.set(transferId, transfer);
    }

    if (chunkIndex >= transfer.totalChunks || transfer.chunks.has(chunkIndex)) return; // out-of-range or duplicate

    // chunkData is a subarray of the decrypted plaintext. Slice so the backing
    // buffer can be freed; we only keep the ~4 MB slice, not the full allocation.
    transfer.chunks.set(chunkIndex, chunkData.slice());

    if (transfer.chunks.size < transfer.totalChunks) return; // still waiting

    // All chunks received — assemble in order and emit.
    this.incomingFiles.delete(transferId);
    let total = 0;
    for (const c of transfer.chunks.values()) total += c.length;
    const assembled = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < transfer.totalChunks; i++) {
      const c = transfer.chunks.get(i)!;
      assembled.set(c, offset);
      offset += c.length;
    }
    this.onMessage({
      type: "file",
      direction: "peer",
      msgId: transfer.firstMsgId,
      fileName: transfer.fileName,
      fileSize: transfer.totalSize,
      fileData: assembled,
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
      this.loopStateSend = loopInit(await loopExpand(this.ratchetState.chainKeySend));
    }
    if (this.ratchetState.chainKeyRecv) {
      this.loopStateRecv = loopInit(await loopExpand(this.ratchetState.chainKeyRecv));
    }
    // reselect TURN only when external assist survives post-establishment.
    // if externalAssistEstablishmentOnly (default), dropExternalAssist already
    // cleared iceServers — setConfiguration would be pointless.
    if (this.turnPool.length && !this.externalAssistEstablishmentOnly) void this.ratchetTurnSelection();
  }

  // advance the receive loop state and ratchet counter to `until`, storing
  // loop-derived message keys for potential out-of-order delivery.
  private async skipMessagesWithLoop(until: number): Promise<void> {
    if (!this.ratchetState || !this.loopStateRecv) return;
    if (until - this.ratchetState.nRecv > 256) throw new Error("Too many skipped messages");
    const pubHex = this.ratchetState.dhPeerHex;
    while (this.ratchetState.nRecv < until) {
      const counter = this.ratchetState.nRecv;
      const { next: nextLoop, messageKey } = await loopStep(this.loopStateRecv);
      this.skippedLoopKeys.set(`${pubHex}:${counter}`, messageKey);
      loopWipe(this.loopStateRecv);
      this.loopStateRecv = nextLoop;
      this.ratchetState.nRecv++;
    }
  }

  // retrieve and remove a previously skipped loop-derived message key. O(1) lookup.
  private tryLoopSkippedKey(pubHex: string, nr: number): Uint8Array | null {
    const key = `${pubHex}:${nr}`;
    const mk = this.skippedLoopKeys.get(key);
    if (!mk) return null;
    this.skippedLoopKeys.delete(key);
    return mk;
  }

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

    // compress plaintext with the loop codec (advances counts)
    const { encoded: compressed, next: afterEncode } = loopEncode(this.loopStateSend, plaintext);
    this.loopStateSend = afterEncode;

    // prefix compressed payload with decodedLen so the receiver knows output size
    const decodedLenBytes = new Uint8Array(4);
    new DataView(decodedLenBytes.buffer).setUint32(0, plaintext.length, true);
    const compressedPayload = concatBytes(decodedLenBytes, compressed);

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

    const wireMessage = concatBytes(header, ciphertext);

    this.ratchetState.nSend++;

    const totalBytes = estimateChunkedPrefixedSize(wireMessage.length);
    let bytesSent = 0;
    let lastProgressEmit = 0;
    for (const chunk of iterateChunksPrefixed(wireMessage, LIVE_MSG.ENCRYPTED)) {
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
    this.externalAssistDropped = false;
    this.turnInjected = false;

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
