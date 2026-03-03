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
 *   - AES-256-GCM per-message encryption (32-byte keys, 12-byte random nonces)
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
import { sdpToCode, codeToSdp } from "./live-sdp";
import { CTRL_OP, encodeCtrl, decodeCtrl } from "./live-ctrl";
import {
  type DrawStreamEvent,
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
  buildHeader,
  parseHeader,
  encodeFilePlaintext,
  decodeFilePlaintext,
} from "./live-wire";

import {
  BUFFERED_AMOUNT_LOW,
  estimateChunkedPrefixedSize,
  iterateChunksPrefixed,
  ChunkAssembler,
} from "./live-chunking";

import { createMinimalPNGCarrier } from "./live-carrier";

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

const PHRASE_KDF_INFO = TE.encode("whisper-live-keyed");
const TURN_KDF_INFO_PHRASE = TE.encode("whisper-turn-v1");
const TURN_KDF_INFO_BOND = TE.encode("whisper-turn-bond-v1");
const ZERO_SALT_32 = new Uint8Array(32);

async function selectTurnServer(phrase: string, pool: RTCIceServer[]): Promise<RTCIceServer> {
  const phraseHash = await sha256(TE.encode("whisper-phrase|" + phrase));
  const indexBytes = await hkdf(phraseHash, ZERO_SALT_32, TURN_KDF_INFO_PHRASE, 4);
  phraseHash.fill(0);
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

/** STUN config (opt-in). Multiple servers for redundancy. */
export const WHISPER_LIVE_RTC_PUBLIC_STUN: RTCConfiguration = {
  iceServers: [
    {
      urls: [
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
} as const;

const LIVE_FLAG = {
  FILE: 0x01,
  CAMPFIRE: 0x02,
} as const;
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

export class WhisperLiveSession {
  private _state: LiveState = "idle";
  private _destroyed = false;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ratchetState: RatchetState | null = null;
  private sharedSecret: Uint8Array | null = null;
  private consecutiveDecryptFailures = 0;
  private sharedPhrase: string | null = "";
  private transportMode: TransportMode = "naked";
  private assembler = new ChunkAssembler();
  private engine: WhisperEngine | null = null;
  private isOfferer = false;
  /** Total messages sent this session — never resets unlike ratchet nSend. */
  private nSentTotal = 0;
  /** Total messages received this session — mirrors peer's nSentTotal. */
  private nRecvTotal = 0;
  private nextDrawStreamSeq = 0;

  // Kizuna membrane: loop states for send and receive directions.
  // initialized from ECDH-derived chain keys. reinit on each DH ratchet step.
  private loopStateSend: LoopState | null = null;
  private loopStateRecv: LoopState | null = null;
  // skipped message keys (loop-derived, for out-of-order delivery recovery).
  // dead code with ordered SCTP DataChannels — stored for correctness.
  private skippedLoopKeys: Map<string, Uint8Array> = new Map();

  /** Ephemeral ECDH private key — exists only during handshake, then wiped */
  private ephPrivateKey: CryptoKey | null = null;

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

  // Tab-aware heartbeat
  private tabHidden = false;
  private visibilityHandler: (() => void) | null = null;

  // Connection stats polling
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  // Recovery send queue — holds jobs until session returns to live
  private recoveryResolve: (() => void) | null = null;

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
    if (!this.turnPool.length || !this.sharedPhrase) return this.rtcConfig;
    const turn = await selectTurnServer(this.sharedPhrase, this.turnPool);
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

  /** Retrieve the 256-bit shared session secret as a Uint32Array for the WebAssembly audio codec. */
  get audioKey(): Uint32Array | undefined {
    if (!this.sharedSecret) return undefined;
    // Extract first 16 bytes for the 128-bit seed expected by the WASM codec
    return new Uint32Array(this.sharedSecret.buffer, this.sharedSecret.byteOffset, 4);
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

  /* ── Offer/Answer Lifecycle ─────────────────────────────── */

  private initSession(sharedPhrase?: string, asOfferer = true): void {
    this._destroyed = false;
    this.externalAssistDropped = false;
    this.turnInjected = false;
    this.connectingGraceDone = false;
    this.sharedPhrase = sharedPhrase ?? "";
    this.isOfferer = asOfferer;
  }

  /** Peer A: create an offer code. */
  async createOffer(sharedPhrase?: string): Promise<string> {
    this.initSession(sharedPhrase, true);
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

    const code = await sdpToCode(this.pc.localDescription!.sdp, "offer", this.sharedPhrase || undefined);

    this.onLog(`offer code ready${this.sharedPhrase ? " (sealed)" : ""}`);
    this.setState("waiting-for-answer");

    return code;
  }

  /** Peer A: apply the answer code from Peer B. */
  async applyAnswer(answerCode: string): Promise<void> {
    if (!this.pc) throw new Error("No connection, create offer first");

    this.onLog("applying answer code...");
    const sdp = await codeToSdp(answerCode, "answer", this.sharedPhrase || undefined);
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    this.setState("connecting");
    this.onLog("connecting peer-to-peer...");
  }

  /** Peer B: accept an offer code, return an answer code. */
  async acceptOffer(offerCode: string, sharedPhrase?: string): Promise<string> {
    this.initSession(sharedPhrase, false);
    this.setState("answering");
    this.onLog("accepting offer code...");

    const offerSDP = await codeToSdp(offerCode, "offer", this.sharedPhrase || undefined);

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

    const answerCode = await sdpToCode(this.pc.localDescription!.sdp, "answer", this.sharedPhrase || undefined);

    this.onLog(`answer code ready${this.sharedPhrase ? " (sealed)" : ""}`);
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
        if (!this.dc || this.dc.readyState !== "open") {
          this.onLog("key exchange aborted, channel not available");
          return;
        }
        this.send(LIVE_MSG.KEY_EXCHANGE, pubKeyRaw);

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

      const peerPubKey = await crypto.subtle.importKey(
        "raw", toArrayBuffer(peerPubKeyRaw), { name: "ECDH", namedCurve: "P-256" }, false, [],
      );
      const sharedBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: peerPubKey }, this.ephPrivateKey, 256,
      );
      let sharedSecret: Uint8Array = new Uint8Array(sharedBits);

      this.ephPrivateKey = null;

      if (this.sharedPhrase) {
        const phraseHash = await sha256(TE.encode("whisper-phrase|" + this.sharedPhrase));
        this.sharedPhrase = null; // wipe phrase immediately
        const concat = concatBytes(sharedSecret, phraseHash);
        phraseHash.fill(0); // wipe intermediate
        const oldSecret = sharedSecret;
        sharedSecret = await hkdf(
          concat,
          ZERO_SALT_32,
          PHRASE_KDF_INFO,
          32,
        );
        concat.fill(0); // wipe concat intermediate
        oldSecret.fill(0); // wipe raw ECDH output
      } else {
        this.sharedPhrase = null;
      }

      this.sharedSecret = sharedSecret;

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

        if (this.dc && this.dc.readyState === "open") {
          this.send(LIVE_MSG.RATCHET_INIT, dhSelf.publicKey);
        }
      }

      this.setState("verifying");

      // Answerer auto-confirm is deferred to handleRatchetInit (after chainKeySend is set).
      // Offerer auto-confirm is also deferred to handleRatchetInit so that chainKeySend
      // is guaranteed initialized before entering "live" — avoids a silent send-failure
      // race where the offerer is "live" but the send chain isn't ready yet.
    } catch (err) {
      this.onLog(`key derivation failed: ${errorMessage(err, "unknown error")}`);
      this.setState("error", "couldn't establish encryption, try again");
    }
  }

  private async handleRatchetInit(peerRatchetPubKey: Uint8Array): Promise<void> {
    if (this._state !== "handshaking" && this._state !== "verifying") return;
    if (!this.sharedSecret) return;

    if (!this.isOfferer) {
      this.ratchetState = await initRatchetAsReceiver(this.sharedSecret, peerRatchetPubKey);

      // answerer has chainKeySend immediately; chainKeyRecv is null until first DH step.
      // init loopStateSend now; loopStateRecv will be set by the first incoming DH ratchet.
      this.loopStateSend = loopInit(await loopExpand(this.ratchetState.chainKeySend!));

      if (this.dc && this.dc.readyState === "open") {
        this.send(LIVE_MSG.RATCHET_INIT, this.ratchetState.dhSelf.publicKey);
        this.onLog("kizuna membrane sealed");
      }

      if (this.autoConfirm && this._state === "verifying") {
        this.confirmFingerprint();
      }
    } else {
      if (this.ratchetState) {
        await dhRatchetStep(this.ratchetState, peerRatchetPubKey);

        // both chain keys are now set after the DH step — init both loop states.
        await this.loopReinitFromChainKeys();
        this.onLog("kizuna membrane sealed");
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
        this.onLog("peer confirmed fingerprint");
        if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
        if (this.fingerprintNudgeTimer) { clearTimeout(this.fingerprintNudgeTimer); this.fingerprintNudgeTimer = null; }
        if (this._state === "verifying") {
          this.startHeartbeat();
          this.setState(this.transportMode === "silent" ? "silent" : "live");
        }
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
        if (this.onPeerTyping) this.onPeerTyping(bytes.length >= 2 ? bytes[1] : 0x00);
        break;
      case LIVE_MSG.ACK: {
        if (bytes.length >= 5 && this.onAck) {
          const msgId = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, true);
          this.onAck(msgId);
        }
        break;
      }
      case LIVE_MSG.CTRL: {
        const frame = decodeCtrl(bytes.subarray(1));
        if (frame) {
          if (this.onCtrl) this.onCtrl(frame.opcode, frame.payload);
          if (frame.opcode === CTRL_OP.DRAW_STREAM && this.onDrawStream) {
            const drawEvent = decodeDrawStreamEvent(frame.payload);
            if (drawEvent) this.onDrawStream(drawEvent);
          }
        }
        break;
      }
      default:
        this.onLog(`unknown message type: 0x${type.toString(16)}`);
    }
  }

  private async handleEncryptedMessage(wireData: Uint8Array): Promise<void> {
    const complete = this.assembler.feed(wireData);
    if (!complete) return; // Still waiting for more chunks

    if (!this.ratchetState) return;

    if (complete.length < HEADER_SIZE + 16) return; // header + minimum AES-GCM tag

    try {
      const header = parseHeader(complete);
      const pubKeyHex = toHex(header.pubKey);

      // try loop-derived skipped key first.
      // NOTE: structurally dead with ordered SCTP DataChannels, AND would be broken
      // even with unordered delivery — the loop codec is order-dependent (counts evolve
      // from message content), so loopDecode after a skip produces garbage. the AES-GCM
      // messageKey from the skip cache decrypts correctly, but decompression fails.
      // kept for defense-in-depth against hypothetical transport reordering.
      let messageKey = this.tryLoopSkippedKey(pubKeyHex, header.counter);
      let didDHRatchet = false;

      if (!messageKey) {
        // check if this is a new DH ratchet key
        if (pubKeyHex !== this.ratchetState.dhPeerHex) {
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
        await this.skipMessagesWithLoop(header.counter);

        if (!this.loopStateRecv) throw new Error("No receiving loop state");

        // derive this message's key via loopStep (advances chain, primes counts)
        const { next: nextLoopRecv, messageKey: mk } = await loopStep(this.loopStateRecv);
        loopWipe(this.loopStateRecv);
        this.loopStateRecv = nextLoopRecv;
        this.ratchetState.nRecv++;
        messageKey = mk;
      }

      const aad = complete.subarray(0, HEADER_SIZE);
      let compressedPayload: Uint8Array;
      try {
        compressedPayload = await aesGcmDecrypt(messageKey, header.ciphertext, header.nonce, aad);
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
      messageKey.fill(0); // wipe message key after use

      // decompress: first 4 bytes are decodedLen (LE uint32), rest is loop-encoded plaintext
      if (compressedPayload.length < 4) throw new Error("ciphertext too short");
      const decodedLen = new DataView(
        compressedPayload.buffer, compressedPayload.byteOffset,
      ).getUint32(0, true);
      const compressed = compressedPayload.subarray(4);

      if (!this.loopStateRecv) throw new Error("No receiving loop state after step");
      const { decoded: plaintext, next: afterDecode } = loopDecode(this.loopStateRecv, compressed, decodedLen);
      this.loopStateRecv = afterDecode;

      this.consecutiveDecryptFailures = 0; // reset on successful decrypt+decompress

      // Global msgId — must increment for ALL messages (incl. campfire) to mirror peer's nSentTotal.
      const msgId = this.nRecvTotal * 2 + (this.isOfferer ? 1 : 0);
      this.nRecvTotal++;

      const ackPayload = new Uint8Array(4);
      new DataView(ackPayload.buffer).setUint32(0, msgId, true);
      this.send(LIVE_MSG.ACK, ackPayload);

      const isCampfire = (header.flags & LIVE_FLAG.CAMPFIRE) !== 0;
      const isFile = (header.flags & LIVE_FLAG.FILE) !== 0;

      if (isCampfire && this.onRawDecrypted) {
        this.onRawDecrypted(plaintext);
        return;
      }

      if (isFile) {
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

  // reinitialize both loop states from the current ratchet chain keys.
  // called after each DH ratchet step to give the codec layer break-in recovery.
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
  // loop-derived message keys for potential out-of-order recovery.
  // with ordered SCTP DataChannels this loop body never executes in practice.
  private async skipMessagesWithLoop(until: number): Promise<void> {
    if (!this.ratchetState || !this.loopStateRecv) return;
    if (until - this.ratchetState.nRecv > 256) throw new Error("Too many skipped messages");
    const pubHex = this.ratchetState.dhPeerHex;
    while (this.ratchetState.nRecv < until) {
      const counter = this.ratchetState.nRecv;
      const { next: nextLoop, messageKey } = await loopStep(this.loopStateRecv);
      // store for possible out-of-order recovery (matches encryptAndSend's loopStep-derived keys)
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
    this.send(LIVE_MSG.TYPING, new Uint8Array([state]));
  }

  /** Send a control frame to the peer. */
  sendCtrl(opcode: number, payload?: Uint8Array): void {
    if (!this.isLiveState()) return;
    this.send(LIVE_MSG.CTRL, encodeCtrl(opcode, payload));
  }

  /** Send a live draw stream event to the peer over CTRL transport. */
  sendDrawStream(event: Omit<DrawStreamEvent, "seq">): void {
    if (!this.isLiveState()) return;
    const fullEvent = { ...event, seq: this.nextDrawStreamSeq++ } as DrawStreamEvent;
    const payload = encodeDrawStreamEvent(fullEvent);
    this.send(LIVE_MSG.CTRL, encodeCtrl(CTRL_OP.DRAW_STREAM, payload));
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

  /** Enqueue a send job — serializes through sendQueue so ratchet state is never concurrent. */
  private enqueueSend(job: () => Promise<void>): Promise<void> {
    const wrapped = () => job().catch((err) => {
      const msg = errorMessage(err);
      this.onLog(`send failed: ${msg}`);
      this.onMessage({ type: "system", direction: "system", text: `message not sent: ${msg}`, timestamp: Date.now() });
    });
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

  async sendFile(file: File): Promise<number> {
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
    });
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

    const nonce = randomBytes(12);
    const counter = this.ratchetState.nSend;
    const prevChainLen = this.ratchetState.prevChainLength;

    const header = buildHeader(
      flags,
      this.ratchetState.dhSelf.publicKey,
      counter,
      prevChainLen,
      nonce,
    );

    const ciphertext = await aesGcmEncrypt(messageKey, compressedPayload, nonce, header);
    messageKey.fill(0); // wipe message key after use

    const wireMessage = concatBytes(header, ciphertext);

    if (this.ratchetState.nSend >= 0xFFFFFFFF) {
      throw new Error("Message counter exhausted — session must be restarted");
    }
    this.ratchetState.nSend++;

    const totalBytes = estimateChunkedPrefixedSize(wireMessage.length);
    let bytesSent = 0;
    let lastProgressEmit = 0;
    for (const chunk of iterateChunksPrefixed(wireMessage, LIVE_MSG.ENCRYPTED)) {
      if (this.dc.bufferedAmount > BUFFERED_AMOUNT_LOW) {
        try { await this.waitForDrain(); } catch { return msgId; } // channel closed during drain
      }
      if (!this.dc || this.dc.readyState !== "open") return msgId;
      // Send chunk directly (Uint8Array is a valid BufferSource).
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
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
    if (this.fingerprintNudgeTimer) { clearTimeout(this.fingerprintNudgeTimer); this.fingerprintNudgeTimer = null; }
    this.send(LIVE_MSG.FINGERPRINT_CONFIRMED);
    this.startHeartbeat();
    this.setState(this.transportMode === "silent" ? "silent" : "live");
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

  /** Get the shared secret as a hex string for Silent mode (use as Whisper solo password). */
  getSharedSecret(): string | null {
    if (!this.sharedSecret) return null;
    return toHex(this.sharedSecret);
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

    this.sharedPhrase = null;
    this.consecutiveDecryptFailures = 0;
    this.assembler.reset();

    if (this.recoveryResolve) {
      const resolve = this.recoveryResolve;
      this.recoveryResolve = null;
      resolve();
    }

    this.ephPrivateKey = null;
    this.keyReady = Promise.resolve();
  }
}
