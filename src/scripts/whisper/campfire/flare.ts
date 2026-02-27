/**
 * Campfire flare signaling over tracker WebSocket backends.
 *
 * Uses the same tracker primitives as Whisper Live relay/flare, but with
 * role-directed behavior for Campfire:
 *   - host: offer-only, continuously accepts answers
 *   - joiner: answer-only, waits for host offers
 */

import {
  deriveInfoHashes,
  randomBinId,
  padCode,
  unpadCode,
  TRACKER_URLS,
  MIN_CODE_LEN,
  BASE64URL_RE,
  makeTrackerAnnouncePayloads,
  makeTrackerStoppedPayloads,
  parseTrackerMessage,
  createTrackerPool,
  rememberSeen,
} from "../live-tracker";

interface FlareBaseCallbacks {
  onStatus: (msg: string) => void;
  onLog: (msg: string) => void;
}

export interface CampfireHostFlareOptions extends FlareBaseCallbacks {
  phrase: string;
  getCurrentOfferCode: () => string | null;
  applyAnswerCode: (answerCode: string) => Promise<void>;
  signal: AbortSignal;
}

export interface CampfireJoinFlareOptions extends FlareBaseCallbacks {
  phrase: string;
  acceptOfferCode: (offerCode: string) => Promise<string>;
  signal: AbortSignal;
}

const MAX_SEEN = 1024;
const JOIN_TOTAL_TIMEOUT = 60_000;
const WS_CONNECT_TIMEOUT = 8_000;

interface OfferContext {
  offerCode: string;
  offerId: string;
  paddedOffer: string;
}

async function waitForNextOffer(
  getCurrentOfferCode: () => string | null,
  previousOffer: string,
  signal: AbortSignal,
): Promise<string | null> {
  const start = Date.now();
  while (!signal.aborted && Date.now() - start < 12_000) {
    const next = getCurrentOfferCode();
    if (next && next !== previousOffer) return next;
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

export async function hostCampfireViaFlare(opts: CampfireHostFlareOptions): Promise<void> {
  if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");

  const peerId = randomBinId();
  const initialHashes = await deriveInfoHashes(opts.phrase);

  let seedOffer = opts.getCurrentOfferCode();
  if (!seedOffer) throw new Error("no-offer-code");
  let offerCtx: OfferContext = {
    offerCode: seedOffer,
    offerId: randomBinId(),
    paddedOffer: padCode(seedOffer),
  };

  const seenAnswers = new Set<string>();
  let rotatingOffer = false;

  opts.onLog("campfire flare room is burning");

  const rotateOffer = async (): Promise<void> => {
    if (rotatingOffer || opts.signal.aborted) return;
    rotatingOffer = true;
    try {
      const nextOffer = await waitForNextOffer(opts.getCurrentOfferCode, offerCtx.offerCode, opts.signal);
      if (!nextOffer || nextOffer === offerCtx.offerCode || opts.signal.aborted) return;
      offerCtx = {
        offerCode: nextOffer,
        offerId: randomBinId(),
        paddedOffer: padCode(nextOffer),
      };
      pool.sendAll(makeAnnounce(pool.hashes));
      opts.onLog("campfire flare refreshed join slot");
    } finally {
      rotatingOffer = false;
    }
  };

  const makeAnnounce = (hashes: string[]): string[] =>
    makeTrackerAnnouncePayloads(hashes, peerId, offerCtx.offerId, offerCtx.paddedOffer);

  const handleAnswer = async (msg: Record<string, unknown>): Promise<void> => {
    if (rotatingOffer || opts.signal.aborted) return;
    if (!msg.answer || typeof msg.answer !== "object") return;

    const answer = msg.answer as Record<string, unknown>;
    const answerCode = unpadCode(String(answer.sdp ?? ""));
    const fromPeerId = String(msg.peer_id ?? "");
    const toPeerId = String(msg.to_peer_id ?? "");
    const incomingOfferId = String(msg.offer_id ?? "");

    if (!answerCode || answerCode.length < MIN_CODE_LEN) return;
    if (!fromPeerId || fromPeerId === peerId) return;
    if (toPeerId && toPeerId !== peerId) return;
    if (!incomingOfferId || incomingOfferId !== offerCtx.offerId) return;
    if (!BASE64URL_RE.test(answerCode)) return;

    const key = `${fromPeerId}|${incomingOfferId}|${answerCode.slice(0, 24)}`;
    if (!rememberSeen(seenAnswers, key, MAX_SEEN)) return;

    opts.onStatus("peer joining campfire...");
    try {
      await opts.applyAnswerCode(answerCode);
      opts.onStatus("campfire flare is burning");
      opts.onLog("peer joined via flare");
      await rotateOffer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      opts.onLog(`flare answer apply failed: ${msg}`);
      opts.onStatus("campfire flare is burning");
    }
  };

  const pool = createTrackerPool(opts.phrase, peerId, initialHashes, {
    onLog: (msg) => opts.onLog(`campfire flare ${msg}`),
    makeAnnounce,
    onMessage: (msg) => {
      if (opts.signal.aborted) return;
      void handleAnswer(msg);
    },
    onReady: () => {
      opts.onStatus("campfire flare is burning");
    },
  }, opts.signal);

  // block until abort
  await new Promise<void>((resolve) => {
    opts.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  pool.destroy();
}

export async function joinCampfireViaFlare(opts: CampfireJoinFlareOptions): Promise<void> {
  if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");

  const hashes = await deriveInfoHashes(opts.phrase);
  const peerId = randomBinId();
  const seenOffers = new Set<string>();

  opts.onLog("searching for campfire flare...");

  const totalAc = new AbortController();
  const timeout = setTimeout(() => totalAc.abort(), JOIN_TOTAL_TIMEOUT);
  opts.signal.addEventListener("abort", () => totalAc.abort(), { once: true });

  try {
    const attempts = TRACKER_URLS.map((url) => connectJoinTracker(url, hashes, peerId, seenOffers, opts, totalAc.signal));
    await Promise.any(attempts);
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
    clearTimeout(timeout);
    totalAc.abort();
  }
}

function hostName(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function connectJoinTracker(
  url: string,
  hashes: string[],
  peerId: string,
  seenOffers: Set<string>,
  opts: CampfireJoinFlareOptions,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let ws: WebSocket | null = null;
    let done = false;

    const announcePayloads = hashes.map((h) => JSON.stringify({
      action: "announce",
      info_hash: h,
      peer_id: peerId,
      numwant: 1,
    }));

    const stoppedPayloads = makeTrackerStoppedPayloads(hashes, peerId);

    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);

      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const payload of stoppedPayloads) {
          try { ws.send(payload); } catch { break; }
        }
      }
      try { ws?.close(1000); } catch { /* noop */ }
      ws = null;

      if (error) reject(error);
      else resolve();
    };

    signal.addEventListener("abort", () => {
      finish(new DOMException("Aborted", "AbortError"));
    }, { once: true });

    const connectTimer = setTimeout(() => {
      finish(new Error("relay-unavailable"));
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
      opts.onLog(`campfire flare relay connected via ${hostName(url)}`);
      opts.onStatus("waiting for room flare...");
      for (const payload of announcePayloads) ws!.send(payload);
    };

    ws.onmessage = (event) => {
      if (done) return;
      const msg = parseTrackerMessage(event.data);
      if (!msg || !msg.offer || typeof msg.offer !== "object") return;

      const offer = msg.offer as Record<string, unknown>;
      const offerCode = unpadCode(String(offer.sdp ?? ""));
      const offerId = String(msg.offer_id ?? "");
      const fromPeerId = String(msg.peer_id ?? "");
      const toPeerId = String(msg.to_peer_id ?? "");
      const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : "";

      if (!offerCode || offerCode.length < MIN_CODE_LEN) return;
      if (!offerId) return;
      if (!fromPeerId || fromPeerId === peerId) return;
      if (toPeerId && toPeerId !== peerId) return;
      if (infoHash && !hashes.includes(infoHash)) return;
      if (!BASE64URL_RE.test(offerCode)) return;

      const offerKey = `${fromPeerId}|${offerId}|${offerCode.slice(0, 24)}`;
      if (!rememberSeen(seenOffers, offerKey, MAX_SEEN)) return;

      opts.onStatus("found campfire host, joining...");
      void opts.acceptOfferCode(offerCode)
        .then((answerCode) => {
          if (done || !ws || ws.readyState !== WebSocket.OPEN) return;

          ws.send(JSON.stringify({
            action: "announce",
            info_hash: infoHash || hashes[0],
            peer_id: peerId,
            to_peer_id: fromPeerId,
            answer: { type: "answer", sdp: padCode(answerCode) },
            offer_id: offerId,
          }));

          opts.onStatus("joining campfire...");
          opts.onLog("campfire flare exchange complete");
          finish();
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : "handshake-failed";
          finish(new Error(msg));
        });
    };

    ws.onerror = () => finish(new Error("relay-unavailable"));
    ws.onclose = () => {
      if (!done) finish(new Error("relay-unavailable"));
    };
  });
}
