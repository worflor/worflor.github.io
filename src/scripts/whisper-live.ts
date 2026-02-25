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
} from "./whisper-wasm";
import {
  TE,
  TD,
  hkdf,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from "./whisper-live-crypto";
import { sdpToCode, codeToSdp } from "./whisper-live-sdp";

import {
  type RatchetState,
  generateDHKeyPair,
  dhRatchetStep,
  initRatchetAsOfferer,
  initRatchetAsReceiver,
  kdfChain,
  skipMessageKeys,
  trySkippedKey,
} from "./whisper-live-ratchet";

import {
  HEADER_SIZE,
  buildHeader,
  parseHeader,
  encodeFilePlaintext,
  decodeFilePlaintext,
} from "./whisper-live-wire";

import {
  BUFFERED_AMOUNT_LOW,
  chunkMessagePrefixed,
  ChunkAssembler,
} from "./whisper-live-chunking";

import { createMinimalPNGCarrier } from "./whisper-live-carrier";

/* ═══════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════ */

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

export interface WhisperLiveCallbacks {
  onStateChange: (state: LiveState, detail?: string) => void;
  onFingerprint: (emoji: string) => void;
  onMessage: (msg: LiveMessage) => void;
  onLog: (line: string) => void;
  /** When set and flags & 0x02 (campfire bit), decrypted plaintext is forwarded here instead of onMessage. */
  onRawDecrypted?: (plaintext: Uint8Array) => void;
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

/* ═══════════════════════════════════════════════════════════════════
   Visual Fingerprint
   ═══════════════════════════════════════════════════════════════════ */

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

/* Pre-encoded constants — avoids per-call TextEncoder allocations */
const FP_PREFIX = TE.encode("whisper-fp-v1");
const PHRASE_PREFIX = "whisper-phrase|";
const PHRASE_KDF_INFO = TE.encode("whisper-live-keyed");
const ZERO_SALT_32 = new Uint8Array(32);

async function deriveFingerprint(sharedSecret: Uint8Array): Promise<string> {
  const hash = await sha256(concatBytes(FP_PREFIX, sharedSecret));
  return Array.from(hash.subarray(0, 4))
    .map((b) => FINGERPRINT_EMOJI[b % FINGERPRINT_EMOJI.length])
    .join("");
}

/* ═══════════════════════════════════════════════════════════════════
   WhisperLiveSession
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Default: local-only ICE.
 * This prevents accidental metadata leakage to public STUN servers.
 * Users can opt-in to STUN via UI/URL wiring by passing `rtcConfig`.
 */
export const WHISPER_LIVE_RTC_LOCAL_ONLY: RTCConfiguration = {
  iceServers: [],
};

/** Legacy/compat STUN config (opt-in). */
export const WHISPER_LIVE_RTC_PUBLIC_STUN: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
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

  private rtcConfig: RTCConfiguration;

  constructor(callbacks: WhisperLiveCallbacks, options: WhisperLiveSessionOptions = {}) {
    this.onStateChange = callbacks.onStateChange;
    this.onFingerprint = callbacks.onFingerprint;
    this.onMessage = callbacks.onMessage;
    this.onLog = callbacks.onLog;
    this.onRawDecrypted = callbacks.onRawDecrypted;

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
        this.log("external assist could not be disabled. setConfiguration unavailable");
        return;
      }

      const current = (typeof pc.getConfiguration === "function") ? pc.getConfiguration() : {};
      pc.setConfiguration({ ...current, iceServers: [] });
      this.log("external assist disabled. continuing local-only");
    } catch (err) {
      this.log(`external assist disable failed: ${errorMessage(err)}`);
    }
  }

  get state(): LiveState { return this._state; }

  private setState(state: LiveState, detail?: string): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.includes(state)) {
      this.log(`blocked transition ${this._state} → ${state}`);
      return;
    }
    this._state = state;
    this.onStateChange(state, detail);
  }

  private log(line: string): void {
    this.onLog(line);
  }

  private sendControlByte(type: number): void {
    if (this.dc?.readyState !== "open") return;
    this.dc.send(new Uint8Array([type]));
  }

  private sendPrefixed(type: number, payload: Uint8Array): void {
    if (this.dc?.readyState !== "open") return;
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = type;
    msg.set(payload, 1);
    this.dc.send(msg);
  }

  /* ── Offer/Answer Lifecycle ─────────────────────────────── */

  /** Peer A: create an offer code. */
  async createOffer(sharedPhrase?: string): Promise<string> {
    this._destroyed = false;
    this.externalAssistDropped = false;
    this.sharedPhrase = sharedPhrase ?? "";
    this.isOfferer = true;
    this.setState("offering");
    this.log("creating offer...");

    this.pc = new RTCPeerConnection(this.rtcConfig);

    this.setupPeerConnection(this.pc);

    // Create data channel
    this.dc = this.pc.createDataChannel("whisper", {
      ordered: true,
    });
    this.setupDataChannel(this.dc);

    // Create offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    // Wait for ICE gathering
    this.log("gathering network candidates...");
    await this.waitForICE();

    const code = await sdpToCode(this.pc.localDescription!.sdp, "offer", this.sharedPhrase || undefined);

    this.log(`offer code ready${this.sharedPhrase ? " (sealed)" : ""}`);
    this.setState("waiting-for-answer");

    return code;
  }

  /** Peer A: apply the answer code from Peer B. */
  async applyAnswer(answerCode: string): Promise<void> {
    if (!this.pc) throw new Error("No connection, create offer first");

    this.log("applying answer code...");
    const sdp = await codeToSdp(answerCode, "answer", this.sharedPhrase || undefined);
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    this.setState("connecting");
    this.log("connecting peer-to-peer...");

    // Connection established via DataChannel open event (set up in setupDataChannel)
  }

  /** Peer B: accept an offer code, return an answer code. */
  async acceptOffer(offerCode: string, sharedPhrase?: string): Promise<string> {
    this._destroyed = false;
    this.externalAssistDropped = false;
    this.sharedPhrase = sharedPhrase ?? "";
    this.isOfferer = false;
    this.setState("answering");
    this.log("accepting offer code...");

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

    // Create answer
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    // Wait for ICE
    this.log("gathering network candidates...");
    await this.waitForICE();

    const answerCode = await sdpToCode(this.pc.localDescription!.sdp, "answer", this.sharedPhrase || undefined);

    this.log(`answer code ready${this.sharedPhrase ? " (sealed)" : ""}`);
    this.setState("connecting");
    this.log("connecting peer-to-peer...");

    return answerCode;
  }

  /** Wait for ICE gathering to complete or timeout. */
  private waitForICE(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.pc) { resolve(); return; }

      if (this.pc.iceGatheringState === "complete") {
        resolve();
        return;
      }

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pc) this.pc.onicegatheringstatechange = null;
        resolve();
      };

      const timer = setTimeout(() => {
        this.log("candidate gathering timed out, proceeding with what we have");
        done();
      }, ICE_GATHER_TIMEOUT);

      this.pc.onicegatheringstatechange = () => {
        if (this.pc?.iceGatheringState === "complete") done();
      };
    });
  }

  /* ── Peer Connection ─────────────────────────────────────── */

  private setupPeerConnection(pc: RTCPeerConnection): void {
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "disconnected") {
        // During live sessions, enter recovery grace period instead of instant disconnect
        if (this._state === "live" || this._state === "silent") {
          this.stateBeforeRecovery = this._state;
          this.setState("recovering");
          this.log("connection interrupted, attempting recovery...");
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;
            if (this._state === "recovering") {
              this.log("recovery timeout, peer unreachable");
              this.setState("disconnected");
              this.cleanupConnection();
            }
          }, HEARTBEAT_TIMEOUT);
        } else if (this._state !== "recovering") {
          // Pre-live states: no recovery, just log
          this.log("connection interrupted during setup");
        }
      } else if (s === "failed") {
        // During active sessions, attempt one ICE restart before giving up
        if ((this._state === "live" || this._state === "silent" || this._state === "recovering") && !this.iceRestartAttempted) {
          this.iceRestartAttempted = true;
          this.log("connection failed, attempting restart...");
          if (this._state !== "recovering") {
            this.stateBeforeRecovery = this._state as "live" | "silent";
            this.setState("recovering");
          }
          this.attemptIceRestart(pc);
        } else {
          this.log("connection failed, could not reach peer");
          this.setState("error", "Connection failed, peer may be unreachable");
          this.cleanupConnection();
        }
      } else if (s === "connected" || s === "completed") {
        this.log(s === "completed" ? "connection established" : "connected to peer");
        this.iceRestartAttempted = false;
        this.dropExternalAssist(pc);
        // Recover from transient disruption
        if (this._state === "recovering" && this.stateBeforeRecovery) {
          if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
          const returnState = this.stateBeforeRecovery;
          this.stateBeforeRecovery = null;
          this.log("connection recovered");
          this.setState(returnState);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        // Some browsers stabilize connectionState before ICE emits completed.
        this.dropExternalAssist(pc);
      }
      if (s === "failed") {
        // If we're already recovering (ICE restart in flight), let the ICE handler manage it
        if (this._state === "recovering") return;
        this.log("connection to peer failed");
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
        .then(() => this.log("restart offer sent"))
        .catch((err) => {
          this.log(`restart failed: ${errorMessage(err)}`);
          this.setState("disconnected");
          this.cleanupConnection();
        });
    } else {
      // Answerer: restartIce() signals the browser to expect a new offer
      pc.restartIce();
      this.log("restart requested, waiting for path to recover");
    }
  }

  /* ── DataChannel ────────────────────────────────────────── */

  private setupDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;

    dc.onopen = () => {
      this.log("secure channel open, starting key exchange");
      // Establishment is complete at this point (DTLS/SCTP ready). If external assist was
      // enabled, drop it now so the rest of the session stays local-only.
      if (this.pc) this.dropExternalAssist(this.pc);
      this.setState("handshaking");
      // Start handshake timeout — if fingerprint not confirmed within HEARTBEAT_TIMEOUT, abort
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        if (this._state === "handshaking" || this._state === "verifying") {
          this.log("handshake timeout, key exchange took too long");
          this.setState("error", "Handshake timed out");
          this.cleanupConnection();
        }
      }, HEARTBEAT_TIMEOUT);
      this.performKeyExchange();
    };

    dc.onclose = () => {
      if (this._state === "live" || this._state === "silent" ||
          this._state === "recovering" ||
          this._state === "verifying" || this._state === "handshaking") {
        this.log("peer disconnected");
        this.setState("disconnected");
        this.cleanupConnection();
      }
    };

    dc.onerror = (event) => {
      const msg = (event as ErrorEvent).message ?? "unknown";
      this.log(`channel error: ${msg}`);
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
      }).catch(() => {});
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
    try {
      // Generate ephemeral ECDH keypair
      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      );

      const pubKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
      this.log("sending public key");

      // Send our public key
      if (!this.dc || this.dc.readyState !== "open") {
        this.log("key exchange aborted, channel not available");
        return;
      }
      this.sendPrefixed(LIVE_MSG.KEY_EXCHANGE, pubKeyRaw);

      // Store private key for derivation when peer's key arrives
      this.ephPrivateKey = keyPair.privateKey;
    } catch (err) {
      this.log(`key exchange failed: ${errorMessage(err, "unknown error")}`);
      this.setState("error", "Key exchange failed");
    }
  }

  private async handleKeyExchangeMessage(peerPubKeyRaw: Uint8Array): Promise<void> {
    if (this._state !== "handshaking") {
      this.log("ignoring key exchange message, not in handshaking state");
      return;
    }
    try {
      if (!this.ephPrivateKey) throw new Error("No ephemeral private key");

      // Derive shared secret via ECDH
      const peerPubKey = await crypto.subtle.importKey(
        "raw", toArrayBuffer(peerPubKeyRaw), { name: "ECDH", namedCurve: "P-256" }, false, [],
      );
      const sharedBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: peerPubKey }, this.ephPrivateKey, 256,
      );
      let sharedSecret: Uint8Array = new Uint8Array(sharedBits);

      // Wipe ephemeral key immediately — no longer needed
      this.ephPrivateKey = null;

      this.log("shared secret derived");

      // Mix in shared phrase if provided
      if (this.sharedPhrase) {
        const phraseHash = await sha256(TE.encode(PHRASE_PREFIX + this.sharedPhrase));
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
        this.log("shared phrase mixed into key derivation");
      } else {
        this.sharedPhrase = null;
      }

      this.sharedSecret = sharedSecret;

      // Derive fingerprint
      const fingerprint = await deriveFingerprint(sharedSecret);
      this.log(`fingerprint: ${fingerprint}`);
      this.onFingerprint(fingerprint);

      // Initialize Double Ratchet
      // The offerer generates an initial ratchet DH keypair and sends it.
      // The answerer receives it and uses it to derive both send and receive chains.
      // Then the answerer sends back their ratchet public key so the offerer
      // can derive their receive chain (and a new send chain).
      if (this.isOfferer) {
        const dhSelf = await generateDHKeyPair();
        this.ratchetState = await initRatchetAsOfferer(sharedSecret, dhSelf);

        // Send our initial ratchet public key
        if (this.dc && this.dc.readyState === "open") {
          this.sendPrefixed(LIVE_MSG.RATCHET_INIT, dhSelf.publicKey);
          this.log("sent initial ratchet key");
        }
      }
      // Answerer waits for RATCHET_INIT from the offerer

      this.setState("verifying");

      // Auto-confirm for programmatic connections (Campfire neighbor links)
      if (this.autoConfirm) {
        this.confirmFingerprint();
      }
    } catch (err) {
      this.log(`key derivation failed: ${errorMessage(err, "unknown error")}`);
      this.setState("error", "Key derivation failed");
    }
  }

  private async handleRatchetInit(peerRatchetPubKey: Uint8Array): Promise<void> {
    if (this._state !== "handshaking" && this._state !== "verifying") {
      this.log("ignoring ratchet init, not in expected state");
      return;
    }
    if (!this.sharedSecret) return;

    if (!this.isOfferer) {
      // Answerer receives offerer's initial DH public key.
      // initRatchetAsReceiver derives a sending chain for the answerer.
      this.ratchetState = await initRatchetAsReceiver(this.sharedSecret, peerRatchetPubKey);

      // Send our ratchet public key back so the offerer can derive their receive chain.
      if (this.dc && this.dc.readyState === "open") {
        this.sendPrefixed(LIVE_MSG.RATCHET_INIT, this.ratchetState.dhSelf.publicKey);
        this.log("encryption ratchet initialized, keys exchanged");
      }
    } else {
      // Offerer receives answerer's ratchet public key.
      // Perform the first DH ratchet step so the offerer has send and receive chains.
      if (this.ratchetState) {
        await dhRatchetStep(this.ratchetState, peerRatchetPubKey);
        this.log("encryption ratchet initialized, received peer key");
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
        this.log("peer confirmed fingerprint");
        break;
      case LIVE_MSG.FINGERPRINT_REJECTED: // Fingerprint rejected
        this.log("peer rejected fingerprint, aborting");
        this.setState("error", "Peer rejected fingerprint, possible interception");
        this.cleanupConnection();
        break;
      case LIVE_MSG.PING: // Ping — peer is alive, reply with pong
        this.lastPongReceived = Date.now();
        this.sendControlByte(LIVE_MSG.PONG);
        break;
      case LIVE_MSG.PONG: // Pong — peer acknowledged our ping
        this.lastPongReceived = Date.now();
        break;
      default:
        this.log(`unknown message type: 0x${type.toString(16)}`);
    }
  }

  private async handleEncryptedMessage(wireData: Uint8Array): Promise<void> {
    // Reassemble chunks
    const complete = this.assembler.feed(wireData);
    if (!complete) return; // Still waiting for more chunks

    if (!this.ratchetState) {
      this.log("received message but ratchet not initialized");
      return;
    }

    if (complete.length < HEADER_SIZE + 16) { // header + minimum AES-GCM tag
      this.log("received message too short, dropped");
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

        // Skip to the correct message number
        await skipMessageKeys(this.ratchetState, header.counter);

        // Derive message key
        if (!this.ratchetState.chainKeyRecv) throw new Error("No receiving chain key");
        const oldRecvChainKey = this.ratchetState.chainKeyRecv;
        const [newChainKey, mk] = await kdfChain(oldRecvChainKey);
        oldRecvChainKey.fill(0); // wipe old chain key
        this.ratchetState.chainKeyRecv = newChainKey;
        this.ratchetState.nRecv++;
        messageKey = mk;
      }

      // Decrypt
      const aad = complete.subarray(0, HEADER_SIZE); // header as AAD
      let plaintext: Uint8Array;
      try {
        plaintext = await aesGcmDecrypt(messageKey, header.ciphertext, header.nonce, aad);
      } catch (decryptErr) {
        messageKey.fill(0);
        // If a DH ratchet step was performed and decrypt still fails, the ratchet
        // is structurally broken (mismatched keys). Deterministic — disconnect.
        if (didDHRatchet) {
          this.log("decryption failed, encryption state unrecoverable. disconnecting");
          this.setState("error", "Encryption desync, session cannot recover");
          this.cleanupConnection();
          return;
        }
        throw decryptErr;
      }
      messageKey.fill(0); // wipe message key after use

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
      this.log(`decrypt failed: ${errorMessage(err)}`);
    }
  }

  /* ── Sending ────────────────────────────────────────────── */

  /** Enqueue a send job — serializes through sendQueue so ratchet state is never concurrent. */
  private enqueueSend(job: () => Promise<void>): Promise<void> {
    const wrapped = () => job().catch((err) => {
      this.log(`send failed: ${errorMessage(err)}`);
    });
    this.sendQueue = this.sendQueue.then(wrapped);
    return this.sendQueue;
  }

  async sendText(text: string): Promise<void> {
    if (this._state !== "live" || !this.dc || !this.ratchetState) return;

    await this.enqueueSend(async () => {
      if (this._state !== "live" || !this.dc || !this.ratchetState) return;
      await this.encryptAndSend(TE.encode(text), 0x00);
      this.onMessage({ type: "text", direction: "self", text, timestamp: Date.now() });
    });
  }

  async sendFile(file: File): Promise<void> {
    if (this._state !== "live" || !this.dc || !this.ratchetState) return;

    const fileBytes = new Uint8Array(await file.arrayBuffer());

    await this.enqueueSend(async () => {
      if (this._state !== "live" || !this.dc || !this.ratchetState) return;

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
    if (this._state !== "live" || !this.dc || !this.ratchetState) return;

    await this.enqueueSend(async () => {
      if (this._state !== "live" || !this.dc || !this.ratchetState) return;
      await this.encryptAndSend(plaintext, flags);
    });
  }

  private async sendFileDressed(
    fileName: string, fileType: string, fileBytes: Uint8Array,
  ): Promise<void> {
    // Dressed mode: embed the file into a carrier using the steganography engine
    // For now, we create a minimal PNG carrier and embed into it
    if (!this.engine) this.engine = new WhisperEngine();

    // Create a simple carrier (1x1 transparent PNG)
    const carrier = createMinimalPNGCarrier();

    try {
      // Derive stego password via HKDF — avoids exposing raw sharedSecret
      let password: string;
      if (this.sharedSecret) {
        const stegoKey = await hkdf(this.sharedSecret, ZERO_SALT_32, TE.encode("whisper-stego"), 16);
        password = toHex(stegoKey);
        stegoKey.fill(0);
      } else {
        password = "whisper-dressed";
      }

      // Create a File object for the payload
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

      this.log(`sent ${fileName} (embedded in carrier)`);
    } catch (err) {
      this.log(`steganography failed, sending directly: ${errorMessage(err)}`);
      const plaintext = encodeFilePlaintext(fileName, fileType, fileBytes);
      await this.encryptAndSend(plaintext, LIVE_FLAG.FILE);
      this.onMessage({
        type: "file", direction: "self",
        fileName, fileSize: fileBytes.length, fileType,
        timestamp: Date.now(),
      });
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

    // Ensure we have a sending chain
    if (!this.ratchetState.chainKeySend) {
      throw new Error("No sending chain, ratchet not fully initialized");
    }

    // Derive message key from sending chain
    const oldSendChainKey = this.ratchetState.chainKeySend;
    const [newChainKey, messageKey] = await kdfChain(oldSendChainKey);
    oldSendChainKey.fill(0); // wipe old chain key
    this.ratchetState.chainKeySend = newChainKey;

    const nonce = randomBytes(12);
    const counter = this.ratchetState.nSend;
    const prevChainLen = this.ratchetState.prevChainLength;

    // Build header
    const header = buildHeader(
      flags,
      this.ratchetState.dhSelf.publicKey,
      counter,
      prevChainLen,
      nonce,
    );

    // Encrypt with header as AAD
    const ciphertext = await aesGcmEncrypt(messageKey, plaintext, nonce, header);
    messageKey.fill(0); // wipe message key after use

    // Combine header + ciphertext
    const wireMessage = concatBytes(header, ciphertext);

    this.ratchetState.nSend++;

    // Chunk (with 0x20 prefix baked in) and send with backpressure
    const chunks = chunkMessagePrefixed(wireMessage, LIVE_MSG.ENCRYPTED);
    for (const chunk of chunks) {
      if (this.dc.bufferedAmount > BUFFERED_AMOUNT_LOW) {
        try { await this.waitForDrain(); } catch { return; } // channel closed during drain
      }
      if (!this.dc || this.dc.readyState !== "open") return;
      const ab = new ArrayBuffer(chunk.byteLength);
      new Uint8Array(ab).set(chunk);
      this.dc.send(ab);
    }
  }

  /* ── Trust ──────────────────────────────────────────────── */

  confirmFingerprint(): void {
    if (this._state !== "verifying") return;

    // Cancel handshake timeout
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }

    // Notify peer
    this.sendControlByte(LIVE_MSG.FINGERPRINT_CONFIRMED);
    this.log("fingerprint confirmed, session is live");
    this.startHeartbeat();

    if (this.transportMode === "silent") {
      this.setState("silent");
    } else {
      this.setState("live");
    }
  }

  rejectFingerprint(): void {
    if (this._state !== "verifying") return;

    this.sendControlByte(LIVE_MSG.FINGERPRINT_REJECTED);
    this.log("fingerprint rejected, aborting connection");
    this.setState("error", "Fingerprint mismatch, possible interception");
    this.cleanupConnection();
  }

  /* ── Transport ──────────────────────────────────────────── */

  setTransport(mode: TransportMode): void {
    this.transportMode = mode;
    this.log(`switched to ${mode} mode`);

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
    this.log("disconnecting, clearing session");
    this.setState("disconnected");
    this.cleanupConnection();
  }

  /* ── Heartbeat ─────────────────────────────────────────── */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongReceived = Date.now();
    this.heartbeatSend = setInterval(() => {
      this.sendControlByte(LIVE_MSG.PING);
    }, HEARTBEAT_INTERVAL);
    this.heartbeatCheck = setInterval(() => {
      if (this._state === "recovering" || this._destroyed) return;
      if (Date.now() - this.lastPongReceived > HEARTBEAT_TIMEOUT) {
        this.log("heartbeat timeout, peer unresponsive");
        this.setState("disconnected");
        this.cleanupConnection();
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatSend) { clearInterval(this.heartbeatSend); this.heartbeatSend = null; }
    if (this.heartbeatCheck) { clearInterval(this.heartbeatCheck); this.heartbeatCheck = null; }
  }

  /* ── Cleanup ─────────────────────────────────────────────── */

  private cleanupConnection(): void {
    if (this._destroyed) return; // re-entrancy guard
    this._destroyed = true;

    this.stopHeartbeat();
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
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
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.ondatachannel = null;
      try { pc.close(); } catch { /* ignore */ }
    }

    // Wipe crypto state
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

    // Wipe ephemeral key if still present (interrupted handshake)
    this.ephPrivateKey = null;
  }
}
