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
 *   - HMAC-SHA256 symmetric chain ratchet + HKDF root chain ratchet
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
import { sdpToCode, codeToSdp } from "./live-sdp";

import {
  type RatchetState,
  generateDHKeyPair,
  dhRatchetStep,
  initRatchetAsOfferer,
  initRatchetAsReceiver,
  kdfChain,
  skipMessageKeys,
  trySkippedKey,
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
  chunkMessagePrefixed,
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
  /** Peer is actively typing. Fires at most once per ~3s. UI should auto-clear after ~4s of silence. */
  onPeerTyping?: () => void;
  /** A message we sent was successfully decrypted by the peer. Counter identifies which message. */
  onAck?: (counter: number) => void;
  /** Progress during chunked send (file transfers). */
  onSendProgress?: (bytesSent: number, totalBytes: number) => void;
  /** Periodic connection quality stats (fires each heartbeat cycle). */
  onConnectionStats?: (stats: ConnectionStats) => void;
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
}

/* ── Visual Fingerprint ──── */

const FINGERPRINT_EMOJI = [
  "\u{1F30A}", // wave
  "\u{1F98A}", // fox
  "\u{1F525}", // fire
  "\u{2B50}",  // star
  "\u{1F343}", // leaf
  "\u{1F312}", // moon
  "\u{26A1}",  // lightning
  "\u{2744}\uFE0F",  // snowflake
  "\u{1F338}", // cherry blossom
  "\u{1F40B}", // whale
  "\u{1F987}", // bat
  "\u{1F426}", // bird
  "\u{1F98B}", // butterfly
  "\u{1F41A}", // shell
  "\u{1F340}", // four leaf clover
  "\u{1F30B}", // volcano
  "\u{1F30C}", // milky way
  "\u{1F300}", // cyclone
  "\u{1F308}", // rainbow
  "\u{2602}\uFE0F",  // umbrella
  "\u{1F30D}", // globe
  "\u{1F3D4}\uFE0F",  // mountain
  "\u{1F3DD}\uFE0F",  // island
  "\u{1F335}", // cactus
  "\u{1F344}", // mushroom
  "\u{1F33B}", // sunflower
  "\u{1F334}", // palm
  "\u{1F333}", // deciduous tree
  "\u{1F47B}", // ghost
  "\u{1F3AD}", // performing arts
  "\u{1F52E}", // crystal ball
  "\u{1F3B2}", // dice
  "\u{1F511}", // key
  "\u{1F6E1}\uFE0F",  // shield
  "\u{2693}",  // anchor
  "\u{1FA90}", // ringed planet
  "\u{1F9CA}", // ice
  "\u{1F40C}", // snail
  "\u{1F9A5}", // sloth
  "\u{1F995}", // sauropod
  "\u{1F3AF}", // dart
  "\u{1F3B5}", // music note
  "\u{1F9E9}", // puzzle piece
  "\u{1F52D}", // telescope
  "\u{2699}\uFE0F",  // gear
  "\u{1F9ED}", // compass
  "\u{1F3F3}\uFE0F",  // white flag
  "\u{1F54A}\uFE0F",  // dove
  "\u{1F985}", // eagle
  "\u{1F989}", // owl
  "\u{1F99C}", // parrot
  "\u{1F409}", // dragon
  "\u{1F984}", // unicorn
  "\u{1F9A0}", // microbe
  "\u{1F30E}", // globe americas
  "\u{1F319}", // crescent moon
  "\u{2604}\uFE0F",  // comet
  "\u{1F30F}", // globe asia
  "\u{1F311}", // new moon
  "\u{1F315}", // full moon
  "\u{1F4A0}", // diamond with dot
  "\u{1F4AB}", // dizzy
  "\u{1F329}\uFE0F",  // cloud lightning
  "\u{1F32A}\uFE0F",  // tornado
];

const PHRASE_KDF_INFO = TE.encode("whisper-live-keyed");
const ZERO_SALT_32 = new Uint8Array(32);

async function deriveFingerprint(sharedSecret: Uint8Array): Promise<string> {
  const hash = await sha256(concatBytes(TE.encode("whisper-fp-v1"), sharedSecret));
  return Array.from(hash.subarray(0, 4))
    .map((b) => FINGERPRINT_EMOJI[b % FINGERPRINT_EMOJI.length])
    .join("");
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
    { urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302",
    ] },
  ],
  iceCandidatePoolSize: 2,
};

// Timeout for ICE gathering (ms)
const ICE_GATHER_TIMEOUT = 8000;

const HEARTBEAT_INTERVAL = 15_000;        // send ping every 15s
const HEARTBEAT_TIMEOUT  = 45_000;        // drop peer after 45s silence

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
} as const;

const LIVE_FLAG = {
  FILE: 0x01,
  CAMPFIRE: 0x02,
} as const;

function errorMessage(err: unknown, fallback = "unknown"): string {
  return err instanceof Error ? err.message : fallback;
}

const VALID_TRANSITIONS: Record<LiveState, readonly LiveState[]> = {
  "idle":               ["offering", "answering", "error"],
  "offering":           ["waiting-for-answer", "error", "disconnected"],
  "waiting-for-answer": ["connecting", "error", "disconnected"],
  "answering":          ["connecting", "error", "disconnected"],
  "connecting":         ["handshaking", "error", "disconnected"],
  "handshaking":        ["verifying", "error", "disconnected"],
  "verifying":          ["live", "silent", "error", "disconnected"],
  "live":               ["silent", "recovering", "disconnected", "error"],
  "silent":             ["live", "recovering", "disconnected", "error"],
  "recovering":         ["live", "silent", "disconnected", "error"],
  "disconnected":       ["idle"],
  "error":              ["idle"],
};

export class WhisperLiveSession {
  private _state: LiveState = "idle";
  private _destroyed = false;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ratchetState: RatchetState | null = null;
  private sharedSecret: Uint8Array | null = null;
  private sharedPhrase: string | null = "";
  private transportMode: TransportMode = "naked";
  private assembler = new ChunkAssembler();
  private engine: WhisperEngine | null = null;
  private isOfferer = false;

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

  // Tab-aware heartbeat
  private tabHidden = false;
  private visibilityHandler: (() => void) | null = null;

  // Connection stats polling
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  // Recovery send queue — holds jobs until session returns to live
  private recoveryResolve: (() => void) | null = null;

  private rtcConfig: RTCConfiguration;

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

    this.rtcConfig = options.rtcConfig ?? WHISPER_LIVE_RTC_LOCAL_ONLY;
    this.externalAssistEstablishmentOnly = options.externalAssistEstablishmentOnly ?? true;
    this.autoConfirm = options.autoConfirmFingerprint ?? false;
  }

  private hasExternalAssistConfigured(): boolean {
    const servers = this.rtcConfig.iceServers;
    return Array.isArray(servers) && servers.length > 0;
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
      this.onLog("external assist disabled. continuing local-only");
    } catch (err) {
      this.onLog(`external assist disable failed: ${errorMessage(err)}`);
    }
  }

  get state(): LiveState { return this._state; }

  private setState(state: LiveState, detail?: string): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.includes(state)) {
      this.onLog(`blocked transition ${this._state} → ${state}`);
      return;
    }
    this._state = state;
    this.onStateChange(state, detail);
    // Flush recovery queue when session resumes
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
    this.connectingGraceDone = false;
    this.sharedPhrase = sharedPhrase ?? "";
    this.isOfferer = asOfferer;
  }

  /** Peer A: create an offer code. */
  async createOffer(sharedPhrase?: string): Promise<string> {
    this.initSession(sharedPhrase, true);
    this.setState("offering");
    this.onLog("creating offer...");

    this.pc = new RTCPeerConnection(this.rtcConfig);

    this.setupPeerConnection(this.pc);

    this.dc = this.pc.createDataChannel("whisper", {
      ordered: true,
    });
    this.setupDataChannel(this.dc);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    // Wait for ICE gathering
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

    // Connection established via DataChannel open event (set up in setupDataChannel)
  }

  /** Peer B: accept an offer code, return an answer code. */
  async acceptOffer(offerCode: string, sharedPhrase?: string): Promise<string> {
    this.initSession(sharedPhrase, false);
    this.setState("answering");
    this.onLog("accepting offer code...");

    const offerSDP = await codeToSdp(offerCode, "offer", this.sharedPhrase || undefined);

    this.pc = new RTCPeerConnection(this.rtcConfig);
    this.setupPeerConnection(this.pc);

    // Listen for incoming data channel
    this.pc.ondatachannel = (event) => {
      this.dc = event.channel;
      this.setupDataChannel(this.dc);
    };

    // Set remote description (offer)
    await this.pc.setRemoteDescription({ type: "offer", sdp: offerSDP });

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    // Wait for ICE
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
        this.onLog(`gathered ${types.length} candidate(s): ${types.join(", ") || "none"}`);
        if (!types.includes("srflx") && this.hasExternalAssistConfigured())
          this.onLog("warning: no server-reflexive candidates — STUN may be blocked");
        if (types.length === 0)
          this.onLog("warning: no candidates gathered — connection will likely fail");
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
        this.onLog("candidate gathering timed out, proceeding with what we have");
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
    this.onLog("ICE failed during setup, waiting for peer to complete exchange...");

    // Periodically nudge the browser to retry ICE checks. When the peer
    // finally applies our code, their ICE agent starts sending binding
    // requests. Our side needs to be actively checking too. Re-applying
    // the existing remote description re-arms the ICE agent to process
    // new incoming connectivity checks from the peer.
    this.iceRetryInterval = setInterval(() => {
      if (!this.pc) return;
      const s = this.pc.iceConnectionState;
      if (s === "connected" || s === "completed") {
        if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
        return;
      }
      if (s === "failed" || s === "disconnected") {
        this.onLog(`ICE still ${s}, waiting for peer...`);
        // Re-apply remote description to re-arm ICE agent. This makes the
        // browser reconsider existing candidate pairs that may now work
        // because the peer has finally applied our offer/answer.
        const rd = this.pc.remoteDescription;
        if (rd) {
          this.pc.setRemoteDescription(rd).catch(() => {});
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
      this.onLog(`connection failed after grace period (ICE: ${iceState})`);
      this.setState("error", "Connection failed — peer may be unreachable. Make sure both sides have external assist enabled if connecting across networks.");
      this.cleanupConnection();
    }, HEARTBEAT_TIMEOUT);
  }

  private setupPeerConnection(pc: RTCPeerConnection): void {
    // Log every ICE candidate for debugging
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const c = event.candidate;
        this.onLog(`ICE candidate: ${c.type ?? "?"} ${c.protocol ?? "?"} ${c.address ?? "?"}:${c.port ?? "?"}`);
      } else {
        this.onLog("ICE gathering complete");
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      this.onLog(`ICE: ${s}`);

      if (s === "checking") {
        // Normal — ICE is probing candidates. Nothing to do.
        return;
      }

      if (s === "disconnected") {
        // During live sessions, enter recovery grace period instead of instant disconnect
        if (this.isLiveState()) {
          this.stateBeforeRecovery = this._state;
          this.setState("recovering");
          this.onLog("connection interrupted, attempting recovery...");
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;
            if (this._state === "recovering") {
              this.onLog("recovery timeout, peer unreachable");
              this.setState("disconnected");
              this.cleanupConnection();
            }
          }, HEARTBEAT_TIMEOUT);
        } else if (this._state !== "recovering") {
          // Pre-live states: expected during out-of-band code exchange, just log
          this.onLog("connection interrupted during setup (expected while exchanging codes)");
        }
        return;
      }

      if (s === "failed") {
        // During active sessions, attempt one ICE restart before giving up
        if ((this.isLiveState() || this._state === "recovering") && !this.iceRestartAttempted) {
          this.iceRestartAttempted = true;
          this.onLog("connection failed, attempting restart...");
          if (this._state !== "recovering") {
            this.stateBeforeRecovery = this._state as "live" | "silent";
            this.setState("recovering");
          }
          this.attemptIceRestart(pc);
        } else if (this.isSetupState()) {
          // During setup: ICE fails because the other side hasn't applied our
          // answer/offer yet. This is normal for manual code exchange — start
          // a grace period to wait for the peer to catch up.
          this.startConnectingGrace(pc);
        } else {
          this.onLog("connection failed, could not reach peer");
          this.setState("error", "Connection failed, peer may be unreachable");
          this.cleanupConnection();
        }
        return;
      }

      if (s === "connected" || s === "completed") {
        this.onLog(s === "completed" ? "connection fully established" : "connected to peer");
        this.iceRestartAttempted = false;
        if (this.connectingGraceTimer) { clearTimeout(this.connectingGraceTimer); this.connectingGraceTimer = null; }
        if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
        this.connectingGraceDone = false;
        // Only strip STUN once we're past setup — during setup the srflx
        // candidates still need STUN keepalives to maintain NAT bindings.
        if (!this.isSetupState()) this.dropExternalAssist(pc);
        // Recover from transient disruption
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
      this.onLog(`conn: ${s}`);
      if (s === "connected") {
        // Some browsers stabilize connectionState before ICE emits completed.
        if (!this.isSetupState()) this.dropExternalAssist(pc);
      }
      if (s === "failed") {
        // If we're already recovering (ICE restart in flight), let the ICE handler manage it
        if (this._state === "recovering") return;
        // During setup: ICE failure is expected, grace period handles it
        if (this.connectingGraceTimer) return;
        if (this.isSetupState()) {
          // Start grace if not already started (connectionState can fire before iceConnectionState)
          this.startConnectingGrace(pc);
          return;
        }
        this.onLog("connection to peer failed");
        this.setState("error", "Connection failed");
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
        .then(() => this.onLog("restart offer sent"))
        .catch((err) => {
          this.onLog(`restart failed: ${errorMessage(err)}`);
          this.setState("disconnected");
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
      // Establishment is complete at this point (DTLS/SCTP ready). If external assist was
      // enabled, drop it now so the rest of the session stays local-only.
      if (this.pc) this.dropExternalAssist(this.pc);
      this.setState("handshaking");
      // Start handshake timeout — if fingerprint not confirmed within HEARTBEAT_TIMEOUT, abort
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        if (this._state === "handshaking" || this._state === "verifying") {
          this.onLog("handshake timeout, key exchange took too long");
          this.setState("error", "Handshake timed out");
          this.cleanupConnection();
        }
      }, HEARTBEAT_TIMEOUT);
      this.performKeyExchange();
    };

    dc.onclose = () => {
      if (this.isLiveState() ||
          this._state === "recovering" ||
          this._state === "verifying" || this._state === "handshaking") {
        this.onLog("peer disconnected");
        this.setState("disconnected");
        this.cleanupConnection();
      }
    };

    dc.onerror = (event) => {
      const msg = (event as ErrorEvent).message ?? "unknown";
      this.onLog(`channel error: ${msg}`);
      // During setup phases, treat as fatal; during live, let heartbeat handle it
      if (this._state === "handshaking" || this._state === "connecting") {
        this.setState("error", `Connection error: ${msg}`);
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
        this.onLog("sending public key");
        if (!this.dc || this.dc.readyState !== "open") {
          this.onLog("key exchange aborted, channel not available");
          return;
        }
        this.send(LIVE_MSG.KEY_EXCHANGE, pubKeyRaw);

        this.ephPrivateKey = keyPair.privateKey;
      } catch (err) {
        this.onLog(`key exchange failed: ${errorMessage(err, "unknown error")}`);
        this.setState("error", "Key exchange failed");
      }
    })();
  }

  private async handleKeyExchangeMessage(peerPubKeyRaw: Uint8Array): Promise<void> {
    if (this._state !== "handshaking") {
      this.onLog("ignoring key exchange message, not in handshaking state");
      return;
    }
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

      this.onLog("shared secret derived");

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
        this.onLog("shared phrase mixed into key derivation");
      } else {
        this.sharedPhrase = null;
      }

      this.sharedSecret = sharedSecret;

      const fingerprint = await deriveFingerprint(sharedSecret);
      this.onLog(`fingerprint: ${fingerprint}`);
      this.onFingerprint(fingerprint);

      if (this.isOfferer) {
        const dhSelf = await generateDHKeyPair();
        this.ratchetState = await initRatchetAsOfferer(sharedSecret, dhSelf);

        if (this.dc && this.dc.readyState === "open") {
          this.send(LIVE_MSG.RATCHET_INIT, dhSelf.publicKey);
          this.onLog("sent initial ratchet key");
        }
      }

      this.setState("verifying");

      // Auto-confirm for programmatic connections (Campfire neighbor links)
      // Offerer can confirm immediately (ratchet already initialized above).
      // Answerer must wait for RATCHET_INIT from offerer (handled in handleRatchetInit).
      if (this.autoConfirm && this.isOfferer) {
        this.confirmFingerprint();
      }
    } catch (err) {
      this.onLog(`key derivation failed: ${errorMessage(err, "unknown error")}`);
      this.setState("error", "Key derivation failed");
    }
  }

  private async handleRatchetInit(peerRatchetPubKey: Uint8Array): Promise<void> {
    if (this._state !== "handshaking" && this._state !== "verifying") {
      this.onLog("ignoring ratchet init, not in expected state");
      return;
    }
    if (!this.sharedSecret) return;

    if (!this.isOfferer) {
      this.ratchetState = await initRatchetAsReceiver(this.sharedSecret, peerRatchetPubKey);

      if (this.dc && this.dc.readyState === "open") {
        this.send(LIVE_MSG.RATCHET_INIT, this.ratchetState.dhSelf.publicKey);
        this.onLog("encryption ratchet initialized, keys exchanged");
      }

      if (this.autoConfirm && this._state === "verifying") {
        this.confirmFingerprint();
      }
    } else {
      if (this.ratchetState) {
        await dhRatchetStep(this.ratchetState, peerRatchetPubKey);
        this.onLog("encryption ratchet initialized, received peer key");
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
      case LIVE_MSG.KEY_EXCHANGE: // Key exchange
        await this.handleKeyExchangeMessage(bytes.subarray(1));
        break;
      case LIVE_MSG.RATCHET_INIT: // Ratchet init
        await this.handleRatchetInit(bytes.subarray(1));
        break;
      case LIVE_MSG.ENCRYPTED: // Encrypted message
        await this.handleEncryptedMessage(bytes.subarray(1));
        break;
      case LIVE_MSG.FINGERPRINT_CONFIRMED: // Fingerprint confirmed
        this.onLog("peer confirmed fingerprint");
        if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
        if (this._state === "verifying") {
          this.startHeartbeat();
          this.setState(this.transportMode === "silent" ? "silent" : "live");
        }
        break;
      case LIVE_MSG.FINGERPRINT_REJECTED: // Fingerprint rejected
        this.onLog("peer rejected fingerprint, aborting");
        this.setState("error", "Peer rejected fingerprint, possible interception");
        this.cleanupConnection();
        break;
      case LIVE_MSG.PING: // Ping — peer is alive, reply with pong
        this.lastPongReceived = Date.now();
        this.send(LIVE_MSG.PONG);
        break;
      case LIVE_MSG.PONG: // Pong — peer acknowledged our ping
        this.lastPongReceived = Date.now();
        break;
      case LIVE_MSG.TYPING:
        if (this.onPeerTyping) this.onPeerTyping();
        break;
      case LIVE_MSG.ACK: {
        if (bytes.length >= 5 && this.onAck) {
          const counter = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, true);
          this.onAck(counter);
        }
        break;
      }
      default:
        this.onLog(`unknown message type: 0x${type.toString(16)}`);
    }
  }

  private async handleEncryptedMessage(wireData: Uint8Array): Promise<void> {
    // Reassemble chunks
    const complete = this.assembler.feed(wireData);
    if (!complete) return; // Still waiting for more chunks

    if (!this.ratchetState) {
      this.onLog("received message but ratchet not initialized");
      return;
    }

    if (complete.length < HEADER_SIZE + 16) { // header + minimum AES-GCM tag
      this.onLog("received message too short, dropped");
      return;
    }

    try {
      const header = parseHeader(complete);
      const pubKeyHex = toHex(header.pubKey);

      // Try skipped keys first
      let messageKey = trySkippedKey(this.ratchetState, pubKeyHex, header.counter);
      let didDHRatchet = false;

      if (!messageKey) {
        // Check if this is a new DH ratchet key
        if (pubKeyHex !== this.ratchetState.dhPeerHex) {
          // New DH ratchet — skip any remaining messages in current chain
          if (this.ratchetState.chainKeyRecv) {
            await skipMessageKeys(this.ratchetState, header.prevChainLen);
          }
          await dhRatchetStep(this.ratchetState, header.pubKey);
          didDHRatchet = true;
        }

        await skipMessageKeys(this.ratchetState, header.counter);

        if (!this.ratchetState.chainKeyRecv) throw new Error("No receiving chain key");
        const oldRecvChainKey = this.ratchetState.chainKeyRecv;
        const [newChainKey, mk] = await kdfChain(oldRecvChainKey);
        oldRecvChainKey.fill(0); // wipe old chain key
        this.ratchetState.chainKeyRecv = newChainKey;
        this.ratchetState.nRecv++;
        messageKey = mk;
      }

      const aad = complete.subarray(0, HEADER_SIZE);
      let plaintext: Uint8Array;
      try {
        plaintext = await aesGcmDecrypt(messageKey, header.ciphertext, header.nonce, aad);
      } catch (decryptErr) {
        messageKey.fill(0);
        // If a DH ratchet step was performed and decrypt still fails, the ratchet
        // is structurally broken (mismatched keys). Deterministic — disconnect.
        if (didDHRatchet) {
          this.onLog("decryption failed, encryption state unrecoverable. disconnecting");
          this.setState("error", "Encryption desync, session cannot recover");
          this.cleanupConnection();
          return;
        }
        throw decryptErr;
      }
      messageKey.fill(0); // wipe message key after use

      // ACK: tell sender we decrypted this message successfully
      const ackPayload = new Uint8Array(4);
      new DataView(ackPayload.buffer).setUint32(0, header.counter, true);
      this.send(LIVE_MSG.ACK, ackPayload);

      const isCampfire = (header.flags & LIVE_FLAG.CAMPFIRE) !== 0;
      const isFile = (header.flags & LIVE_FLAG.FILE) !== 0;

      // Campfire messages: delegate to raw callback instead of processing as text/file
      if (isCampfire && this.onRawDecrypted) {
        this.onRawDecrypted(plaintext);
        return;
      }

      if (isFile) {
        const { fileName, fileType, fileBytes } = decodeFilePlaintext(plaintext);
        this.onMessage({
          type: "file",
          direction: "peer",
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
          text: TD.decode(plaintext),
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.onLog(`decrypt failed: ${errorMessage(err)}`);
    }
  }

  /* ── Sending ────────────────────────────────────────────── */

  /** Signal that we're actively typing. Callers should debounce (~3s). */
  sendTyping(): void {
    if (!this.isLiveState()) return;
    this.send(LIVE_MSG.TYPING);
  }

  /** Wait for recovery to complete before sending. Returns false if destroyed. */
  private isLiveState(): boolean {
    return this.isLiveState();
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
      this.onLog(`send failed: ${errorMessage(err)}`);
    });
    this.sendQueue = this.sendQueue.then(wrapped);
    return this.sendQueue;
  }

  async sendText(text: string): Promise<void> {
    await this.enqueueSend(async () => {
      if (this._state === "recovering") {
        if (!await this.waitForRecovery()) return;
      }
      if (!this.isLiveState() || !this.dc || !this.ratchetState) return;
      await this.encryptAndSend(TE.encode(text), 0x00);
      this.onMessage({ type: "text", direction: "self", text, timestamp: Date.now() });
    });
  }

  async sendFile(file: File): Promise<void> {
    const fileBytes = new Uint8Array(await file.arrayBuffer());

    await this.enqueueSend(async () => {
      if (this._state === "recovering") {
        if (!await this.waitForRecovery()) return;
      }
      if (!this.isLiveState() || !this.dc || !this.ratchetState) return;

      if (this.transportMode === "dressed") {
        await this.sendFileDressed(file.name, file.type, fileBytes);
        return;
      }

      const plaintext = encodeFilePlaintext(file.name, file.type, fileBytes);
      await this.encryptAndSend(plaintext, LIVE_FLAG.FILE);
      this.onMessage({
        type: "file", direction: "self",
        fileName: file.name, fileSize: fileBytes.length, fileType: file.type,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Send arbitrary plaintext through the encrypted channel with custom flags.
   * Used by CampfireNode to send campfire-typed messages through pairwise channels.
   */
  async sendEncryptedRaw(plaintext: Uint8Array, flags: number): Promise<void> {
    await this.enqueueSend(async () => {
      if (this._state === "recovering") {
        if (!await this.waitForRecovery()) return;
      }
      if (!this.isLiveState() || !this.dc || !this.ratchetState) return;
      await this.encryptAndSend(plaintext, flags);
    });
  }

  private async sendFileDressed(
    fileName: string, fileType: string, fileBytes: Uint8Array,
  ): Promise<void> {
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
      await this.encryptAndSend(plaintext, LIVE_FLAG.FILE);

      this.onMessage({
        type: "file",
        direction: "self",
        fileName: result.outputName,
        fileSize: dressedBytes.length,
        fileType: result.outputType,
        timestamp: Date.now(),
      });

      this.onLog(`sent ${fileName} (embedded in carrier)`);
    } catch (err) {
      this.onLog(`steganography failed, sending directly: ${errorMessage(err)}`);
      await this.encryptAndSend(encodeFilePlaintext(fileName, fileType, fileBytes), LIVE_FLAG.FILE);
      this.onMessage({ type: "file", direction: "self", fileName, fileSize: fileBytes.length, fileType, timestamp: Date.now() });
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

  private async encryptAndSend(plaintext: Uint8Array, flags: number): Promise<void> {
    if (!this.ratchetState || !this.dc) return;

    if (!this.ratchetState.chainKeySend) {
      throw new Error("No sending chain, ratchet not fully initialized");
    }

    const oldSendChainKey = this.ratchetState.chainKeySend;
    const [newChainKey, messageKey] = await kdfChain(oldSendChainKey);
    oldSendChainKey.fill(0); // wipe old chain key
    this.ratchetState.chainKeySend = newChainKey;

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

    const ciphertext = await aesGcmEncrypt(messageKey, plaintext, nonce, header);
    messageKey.fill(0); // wipe message key after use

    const wireMessage = concatBytes(header, ciphertext);

    this.ratchetState.nSend++;

    const chunks = chunkMessagePrefixed(wireMessage, LIVE_MSG.ENCRYPTED);
    const totalBytes = wireMessage.length;
    let bytesSent = 0;
    for (const chunk of chunks) {
      if (this.dc.bufferedAmount > BUFFERED_AMOUNT_LOW) {
        try { await this.waitForDrain(); } catch { return; } // channel closed during drain
      }
      if (!this.dc || this.dc.readyState !== "open") return;
      const ab = new ArrayBuffer(chunk.byteLength);
      new Uint8Array(ab).set(chunk);
      this.dc.send(ab);
      bytesSent += chunk.byteLength;
      if (this.onSendProgress) this.onSendProgress(bytesSent, totalBytes);
    }
  }

  /* ── Trust ──────────────────────────────────────────────── */

  confirmFingerprint(): void {
    if (this._state !== "verifying") return;

    // Cancel handshake timeout
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }

    // Notify peer
    this.send(LIVE_MSG.FINGERPRINT_CONFIRMED);
    this.onLog("fingerprint confirmed, session is live");
    this.startHeartbeat();

    if (this.transportMode === "silent") {
      this.setState("silent");
    } else {
      this.setState("live");
    }
  }

  rejectFingerprint(): void {
    if (this._state !== "verifying") return;

    this.send(LIVE_MSG.FINGERPRINT_REJECTED);
    this.onLog("fingerprint rejected, aborting connection");
    this.setState("error", "Fingerprint mismatch, possible interception");
    this.cleanupConnection();
  }

  /* ── Transport ──────────────────────────────────────────── */

  setTransport(mode: TransportMode): void {
    this.transportMode = mode;
    this.onLog(`switched to ${mode} mode`);

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
    this.onLog("disconnecting, clearing session");
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
        this.setState("disconnected");
        this.cleanupConnection();
      }
    }, HEARTBEAT_INTERVAL);

    // Tab visibility — avoid false-positive timeouts when backgrounded
    this.visibilityHandler = () => {
      this.tabHidden = document.hidden;
      if (!document.hidden) {
        // Returning to foreground: bump lastPong so we don't immediately timeout
        this.lastPongReceived = Math.max(this.lastPongReceived, Date.now() - HEARTBEAT_TIMEOUT + 5_000);
        this.send(LIVE_MSG.PING);
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);

    // Connection stats polling
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
    clr(this.recoveryTimer); this.recoveryTimer = null;
    clr(this.connectingGraceTimer); this.connectingGraceTimer = null;
    if (this.iceRetryInterval) { clearInterval(this.iceRetryInterval); this.iceRetryInterval = null; }
    this.connectingGraceDone = false;
    this.stateBeforeRecovery = null;
    this.iceRestartAttempted = false;
    this.externalAssistDropped = false;

    // Detach handlers before close — prevents pc.close() from firing
    // oniceconnectionstatechange / onconnectionstatechange during teardown
    const dc = this.dc;
    const pc = this.pc;
    this.dc = null;
    this.pc = null;

    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onerror = null;
      dc.onmessage = null;
      try { dc.close(); } catch { /* ignore */ }
    }

    if (pc) {
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.ondatachannel = null;
      try { pc.close(); } catch { /* ignore */ }
    }

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
