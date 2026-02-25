/**
 * Whisper Live — tracker-based auto-signaling.
 *
 * Piggybacks on WebTorrent tracker WebSocket infrastructure to exchange sealed
 * SDP codes between two peers who share a phrase. The tracker sees only encrypted
 * blobs — it thinks it's brokering a torrent swarm.
 *
 * Both peers type the same phrase, click Connect, and the tracker relays encrypted
 * blobs between them in ~3 seconds. Then the WebSocket dies.
 *
 * No external dependencies. No accounts. No new infrastructure.
 *
 * Protocol note: WebTorrent trackers expect info_hash, peer_id, offer_id, and
 * to_peer_id as 20-byte binary strings (each char = one byte via charCodeAt).
 * JSON.stringify handles the \uXXXX escaping automatically.
 */

import { sha256, randomBytes } from "./wasm";
import { TE } from "./live-crypto";

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

/** Re-announce interval — keeps us visible if the tracker evicts stale peers. */
const REANNOUNCE_MS = 20_000;

/** Epoch window for salted info_hash — peers in the same window find each other. */
const EPOCH_WINDOW = 10 * 60 * 1000; // 10 minutes

/** Fixed length for padded SDP codes — hides true blob size from tracker. */
const PADDED_CODE_LEN = 1024;
const PAD_CHAR = "."; // not in base64url alphabet

/* ── Helpers ──────────────────────────────────────────────── */

/** Each byte → one char via fromCharCode.
 *  This is the encoding WebTorrent trackers expect for info_hash, peer_id, etc. */
function toBin(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Derive two info_hashes salted with the current and previous epoch,
 *  so peers near an epoch boundary still discover each other. */
async function deriveInfoHashes(phrase: string): Promise<[current: string, previous: string]> {
  const epoch = Math.floor(Date.now() / EPOCH_WINDOW);
  const [cur, prev] = await Promise.all([
    sha256(TE.encode("whisper-tracker|" + phrase + "|" + epoch)),
    sha256(TE.encode("whisper-tracker|" + phrase + "|" + (epoch - 1))),
  ]);
  return [toBin(cur.slice(0, 20)), toBin(prev.slice(0, 20))];
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
  const [currentHash, previousHash] = await deriveInfoHashes(phrase);
  const peerId = randomBinId();
  const offerId = randomBinId();

  callbacks.onLog("relay: room ready");

  // Hard cap on total exchange time
  const totalAc = new AbortController();
  const totalTimer = setTimeout(() => totalAc.abort(), TOTAL_TIMEOUT);
  const cleanup = () => clearTimeout(totalTimer);

  if (signal) {
    if (signal.aborted) {
      cleanup();
      throw new DOMException("Aborted", "AbortError");
    }
    signal.addEventListener("abort", () => totalAc.abort(), { once: true });
  }

  try {
    const attempts = TRACKER_URLS.flatMap((url) => [
      connectToTracker(url, currentHash, peerId, offerId, myOfferCode, acceptOfferFn, callbacks, totalAc.signal),
      connectToTracker(url, previousHash, peerId, offerId, myOfferCode, acceptOfferFn, callbacks, totalAc.signal),
    ]);
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
    cleanup();
    totalAc.abort();
  }
}

/* ── Single tracker connection ────────────────────────────── */

function connectToTracker(
  url: string,
  infoHash: string,
  peerId: string,
  offerId: string,
  myOfferCode: string,
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
    let resolved = false;
    let reannounceTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (result?: TrackerSignalResult, error?: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(connectTimer);
      clearTimeout(discoveryTimer);
      if (reannounceTimer) { clearInterval(reannounceTimer); reannounceTimer = null; }
      try { ws?.close(); } catch { /* noop */ }
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

    let discoveryTimer: ReturnType<typeof setTimeout>;

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

      const announcePayload = JSON.stringify({
        action: "announce",
        info_hash: infoHash,
        peer_id: peerId,
        numwant: 1,
        offers: [{
          offer_id: offerId,
          offer: { type: "offer", sdp: padCode(myOfferCode) },
        }],
      });
      ws!.send(announcePayload);

      // Re-announce periodically — keeps us in the tracker's peer pool
      reannounceTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(announcePayload);
      }, REANNOUNCE_MS);
    };

    ws.onmessage = (event) => {
      if (resolved) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch { return; }

      if (msg["failure reason"]) {
        callbacks.onLog(`relay: tracker said: ${msg["failure reason"]}`);
        return;
      }

      // Received an offer → we may become the answerer
      if (msg.offer && typeof msg.offer === "object") {
        const offer = msg.offer as Record<string, unknown>;
        const peerOfferCode = unpadCode(String(offer.sdp ?? ""));
        const peerOfferId = String(msg.offer_id ?? "");
        const peerPeerId = String(msg.peer_id ?? "");

        if (!peerOfferCode) return;

        // Simultaneous arrival tie-break: lower peer_id becomes answerer
        if (peerId > peerPeerId) {
          callbacks.onLog("relay: resolving connection order...");
          return;
        }

        callbacks.onStatus("found your peer!");
        callbacks.onLog("relay: peer found, accepting their offer");

        void acceptOfferFn(peerOfferCode)
          .then((myAnswerCode) => {
            if (resolved || !ws || ws.readyState !== WebSocket.OPEN) return;

            ws.send(JSON.stringify({
              action: "announce",
              info_hash: infoHash,
              peer_id: peerId,
              to_peer_id: peerPeerId,
              answer: { type: "answer", sdp: padCode(myAnswerCode) },
              offer_id: peerOfferId,
            }));

            callbacks.onLog("relay: exchange complete, going direct");
            callbacks.onStatus("connecting directly...");
            finish({ role: "answerer" });
          })
          .catch((err) => {
            finish(undefined, new Error(`handshake-failed`));
          });

        return;
      }

      // Received an answer → we stay offerer
      if (msg.answer && typeof msg.answer === "object") {
        const answer = msg.answer as Record<string, unknown>;
        const peerAnswerCode = unpadCode(String(answer.sdp ?? ""));
        if (!peerAnswerCode) return;

        callbacks.onStatus("found your peer!");
        callbacks.onLog("relay: peer accepted our offer");
        finish({ role: "offerer", peerAnswerCode });
        return;
      }
    };

    ws.onerror = () => {
      finish(undefined, new Error("relay-unavailable"));
    };

    ws.onclose = () => {
      if (!resolved) finish(undefined, new Error("relay-unavailable"));
    };
  });
}
