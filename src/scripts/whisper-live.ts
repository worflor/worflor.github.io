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
  kdfChainDirect,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from "./whisper-live-crypto";
import { sdpToCode, codeToSdp } from "./whisper-live-sdp";

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
}

export interface WhisperLiveSessionOptions {
  /**
   * RTCPeerConnection configuration.
   * Default is “local-only” (no STUN/TURN) to avoid any external network assist.
   */
  rtcConfig?: RTCConfiguration;

  /**
   * When true (default), if `rtcConfig` includes ICE servers we will disable them
   * after establishment (DataChannel open / connected). This keeps external assist
   * scoped to connection setup only.
   */
  externalAssistEstablishmentOnly?: boolean;
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
const KDF_INFO_RATCHET = TE.encode("whisper-ratchet");
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
   Double Ratchet
   ═══════════════════════════════════════════════════════════════════
   Signal Protocol Double Ratchet algorithm.

   Root chain: initialized from ECDH shared secret.
   DH ratchet: new P-256 keypair per sending turn.
   Symmetric ratchet: HMAC-SHA256 chain per direction.
   Message keys: derived from chain, used once then discarded.
   ═══════════════════════════════════════════════════════════════════ */

const MAX_SKIP = 256;  // max skipped message keys to store

interface RatchetKeyPair {
  publicKey: Uint8Array;    // raw 65-byte uncompressed P-256 point
  privateKey: CryptoKey;    // non-extractable ECDH private key
}

interface RatchetState {
  /** Root key — 32 bytes, ratcheted with each DH exchange */
  rootKey: Uint8Array;

  /** Our current DH ratchet keypair */
  dhSelf: RatchetKeyPair;

  /** Peer's current DH ratchet public key (raw bytes) */
  dhPeer: Uint8Array | null;

  /** Cached hex of dhPeer — avoids recomputing toHex(dhPeer) per message */
  dhPeerHex: string;

  /** Sending chain key */
  chainKeySend: Uint8Array | null;

  /** Receiving chain key */
  chainKeyRecv: Uint8Array | null;

  /** Number of messages sent in current sending chain */
  nSend: number;

  /** Number of messages received in current receiving chain */
  nRecv: number;

  /** Previous sending chain length (for header) */
  prevChainLength: number;

  /** Skipped message keys for out-of-order delivery — Map<"pubHex:nr", messageKey> */
  skippedKeys: Map<string, Uint8Array>;
}

async function generateDHKeyPair(): Promise<RatchetKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: pubRaw, privateKey: pair.privateKey };
}

async function dhExchange(privateKey: CryptoKey, peerPublicRaw: Uint8Array): Promise<Uint8Array> {
  const peerKey = await crypto.subtle.importKey(
    "raw", toArrayBuffer(peerPublicRaw), { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerKey }, privateKey, 256,
  );
  return new Uint8Array(bits);
}

/** KDF for root chain ratchet: HKDF(rootKey, dhOutput) → [newRootKey, newChainKey] */
async function kdfRootChain(
  rootKey: Uint8Array, dhOutput: Uint8Array,
): Promise<[Uint8Array, Uint8Array]> {
  const derived = await hkdf(dhOutput, rootKey, KDF_INFO_RATCHET, 64);
  return [derived.subarray(0, 32), derived.subarray(32, 64)];
}

/** KDF for symmetric chain ratchet: chainKey → [newChainKey, messageKey] */
const kdfChain = kdfChainDirect;

/** Initialize ratchet state — called by the person who received the first message (answerer). */
async function initRatchetAsReceiver(
  sharedSecret: Uint8Array,
  peerPublicKey: Uint8Array,
): Promise<RatchetState> {
  const dhSelf = await generateDHKeyPair();
  const dhOutput = await dhExchange(dhSelf.privateKey, peerPublicKey);
  const [rootKey, chainKeySend] = await kdfRootChain(sharedSecret, dhOutput);
  dhOutput.fill(0); // wipe DH output
  sharedSecret.fill(0); // wipe initial shared secret (now in rootKey)

  return {
    rootKey,
    dhSelf,
    dhPeer: peerPublicKey,
    dhPeerHex: toHex(peerPublicKey),
    chainKeySend,
    chainKeyRecv: null,
    nSend: 0,
    nRecv: 0,
    prevChainLength: 0,
    skippedKeys: new Map(),
  };
}

/** Initialize ratchet state — called by the person who sent the first message (offerer). */
async function initRatchetAsOfferer(
  sharedSecret: Uint8Array, dhSelf: RatchetKeyPair,
): Promise<RatchetState> {
  return {
    rootKey: sharedSecret,
    dhSelf,
    dhPeer: null,
    dhPeerHex: "",
    chainKeySend: null,
    chainKeyRecv: null,
    nSend: 0,
    nRecv: 0,
    prevChainLength: 0,
    skippedKeys: new Map(),
  };
}

/** Perform a DH ratchet step when receiving a new public key from peer. */
async function dhRatchetStep(state: RatchetState, peerPublicKey: Uint8Array): Promise<void> {
  state.prevChainLength = state.nSend;
  state.nSend = 0;
  state.nRecv = 0;

  // Wipe old peer key before replacing
  if (state.dhPeer) state.dhPeer.fill(0);
  state.dhPeer = peerPublicKey;
  state.dhPeerHex = toHex(peerPublicKey);

  // Wipe old chain keys before replacing
  if (state.chainKeyRecv) state.chainKeyRecv.fill(0);
  if (state.chainKeySend) state.chainKeySend.fill(0);

  // Derive receiving chain
  const dhRecv = await dhExchange(state.dhSelf.privateKey, peerPublicKey);
  const oldRootKey1 = state.rootKey;
  const [rootKey1, chainKeyRecv] = await kdfRootChain(state.rootKey, dhRecv);
  dhRecv.fill(0); // wipe DH output
  oldRootKey1.fill(0); // wipe old root key
  state.rootKey = rootKey1;
  state.chainKeyRecv = chainKeyRecv;

  // Generate new DH keypair and derive sending chain
  const oldDhSelf = state.dhSelf;
  state.dhSelf = await generateDHKeyPair();
  oldDhSelf.publicKey.fill(0); // wipe old DH public key
  const dhSend = await dhExchange(state.dhSelf.privateKey, peerPublicKey);
  const intermediateRootKey = state.rootKey;
  const [rootKey2, chainKeySend] = await kdfRootChain(state.rootKey, dhSend);
  dhSend.fill(0); // wipe DH output
  intermediateRootKey.fill(0); // wipe intermediate root key
  state.rootKey = rootKey2;
  state.chainKeySend = chainKeySend;
}

/** Skip message keys for out-of-order delivery. */
async function skipMessageKeys(state: RatchetState, until: number): Promise<void> {
  if (!state.chainKeyRecv) return;
  if (until - state.nRecv > MAX_SKIP) throw new Error("Too many skipped messages");
  const pubHex = state.dhPeerHex;

  while (state.nRecv < until) {
    const oldChainKey = state.chainKeyRecv!;
    const [newChainKey, mk] = await kdfChain(oldChainKey);
    oldChainKey.fill(0); // wipe old chain key
    state.chainKeyRecv = newChainKey;
    state.skippedKeys.set(`${pubHex}:${state.nRecv}`, mk);
    state.nRecv++;

    // Evict oldest entries if over limit (Map preserves insertion order)
    if (state.skippedKeys.size > MAX_SKIP * 2) {
      const excess = state.skippedKeys.size - MAX_SKIP;
      const iter = state.skippedKeys.keys();
      for (let i = 0; i < excess; i++) {
        const k = iter.next().value;
        if (k !== undefined) {
          // Zero skipped keys before eviction (item 7)
          const evicted = state.skippedKeys.get(k);
          if (evicted) evicted.fill(0);
          state.skippedKeys.delete(k);
        }
      }
    }
  }
}

/** Try to find a skipped message key. Returns and removes it if found. O(1) Map lookup. */
function trySkippedKey(
  state: RatchetState, pubKeyHex: string, nr: number,
): Uint8Array | null {
  const key = `${pubKeyHex}:${nr}`;
  const mk = state.skippedKeys.get(key);
  if (!mk) return null;
  state.skippedKeys.delete(key);
  return mk;
}

/* ═══════════════════════════════════════════════════════════════════
   Message Wire Format
   ═══════════════════════════════════════════════════════════════════
   Header:
     [0]      flags (1B): bit0 = isFile
     [1..65]  ratchet public key (65B, uncompressed P-256)
     [66..69] message counter (4B LE)
     [70..73] previous chain length (4B LE)
     [74..85] nonce (12B)
   Payload:
     [86..]   AES-256-GCM ciphertext (includes 16B auth tag)

   For file messages, the plaintext is:
     [0..3]   filename length (4B LE)
     [4..4+N] filename (UTF-8)
     [4+N..]  file type (null-terminated) + file bytes
   ═══════════════════════════════════════════════════════════════════ */

const HEADER_SIZE = 86;

function buildHeader(
  flags: number, pubKey: Uint8Array, counter: number, prevChainLen: number, nonce: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header[0] = flags;
  header.set(pubKey, 1);
  view.setUint32(66, counter, true);
  view.setUint32(70, prevChainLen, true);
  header.set(nonce, 74);
  return header;
}

function parseHeader(data: Uint8Array): {
  flags: number;
  pubKey: Uint8Array;
  counter: number;
  prevChainLen: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    flags: data[0],
    pubKey: data.subarray(1, 66),
    counter: view.getUint32(66, true),
    prevChainLen: view.getUint32(70, true),
    nonce: data.subarray(74, 86),
    ciphertext: data.subarray(86),
  };
}

function encodeFilePlaintext(fileName: string, fileType: string, fileBytes: Uint8Array): Uint8Array {
  const nameBytes = TE.encode(fileName);
  const typeBytes = TE.encode(fileType);
  const buf = new Uint8Array(4 + nameBytes.length + typeBytes.length + 1 + fileBytes.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, nameBytes.length, true);
  buf.set(nameBytes, 4);
  buf.set(typeBytes, 4 + nameBytes.length);
  buf[4 + nameBytes.length + typeBytes.length] = 0; // null terminator for type
  buf.set(fileBytes, 4 + nameBytes.length + typeBytes.length + 1);
  return buf;
}

/** Strip path separators, control chars, and null bytes from a filename. */
function sanitizeFileName(name: string): string {
  // Remove path separators and null bytes, then strip control characters (U+0000–U+001F, U+007F)
  return name.replace(/[/\\]/g, "_").replace(/[\x00-\x1f\x7f]/g, "") || "file";
}

function decodeFilePlaintext(data: Uint8Array): { fileName: string; fileType: string; fileBytes: Uint8Array } {
  if (data.length < 5) throw new Error("file payload too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nameLen = view.getUint32(0, true);
  if (nameLen > data.length - 4) throw new Error("file name length exceeds payload");
  const fileName = sanitizeFileName(TD.decode(data.subarray(4, 4 + nameLen)));
  // Find null terminator after name
  let typeEnd = 4 + nameLen;
  while (typeEnd < data.length && data[typeEnd] !== 0) typeEnd++;
  const fileType = TD.decode(data.subarray(4 + nameLen, typeEnd));
  const fileBytes = data.subarray(typeEnd + 1);
  return { fileName, fileType, fileBytes };
}

/* ═══════════════════════════════════════════════════════════════════
   File Chunking for DataChannel
   ═══════════════════════════════════════════════════════════════════
   WebRTC DataChannels have message size limits (~256KB typically,
   but 16KB is the safe max for interoperability). We chunk large
   messages and reassemble on the other side.

   Chunk format:
     [0]      chunk type (0x01 = start, 0x02 = continue, 0x03 = end, 0x04 = single)
     [1..4]   total message length (4B LE, only in start chunk)
     [5..]    chunk data
   ═══════════════════════════════════════════════════════════════════ */

const CHUNK_SIZE = 15_360; // 15KB payload per chunk (under 16KB DataChannel limit)
const CHUNK_START = 0x01;
const CHUNK_CONTINUE = 0x02;
const CHUNK_END = 0x03;
const CHUNK_SINGLE = 0x04;
const BUFFERED_AMOUNT_LOW = 64 * 1024;    // 64 KB backpressure threshold
const HEARTBEAT_INTERVAL = 15_000;        // send ping every 15s
const HEARTBEAT_TIMEOUT  = 45_000;        // drop peer after 45s silence

/**
 * Chunk a message for DataChannel transport, baking in a wire prefix byte
 * at position [0] of each chunk. This avoids a second allocation + copy
 * in encryptAndSend — chunks are ready to send directly.
 */
function chunkMessagePrefixed(data: Uint8Array, prefix: number): Uint8Array[] {
  if (data.length <= CHUNK_SIZE) {
    const chunk = new Uint8Array(2 + data.length);
    chunk[0] = prefix;
    chunk[1] = CHUNK_SINGLE;
    chunk.set(data, 2);
    return [chunk];
  }

  const chunks: Uint8Array[] = [];
  let offset = 0;

  // Start chunk: prefix + type + total length (4B) + payload
  const startPayload = Math.min(CHUNK_SIZE - 4, data.length);
  const startChunk = new Uint8Array(6 + startPayload);
  startChunk[0] = prefix;
  startChunk[1] = CHUNK_START;
  new DataView(startChunk.buffer).setUint32(2, data.length, true);
  startChunk.set(data.subarray(0, startPayload), 6);
  chunks.push(startChunk);
  offset = startPayload;

  // Continue / end chunks
  while (offset < data.length) {
    const remaining = data.length - offset;
    const payloadSize = Math.min(CHUNK_SIZE, remaining);
    const isLast = offset + payloadSize >= data.length;

    const chunk = new Uint8Array(2 + payloadSize);
    chunk[0] = prefix;
    chunk[1] = isLast ? CHUNK_END : CHUNK_CONTINUE;
    chunk.set(data.subarray(offset, offset + payloadSize), 2);
    chunks.push(chunk);
    offset += payloadSize;
  }

  return chunks;
}

class ChunkAssembler {
  private chunks: Uint8Array[] = [];
  private receiving = false;

  /** Feed a chunk. Returns the complete message when all chunks received, or null if incomplete. */
  feed(chunk: Uint8Array): Uint8Array | null {
    const type = chunk[0];

    if (type === CHUNK_SINGLE) {
      return chunk.subarray(1);
    }

    if (type === CHUNK_START) {
      // Don't pre-allocate from peer-declared totalLength — just start collecting
      this.reset();
      this.receiving = true;
      const payload = chunk.subarray(5); // skip type(1) + totalLength(4)
      if (payload.length > 0) this.chunks.push(payload.slice());
      return null;
    }

    if ((type === CHUNK_CONTINUE || type === CHUNK_END) && this.receiving) {
      const payload = chunk.subarray(1);
      if (payload.length > 0) this.chunks.push(payload.slice());

      if (type === CHUNK_END) {
        // Concatenate all collected payloads — bounded by what peer actually sent
        const parts = this.chunks;
        this.reset();
        if (parts.length === 1) return parts[0];
        let total = 0;
        for (const p of parts) total += p.length;
        const result = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) { result.set(p, offset); offset += p.length; }
        return result;
      }
    }

    return null;
  }

  reset(): void {
    this.chunks = [];
    this.receiving = false;
  }
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

  // Callbacks
  onStateChange: WhisperLiveCallbacks["onStateChange"];
  onFingerprint: WhisperLiveCallbacks["onFingerprint"];
  onMessage: WhisperLiveCallbacks["onMessage"];
  onLog: WhisperLiveCallbacks["onLog"];

  private rtcConfig: RTCConfiguration;

  constructor(callbacks: WhisperLiveCallbacks, options: WhisperLiveSessionOptions = {}) {
    this.onStateChange = callbacks.onStateChange;
    this.onFingerprint = callbacks.onFingerprint;
    this.onMessage = callbacks.onMessage;
    this.onLog = callbacks.onLog;

    this.rtcConfig = options.rtcConfig ?? WHISPER_LIVE_RTC_LOCAL_ONLY;
    this.externalAssistEstablishmentOnly = options.externalAssistEstablishmentOnly ?? true;
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
      this.log(`external assist disable failed: ${err instanceof Error ? err.message : "unknown"}`);
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
          this.log(`restart failed: ${err instanceof Error ? err.message : "unknown"}`);
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
   *   [0x10] + publicKey (65B)                → key exchange message
   *   [0x11] + ratchetPubKey (65B)            → ratchet init (offerer sends initial DH pubkey)
   *   [0x20] + encryptedMessage               → encrypted chat message
   *   [0x30]                                   → fingerprint confirmed
   *   [0x31]                                   → fingerprint rejected
   *   [0x40]                                   → ping (heartbeat)
   *   [0x41]                                   → pong (heartbeat reply)
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
      const msg = new Uint8Array(1 + pubKeyRaw.length);
      msg[0] = 0x10;
      msg.set(pubKeyRaw, 1);
      this.dc.send(msg);

      // Store private key for derivation when peer's key arrives
      this.ephPrivateKey = keyPair.privateKey;
    } catch (err) {
      this.log(`key exchange failed: ${err instanceof Error ? err.message : "unknown error"}`);
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
          const rMsg = new Uint8Array(1 + dhSelf.publicKey.length);
          rMsg[0] = 0x11;
          rMsg.set(dhSelf.publicKey, 1);
          this.dc.send(rMsg);
          this.log("sent initial ratchet key");
        }
      }
      // Answerer waits for 0x11 from the offerer

      this.setState("verifying");
    } catch (err) {
      this.log(`key derivation failed: ${err instanceof Error ? err.message : "unknown error"}`);
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
        const rMsg = new Uint8Array(1 + this.ratchetState.dhSelf.publicKey.length);
        rMsg[0] = 0x11;
        rMsg.set(this.ratchetState.dhSelf.publicKey, 1);
        this.dc.send(rMsg);
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
      case 0x10: // Key exchange
        await this.handleKeyExchangeMessage(bytes.subarray(1));
        break;
      case 0x11: // Ratchet init
        await this.handleRatchetInit(bytes.subarray(1));
        break;
      case 0x20: // Encrypted message
        await this.handleEncryptedMessage(bytes.subarray(1));
        break;
      case 0x30: // Fingerprint confirmed
        this.log("peer confirmed fingerprint");
        break;
      case 0x31: // Fingerprint rejected
        this.log("peer rejected fingerprint, aborting");
        this.setState("error", "Peer rejected fingerprint, possible interception");
        this.cleanupConnection();
        break;
      case 0x40: // Ping — peer is alive, reply with pong
        this.lastPongReceived = Date.now();
        this.dc?.send(new Uint8Array([0x41]));
        break;
      case 0x41: // Pong — peer acknowledged our ping
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

      const isFile = (header.flags & 0x01) !== 0;

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
      this.log(`decrypt failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  /* ── Sending ────────────────────────────────────────────── */

  /** Enqueue a send job — serializes through sendQueue so ratchet state is never concurrent. */
  private enqueueSend(job: () => Promise<void>): Promise<void> {
    const wrapped = () => job().catch((err) => {
      this.log(`send failed: ${err instanceof Error ? err.message : "unknown"}`);
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
      await this.encryptAndSend(plaintext, 0x01);
      this.onMessage({
        type: "file", direction: "self",
        fileName: file.name, fileSize: fileBytes.length, fileType: file.type,
        timestamp: Date.now(),
      });
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
      await this.encryptAndSend(plaintext, 0x01);

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
      this.log(`steganography failed, sending directly: ${err instanceof Error ? err.message : "unknown"}`);
      const plaintext = encodeFilePlaintext(fileName, fileType, fileBytes);
      await this.encryptAndSend(plaintext, 0x01);
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
    const chunks = chunkMessagePrefixed(wireMessage, 0x20);
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
    this.dc?.send(new Uint8Array([0x30]));
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

    this.dc?.send(new Uint8Array([0x31]));
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
      if (this.dc?.readyState === "open") this.dc.send(new Uint8Array([0x40]));
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

/* ═══════════════════════════════════════════════════════════════════
   Minimal PNG Carrier (for Dressed mode)
   ═══════════════════════════════════════════════════════════════════
   Creates a small 8x8 transparent PNG as a carrier for dressed messages.
   This is used when the user doesn't provide their own carrier file.
   ═══════════════════════════════════════════════════════════════════ */

function createMinimalPNGCarrier(): Uint8Array {
  // 8x8 RGBA transparent PNG
  // Pre-built minimal valid PNG bytes
  const header = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
  ]);

  // IHDR chunk: 8x8, 8-bit RGBA
  const ihdr = pngChunk("IHDR", (() => {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);
    view.setUint32(0, 8); // width
    view.setUint32(4, 8); // height
    data[8] = 8;  // bit depth
    data[9] = 6;  // color type (RGBA)
    data[10] = 0; // compression
    data[11] = 0; // filter
    data[12] = 0; // interlace
    return data;
  })());

  // IDAT chunk: 8 rows of 8 pixels, all zero (transparent)
  // Each row: filter byte (0) + 32 bytes (8 pixels * 4 channels)
  const rawData = new Uint8Array(8 * (1 + 8 * 4)); // all zeros = transparent

  // Compress with deflate (store block, no compression for simplicity)
  const deflated = deflateStore(rawData);

  const idat = pngChunk("IDAT", deflated);
  const iend = pngChunk("IEND", new Uint8Array(0));

  return concatBytes(header, ihdr, idat, iend);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = TE.encode(type);
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);

  // Length
  view.setUint32(0, data.length);

  // Type
  chunk.set(typeBytes, 4);

  // Data
  chunk.set(data, 8);

  // CRC32 over type + data
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);

  return chunk;
}

function deflateStore(data: Uint8Array): Uint8Array {
  // Zlib wrapper with store (no compression) deflate blocks
  // Header: CMF=0x78, FLG=0x01
  const maxBlock = 65535;
  const blocks: Uint8Array[] = [];
  let offset = 0;

  while (offset < data.length) {
    const remaining = data.length - offset;
    const blockSize = Math.min(maxBlock, remaining);
    const isLast = offset + blockSize >= data.length;

    const blockHeader = new Uint8Array(5);
    blockHeader[0] = isLast ? 0x01 : 0x00;
    blockHeader[1] = blockSize & 0xFF;
    blockHeader[2] = (blockSize >> 8) & 0xFF;
    blockHeader[3] = ~blockSize & 0xFF;
    blockHeader[4] = (~blockSize >> 8) & 0xFF;

    blocks.push(blockHeader);
    blocks.push(data.subarray(offset, offset + blockSize));
    offset += blockSize;
  }

  // Adler-32 checksum
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = new Uint8Array(4);
  const adlerView = new DataView(adler.buffer);
  adlerView.setUint32(0, (b << 16) | a);

  return concatBytes(new Uint8Array([0x78, 0x01]), ...blocks, adler);
}

// CRC32 lookup table
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
