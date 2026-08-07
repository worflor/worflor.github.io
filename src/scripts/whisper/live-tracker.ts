/**
 * Whisper Live — tracker-based auto-signaling.
 *
 * Piggybacks on WebTorrent tracker WebSocket infrastructure to exchange sealed
 * SDP codes between two peers who share a phrase. The tracker sees only encrypted
 * blobs — it thinks it's brokering a torrent swarm.
 *
 * Server etiquette: one socket per tracker, all hashes multiplexed on it,
 * race trackers but kill the loser immediately, send `stopped` on exit.
 */

import { randomBytes } from "./wasm";
import { TE, TD, hkdf } from "./live-crypto";
import { derivePhraseRoot, derivePhraseScopedKey } from "./live-handshake";

/* ── API ──────────────────────────────────────────────────── */

export interface LiveRendezvousResult {
  role: "offerer" | "answerer";
  peerAnswerCode?: string; // present when role === "offerer"
  relay?: TrackerRelayHandle;
}

interface TrackerSignalCallbacks {
  onStatus: (msg: string) => void;
  onLog: (msg: string) => void;
}

export type LiveRendezvousMode = "simultaneous" | "flare-listener";

export type TrackerConnectErrorCode =
  | "peer-not-found"
  | "relay-unavailable"
  | "handshake-failed"
  | "flare-relay-dropped";

export interface LiveRendezvousCallbacks extends TrackerSignalCallbacks {
  onPeerArrived?: () => Promise<boolean>;
}

export interface LiveRendezvousOptions {
  mode: LiveRendezvousMode;
  phrase: string;
  createOfferCode?: () => Promise<string>;
  acceptOfferCode: (peerOfferCode: string) => Promise<string>;
  callbacks: LiveRendezvousCallbacks;
  signal?: AbortSignal;
}

export type TrackerRelaySignal =
  | { kind: "answer-ack" }
  | { kind: "ice"; candidate: RTCIceCandidateInit | null }
  | { kind: "restart-offer"; code: string }
  | { kind: "restart-answer"; code: string };

export interface TrackerRelayHandle {
  destroy: () => void;
  sendSignal: (signal: TrackerRelaySignal) => void;
  setOnSignal: (cb: ((signal: TrackerRelaySignal) => void) | null) => void;
}

export function trackerErrorCode(err: unknown): TrackerConnectErrorCode | null {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (raw.includes("peer-not-found")) return "peer-not-found";
  if (raw.includes("relay-unavailable")) return "relay-unavailable";
  if (raw.includes("handshake-failed")) return "handshake-failed";
  if (raw.includes("flare-relay-dropped")) return "flare-relay-dropped";
  return null;
}

/* ── Constants ────────────────────────────────────────────── */

export const TRACKER_URLS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
];

const WS_CONNECT_TIMEOUT = 5_000;
const TOTAL_TIMEOUT = 45_000;
const REANNOUNCE_INTERVAL = 10_000;
export const EPOCH_WINDOW = 2 * 60 * 1000;
const EPOCH_BOUNDARY_MARGIN = 15_000;
export const PADDED_CODE_LEN = 1024;
export const PAD_CHAR = ".";
export const MIN_CODE_LEN = 40;
export const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
export const TRACKER_MAX_MESSAGE_LEN = 8192;
const TRACKER_SIGNAL_TYPE = "whisper-signal";
const TRACKER_INTENT_TYPE = "whisper-intent";
const TRACKER_MATCH_ACK_TYPE = "whisper-match-ack";
const TRACKER_OFFER_CODE_TYPE = "whisper-offer-code";
const TRACKER_ANSWER_CODE_TYPE = "whisper-answer-code";

// Concurrent tracker socket budget (module-scoped, survives pool teardown).
let liveSockets = 0;
const MAX_SOCKETS = 6;

/* ── Helpers ──────────────────────────────────────────────── */

export function toBin(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const TRACKER_HASH_INFO   = TE.encode("whisper-tracker-room");
const TRACKER_SELECT_INFO = TE.encode("whisper-tracker-select");
const ZERO_SALT_32 = new Uint8Array(32);

/** Hash the phrase once for use across all tracker derivations. Caller must wipe. */
async function trackerPhraseHash(phrase: string): Promise<Uint8Array> {
  const phraseRoot = await derivePhraseRoot(phrase);
  try {
    return await derivePhraseScopedKey(phraseRoot, "tracker-root", 32);
  } finally {
    phraseRoot.fill(0);
  }
}

export async function deriveInfoHashes(phrase: string): Promise<string[]> {
  const now = Date.now();
  const epoch = Math.floor(now / EPOCH_WINDOW);
  const phraseHash = await trackerPhraseHash(phrase);
  const cur = await hkdf(phraseHash, TE.encode(String(epoch)), TRACKER_HASH_INFO, 20);
  const hashes: string[] = [toBin(cur)];
  if (now - epoch * EPOCH_WINDOW < EPOCH_BOUNDARY_MARGIN) {
    const prev = await hkdf(phraseHash, TE.encode(String(epoch - 1)), TRACKER_HASH_INFO, 20);
    hashes.push(toBin(prev));
  }
  phraseHash.fill(0);
  return hashes;
}

/**
 * Derive a deterministic tracker ordering from the phrase.
 * Both peers independently produce the same rotation, so they naturally
 * converge on the same primary tracker. Sessions distribute across the
 * pool by phrase — an adversary watching any single tracker sees only
 * a 1/N fraction rather than everything.
 */
export async function deriveTrackerOrder(phrase: string, urls: readonly string[]): Promise<string[]> {
  if (urls.length <= 1) return [...urls];
  const phraseHash = await trackerPhraseHash(phrase);
  const indexBytes = await hkdf(phraseHash, ZERO_SALT_32, TRACKER_SELECT_INFO, 4);
  phraseHash.fill(0);
  const idx = new DataView(indexBytes.buffer, indexBytes.byteOffset).getUint32(0, false) % urls.length;
  return [...urls.slice(idx), ...urls.slice(0, idx)];
}

export function randomBinId(): string {
  return toBin(randomBytes(20));
}

export function padCode(code: string): string {
  if (code.length >= PADDED_CODE_LEN) return code;
  return code + PAD_CHAR.repeat(PADDED_CODE_LEN - code.length);
}

export function unpadCode(code: string): string {
  const idx = code.indexOf(PAD_CHAR);
  return idx === -1 ? code : code.slice(0, idx);
}

export function makeTrackerAnnouncePayloads(
  infoHashes: string[],
  peerId: string,
  offerId: string,
  paddedOffer: string,
): string[] {
  return infoHashes.map((h) => JSON.stringify({
    action: "announce",
    info_hash: h,
    peer_id: peerId,
    numwant: 1,
    offers: [{ offer_id: offerId, offer: { type: "offer", sdp: paddedOffer } }],
  }));
}

/** presence-only announce, no SDP offers attached. used by flares to sit in
 *  the swarm and receive offers from relay peers without advertising their own. */
export function makeTrackerPresencePayloads(
  infoHashes: string[],
  peerId: string,
): string[] {
  return infoHashes.map((h) => JSON.stringify({
    action: "announce",
    info_hash: h,
    peer_id: peerId,
    numwant: 1,
    offers: [],
  }));
}

export function makeTrackerStoppedPayloads(infoHashes: string[], peerId: string): string[] {
  return infoHashes.map((h) => JSON.stringify({
    action: "announce",
    info_hash: h,
    peer_id: peerId,
    event: "stopped",
  }));
}

export function parseTrackerMessage(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > TRACKER_MAX_MESSAGE_LEN) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = (s + "=".repeat(pad)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeTrackerRelaySignal(signal: TrackerRelaySignal): string {
  return b64url(TE.encode(JSON.stringify(signal)));
}

function decodeTrackerRelaySignal(encoded: string): TrackerRelaySignal | null {
  try {
    const parsed = JSON.parse(TD.decode(b64urlDecode(encoded))) as Partial<TrackerRelaySignal>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") return null;
    if (parsed.kind === "answer-ack") return { kind: "answer-ack" };
    if (parsed.kind === "ice") {
      if (!("candidate" in parsed)) return null;
      return { kind: "ice", candidate: (parsed as { candidate: RTCIceCandidateInit | null }).candidate ?? null };
    }
    if ((parsed.kind === "restart-offer" || parsed.kind === "restart-answer") && typeof (parsed as { code?: unknown }).code === "string") {
      return { kind: parsed.kind, code: (parsed as { code: string }).code };
    }
    return null;
  } catch {
    return null;
  }
}

interface TrackerIntentPayload {
  attemptId: string;
  sessionTag: string;
  issuedAt: number;
}

interface TrackerMatchAckPayload {
  rendezvousId: string;
  fromAttemptId: string;
  fromSessionTag: string;
  toSessionTag: string;
  issuedAt: number;
}

interface TrackerOfferCodePayload {
  rendezvousId: string;
  code: string;
  fromSessionTag: string;
  toSessionTag: string;
  issuedAt: number;
}

interface TrackerAnswerCodePayload {
  rendezvousId: string;
  code: string;
  fromSessionTag: string;
  toSessionTag: string;
  issuedAt: number;
}

function encodeTrackerPayload<T>(payload: T): string {
  return b64url(TE.encode(JSON.stringify(payload)));
}

function decodeTrackerPayload<T>(encoded: unknown): T | null {
  if (typeof encoded !== "string" || !encoded) return null;
  try {
    return JSON.parse(TD.decode(b64urlDecode(unpadCode(encoded)))) as T;
  } catch {
    return null;
  }
}

// the WebTorrent tracker protocol requires offer.type === "offer" and
// answer.type === "answer" for routing. custom types are silently dropped.
// encode the whisper message type as a prefix in the sdp field instead:
// sdp = "whisper-intent:base64payload" — the tracker treats sdp as opaque.

function whisperSdp(whisperType: string, payload: string): string {
  return `${whisperType}:${payload}`;
}

function parseWhisperSdp(sdp: unknown): { whisperType: string; payload: string } | null {
  if (typeof sdp !== "string") return null;
  const i = sdp.indexOf(":");
  if (i < 1) return null;
  return { whisperType: sdp.slice(0, i), payload: sdp.slice(i + 1) };
}

function makeIntentPayloads(
  infoHashes: string[],
  peerId: string,
  offerId: string,
  attemptId: string,
  sessionTag: string,
): string[] {
  const encoded = encodeTrackerPayload<TrackerIntentPayload>({
    attemptId,
    sessionTag,
    issuedAt: Date.now(),
  });
  return infoHashes.map((h) => JSON.stringify({
    action: "announce",
    info_hash: h,
    peer_id: peerId,
    numwant: 1,
    offers: [{
      offer_id: offerId,
      offer: {
        type: "offer",
        sdp: whisperSdp(TRACKER_INTENT_TYPE, encoded),
      },
    }],
  }));
}

function makeMatchAckPayload(
  infoHash: string,
  peerId: string,
  toPeerId: string,
  offerId: string,
  rendezvousId: string,
  fromAttemptId: string,
  fromSessionTag: string,
  toSessionTag: string,
): string {
  return JSON.stringify({
    action: "announce",
    info_hash: infoHash,
    peer_id: peerId,
    to_peer_id: toPeerId,
    answer: {
      type: "answer",
      sdp: whisperSdp(TRACKER_MATCH_ACK_TYPE, encodeTrackerPayload<TrackerMatchAckPayload>({
        rendezvousId,
        fromAttemptId,
        fromSessionTag,
        toSessionTag,
        issuedAt: Date.now(),
      })),
    },
    offer_id: offerId,
  });
}

function makeOfferCodePayload(
  infoHash: string,
  peerId: string,
  toPeerId: string,
  rendezvousId: string,
  offerId: string,
  offerCode: string,
  fromSessionTag: string,
  toSessionTag: string,
): string {
  return JSON.stringify({
    action: "announce",
    info_hash: infoHash,
    peer_id: peerId,
    numwant: 1,
    offers: [{
      offer_id: offerId,
      offer: {
        type: "offer",
        sdp: padCode(whisperSdp(TRACKER_OFFER_CODE_TYPE, encodeTrackerPayload<TrackerOfferCodePayload>({
          rendezvousId,
          code: offerCode,
          fromSessionTag,
          toSessionTag,
          issuedAt: Date.now(),
        }))),
        whisper_session: rendezvousId,
        to_peer_id: toPeerId,
      },
    }],
  });
}

function makeAnswerCodePayload(
  infoHash: string,
  peerId: string,
  toPeerId: string,
  rendezvousId: string,
  offerId: string,
  answerCode: string,
  fromSessionTag: string,
  toSessionTag: string,
): string {
  return JSON.stringify({
    action: "announce",
    info_hash: infoHash,
    peer_id: peerId,
    to_peer_id: toPeerId,
    answer: {
      type: "answer",
      sdp: padCode(whisperSdp(TRACKER_ANSWER_CODE_TYPE, encodeTrackerPayload<TrackerAnswerCodePayload>({
        rendezvousId,
        code: answerCode,
        fromSessionTag,
        toSessionTag,
        issuedAt: Date.now(),
      }))),
      whisper_session: rendezvousId,
    },
    offer_id: offerId,
  });
}

/**
 * The name of one side of a rendezvous. Two peers, two keys, one order.
 */
export function attemptKey(peerId: string, attemptId: string): string {
  return `${peerId}:${attemptId}`;
}

/**
 * THE order on attempt keys. Code units, nothing else.
 *
 * Both peers must derive the same answer from the same pair of strings while
 * sharing no state, so the comparison has to be a pure function of the bytes.
 * `localeCompare` is not: with no locale argument it uses the HOST's, and the
 * two peers are different hosts. Measured over random ids of the shape actually
 * used here, en and sv order 4.79% of pairs oppositely (da 4.56%, lt 1.61%,
 * tr 0.14%, pl 0.09%). Each disagreement hands both peers the same role — both
 * offerer, or both answerer, which `handleMatchAck` then turns into both
 * offerer — and the handshake dies with the two sides disagreeing about who is
 * who.
 *
 * The ids make it worse than a normal collation hazard: `randomBinId` is raw
 * bytes rendered with `String.fromCharCode`, so these strings are full of
 * control characters and punctuation, exactly the code points collation treats
 * as ignorable or variable-weighted rather than as data.
 *
 * The same file already needed this order once, in `createRendezvousId`, and got
 * it right there by using a plain sort. One pair of strings had two orderings;
 * now both callers read this.
 */
export function compareAttemptKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createRendezvousId(
  localPeerId: string,
  localAttemptId: string,
  remotePeerId: string,
  remoteAttemptId: string,
): string {
  const [first, second] = [
    attemptKey(localPeerId, localAttemptId),
    attemptKey(remotePeerId, remoteAttemptId),
  ].sort(compareAttemptKeys);
  return encodeTrackerPayload({ peers: [first, second] });
}

export function compareAttemptOrder(
  localPeerId: string,
  localAttemptId: string,
  remotePeerId: string,
  remoteAttemptId: string,
): number {
  return compareAttemptKeys(
    attemptKey(localPeerId, localAttemptId),
    attemptKey(remotePeerId, remoteAttemptId),
  );
}

// issuedAt is validated for shape only. we deliberately do NOT reject on a
// wall-clock age window: the two devices' clocks are independent and unsynced,
// so a stamped TTL silently froze out any peer whose clock drifted. replay
// within a rendezvous is already prevented by seenMessages, and cross-session
// bleed by sessionTag, so an absolute-time gate is pure fragility here.
/** deliberately shape-only: a wall-clock freshness gate lived here once
 *  (30s ttl) and silently froze out peers with drifted device clocks —
 *  see the old-timestamp regression test. ghost messages from previous
 *  rendezvous are excluded by identity (recentGhosts below), never by
 *  comparing unsynced clocks. */
function isValidIssuedAt(issuedAt: unknown): issuedAt is number {
  return typeof issuedAt === "number" && Number.isFinite(issuedAt);
}

/** identities from this page's previous rendezvous attempts. a new attempt
 *  must never lock onto an echo of a dead one: the tracker can replay a
 *  prior session's intent, and locking onto that ghost while the real peer
 *  handshakes fresh is the intermittent "handshake proof mismatch" on
 *  reconnect. keyed by peerId|attemptId so a peer retrying with a fresh
 *  attempt is welcomed while its stale echoes are refused. capped. */
const recentGhosts = new Set<string>();

export function rememberRendezvousGhost(peerId: string, attemptId: string): void {
  if (!peerId || !attemptId) return;
  if (recentGhosts.size >= 64) {
    const oldest = recentGhosts.values().next().value;
    if (oldest !== undefined) recentGhosts.delete(oldest);
  }
  recentGhosts.add(`${peerId}|${attemptId}`);
}

function isRendezvousGhost(peerId: string, attemptId: string): boolean {
  return recentGhosts.has(`${peerId}|${attemptId}`);
}

/* ── Shared helpers ──────────────────────────────────────── */

/** add key to a capped set. returns true if the key was new. */
export function rememberSeen(set: Set<string>, key: string, cap = 1024): boolean {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
  return true;
}

/* ── TrackerPool ─────────────────────────────────────────── */

const POOL_CONNECT_TIMEOUT = 8_000;
const POOL_RECONNECT_BASE = 2_000;
const POOL_RECONNECT_CAP = 30_000;
const POOL_EPOCH_CHECK_INTERVAL = 30_000;

export interface TrackerPoolCallbacks {
  onLog: (msg: string) => void;
  /** called on each announce cycle (initial + re-announce + epoch refresh).
   *  return the payloads to send on every open socket. */
  makeAnnounce: (hashes: string[]) => string[];
  /** called for every parsed tracker message on any socket.
   *  hash filtering already applied, only messages matching current hashes arrive. */
  onMessage: (msg: Record<string, unknown>, ws: WebSocket) => void;
  /** fires when any socket opens */
  onReady?: () => void;
  /** fires when all sockets are down simultaneously */
  onAllDown?: () => void;
  /** periodic announce cadence, defaults to epoch checks only */
  announceIntervalMs?: number;
}

export interface TrackerPoolHandle {
  /** current epoch hashes */
  readonly hashes: string[];
  /** send payloads on all open sockets */
  sendAll: (payloads: string[]) => void;
  /** send payloads on a specific socket */
  sendOn: (ws: WebSocket, payloads: string[]) => void;
  /** tear down everything (idempotent) */
  destroy: () => void;
}

export function createTrackerPool(
  phrase: string,
  peerId: string,
  initialHashes: string[],
  callbacks: TrackerPoolCallbacks,
  signal: AbortSignal,
): TrackerPoolHandle {
  let destroyed = false;
  let currentHashes = initialHashes;
  let lastEpoch = Math.floor(Date.now() / EPOCH_WINDOW);
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  const announceIntervalMs = callbacks.announceIntervalMs ?? POOL_EPOCH_CHECK_INTERVAL;

  const sockets = new Map<string, WebSocket>();
  const connectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectDelayByUrl = new Map<string, number>();
  const clearConnectTimer = (url: string): void => {
    const timer = connectTimers.get(url);
    if (timer) clearTimeout(timer);
    connectTimers.delete(url);
  };

  const closeSocket = (ws: WebSocket): void => {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(1000); } catch { /* noop */ }
  };

  // ── send helpers ──

  const sendOn = (ws: WebSocket, payloads: string[]): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const p of payloads) {
      try { ws.send(p); } catch { break; }
    }
  };

  const sendAll = (payloads: string[]): void => {
    for (const ws of sockets.values()) sendOn(ws, payloads);
  };

  // ── epoch refresh ──

  // refreshes epoch hashes if needed, but does NOT re-announce.
  // the maintenance interval always re-announces after this returns,
  // so the announce path is unified in one place.
  const refreshEpochPresence = async (): Promise<void> => {
    if (destroyed) return;
    const epoch = Math.floor(Date.now() / EPOCH_WINDOW);
    if (epoch === lastEpoch) return;

    callbacks.onLog("renewing presence");

    const oldHashes = currentHashes;
    let nextHashes: string[];
    try {
      nextHashes = await deriveInfoHashes(phrase);
    } catch {
      callbacks.onLog("renewal skipped (hash refresh failed)");
      return;
    }
    if (destroyed) return;

    sendAll(makeTrackerStoppedPayloads(oldHashes, peerId));
    lastEpoch = epoch;
    currentHashes = nextHashes;
  };

  // ── reconnect ──

  const scheduleReconnect = (url: string): void => {
    if (destroyed) return;
    if (reconnectTimers.has(url)) return;

    const host = new URL(url).host;
    const delay = reconnectDelayByUrl.get(url) ?? POOL_RECONNECT_BASE;
    reconnectDelayByUrl.set(url, Math.min(delay * 2, POOL_RECONNECT_CAP));

    callbacks.onLog(`reconnecting via ${host} in ${(delay / 1000).toFixed(0)}s...`);

    const timer = setTimeout(async () => {
      reconnectTimers.delete(url);
      if (destroyed) return;

      try {
        lastEpoch = Math.floor(Date.now() / EPOCH_WINDOW);
        currentHashes = await deriveInfoHashes(phrase);
      } catch {
        if (!destroyed) scheduleReconnect(url);
        return;
      }
      if (destroyed) return;
      connectToUrl(url);
    }, delay);

    reconnectTimers.set(url, timer);
  };

  // ── per-url socket lifecycle ──

  const connectToUrl = (url: string): void => {
    if (destroyed) return;
    if (sockets.has(url)) return;
    if (liveSockets >= MAX_SOCKETS) return;

    const host = new URL(url).host;

    let opened = false;
    let closeHandled = false;
    const releaseSocket = () => { if (!closeHandled) { closeHandled = true; liveSockets--; } };
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      connectTimer = null;
      connectTimers.delete(url);
      if (closeHandled) return;
      releaseSocket();
      const sock = sockets.get(url);
      if (sock) sockets.delete(url);
      if (sock) {
        try { sock.close(); } catch { /* noop */ }
      }
      if (!destroyed) scheduleReconnect(url);
    }, POOL_CONNECT_TIMEOUT);
    connectTimers.set(url, connectTimer);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
      liveSockets++;
    } catch {
      if (connectTimer) connectTimer = null;
      clearConnectTimer(url);
      scheduleReconnect(url);
      return;
    }
    sockets.set(url, ws);

    const handleDrop = () => {
      if (closeHandled) return;
      releaseSocket();
      connectTimer = null;
      clearConnectTimer(url);
      const cur = sockets.get(url);
      if (cur === ws) sockets.delete(url);
      if (!destroyed) {
        if (opened) callbacks.onLog(`connection dropped via ${host}, reconnecting...`);
        const anyOpen = [...sockets.values()].some(s => s.readyState === WebSocket.OPEN);
        if (!anyOpen) callbacks.onAllDown?.();
        scheduleReconnect(url);
      }
    };

    ws.onopen = () => {
      opened = true;
      connectTimer = null;
      clearConnectTimer(url);
      if (destroyed) return;

      reconnectDelayByUrl.set(url, POOL_RECONNECT_BASE);
      callbacks.onLog(`connected via ${host}`);
      callbacks.onReady?.();

      sendOn(ws, callbacks.makeAnnounce(currentHashes));

      if (!maintenanceTimer) {
        maintenanceTimer = setInterval(() => {
          if (destroyed) return;
          void refreshEpochPresence().then(() => {
            if (!destroyed) sendAll(callbacks.makeAnnounce(currentHashes));
          });
        }, announceIntervalMs);
      }
    };

    ws.onmessage = (event) => {
      if (destroyed) return;

      const msg = parseTrackerMessage(event.data);
      if (!msg) return;

      // filter by hash
      const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : "";
      if (infoHash && !currentHashes.includes(infoHash)) return;

      callbacks.onMessage(msg, ws);
    };

    ws.onerror = () => { /* onclose handles reconnect */ };
    ws.onclose = handleDrop;
  };

  // ── destroy ──

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    signal.removeEventListener("abort", onAbort);

    if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
    for (const t of connectTimers.values()) clearTimeout(t);
    connectTimers.clear();
    for (const t of reconnectTimers.values()) clearTimeout(t);
    reconnectTimers.clear();
    reconnectDelayByUrl.clear();

    const stoppedPayloads = makeTrackerStoppedPayloads(currentHashes, peerId);
    for (const ws of sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        for (const payload of stoppedPayloads) {
          try { ws.send(payload); } catch { break; }
        }
      }
      closeSocket(ws);
      liveSockets--;
    }
    sockets.clear();
  };

  const onAbort = (): void => {
    destroy();
  };

  // ── auto-destroy on abort ──

  if (signal.aborted) {
    destroyed = true;
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // ── connect to all trackers ──

  if (!destroyed) {
    void deriveTrackerOrder(phrase, TRACKER_URLS)
      .then((orderedTrackers) => {
        if (destroyed) return;
        for (const url of orderedTrackers) connectToUrl(url);
      })
      .catch(() => {
        if (destroyed) return;
        for (const url of TRACKER_URLS) connectToUrl(url);
      });
  }

  return {
    get hashes() { return currentHashes; },
    sendAll,
    sendOn,
    destroy,
  };
}

/* ── Main exchange function ───────────────────────────────── */

/* Unified rendezvous engine */

export async function runLiveRendezvous(opts: LiveRendezvousOptions): Promise<LiveRendezvousResult> {
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (opts.mode === "simultaneous" && !opts.createOfferCode) throw new Error("handshake-failed");

  const hashes = await deriveInfoHashes(opts.phrase);
  const peerId = randomBinId();
  const attemptId = randomBinId();
  const sessionTag = randomBinId();
  const intentOfferId = randomBinId();
  const seenMessages = new Set<string>();

  opts.callbacks.onLog(opts.mode === "flare-listener" ? "flare room ready" : "relay room ready");

  return await new Promise<LiveRendezvousResult>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let peerPromptActive = false;
    let offerCreationStarted = false;
    let acceptStarted = false;
    let relaySignalCb: ((signal: TrackerRelaySignal) => void) | null = null;
    const pendingSignals: TrackerRelaySignal[] = [];

    let lockPeerId = "";
    let lockAttemptId = "";
    let lockPeerSessionTag = "";
    let lockInfoHash = "";
    let rendezvousId = "";
    let currentOfferCode: string | null = null;
    let realOfferId = "";
    let role: "offerer" | "answerer" | null = null;
    let pool: TrackerPoolHandle | null = null;

    const totalAc = new AbortController();
    const onExternalAbort = (): void => totalAc.abort();
    const totalTimer = opts.mode === "simultaneous"
      ? setTimeout(() => finish(undefined, new Error("peer-not-found")), TOTAL_TIMEOUT)
      : null;

    const finish = (result?: LiveRendezvousResult, error?: Error): void => {
      if (settled) return;
      settled = true;
      // this attempt's identities are ghosts from here on: a later attempt
      // on this page must never lock onto their tracker echoes.
      rememberRendezvousGhost(peerId, attemptId);
      if (lockPeerId && lockAttemptId) rememberRendezvousGhost(lockPeerId, lockAttemptId);
      if (totalTimer) clearTimeout(totalTimer);
      totalAc.signal.removeEventListener("abort", onAbort);
      opts.signal?.removeEventListener("abort", onExternalAbort);
      if (result) {
        resolve(result);
        return;
      }
      pool?.destroy();
      pool = null;
      reject(error ?? new Error("relay-unavailable"));
    };

    const onAbort = (): void => {
      finish(undefined, new DOMException("Aborted", "AbortError"));
    };

    const emitRelaySignal = (signal: TrackerRelaySignal): void => {
      if (relaySignalCb) {
        relaySignalCb(signal);
      } else {
        pendingSignals.push(signal);
      }
    };

    const lockPeer = (
      remotePeerId: string,
      remoteAttemptId: string,
      remoteSessionTag: string,
      infoHash: string,
    ): boolean => {
      if (!remotePeerId || !remoteAttemptId || !remoteSessionTag) return false;
      // sticky lock: once locked, only the original peer+sessionTag is honored.
      // the old "replace with a newer attempt" branch let the two sides diverge
      // on which session was authoritative, so they matched then deadlocked
      // rejecting each other's offer/answer as "a different session".
      if (lockPeerId) return lockPeerId === remotePeerId && lockPeerSessionTag === remoteSessionTag;
      lockPeerId = remotePeerId;
      lockAttemptId = remoteAttemptId;
      lockPeerSessionTag = remoteSessionTag;
      lockInfoHash = infoHash || hashes[0];
      rendezvousId = createRendezvousId(peerId, attemptId, remotePeerId, remoteAttemptId);
      opts.callbacks.onLog("relay attempt locked to peer");
      return true;
    };

    const buildAnnouncePayloads = (announceHashes: string[]): string[] => {
      if (opts.mode === "flare-listener") {
        return makeTrackerPresencePayloads(announceHashes, peerId);
      }
      if (role === "offerer" && realOfferId && lockPeerId && rendezvousId && currentOfferCode) {
        return announceHashes.map((infoHash) =>
          makeOfferCodePayload(
            infoHash,
            peerId,
            lockPeerId,
            rendezvousId,
            realOfferId,
            currentOfferCode!,
            sessionTag,
            lockPeerSessionTag,
          ));
      }
      if (role === "answerer") {
        return makeTrackerPresencePayloads(announceHashes, peerId);
      }
      return makeIntentPayloads(announceHashes, peerId, intentOfferId, attemptId, sessionTag);
    };

    const buildRelayHandle = (): TrackerRelayHandle => ({
      destroy: () => {
        pool?.destroy();
        pool = null;
      },
      sendSignal: (signal) => {
        if (!pool || !role || !lockPeerId || !lockInfoHash || !rendezvousId || !realOfferId) return;
        const encoded = encodeTrackerRelaySignal(signal);
        if (role === "answerer") {
          pool.sendAll([JSON.stringify({
            action: "announce",
            info_hash: lockInfoHash,
            peer_id: peerId,
            to_peer_id: lockPeerId,
            answer: {
              type: "answer",
              sdp: whisperSdp(TRACKER_SIGNAL_TYPE, encoded),
              whisper_session: rendezvousId,
            },
            offer_id: realOfferId,
          })]);
          return;
        }
        pool.sendAll([JSON.stringify({
          action: "announce",
          info_hash: lockInfoHash,
          peer_id: peerId,
          numwant: 1,
          offers: [{
            offer_id: randomBinId(),
            offer: {
              type: "offer",
              sdp: whisperSdp(TRACKER_SIGNAL_TYPE, encoded),
              whisper_session: rendezvousId,
              to_peer_id: lockPeerId,
            },
          }],
        })]);
      },
      setOnSignal: (cb) => {
        relaySignalCb = cb;
        if (!cb) return;
        while (pendingSignals.length) cb(pendingSignals.shift()!);
      },
    });

    const logDifferentSession = (): void => {
      opts.callbacks.onLog("ignoring relay payload for a different session");
    };

    const logMalformedRelayIntent = (): void => {
      opts.callbacks.onLog("ignoring malformed relay intent");
    };

    const startOfferCreation = (): void => {
      if (offerCreationStarted || !opts.createOfferCode || !lockPeerId || !lockInfoHash || !rendezvousId) return;
      offerCreationStarted = true;
      realOfferId = randomBinId();
      opts.callbacks.onStatus("creating your invite...");
      opts.callbacks.onLog("peer matched, creating live offer");
      void opts.createOfferCode()
        .then((offerCode) => {
          if (settled) return;
          currentOfferCode = offerCode;
          if (!pool) {
            finish(undefined, new Error("handshake-failed"));
            return;
          }
          pool.sendAll(buildAnnouncePayloads(pool.hashes));
          opts.callbacks.onStatus("waiting for your peer...");
        })
        .catch(() => {
          finish(undefined, new Error("handshake-failed"));
        });
    };

    const handleIntent = (msg: Record<string, unknown>): void => {
      const offer = msg.offer as Record<string, unknown>;
      const parsed = parseWhisperSdp(offer.sdp);
      if (!parsed || parsed.whisperType !== TRACKER_INTENT_TYPE) return;
      if (opts.mode === "flare-listener" && !opts.callbacks.onPeerArrived) return;

      const payload = decodeTrackerPayload<TrackerIntentPayload>(parsed.payload);
      const remotePeerId = String(msg.peer_id ?? "");
      const toPeerId = String(offer.to_peer_id ?? msg.to_peer_id ?? "");
      const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : hashes[0];
      const remoteOfferId = String(msg.offer_id ?? "");

      if (!payload?.attemptId || !payload.sessionTag || !isValidIssuedAt(payload.issuedAt)) {
        logMalformedRelayIntent();
        return;
      }
      if (!remotePeerId || !remoteOfferId) return;
      if (remotePeerId === peerId) return;
      if (toPeerId && toPeerId !== peerId) return;
      if (isRendezvousGhost(remotePeerId, payload.attemptId)) return; // echo of a dead attempt
      if (!rememberSeen(seenMessages, `intent|${remotePeerId}|${remoteOfferId}|${payload.attemptId}|${payload.sessionTag}`)) return;
      if (!lockPeer(remotePeerId, payload.attemptId, payload.sessionTag, infoHash)) return;

      const becomeAnswerer = (): void => {
        role = "answerer";
        opts.callbacks.onStatus("found your peer!");
        opts.callbacks.onLog(opts.mode === "flare-listener" ? "flare accepted peer" : "peer matched, waiting for offer");
        pool?.sendAll([makeMatchAckPayload(
          lockInfoHash,
          peerId,
          lockPeerId,
          remoteOfferId,
          rendezvousId,
          attemptId,
          sessionTag,
          lockPeerSessionTag,
        )]);
      };

      if (opts.mode === "flare-listener") {
        if (peerPromptActive) return;
        peerPromptActive = true;
        opts.callbacks.onLog("someone found your flare");
        void opts.callbacks.onPeerArrived!()
          .then((accepted) => {
            peerPromptActive = false;
            if (settled) return;
            if (!accepted) {
              lockPeerId = "";
              lockAttemptId = "";
              lockPeerSessionTag = "";
              lockInfoHash = "";
              rendezvousId = "";
              opts.callbacks.onLog("peer ignored, still listening");
              opts.callbacks.onStatus("flare is burning");
              return;
            }
            becomeAnswerer();
          })
          .catch(() => {
            peerPromptActive = false;
          });
        return;
      }

      const order = compareAttemptOrder(peerId, attemptId, remotePeerId, payload.attemptId);
      if (order < 0) {
        role = "offerer";
        opts.callbacks.onStatus("found your peer!");
        opts.callbacks.onLog("peer matched, waiting for confirmation");
        return;
      }
      becomeAnswerer();
    };

    const handleMatchAck = (msg: Record<string, unknown>): void => {
      const answer = msg.answer as Record<string, unknown>;
      const parsed = parseWhisperSdp(answer.sdp);
      if (!parsed || parsed.whisperType !== TRACKER_MATCH_ACK_TYPE) return;

      const payload = decodeTrackerPayload<TrackerMatchAckPayload>(parsed.payload);
      const remotePeerId = String(msg.peer_id ?? "");
      const toPeerId = String(msg.to_peer_id ?? "");
      const incomingOfferId = String(msg.offer_id ?? "");

      if (!payload?.rendezvousId || !payload.fromAttemptId || !payload.fromSessionTag || !payload.toSessionTag || !isValidIssuedAt(payload.issuedAt)) return;
      if (!remotePeerId || remotePeerId === peerId) return;
      if (isRendezvousGhost(remotePeerId, payload.fromAttemptId)) return; // echo of a dead attempt
      if (toPeerId && toPeerId !== peerId) return;
      if (payload.toSessionTag !== sessionTag) {
        logDifferentSession();
        return;
      }
      if (lockPeerId && lockPeerSessionTag && payload.fromSessionTag !== lockPeerSessionTag) {
        logDifferentSession();
        return;
      }
      if (incomingOfferId !== intentOfferId) return;

      // Validate the rendezvous id BEFORE taking the lock, not after.
      //
      // The lock is sticky on purpose: once this attempt is bound to a peer it
      // honors no other for its lifetime. Binding it and THEN deciding to reject
      // the frame that caused the binding means a message we refused still chose
      // who we may talk to. The id is a pure function of the two attempt keys,
      // so nothing has to be committed in order to check it.
      const expectedRendezvous = createRendezvousId(peerId, attemptId, remotePeerId, payload.fromAttemptId);
      if (payload.rendezvousId !== expectedRendezvous) return;
      if (!lockPeer(remotePeerId, payload.fromAttemptId, payload.fromSessionTag, typeof msg.info_hash === "string" ? msg.info_hash : hashes[0])) return;

      role = "offerer";
      startOfferCreation();
    };

    const handleOfferCode = (msg: Record<string, unknown>): void => {
      if (role !== "answerer" || acceptStarted) return;
      const offer = msg.offer as Record<string, unknown>;
      const parsed = parseWhisperSdp(offer.sdp);
      if (!parsed || parsed.whisperType !== TRACKER_OFFER_CODE_TYPE) return;

      const payload = decodeTrackerPayload<TrackerOfferCodePayload>(parsed.payload);
      const remotePeerId = String(msg.peer_id ?? "");
      const toPeerId = String(offer.to_peer_id ?? msg.to_peer_id ?? "");
      const incomingOfferId = String(msg.offer_id ?? "");

      if (!payload?.rendezvousId || !payload.code || !payload.fromSessionTag || !payload.toSessionTag || !isValidIssuedAt(payload.issuedAt)) return;
      if (!remotePeerId || remotePeerId !== lockPeerId) return;
      if (toPeerId && toPeerId !== peerId) return;
      if (payload.toSessionTag !== sessionTag) {
        logDifferentSession();
        return;
      }
      if (payload.fromSessionTag !== lockPeerSessionTag) {
        logDifferentSession();
        return;
      }
      if (payload.rendezvousId !== rendezvousId) return;
      if (!BASE64URL_RE.test(payload.code) || payload.code.length < MIN_CODE_LEN) return;

      acceptStarted = true;
      realOfferId = incomingOfferId;
      opts.callbacks.onStatus("connecting to peer...");
      opts.callbacks.onLog("accepting live offer");
      void opts.acceptOfferCode(payload.code)
        .then((answerCode) => {
          if (settled) return;
          pool?.sendAll([makeAnswerCodePayload(
            lockInfoHash,
            peerId,
            lockPeerId,
            rendezvousId,
            realOfferId,
            answerCode,
            sessionTag,
            lockPeerSessionTag,
          )]);
          opts.callbacks.onStatus("connecting directly...");
          finish({ role: "answerer", relay: buildRelayHandle() });
        })
        .catch(() => {
          finish(undefined, new Error("handshake-failed"));
        });
    };

    const handleAnswerCode = (msg: Record<string, unknown>): void => {
      if (role !== "offerer" || !realOfferId) return;
      const answer = msg.answer as Record<string, unknown>;
      const parsed = parseWhisperSdp(answer.sdp);
      if (!parsed || parsed.whisperType !== TRACKER_ANSWER_CODE_TYPE) return;

      const payload = decodeTrackerPayload<TrackerAnswerCodePayload>(parsed.payload);
      const remotePeerId = String(msg.peer_id ?? "");
      const toPeerId = String(msg.to_peer_id ?? "");
      const incomingOfferId = String(msg.offer_id ?? "");

      if (!payload?.rendezvousId || !payload.code || !payload.fromSessionTag || !payload.toSessionTag || !isValidIssuedAt(payload.issuedAt)) return;
      if (!remotePeerId || remotePeerId !== lockPeerId) return;
      if (toPeerId && toPeerId !== peerId) return;
      if (payload.toSessionTag !== sessionTag) {
        logDifferentSession();
        return;
      }
      if (payload.fromSessionTag !== lockPeerSessionTag) {
        logDifferentSession();
        return;
      }
      if (incomingOfferId !== realOfferId) return;
      if (payload.rendezvousId !== rendezvousId) return;
      if (!BASE64URL_RE.test(payload.code) || payload.code.length < MIN_CODE_LEN) return;

      opts.callbacks.onStatus("connecting directly...");
      opts.callbacks.onLog("peer accepted our offer");
      finish({ role: "offerer", peerAnswerCode: payload.code, relay: buildRelayHandle() });
    };

    const handleRelaySignalMessage = (msg: Record<string, unknown>): boolean => {
      if (msg.offer && typeof msg.offer === "object") {
        const offer = msg.offer as Record<string, unknown>;
        const offerParsed = parseWhisperSdp(offer.sdp);
        if (offerParsed && offerParsed.whisperType === TRACKER_SIGNAL_TYPE) {
          const encoded = offerParsed.payload;
          const sessionId = String(offer.whisper_session ?? "");
          const toPeerId = String(offer.to_peer_id ?? "");
          const fromPeerId = String(msg.peer_id ?? "");
          if (!encoded || sessionId !== rendezvousId || toPeerId !== peerId || fromPeerId !== lockPeerId) return true;
          const signalPayload = decodeTrackerRelaySignal(encoded);
          if (signalPayload) emitRelaySignal(signalPayload);
          return true;
        }
      }

      if (msg.answer && typeof msg.answer === "object") {
        const answer = msg.answer as Record<string, unknown>;
        const answerParsed = parseWhisperSdp(answer.sdp);
        if (answerParsed && answerParsed.whisperType === TRACKER_SIGNAL_TYPE) {
          const encoded = answerParsed.payload;
          const sessionId = String(answer.whisper_session ?? "");
          const fromPeerId = String(msg.peer_id ?? "");
          const toPeerId = String(msg.to_peer_id ?? "");
          const incomingOfferId = String(msg.offer_id ?? "");
          if (!encoded || sessionId !== rendezvousId || incomingOfferId !== realOfferId) return true;
          if (fromPeerId !== lockPeerId) return true;
          if (toPeerId && toPeerId !== peerId) return true;
          const signalPayload = decodeTrackerRelaySignal(encoded);
          if (signalPayload) emitRelaySignal(signalPayload);
          return true;
        }
      }

      return false;
    };

    if (opts.signal) opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    totalAc.signal.addEventListener("abort", onAbort, { once: true });

    pool = createTrackerPool(opts.phrase, peerId, hashes, {
      onLog: (msg) => opts.callbacks.onLog(opts.mode === "flare-listener" ? `flare ${msg}` : msg),
      announceIntervalMs: REANNOUNCE_INTERVAL,
      makeAnnounce: buildAnnouncePayloads,
      onReady: () => {
        ready = true;
        opts.callbacks.onStatus(opts.mode === "flare-listener" ? "flare is burning" : "waiting for your peer...");
      },
      onAllDown: () => {
        opts.callbacks.onStatus("reconnecting...");
      },
      onMessage: (msg) => {
        if (settled) return;
        if (msg["failure reason"]) {
          opts.callbacks.onLog(`relay message: ${msg["failure reason"]}`);
          return;
        }
        if (handleRelaySignalMessage(msg)) return;
        if (msg.offer && typeof msg.offer === "object") handleIntent(msg);
        if (msg.answer && typeof msg.answer === "object") handleMatchAck(msg);
        if (msg.offer && typeof msg.offer === "object") handleOfferCode(msg);
        if (msg.answer && typeof msg.answer === "object") handleAnswerCode(msg);
      },
    }, totalAc.signal);

    if (opts.mode === "simultaneous") {
      setTimeout(() => {
        if (!settled && !ready) finish(undefined, new Error("relay-unavailable"));
      }, WS_CONNECT_TIMEOUT);
    }
  });
}
