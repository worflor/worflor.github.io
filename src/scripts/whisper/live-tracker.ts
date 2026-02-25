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

import { sha256, randomBytes } from "./wasm";
import { TE, hkdf } from "./live-crypto";

/* ── API ──────────────────────────────────────────────────── */

export interface TrackerSignalResult {
  role: "offerer" | "answerer";
  peerAnswerCode?: string; // present when role === "offerer"
}

export interface TrackerSignalCallbacks {
  onStatus: (msg: string) => void;
  onLog: (msg: string) => void;
}

/* ── Constants ────────────────────────────────────────────── */

const TRACKER_URLS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
];

const WS_CONNECT_TIMEOUT = 5_000;
const PEER_DISCOVERY_TIMEOUT = 30_000;
const TOTAL_TIMEOUT = 45_000;
const EPOCH_WINDOW = 2 * 60 * 1000;
const EPOCH_BOUNDARY_MARGIN = 15_000;
const PADDED_CODE_LEN = 1024;
const PAD_CHAR = ".";
const MIN_CODE_LEN = 40;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/* ── Helpers ──────────────────────────────────────────────── */

function toBin(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const TRACKER_HASH_INFO = TE.encode("whisper-tracker-room");

async function deriveInfoHashes(phrase: string): Promise<string[]> {
  const now = Date.now();
  const epoch = Math.floor(now / EPOCH_WINDOW);
  const phraseHash = await sha256(TE.encode("whisper-tracker|" + phrase));
  const cur = await hkdf(phraseHash, TE.encode(String(epoch)), TRACKER_HASH_INFO, 20);
  const hashes: string[] = [toBin(cur)];
  if (now - epoch * EPOCH_WINDOW < EPOCH_BOUNDARY_MARGIN) {
    const prev = await hkdf(phraseHash, TE.encode(String(epoch - 1)), TRACKER_HASH_INFO, 20);
    hashes.push(toBin(prev));
  }
  phraseHash.fill(0);
  return hashes;
}

function randomBinId(): string {
  return toBin(randomBytes(20));
}

function padCode(code: string): string {
  if (code.length >= PADDED_CODE_LEN) return code;
  return code + PAD_CHAR.repeat(PADDED_CODE_LEN - code.length);
}

function unpadCode(code: string): string {
  const idx = code.indexOf(PAD_CHAR);
  return idx === -1 ? code : code.slice(0, idx);
}

/* ── Main exchange function ───────────────────────────────── */

export async function exchangeViaTracker(
  phrase: string,
  myOfferCode: string,
  acceptOfferFn: (peerOfferCode: string) => Promise<string>,
  callbacks: TrackerSignalCallbacks,
  signal?: AbortSignal,
): Promise<TrackerSignalResult> {
  const hashes = await deriveInfoHashes(phrase);
  const peerId = randomBinId();
  const offerId = randomBinId();
  const paddedOffer = padCode(myOfferCode);

  callbacks.onLog("relay: room ready");

  const totalAc = new AbortController();
  const totalTimer = setTimeout(() => totalAc.abort(), TOTAL_TIMEOUT);

  if (signal) {
    if (signal.aborted) {
      clearTimeout(totalTimer);
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", () => totalAc.abort(), { once: true });
  }

  // Race all trackers — each opens ONE socket and multiplexes all hashes
  // on it. The first tracker to yield a result wins; losers are torn down
  // immediately via the AbortController in `finally`.
  try {
    const attempts = TRACKER_URLS.map((url) =>
      connectToTracker(url, hashes, peerId, offerId, paddedOffer, acceptOfferFn, callbacks, totalAc.signal),
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
    let discoveryTimer: ReturnType<typeof setTimeout>;

    // Pre-serialize announce payloads — one per hash, reused as-is
    const announcePayloads = infoHashes.map((h) => JSON.stringify({
      action: "announce",
      info_hash: h,
      peer_id: peerId,
      numwant: 1,
      offers: [{ offer_id: offerId, offer: { type: "offer", sdp: paddedOffer } }],
    }));

    // Pre-serialize stopped payloads
    const stoppedPayloads = infoHashes.map((h) => JSON.stringify({
      action: "announce",
      info_hash: h,
      peer_id: peerId,
      event: "stopped",
    }));

    const finish = (result?: TrackerSignalResult, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(discoveryTimer);

      // Politely deregister from all swarms before closing
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const payload of stoppedPayloads) {
          try { ws.send(payload); } catch { break; }
        }
        // Close with 1000 (normal closure) — tells the server this was
        // intentional so it can reclaim resources immediately rather than
        // waiting for TCP FIN timeout.
        try { ws.close(1000); } catch { /* noop */ }
      } else {
        try { ws?.close(1000); } catch { /* noop */ }
      }
      ws = null;

      if (result) resolve(result);
      else reject(error ?? new Error("relay-unavailable"));
    };

    signal.addEventListener("abort", () => {
      finish(undefined, new DOMException("Aborted", "AbortError"));
    }, { once: true });

    const connectTimer = setTimeout(() => {
      finish(undefined, new Error("relay-unavailable"));
    }, WS_CONNECT_TIMEOUT);

    try {
      ws = new WebSocket(url);
    } catch {
      clearTimeout(connectTimer);
      reject(new Error("relay-unavailable"));
      return;
    }

    ws.onopen = () => {
      clearTimeout(connectTimer);
      callbacks.onLog(`relay: connected via ${host}`);
      callbacks.onStatus("waiting for your peer...");

      discoveryTimer = setTimeout(() => {
        finish(undefined, new Error("peer-not-found"));
      }, PEER_DISCOVERY_TIMEOUT);

      // Single announce per hash — no re-announce. The WebSocket staying
      // open is itself the keepalive; trackers evict on socket close,
      // not on announce timeout.
      for (const payload of announcePayloads) ws!.send(payload);
    };

    ws.onmessage = (event) => {
      if (done) return;

      // Text frames arrive as strings — no coercion needed.
      // Binary frames (unexpected from a WebTorrent tracker) are ignored.
      const raw = event.data;
      if (typeof raw !== "string" || raw.length > 8192) return;

      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg["failure reason"]) {
        callbacks.onLog(`relay: tracker said: ${msg["failure reason"]}`);
        return;
      }

      // ── Offer received → we may become the answerer ──

      if (msg.offer && typeof msg.offer === "object") {
        const offer = msg.offer as Record<string, unknown>;
        const peerOfferCode = unpadCode(String(offer.sdp ?? ""));
        const peerOfferId = String(msg.offer_id ?? "");
        const peerPeerId = String(msg.peer_id ?? "");

        if (!peerOfferCode || peerOfferCode.length < MIN_CODE_LEN) return;
        if (peerPeerId === peerId) return;
        if (!BASE64URL_RE.test(peerOfferCode)) return;
        if (offerAccepted) return;
        offerAccepted = true;

        // Tie-break: lower peer_id becomes answerer
        if (peerId > peerPeerId) {
          callbacks.onLog("relay: resolving connection order...");
          return;
        }

        callbacks.onStatus("found your peer!");
        callbacks.onLog("relay: peer found, accepting their offer");

        // Determine which info_hash this offer came on — reply on the same one.
        // The tracker routes answers by (info_hash, to_peer_id, offer_id).
        const replyHash = typeof msg.info_hash === "string" ? msg.info_hash : infoHashes[0];

        void acceptOfferFn(peerOfferCode)
          .then((myAnswerCode) => {
            if (done || !ws || ws.readyState !== WebSocket.OPEN) return;

            ws.send(JSON.stringify({
              action: "announce",
              info_hash: replyHash,
              peer_id: peerId,
              to_peer_id: peerPeerId,
              answer: { type: "answer", sdp: padCode(myAnswerCode) },
              offer_id: peerOfferId,
            }));

            callbacks.onLog("relay: exchange complete, going direct");
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
        if (!peerAnswerCode || peerAnswerCode.length < MIN_CODE_LEN) return;
        if (!BASE64URL_RE.test(peerAnswerCode)) return;

        callbacks.onStatus("found your peer!");
        callbacks.onLog("relay: peer accepted our offer");
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
