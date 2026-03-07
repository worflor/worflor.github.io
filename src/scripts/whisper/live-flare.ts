/**
 * Whisper Live — Signal Flares (long-lived tracker presence).
 *
 * A flare is a passive beacon: it sits in the tracker swarm with presence-only
 * announces (no SDP offer) and waits for a relay peer to send an offer. The
 * flare is always the answerer, never the offerer, so the `onPeerArrived`
 * callback fires every time a peer connects.
 *
 * Unlike `exchangeViaTracker()` which has a 45s timeout and single announce,
 * flares maintain open WebSockets, re-announce on epoch boundaries, and
 * reconnect on socket drops. Same tracker infrastructure, same encryption,
 * same zero-metadata properties.
 */

import {
  deriveInfoHashes,
  randomBinId,
  padCode,
  unpadCode,
  MIN_CODE_LEN,
  BASE64URL_RE,
  makeTrackerPresencePayloads,
  createTrackerPool,
  rememberSeen,
} from "./live-tracker";

/* ── API ──────────────────────────────────────────────────── */

export interface FlareCallbacks {
  onStatus: (msg: string) => void;
  onLog: (msg: string) => void;
  /** Called when a peer arrives, UI should show accept/ignore. */
  onPeerArrived: () => Promise<boolean>;
}

export interface FlareResult {
  peerOfferCode: string;
}

/* ── Constants ────────────────────────────────────────────── */

const MAX_SEEN_OFFERS = 1024;

/* ── Main ─────────────────────────────────────────────────── */

export async function maintainFlare(
  phrase: string,
  acceptOfferFn: (peerOfferCode: string) => Promise<string>,
  callbacks: FlareCallbacks,
  signal: AbortSignal,
): Promise<FlareResult> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const peerId = randomBinId();
  const initialHashes = await deriveInfoHashes(phrase);
  const seenOffers = new Set<string>();
  let peerFlowActive = false;

  callbacks.onLog("flare room ready");

  return new Promise<FlareResult>((resolve, reject) => {
    let done = false;
    let pool: ReturnType<typeof createTrackerPool> | null = null;

    const onAbort = () => {
      finish(undefined, new DOMException("Aborted", "AbortError"));
    };

    const finish = (result?: FlareResult, error?: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      pool?.destroy();
      pool = null;
      if (result) resolve(result);
      else reject(error ?? new Error("flare-failed"));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    pool = createTrackerPool(phrase, peerId, initialHashes, {
      onLog: (msg) => callbacks.onLog(`flare ${msg}`),

      makeAnnounce: (hashes) => makeTrackerPresencePayloads(hashes, peerId),

      onReady: () => {
        callbacks.onStatus("flare is burning");
      },

      onAllDown: () => {
        callbacks.onStatus("reconnecting...");
      },

      onMessage: (msg, ws) => {
        if (done) return;

        if (msg["failure reason"]) {
          callbacks.onLog(`flare message: ${msg["failure reason"]}`);
          return;
        }

        // flare only handles incoming offers, it never sends offers
        if (!msg.offer || typeof msg.offer !== "object") return;
        if (peerFlowActive) return;

        const offer = msg.offer as Record<string, unknown>;
        const peerOfferCode = unpadCode(String(offer.sdp ?? ""));
        const peerOfferId = String(msg.offer_id ?? "");
        const peerPeerId = String(msg.peer_id ?? "");
        const toPeerId = String(msg.to_peer_id ?? "");
        if (!peerPeerId) return;

        if (!peerOfferCode || peerOfferCode.length < MIN_CODE_LEN) return;
        if (!peerOfferId) return;
        if (toPeerId && toPeerId !== peerId) return;
        if (peerPeerId === peerId) return;
        if (!BASE64URL_RE.test(peerOfferCode)) return;

        const offerKey = `${peerPeerId}|${peerOfferId}|${peerOfferCode.slice(0, 24)}`;
        if (!rememberSeen(seenOffers, offerKey, MAX_SEEN_OFFERS)) return;

        callbacks.onLog("someone found your flare");

        const replyHash = typeof msg.info_hash === "string" ? msg.info_hash : initialHashes[0];

        // ask the UI if the user wants to accept
        peerFlowActive = true;
        void callbacks.onPeerArrived().then(async (accepted) => {
          if (done) return;
          if (!accepted) {
            peerFlowActive = false;
            callbacks.onLog("peer ignored, still listening");
            callbacks.onStatus("flare is burning");
            return;
          }

          callbacks.onStatus("connecting to peer...");
          callbacks.onLog("accepting peer offer");

          try {
            const myAnswerCode = await acceptOfferFn(peerOfferCode);
            if (done) return;
            if (ws.readyState !== WebSocket.OPEN) {
              finish(undefined, new Error("flare-relay-dropped"));
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
            finish({ peerOfferCode });
          } catch {
            if (done) return;
            peerFlowActive = false;
            callbacks.onLog("accept failed, still listening");
            callbacks.onStatus("flare is burning");
          }
        }).catch(() => {
          peerFlowActive = false;
        });
      },
    }, signal);
  });
}
