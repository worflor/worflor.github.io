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
import { packLocalSdp, unpackLocalSdp } from "./live-qr-sdp";
import {
  CTRL_OP,
  encodeCtrl,
  decodeCtrl,
  decodeStreamState,
  encodeCallAudio,
  decodeCallAudio,
  FILE_CANCEL_ROLE,
  encodeFileCancelPayload,
  decodeFileCancelPayload,
} from "./live-ctrl";
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
  type ProtocolState,
  protocolEncrypt,
  protocolDecrypt,
  cloneProtocolState,
} from "./live-protocol";

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
  /** Chunked file transfer id, set for FILE_PART assemblies (inbound and the outbound
   *  chunk-0 self-echo) so the UI can resolve progress cards by id instead of name+size. */
  transferId?: number;
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
  /** Fires once, synchronously, when a chunked outbound file transfer starts —
   *  lets the UI attach a cancel control to the outbound card, keyed by transferId. */
  onSendStart?: (transferId: number, fileName: string, totalBytes: number) => void;
  /** Progress during chunked receive (file transfers). Fires on the first chunk
   *  (so the UI can render the incoming card immediately) and periodically thereafter,
   *  throttled the same way as onSendProgress, plus unconditionally on the last chunk. */
  onReceiveProgress?: (transferId: number, receivedBytes: number, totalBytes: number, fileName: string) => void;
  /** A chunked file transfer (in either direction) was cancelled, locally or by the peer. */
  onTransferCancelled?: (transferId: number, by: "local" | "peer", direction: "in" | "out") => void;
  /** Periodic connection quality stats (fires each heartbeat cycle). */
  onConnectionStats?: (stats: ConnectionStats) => void;
  /** Incoming control frame from peer. */
  onCtrl?: (opcode: number, payload: Uint8Array) => void;
  /** Parsed live-draw stream event from peer. */
  onDrawStream?: (event: DrawStreamEvent) => void;
  /** Real-time call audio frame from peer. seq wraps mod 65536; blob is a harmonic frame. */
  onCallAudio?: (seq: number, blob: Uint8Array) => void;
  /** Peer's audio/video/screen stream state changed, plus their mute flag. */
  onStreamState?: (audio: boolean, video: boolean, screen: boolean, muted: boolean) => void;
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

/**
 * Teardown needs BOTH of these. See consecutiveDecryptFailures for why one
 * witness is not enough to tell a desynced session from a bad minute.
 */
const DESYNC_MIN_FAILURES = 8;
const DESYNC_GRACE_MS = 30_000;

const LIVE_MSG = {
  KEY_EXCHANGE: 0x10,
  RATCHET_INIT: 0x11,
  /**
   * "I am leaving on purpose."
   *
   * The transport cannot tell a deliberate departure from a broken path: both
   * surface as a closed channel or a failed connection. Without this frame the
   * remaining side has to GUESS, and the guess is what made the seam asymmetric
   * — whichever detector fired first on a given peer decided whether the drop
   * read as "recovering" or as "peer left". Intent is knowledge only the leaver
   * has, so the leaver states it. Everything else is treated as a fault.
   *
   * Best-effort by nature: a killed tab may never flush it. That is why absence
   * of BYE means "assume recoverable, then time out", never "assume gone".
   */
  BYE: 0x12,
  ENCRYPTED: 0x20,
  FINGERPRINT_CONFIRMED: 0x30,
  FINGERPRINT_REJECTED: 0x31,
  PING: 0x40,
  PONG: 0x41,
  TYPING: 0x42,
  ACK: 0x43,
  CTRL: 0x50,
  SEALED: 0x51,
  CALL_AUDIO: 0x52, // real-time call audio frame, sealed transport.
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
/** dc.bufferedAmount above this: drop the call audio frame at source. freshness
 *  over completeness, a real-time voice frame is worthless once it queues behind a backlog. */
const CALL_DROP_BUFFERED = 32768;

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
  /** performance.now() of the last onReceiveProgress emission, for throttling. */
  lastProgressEmit: number;
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
  /**
   * DESYNC IS A PROPERTY OF THE CHANNEL OVER TIME, NOT OF A FRAME.
   *
   * A count of consecutive failures alone cannot tell the two apart. A genuinely
   * desynced peer produces failures FOREVER — the root keys disagree, so nothing
   * will ever decrypt again. A corrupt or hostile frame produces a failure in a
   * session that is otherwise healthy. Three-in-a-row is satisfied by both, and
   * tearing down on it means any short burst kills a working conversation. This
   * is F1 in the shape it survived in: the fatal signal moved off the ratchet and
   * onto the counter, and the counter was still cheap to drive.
   *
   * So the teardown needs two independent witnesses that must agree: enough
   * failures to rule out a blip, AND a silence long enough that a healthy session
   * would certainly have delivered something. A burst satisfies the first and
   * never the second, because the very next honest frame resets both.
   */
  private consecutiveDecryptFailures = 0;
  /** timestamp of the last successful decrypt; session start counts as one. */
  private lastDecryptSuccessAt = 0;
  /** PBKDF2-stretched phrase root (wipeable bytes, never store the raw string). */
  private phraseRoot: Uint8Array | null = null;
  // in-person local mode: the handshake codes are packed via live-qr-sdp
  // (tiny, host-only, no phrase) instead of the relayed sdpToCode envelope,
  // so the whole exchange fits a scannable QR and never touches the internet.
  private useLocalCodec = false;
  private transportMode: TransportMode = "naked";
  private assembler = new ChunkAssembler();
  private incomingFiles = new Map<number, IncomingFileTransfer>();
  /** transferIds we (as receiver) rejected or dropped — stragglers still in flight are silently ignored. */
  private cancelledIncomingTransfers = new Set<number>();
  /** transferIds we (as sender) or our peer (as receiver) cancelled — checked between chunks in sendFileChunked. */
  private cancelledOutgoingTransfers = new Set<number>();
  /** transferIds actively being sent via sendFileChunked, letting an incoming FILE_CANCEL(RECEIVER)
   *  be validated against a real in-flight send instead of blindly trusting the peer's transferId. */
  private outgoingTransfersInFlight = new Set<number>();
  private engine: WhisperEngine | null = null;
  private isOfferer = false;
  /** Total messages sent this session — never resets unlike ratchet nSend. */
  private nSentTotal = 0;
  /** Total messages received this session — mirrors peer's nSentTotal. */
  private nRecvTotal = 0;
  private nextDrawStreamSeq = 0;
  private drawStreamSendQueue: Promise<void> = Promise.resolve();
  private drawStreamRecvTracker = new DrawStreamTracker();
  /** per-session call-audio sequence counter, wraps mod 65536. */
  private nextCallAudioSeq = 0;

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
  /**
   * The two ratchet pubkeys the confirm context is built from: ours as sent, and
   * the peer's as received, both captured at RATCHET_INIT and never touched again.
   *
   * BOTH have to be pinned, and for the same reason. The confirm proof is a MAC
   * over a transcript, so it only verifies if the two sides hash the identical
   * bytes; a transcript field that keeps moving after the proof is built is not a
   * transcript. `ratchetInitSentPubKey` existed because `dhSelf` is regenerated
   * by `dhRatchetStep` — but that step overwrites `dhPeer` in the same breath
   * (live-ratchet.ts, called from live-protocol.ts on any message carrying a new
   * header key), so reading the peer's half live had exactly the same defect the
   * pinned copy was introduced to fix. One field was pinned, its mirror was not.
   *
   * The window is real: any peer message that lands while we are still
   * `verifying` moves `dhPeer`, our context hash changes underneath us, and the
   * peer's honest proof fails to verify — surfacing as "handshake proof
   * mismatch, reconnect to continue". It is rare on a fresh connection because
   * nothing is queued to send, and common on a RECONNECT, where buffered traffic
   * goes out the instant the channel opens. That is the asymmetry the bug report
   * described: fresh connections fine, reconnects intermittent.
   */
  private ratchetInitSentPubKey: Uint8Array | null = null;
  private ratchetInitRecvPubKey: Uint8Array | null = null;
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
  onSendStart: WhisperLiveCallbacks["onSendStart"];
  onReceiveProgress: WhisperLiveCallbacks["onReceiveProgress"];
  onTransferCancelled: WhisperLiveCallbacks["onTransferCancelled"];
  onConnectionStats: WhisperLiveCallbacks["onConnectionStats"];
  onCtrl: WhisperLiveCallbacks["onCtrl"];
  onDrawStream: WhisperLiveCallbacks["onDrawStream"];
  onCallAudio: WhisperLiveCallbacks["onCallAudio"];
  onStreamState: WhisperLiveCallbacks["onStreamState"];
  onEdit: WhisperLiveCallbacks["onEdit"];

  // Tab-aware heartbeat
  private tabHidden = false;
  private visibilityHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;

  // Connection stats polling
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  // Recovery send queue — holds jobs until session returns to live
  private recoveryResolve: (() => void) | null = null;

  // Send rate shaping: decaying burst level, threshold 15, decay τ=4s, ceil 2s.

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
    this.onSendStart = callbacks.onSendStart;
    this.onReceiveProgress = callbacks.onReceiveProgress;
    this.onTransferCancelled = callbacks.onTransferCancelled;
    this.onConnectionStats = callbacks.onConnectionStats;
    this.onCtrl = callbacks.onCtrl;
    this.onDrawStream = callbacks.onDrawStream;
    this.onCallAudio = callbacks.onCallAudio;
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

  /** Send a frame sealed with the CTRL cipher. Serialized to preserve counter order.
   *  counter + chain consumption both happen inside the queued body, and only commit
   *  after dc.send succeeds: a throw anywhere upstream (kdf/import/seal/send) must
   *  never advance ctrlChainSend without the frame actually going out, or the receiver
   *  can never derive a matching key again. */
  private sendSealed(type: number, payload?: Uint8Array, freshUntil?: number): void {
    if (!this.ctrlChainSend) return; // drop, never send CTRL/ACK/TYPING in plaintext
    const inner = payload
      ? (() => { const b = new Uint8Array(1 + payload.length); b[0] = type; b.set(payload, 1); return b; })()
      : new Uint8Array([type]);
    const dirBit = this.isOfferer ? 0 : 1;
    this.sealedSendQueue = this.sealedSendQueue
      .then(async () => {
        // real-time frames carry a deadline: if the queue held this frame past its
        // useful window, drop it here, before any counter or chain state is touched.
        if (freshUntil !== undefined && Date.now() > freshUntil) return;
        if (!this.dc || this.dc.readyState !== "open" || !this.ctrlChainSend) return; // burn nothing, dc not open
        if (this.ctrlSendCounter >= 0xFFFFFFFF) return; // nonce space exhausted, drop silently, no counter burned
        const counter = this.ctrlSendCounter; // reserved only once send below actually succeeds
        const [newChain, msgKey] = await kdfChainDirect(this.ctrlChainSend);
        const aad = this.ctrlChainSend.slice();  // capture old chain key as AAD, chain itself untouched until commit
        const ck = await importCtrlKey(msgKey);
        msgKey.fill(0);
        let sealed: Uint8Array;
        try {
          sealed = await sealCtrl(ck, inner, counter, dirBit, aad);
        } finally {
          aad.fill(0);  // always wipe, even if sealCtrl throws
        }
        if (!this.dc || this.dc.readyState !== "open" || !this.ctrlChainSend) { newChain.fill(0); return; } // session moved on while sealing
        const wire = new Uint8Array(1 + sealed.length);
        wire[0] = LIVE_MSG.SEALED;
        wire.set(sealed, 1);
        try {
          this.dc.send(wire);
        } catch (sendErr) {
          newChain.fill(0);
          throw sendErr; // counter + chain stay exactly where they were, nothing was actually sent
        }
        // commit only now: the frame is genuinely on the wire.
        this.ctrlChainSend.fill(0);
        this.ctrlChainSend = newChain;
        this.ctrlSendCounter = counter + 1;
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

  /** Add to a cancelled-transfer id set, evicting the oldest entry once it grows past
   *  64, since a long session must not let these sets grow unbounded. Sets preserve
   *  insertion order, so the first key is always the oldest (FIFO). */
  private addCancelledTransferId(set: Set<number>, id: number): void {
    if (set.has(id)) return;
    set.add(id);
    if (set.size > 64) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
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

  /** Bundle the instance's message-protocol fields into a ProtocolState for the
   *  pure transforms in live-protocol.ts. References the same mutable objects. */
  private buildProtoState(): ProtocolState {
    return {
      ratchet: this.ratchetState!,
      loopSend: this.loopStateSend,
      loopRecv: this.loopStateRecv,
      skippedLoopKeys: this.skippedLoopKeys,
      lastSentPubKeyHex: this.lastSentPubKeyHex,
      lastRecvPubKeyHex: this.lastRecvPubKeyHex,
      nSentTotal: this.nSentTotal,
      nRecvTotal: this.nRecvTotal,
      isOfferer: this.isOfferer,
    };
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
    this.wipeBytes(this.ratchetInitRecvPubKey);
    this.ratchetInitRecvPubKey = null;
    this.localConfirmRequested = false;
    this.localConfirmSent = false;
    this.remoteConfirmVerified = false;
  }

  private clearIncomingFiles(): void {
    for (const transfer of this.incomingFiles.values()) {
      transfer.chunks.clear();
    }
    this.incomingFiles.clear();
    this.cancelledIncomingTransfers.clear();
    this.cancelledOutgoingTransfers.clear();
    this.outgoingTransfersInFlight.clear();
  }

  private resetSessionState(): void {
    this.nSentTotal = 0;
    this.nRecvTotal = 0;
    this.nextDrawStreamSeq = 0;
    this.nextCallAudioSeq = 0;
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
    let localSdp = this.pc?.localDescription?.sdp;
    const remoteSdp = this.pc?.remoteDescription?.sdp;
    if (!localSdp || !remoteSdp || !this.localEphPublicKey) {
      throw new Error("handshake transcript incomplete");
    }
    // local mode transports a stripped-and-rebuilt SDP, so our own local
    // description differs from the canonical form the peer reconstructed from
    // our QR payload (regenerated candidate foundation/priority, dropped
    // cruft). round-trip our local SDP through the same codec so both sides
    // transcript over the identical bytes. the remote SDP is already the
    // rebuilt form (setRemoteDescription received the unpacked payload).
    if (this.useLocalCodec) {
      localSdp = unpackLocalSdp(packLocalSdp(localSdp, this.isOfferer)).sdp;
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
    if (!this.sharedSecret || !this.transcriptHash || !this.kizunaWitness) return;
    if (!this.ratchetInitSentPubKey || !this.ratchetInitRecvPubKey) return;
    // Both halves come from the pinned RATCHET_INIT copies, never from the live
    // ratchet. `dhSelf` AND `dhPeer` are both replaced by dhRatchetStep, so
    // either one read live would make this hash move after the proof was built.
    const ownInitKey = this.ratchetInitSentPubKey;
    const peerInitKey = this.ratchetInitRecvPubKey;
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
      const valid = await verifyConfirmProof(this.sharedSecret, this.confirmContextHash, this.peerRole(), proof);
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

    const code = this.useLocalCodec
      ? packLocalSdp(this.pc.localDescription!.sdp, true)
      : await sdpToCode(this.pc.localDescription!.sdp, "offer", this.phraseRoot ?? undefined);

    this.onLog(`offer code ready${this.useLocalCodec ? " (local)" : this.phraseRoot ? " (sealed)" : ""}`);
    this.setState("waiting-for-answer");

    return code;
  }

  /** Peer A: apply the answer code from Peer B. */
  async applyAnswer(answerCode: string): Promise<void> {
    if (!this.pc) throw new Error("No connection, create offer first");

    this.onLog("applying answer code...");
    const sdp = this.useLocalCodec
      ? unpackLocalSdp(answerCode).sdp
      : await codeToSdp(answerCode, "answer", this.phraseRoot ?? undefined);
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

    const offerSDP = this.useLocalCodec
      ? unpackLocalSdp(offerCode).sdp
      : await codeToSdp(offerCode, "offer", this.phraseRoot ?? undefined);

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

    const answerCode = this.useLocalCodec
      ? packLocalSdp(this.pc.localDescription!.sdp, false)
      : await sdpToCode(this.pc.localDescription!.sdp, "answer", this.phraseRoot ?? undefined);

    this.onLog(`answer code ready${this.useLocalCodec ? " (local)" : this.phraseRoot ? " (sealed)" : ""}`);
    this.setState("connecting");
    this.onLog("connecting peer-to-peer...");

    return answerCode;
  }

  /* ── In-person local mode (QR pairing, no server, no phrase) ──
   * these mirror createOffer/acceptOffer/applyAnswer but pack the SDP with
   * live-qr-sdp so the codes fit a scannable QR, and force host-only ICE by
   * passing no phrase (which leaves the config at WHISPER_LIVE_RTC_LOCAL_ONLY,
   * no STUN/TURN). the QR carries the DTLS fingerprint, so scanning it IS the
   * authentication — no relay, no emoji-compare needed. */

  /** Peer A (local): create a host-only offer, returned as a compact QR payload. */
  async createLocalOffer(): Promise<string> {
    this.useLocalCodec = true;
    return this.createOffer();
  }

  /** Peer B (local): accept a scanned offer payload, return a compact answer payload. */
  async acceptLocalOffer(offerPayload: string): Promise<string> {
    this.useLocalCodec = true;
    return this.acceptOffer(offerPayload);
  }

  /** Peer A (local): apply the scanned answer payload to finish the bond. */
  async applyLocalAnswer(answerPayload: string): Promise<void> {
    this.useLocalCodec = true;
    return this.applyAnswer(answerPayload);
  }

  /** Wait for ICE gathering to complete or timeout. */
  private waitForICE(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.pc) { resolve(); return; }
      const pc = this.pc;
      const maxWait = this.hasExternalAssistConfigured() ? ICE_GATHER_TIMEOUT_ASSIST : ICE_GATHER_TIMEOUT;

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
        if (settleTimer) clearTimeout(settleTimer);
        pc.removeEventListener("icecandidate", onIceCandidate);
        pc.onicegatheringstatechange = null;
        logGatherResult();
        resolve();
      };

      /**
       * SETTLE ON THE EVENT, NOT ON A CLOCK.
       *
       * "Candidates have gone quiet for ICE_GATHER_SETTLE_MS" is a statement
       * about the last candidate, so the last candidate is what should decide
       * it. Polling every 250ms answered the same question on a schedule that
       * has nothing to do with the question, which cost up to a full poll
       * interval of pure waiting on every connection even when gathering had
       * finished immediately.
       *
       * A timer re-armed by each candidate is both exact and cheaper: it fires
       * once, exactly ICE_GATHER_SETTLE_MS after the last candidate arrives,
       * instead of waking four times a second to re-read the SDP and re-run two
       * regexes over it.
       */
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      const armSettle = () => {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          if (settled) return;
          // Quiet is necessary but not sufficient: silence with nothing usable
          // gathered yet means keep waiting for the ceiling, not give up early.
          if (!hasUsefulCandidates() || candidateCount() === 0) { armSettle(); return; }
          this.onLog("path discovery settled, proceeding with gathered candidates");
          done();
        }, ICE_GATHER_SETTLE_MS);
      };

      const onIceCandidate = (event: RTCPeerConnectionIceEvent) => {
        if (!event.candidate) return;
        armSettle();
      };

      pc.addEventListener("icecandidate", onIceCandidate);
      armSettle(); // gathering may finish before the first event reaches us

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

    // Every detector below observes the SAME physical event — the path broke —
    // so they must reach the same conclusion. They used not to: ICE
    // "disconnected" entered recovery, while connectionState "failed" and the
    // channel's own close went straight to "peer left, session over". Which one
    // fired first varies by browser, OS and network, and it varies INDEPENDENTLY
    // on the two peers, so a single genuine drop routinely left one side showing
    // a recovering seam and the other declaring the session over. One fact,
    // three owners, no agreement.
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;

      if (s === "checking") return;

      if (s === "disconnected") {
        this.enterRecovery(pc, "connection interrupted, attempting recovery...");
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
        // A failed peer connection on an established session is a FAULT, not a
        // departure. It used to be reported as "peer left" on the strength of
        // nothing, which is what robbed this side of its seam while the peer
        // sat in recovery. A real departure announces itself with BYE.
        this.enterRecovery(pc, "connection failed, attempting recovery...");
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
        // The channel closing says the transport went away; it does not say the
        // person did. If they chose to go, their BYE has already moved us to
        // "disconnected" and this branch is unreachable. So a close that still
        // finds us live is a fault, and gets the same seam the peer is seeing.
        this.enterRecovery(this.pc, "channel closed, attempting recovery...");
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
      // Three independent derivations from one root: nothing here reads anything
      // else here, so awaiting them in sequence was three round trips of latency
      // on the connection path for no ordering requirement.
      const [silentKey, audioKeyBytes, ctrlRoot] = await Promise.all([
        deriveSilentKey(sharedSecret),
        deriveAudioKey(sharedSecret),
        deriveCtrlKey(sharedSecret),
      ]);
      this.silentKey = silentKey;
      this.audioKeyBytes = audioKeyBytes;
      const [chainA, chainB] = await Promise.all([
        hkdf(ctrlRoot, ZERO_SALT_32, TE.encode("ctrl-send"), 32),
        hkdf(ctrlRoot, ZERO_SALT_32, TE.encode("ctrl-recv"), 32),
      ]);
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

  /**
   * The peer said it is leaving on purpose.
   *
   * This is the ONE case that skips recovery, and it may because the peer told
   * us rather than because we inferred it from a silence. It also has to win a
   * race against the detectors: the close that follows a BYE arrives moments
   * later, so moving to "disconnected" now is what makes the later close a
   * no-op instead of a spurious recovering seam.
   *
   * Unauthenticated by construction, like every pre-handshake frame: a BYE from
   * an attacker who can already write to the channel buys them nothing they
   * could not get by closing it, so there is no state here worth forging.
   */
  private handlePeerBye(): void {
    if (!this.isLiveState() && this._state !== "recovering") return;
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    this.onLog("peer left, session over");
    this.setState("disconnected", "left");
    this.cleanupConnection();
  }

  private async handleRatchetInit(peerRatchetPubKey: Uint8Array): Promise<void> {
    if (this._state !== "handshaking" && this._state !== "verifying") return;
    if (!this.sharedSecret) return;
    const generation = this.sessionGeneration;

    // Guard: only accept one RATCHET_INIT per handshake. A duplicate would
    // overwrite (answerer) or desync (offerer) the ratchet state. Reject silently.
    if (this.ratchetInitReceived) return;
    this.ratchetInitReceived = true;

    // Capture the peer's half of the confirm context HERE, at the one moment it
    // is defined, before either branch below hands the key to the ratchet — the
    // answerer's initRatchetAsReceiver and the offerer's dhRatchetStep both take
    // ownership of it, and dhRatchetStep will later zero and replace it.
    this.wipeBytes(this.ratchetInitRecvPubKey);
    this.ratchetInitRecvPubKey = peerRatchetPubKey.slice();

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
      case LIVE_MSG.BYE:
        this.handlePeerBye();
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
              if (state) this.onStreamState(state.audio, state.video, state.screen, state.muted);
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
            if (frame.opcode === CTRL_OP.FILE_CANCEL) {
              const cancel = decodeFileCancelPayload(frame.payload);
              if (cancel) this.handleFileCancel(cancel.transferId, cancel.role);
            }
          }
          break;
        }
        case LIVE_MSG.CALL_AUDIO: {
          const frame = decodeCallAudio(innerPayload);
          if (frame && this.onCallAudio) this.onCallAudio(frame.seq, frame.blob);
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
        // delegate the full receive transform to the pure protocol core — the same
        // dual-ratchet + membrane pipeline (protocolDecrypt) the test harness drives.
        // it runs on a clone; we commit only if it succeeds AND the session is current.
        const clone = cloneProtocolState(this.buildProtoState());
        const outcome = await protocolDecrypt(clone, complete);
        if (!outcome.ok) {
          this.wipeRatchetState(clone.ratchet);
          this.wipeLoopState(clone.loopSend);
          this.wipeLoopState(clone.loopRecv);
          this.wipeSkippedLoopKeys(clone.skippedLoopKeys);
          // the clone is discarded, so committed state is untouched. the session
          // still stays live: ending it needs BOTH a run of failures and a long
          // silence, and any honest frame in between resets both (see
          // consecutiveDecryptFailures).
          // count it here, at the only site that knows the failure was a decrypt
          // failure: the catch below also sees errors thrown while dispatching an
          // already-decrypted message, and those must never look like desync.
          this.consecutiveDecryptFailures++;
          throw new Error(`decrypt failed: ${outcome.reason}`);
        }

        // session may have been torn down/regenerated during the awaits above. a
        // stale session must never commit; discard the speculative clone.
        if (!this.isSessionCurrent(generation)) {
          this.wipeRatchetState(clone.ratchet);
          this.wipeLoopState(clone.loopSend);
          this.wipeLoopState(clone.loopRecv);
          this.wipeSkippedLoopKeys(clone.skippedLoopKeys);
          return;
        }

        this.nRecvTotal = clone.nRecvTotal;
        this.commitReceiveState(clone.ratchet, clone.loopSend, clone.loopRecv, clone.skippedLoopKeys, clone.lastRecvPubKeyHex);
        const { plaintext, msgId, didDHRatchet } = outcome;
        const header = { flags: outcome.flags };
        this.onLog(`recv: committed, nRecv=${this.ratchetState!.nRecv}, DH=${didDHRatchet}`);
        if (didDHRatchet) this.onLog("bond renewed");

        this.consecutiveDecryptFailures = 0; // reset on successful decrypt+decompress
        this.lastDecryptSuccessAt = Date.now();

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
      this.onLog(`receive failed: ${errorMessage(err)}`);
      // the datachannel is dtls-protected, so a frame that got this far really
      // is the peer's. a run of them means the peer's membrane genuinely
      // diverged, and every later message will fail the same way, so say so
      // rather than leaving the user in a silent session that can never heal.
      const quietFor = Date.now() - this.lastDecryptSuccessAt;
      if (this.consecutiveDecryptFailures >= DESYNC_MIN_FAILURES && quietFor >= DESYNC_GRACE_MS) {
        this.onLog(`${this.consecutiveDecryptFailures} decrypt failures and nothing delivered for ${Math.round(quietFor / 1000)}s, session is desynced. disconnecting`);
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

    // dropped locally (we rejected it) or the peer aborted it — ignore any stragglers
    // still in flight without recreating transfer state.
    if (this.cancelledIncomingTransfers.has(transferId)) return;

    let transfer = this.incomingFiles.get(transferId);
    const isNewTransfer = !transfer;
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
        lastProgressEmit: 0,
      };
      this.incomingFiles.set(transferId, transfer);
    }

    if (chunkIndex >= transfer.totalChunks || transfer.chunks.has(chunkIndex)) return; // out-of-range or duplicate

    // store as Blob so the browser can swap to disk — keeps JS heap bounded
    // regardless of total file size (each chunk is ~4 MB, freed after Blob wraps it).
    transfer.chunks.set(chunkIndex, new Blob([chunkData]));
    transfer.receivedBytes += chunkData.length;

    const isLastChunk = transfer.chunks.size >= transfer.totalChunks;
    if (this.onReceiveProgress) {
      const now = performance.now();
      // always emit on the first chunk (so the UI can render the card immediately)
      // and on the last chunk (so the UI can settle at 100%); otherwise throttle.
      if (isNewTransfer || isLastChunk || now - transfer.lastProgressEmit >= SEND_PROGRESS_INTERVAL_MS) {
        this.onReceiveProgress(transferId, transfer.receivedBytes, transfer.totalSize, transfer.fileName);
        transfer.lastProgressEmit = now;
      }
    }

    if (!isLastChunk) return; // still waiting

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
      transferId,
      fileName: transfer.fileName,
      fileSize: transfer.totalSize,
      fileBlob: assembled,
      fileType: transfer.fileType,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle a peer FILE_CANCEL frame.
   * role SENDER   — peer aborted the transfer it was sending us: drop our inbound state.
   * role RECEIVER — peer rejected the transfer we were sending it: abort our outbound loop.
   * both roles are validated against real local state first: an unknown or already
   * finished transferId is silently ignored rather than fabricating cancellation state.
   */
  private handleFileCancel(transferId: number, role: number): void {
    if (role === FILE_CANCEL_ROLE.SENDER) {
      const transfer = this.incomingFiles.get(transferId);
      if (!transfer) return; // unknown or already-completed transfer, nothing to cancel
      transfer.chunks.clear();
      this.incomingFiles.delete(transferId);
      this.addCancelledTransferId(this.cancelledIncomingTransfers, transferId);
      this.onTransferCancelled?.(transferId, "peer", "in");
    } else if (role === FILE_CANCEL_ROLE.RECEIVER) {
      if (!this.outgoingTransfersInFlight.has(transferId)) return; // no such outbound send in flight
      this.addCancelledTransferId(this.cancelledOutgoingTransfers, transferId);
      this.onTransferCancelled?.(transferId, "peer", "out");
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

  /** send one real-time call audio frame. freshness over completeness: frames are
   *  dropped, never queued, when the channel is congested. */
  sendCallAudio(blob: Uint8Array): void {
    if (!this.isLiveState()) return;
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return;
    // drop the frame at source when the channel is backed up. this check runs before
    // sendSealed enqueues, so a dropped frame never burns a seal counter, and we never
    // wait on drain: a stale voice frame is worthless. sendSealed's own queued body
    // still guards against the channel going unusable between enqueue and send.
    if (dc.bufferedAmount > CALL_DROP_BUFFERED) return;
    const seq = this.nextCallAudioSeq++ & 0xffff;
    const payload = encodeCallAudio(seq, blob);
    // the deadline covers the seal queue itself: if crypto contention holds the
    // frame for more than about two frame durations, it dies in the queue instead
    // of arriving as stale audio.
    this.sendSealed(LIVE_MSG.CALL_AUDIO, payload, Date.now() + 160);
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

  /**
   * Enqueue a send job — serializes through sendQueue so ratchet state is never
   * concurrent.
   *
   * NO PACING HERE, DELIBERATELY. This used to impose a decaying burst delay:
   * past fifteen sends it added `2000 * (1 - exp(-excess/5))` ms per message,
   * asymptotically two full seconds each. Nothing depended on it. Congestion is
   * already handled where congestion actually lives — `waitForDrain` blocks on
   * `dc.bufferedAmount`, which is the transport's own measure of whether it can
   * accept more — so the delay was not backpressure, it was a second, blind
   * mechanism guessing at the same thing and getting it wrong by up to two
   * seconds.
   *
   * It was also the wrong shape for the one purpose that could have justified
   * it. Timing obfuscation has to make send times INDEPENDENT of user behaviour;
   * a delay that grows with how fast you are typing does the opposite, encoding
   * the burst pattern into the very timing it would need to hide. Obfuscation
   * belongs in a designed layer, added on purpose, on top of a transport that is
   * otherwise raw.
   */
  private enqueueSend(job: () => Promise<void>): Promise<void> {
    const wrapped = async () => {
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

  /** Cancel an in-flight outbound chunked transfer we initiated. Aborts the send
   *  loop between chunks, tells the peer via CTRL so it drops its partial state,
   *  and always resolves cleanly (no throw) — sendFileChunked simply stops early. */
  cancelFileTransfer(transferId: number): void {
    this.addCancelledTransferId(this.cancelledOutgoingTransfers, transferId);
    this.sendCtrl(CTRL_OP.FILE_CANCEL, encodeFileCancelPayload(transferId, FILE_CANCEL_ROLE.SENDER));
    this.onTransferCancelled?.(transferId, "local", "out");
  }

  /** Reject/drop an in-flight inbound chunked transfer. Releases the partial chunk
   *  blobs we already hold, tells the peer via CTRL so it stops sending, and marks
   *  the transferId so any stragglers still in flight are silently ignored. */
  cancelIncomingTransfer(transferId: number): void {
    const transfer = this.incomingFiles.get(transferId);
    if (transfer) {
      transfer.chunks.clear();
      this.incomingFiles.delete(transferId);
    }
    this.addCancelledTransferId(this.cancelledIncomingTransfers, transferId);
    this.sendCtrl(CTRL_OP.FILE_CANCEL, encodeFileCancelPayload(transferId, FILE_CANCEL_ROLE.RECEIVER));
    this.onTransferCancelled?.(transferId, "local", "in");
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

    this.onSendStart?.(transferId, file.name, file.size);
    this.outgoingTransfersInFlight.add(transferId);

    try {
      for (let i = 0; i < totalChunks; i++) {
        // checked between chunks — cancelled either locally or by the peer rejecting.
        if (this.cancelledOutgoingTransfers.has(transferId)) break;

        const start = i * FILE_CHUNK_SIZE;
        const end = Math.min(start + FILE_CHUNK_SIZE, file.size);
        // file.slice() reads only this byte range — does not load the whole file.
        const chunkBytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
        const chunkIdx = i;
        const chunkLen = chunkBytes.length;

        // Chunked file transfer = single user action — skip rate shaping
        await this.enqueueSend(async () => {
          if (this.cancelledOutgoingTransfers.has(transferId)) return; // cancelled while queued
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
              transferId,
              timestamp: Date.now(),
            });
          }
          bytesSent += chunkLen;
          if (this.onSendProgress) this.onSendProgress(bytesSent, file.size);
        });
      }
    } finally {
      this.cancelledOutgoingTransfers.delete(transferId);
      this.outgoingTransfersInFlight.delete(transferId);
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
    this.onLog(`send: acquiring lock (queue depth: ${this.nSentTotal})`);
    return this.withRatchetLock(async () => {
      this.onLog("send: lock acquired");
      if (!this.ratchetState || !this.dc) return -1;

      if (!this.loopStateSend) {
        throw new Error("No sending loop state, ratchet not fully initialized");
      }

      // delegate the full message transform to the pure protocol core — the same
      // dual-ratchet + membrane pipeline (protocolEncrypt) the test harness drives.
      const proto = this.buildProtoState();
      const { wire, msgId } = await protocolEncrypt(proto, plaintext, flags, randomBytes(4));
      this.loopStateSend = proto.loopSend;
      this.lastSentPubKeyHex = proto.lastSentPubKeyHex;
      this.nSentTotal = proto.nSentTotal;
      this.onLog(`send: encrypted, nSend=${this.ratchetState.nSend}, releasing lock`);

      const wireLen = wire.length;
      const totalBytes = estimateChunkedPrefixedSize(wireLen);
      let bytesSent = 0;
      let lastProgressEmit = 0;
      for (const chunk of iterateChunksPrefixed([wire], LIVE_MSG.ENCRYPTED)) {
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
    // Announce the departure before tearing anything down, so the peer learns
    // it as a fact rather than inferring it from a dead socket. Best effort by
    // definition: if the channel is already gone the peer falls back to the
    // recovery path and times out, which is the honest reading of silence.
    if (this.dc && this.dc.readyState === "open") {
      try { this.dc.send(new Uint8Array([LIVE_MSG.BYE])); } catch { /* already gone */ }
    }
    this.setState("disconnected");
    this.cleanupConnection();
  }

  /**
   * The one place a transport fault becomes a state change.
   *
   * Called by every detector that can observe a broken path — ICE
   * "disconnected", ICE "failed", peer-connection "failed", and the data
   * channel closing. They fire in an order that differs per browser and per
   * peer, so any of them deciding the outcome on its own is how two peers ended
   * up disagreeing about one event. Here they cannot: the first to arrive
   * enters recovery, and the rest find it already entered.
   *
   * Recovery is bounded, not indefinite. If the peer never comes back the timer
   * ends the session as "vanished" — the same conclusion as before, reached by
   * waiting instead of by guessing.
   */
  private enterRecovery(pc: RTCPeerConnection | null, reason: string): void {
    // One guard doing two jobs, and it is worth naming both because they look
    // like they need separate checks and do not. "live" or "silent" means an
    // established session exists to recover; anything else is either a setup
    // state (nothing to restore) or "recovering" itself, which is how a sibling
    // detector arriving second finds the work already done. Adding an explicit
    // `state === "recovering"` test alongside this reads as belt-and-braces but
    // is unreachable, and an unreachable branch is a claim no test can falsify.
    if (!this.isLiveState()) return;
    this.stateBeforeRecovery = this._state as "live" | "silent";
    this.setState("recovering");
    this.onLog(reason);
    if (pc && this.isOfferer && this.relaySignalSender && !this.liveRestartPending) {
      void this.maybeSignalIceRestart(pc, true);
    }
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this._state === "recovering") {
        this.onLog("recovery timeout, peer unreachable");
        this.setState("disconnected", "vanished");
        this.cleanupConnection();
      }
    }, HEARTBEAT_TIMEOUT);
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

    // A closing page still knows it is leaving, so it still owes the peer a
    // goodbye. Without this, the single most common departure — closing the tab
    // — reaches the peer as silence, and silence is now (correctly) read as a
    // fault: the peer would hold a recovering seam for the whole timeout before
    // concluding what was knowable at once.
    //
    // `pagehide` rather than `beforeunload`, because mobile browsers routinely
    // discard a backgrounded page without ever firing the latter. The send is
    // synchronous on purpose: nothing asynchronous is guaranteed to run here.
    this.pageHideHandler = () => {
      if (this.dc && this.dc.readyState === "open") {
        try { this.dc.send(new Uint8Array([LIVE_MSG.BYE])); } catch { /* already gone */ }
      }
    };
    window.addEventListener("pagehide", this.pageHideHandler);

    this.startStatsPoll();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatSend) { clearInterval(this.heartbeatSend); this.heartbeatSend = null; }
    if (this.heartbeatCheck) { clearInterval(this.heartbeatCheck); this.heartbeatCheck = null; }
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.pageHideHandler) {
      window.removeEventListener("pagehide", this.pageHideHandler);
      this.pageHideHandler = null;
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

  /** On-demand snapshot of the live path (direct vs relayed) and RTT, for UI surfaces
   *  like the e2e badge tooltip. Independent of the periodic heartbeat stats above —
   *  callers poll this at their own cadence. Never throws; returns nulls when the
   *  connection or its stats are unavailable. */
  async getConnectionStats(): Promise<{ path: "direct" | "relayed" | null; rttMs: number | null }> {
    if (!this.pc) return { path: null, rttMs: null };
    try {
      const stats = await this.pc.getStats();
      let pair: any = null;

      // preferred: the transport's selected pair, resolved through selectedCandidatePairId
      for (const report of stats.values()) {
        if (report.type === "transport" && report.selectedCandidatePairId) {
          const selected = stats.get(report.selectedCandidatePairId);
          if (selected && selected.type === "candidate-pair") { pair = selected; break; }
        }
      }
      // fallback: a candidate-pair that succeeded and was nominated
      if (!pair) {
        for (const report of stats.values()) {
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
            pair = report;
            break;
          }
        }
      }
      if (!pair) return { path: null, rttMs: null };

      const rttMs = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;

      const localCand = pair.localCandidateId ? stats.get(pair.localCandidateId) : null;
      const remoteCand = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;
      const isRelay = localCand?.candidateType === "relay" || remoteCand?.candidateType === "relay";
      const path: "direct" | "relayed" = isRelay ? "relayed" : "direct";

      return { path, rttMs };
    } catch {
      return { path: null, rttMs: null };
    }
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
    this.lastDecryptSuccessAt = Date.now();
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
