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
import { TE, hkdf } from "./live-crypto";
import { derivePhraseRoot, derivePhraseScopedKey } from "./live-handshake";

/* ── API ──────────────────────────────────────────────────── */

interface TrackerSignalResult {
  role: "offerer" | "answerer";
  peerAnswerCode?: string; // present when role === "offerer"
}

interface TrackerSignalCallbacks {
  onStatus: (msg: string) => void;
  onLog: (msg: string) => void;
}

/* ── Constants ────────────────────────────────────────────── */

export const TRACKER_URLS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
];

const WS_CONNECT_TIMEOUT = 5_000;
const PEER_DISCOVERY_TIMEOUT = 30_000;
const TOTAL_TIMEOUT = 45_000;
const TRACKER_SECOND_ATTEMPT_DELAY = 300;
const REANNOUNCE_INTERVAL = 10_000;
export const EPOCH_WINDOW = 2 * 60 * 1000;
const EPOCH_BOUNDARY_MARGIN = 15_000;
export const PADDED_CODE_LEN = 1024;
export const PAD_CHAR = ".";
export const MIN_CODE_LEN = 40;
export const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
export const TRACKER_MAX_MESSAGE_LEN = 8192;

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
        }, POOL_EPOCH_CHECK_INTERVAL);
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

export async function exchangeViaTracker(
  phrase: string,
  myOfferCode: string,
  acceptOfferFn: (peerOfferCode: string) => Promise<string>,
  callbacks: TrackerSignalCallbacks,
  signal?: AbortSignal,
): Promise<TrackerSignalResult> {
  const [hashes, orderedTrackers] = await Promise.all([
    deriveInfoHashes(phrase),
    deriveTrackerOrder(phrase, TRACKER_URLS),
  ]);
  const peerId = randomBinId();
  const offerId = randomBinId();
  const paddedOffer = padCode(myOfferCode);

  callbacks.onLog("relay room ready");

  const totalAc = new AbortController();
  const totalTimer = setTimeout(() => totalAc.abort(), TOTAL_TIMEOUT);
  const onExternalAbort = (): void => totalAc.abort();

  if (signal) {
    if (signal.aborted) {
      clearTimeout(totalTimer);
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // Stagger tracker attempts to reduce simultaneous socket load on public relays,
  // while retaining fast fallback when the first tracker is slow/unavailable.
  // orderedTrackers is phrase-derived — both peers converge on the same primary,
  // distributing the surveillance surface across the pool by session.
  try {
    const attempts = orderedTrackers.map((url, index) =>
      (index === 0)
        ? connectToTracker(url, hashes, peerId, offerId, paddedOffer, acceptOfferFn, callbacks, totalAc.signal)
        : new Promise<TrackerSignalResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            totalAc.signal.removeEventListener("abort", onAbort);
            connectToTracker(url, hashes, peerId, offerId, paddedOffer, acceptOfferFn, callbacks, totalAc.signal)
              .then(resolve)
              .catch(reject);
          }, TRACKER_SECOND_ATTEMPT_DELAY * index);

          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };

          totalAc.signal.addEventListener("abort", onAbort, { once: true });
        }),
    );
    return await Promise.any(attempts);
  } catch (err) {
    if (err instanceof AggregateError) {
      const first = err.errors[0];
      if (first instanceof DOMException && first.name === "AbortError") {
        throw new Error("peer-not-found");
      }
      throw new Error(first?.message ?? "relay-unavailable");
    }
    throw err;
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
    totalAc.abort();
  }
}

/* ── Single tracker connection (multiplexed hashes) ───────── */

function connectToTracker(
  url: string,
  infoHashes: string[],
  peerId: string,
  offerId: string,
  paddedOffer: string,
  acceptOfferFn: (peerOfferCode: string) => Promise<string>,
  callbacks: TrackerSignalCallbacks,
  signal: AbortSignal,
): Promise<TrackerSignalResult> {
  const host = new URL(url).host;

  return new Promise<TrackerSignalResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let ws: WebSocket | null = null;
    let done = false;
    let offerAccepted = false;
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let reannounceTimer: ReturnType<typeof setInterval> | null = null;

    // Pre-serialize announce payloads — one per hash, reused as-is
    const announcePayloads = makeTrackerAnnouncePayloads(infoHashes, peerId, offerId, paddedOffer);

    // Pre-serialize stopped payloads
    const stoppedPayloads = makeTrackerStoppedPayloads(infoHashes, peerId);
    const onAbort = () => {
      finish(undefined, new DOMException("Aborted", "AbortError"));
    };

    const finish = (result?: TrackerSignalResult, error?: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      clearTimeout(connectTimer);
      if (discoveryTimer) { clearTimeout(discoveryTimer); discoveryTimer = null; }
      if (reannounceTimer) { clearInterval(reannounceTimer); reannounceTimer = null; }

      // Politely deregister from all swarms before closing
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const payload of stoppedPayloads) {
          try { ws.send(payload); } catch { break; }
        }
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try { ws.close(1000); } catch { /* noop */ }
      } else {
        if (ws) {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
        }
        try { ws?.close(1000); } catch { /* noop */ }
      }
      if (ws) liveSockets--;
      ws = null;

      if (result) resolve(result);
      else reject(error ?? new Error("relay-unavailable"));
    };

    if (liveSockets >= MAX_SOCKETS) {
      reject(new Error("relay-unavailable"));
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });

    const connectTimer = setTimeout(() => {
      finish(undefined, new Error("relay-unavailable"));
    }, WS_CONNECT_TIMEOUT);

    try {
      ws = new WebSocket(url);
      liveSockets++;
    } catch {
      clearTimeout(connectTimer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("relay-unavailable"));
      return;
    }

    ws.onopen = () => {
      clearTimeout(connectTimer);
      callbacks.onLog(`connected to relay via ${host}`);
      callbacks.onStatus("waiting for your peer...");

      discoveryTimer = setTimeout(() => {
        finish(undefined, new Error("peer-not-found"));
      }, PEER_DISCOVERY_TIMEOUT);

      for (const payload of announcePayloads) ws!.send(payload);

      // re-announce periodically so our offer reaches peers who join the
      // swarm after the initial announce (e.g. flares sitting with
      // presence-only). tracker offer routing is one-shot at announce time,
      // so without this, late joiners never see us.
      reannounceTimer = setInterval(() => {
        if (done || !ws || ws.readyState !== WebSocket.OPEN) return;
        for (const payload of announcePayloads) {
          try { ws.send(payload); } catch { break; }
        }
      }, REANNOUNCE_INTERVAL);
    };

    ws.onmessage = (event) => {
      if (done) return;

      // Text frames arrive as strings — no coercion needed.
      // Binary frames (unexpected from a WebTorrent tracker) are ignored.
      const msg = parseTrackerMessage(event.data);
      if (!msg) return;

      if (msg["failure reason"]) {
        callbacks.onLog(`relay message: ${msg["failure reason"]}`);
        return;
      }

      // ── Offer received → we may become the answerer ──

      if (msg.offer && typeof msg.offer === "object") {
        const offer = msg.offer as Record<string, unknown>;
        const peerOfferCode = unpadCode(String(offer.sdp ?? ""));
        const peerOfferId = String(msg.offer_id ?? "");
        const peerPeerId = String(msg.peer_id ?? "");
        const toPeerId = String(msg.to_peer_id ?? "");
        const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : "";

        if (!peerOfferCode || peerOfferCode.length < MIN_CODE_LEN) return;
        if (!peerOfferId) return;
        if (!peerPeerId) return;
        if (toPeerId && toPeerId !== peerId) return;
        if (peerPeerId === peerId) return;
        if (infoHash && !infoHashes.includes(infoHash)) return;
        if (!BASE64URL_RE.test(peerOfferCode)) return;
        if (offerAccepted) return;

        // Tie-break: lower peer_id becomes answerer
        if (peerId > peerPeerId) {
          callbacks.onLog("resolving connection order...");
          return;
        }
        offerAccepted = true;
        if (discoveryTimer) {
          clearTimeout(discoveryTimer);
          discoveryTimer = null;
        }
        if (reannounceTimer) { clearInterval(reannounceTimer); reannounceTimer = null; }

        callbacks.onStatus("found your peer!");
        callbacks.onLog("peer found, accepting their offer");

        // Determine which info_hash this offer came on — reply on the same one.
        // The tracker routes answers by (info_hash, to_peer_id, offer_id).
        const replyHash = typeof msg.info_hash === "string" ? msg.info_hash : infoHashes[0];

        void acceptOfferFn(peerOfferCode)
          .then((myAnswerCode) => {
            if (done) return;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              // socket dropped while processing the accept, answer can't be delivered.
              // finish() sends stopped and closes so the swarm room is cleaned up.
              finish(undefined, new Error("handshake-failed"));
              return;
            }

            ws.send(JSON.stringify({
              action: "announce",
              info_hash: replyHash,
              peer_id: peerId,
              to_peer_id: peerPeerId,
              answer: { type: "answer", sdp: padCode(myAnswerCode) },
              offer_id: peerOfferId,
            }));

            callbacks.onLog("exchange complete, connecting directly");
            callbacks.onStatus("connecting directly...");
            finish({ role: "answerer" });
          })
          .catch(() => {
            finish(undefined, new Error("handshake-failed"));
          });

        return;
      }

      // ── Answer received → we stay offerer ──

      if (msg.answer && typeof msg.answer === "object") {
        const answer = msg.answer as Record<string, unknown>;
        const peerAnswerCode = unpadCode(String(answer.sdp ?? ""));
        const fromPeerId = String(msg.peer_id ?? "");
        const toPeerId = String(msg.to_peer_id ?? "");
        const incomingOfferId = String(msg.offer_id ?? "");
        const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : "";
        if (!peerAnswerCode || peerAnswerCode.length < MIN_CODE_LEN) return;
        if (!fromPeerId || fromPeerId === peerId) return;
        if (toPeerId && toPeerId !== peerId) return;
        if (incomingOfferId && incomingOfferId !== offerId) return;
        if (infoHash && !infoHashes.includes(infoHash)) return;
        if (!BASE64URL_RE.test(peerAnswerCode)) return;

        callbacks.onStatus("found your peer!");
        callbacks.onLog("peer accepted our offer");
        finish({ role: "offerer", peerAnswerCode });
        return;
      }
    };

    ws.onerror = () => finish(undefined, new Error("relay-unavailable"));

    ws.onclose = () => {
      if (!done) finish(undefined, new Error("relay-unavailable"));
    };
  });
}
