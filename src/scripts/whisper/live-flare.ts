/**
 * Whisper Live — Signal Flares (long-lived tracker presence).
 *
 * Unlike `exchangeViaTracker()` which has a 45s timeout and single announce,
 * flares maintain an open WebSocket, re-announce on epoch boundaries, and
 * reconnect on socket drops. Same tracker infrastructure, same encryption,
 * same zero-metadata properties.
 */

import {
  deriveInfoHashes,
  randomBinId,
  padCode,
  unpadCode,
  TRACKER_URLS,
  EPOCH_WINDOW,
  MIN_CODE_LEN,
  BASE64URL_RE,
} from "./live-tracker";

/* ── API ──────────────────────────────────────────────────── */

export interface FlareCallbacks {
  onStatus: (msg: string) => void;
  onLog: (msg: string) => void;
  /** Called when a peer arrives — UI should show accept/ignore. */
  onPeerArrived: () => Promise<boolean>;
}

export interface FlareResult {
  role: "offerer" | "answerer";
  peerAnswerCode?: string;
}

/* ── Constants ────────────────────────────────────────────── */

const REANNOUNCE_INTERVAL = 30_000;
const WS_CONNECT_TIMEOUT = 8_000;
const RECONNECT_BASE = 2_000;
const RECONNECT_CAP = 30_000;

/* ── Main ─────────────────────────────────────────────────── */

export async function maintainFlare(
  phrase: string,
  myOfferCode: string,
  acceptOfferFn: (peerOfferCode: string) => Promise<string>,
  callbacks: FlareCallbacks,
  signal: AbortSignal,
): Promise<FlareResult> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const peerId = randomBinId();
  const offerId = randomBinId();
  const paddedOffer = padCode(myOfferCode);

  let lastEpoch = Math.floor(Date.now() / EPOCH_WINDOW);
  let currentHashes = await deriveInfoHashes(phrase);

  callbacks.onLog("flare room ready");

  return new Promise<FlareResult>((resolve, reject) => {
    let done = false;
    let reannounceTimer: ReturnType<typeof setInterval> | null = null;
    const sockets = new Map<string, WebSocket>();
    const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const reconnectDelayByUrl = new Map<string, number>();
    const seenOffers = new Set<string>();
    const seenAnswers = new Set<string>();

    const finish = (result?: FlareResult, error?: Error) => {
      if (done) return;
      done = true;

      if (reannounceTimer) { clearInterval(reannounceTimer); reannounceTimer = null; }
      for (const t of reconnectTimers.values()) clearTimeout(t);
      reconnectTimers.clear();

      // Send stopped for current hashes on all open sockets.
      const stoppedPayloads = makeStoppedPayloads(currentHashes);
      for (const ws of sockets.values()) {
        if (ws.readyState === WebSocket.OPEN) {
          for (const payload of stoppedPayloads) {
            try { ws.send(payload); } catch { break; }
          }
          try { ws.close(1000); } catch { /* noop */ }
        } else {
          try { ws.close(1000); } catch { /* noop */ }
        }
      }
      sockets.clear();

      if (result) resolve(result);
      else reject(error ?? new Error("flare-failed"));
    };

    signal.addEventListener("abort", () => {
      finish(undefined, new DOMException("Aborted", "AbortError"));
    }, { once: true });

    function makeAnnouncePayloads(hashes: string[]): string[] {
      return hashes.map((h) => JSON.stringify({
        action: "announce",
        info_hash: h,
        peer_id: peerId,
        numwant: 1,
        offers: [{ offer_id: offerId, offer: { type: "offer", sdp: paddedOffer } }],
      }));
    }

    function makeStoppedPayloads(hashes: string[]): string[] {
      return hashes.map((h) => JSON.stringify({
        action: "announce",
        info_hash: h,
        peer_id: peerId,
        event: "stopped",
      }));
    }

    function sendAll(payloads: string[]): void {
      for (const ws of sockets.values()) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        for (const p of payloads) {
          try { ws.send(p); } catch { break; }
        }
      }
    }

    async function checkEpochRotation(): Promise<void> {
      if (done) return;
      const now = Date.now();
      const epoch = Math.floor(now / EPOCH_WINDOW);
      if (epoch === lastEpoch) return;

      callbacks.onLog("flare renewing presence");

      // Stop old hashes
      sendAll(makeStoppedPayloads(currentHashes));

      // Derive new
      lastEpoch = epoch;
      currentHashes = await deriveInfoHashes(phrase);

      // Announce new
      sendAll(makeAnnouncePayloads(currentHashes));
    }

    function scheduleReconnect(url: string): void {
      if (done) return;
      if (reconnectTimers.has(url)) return;

      const host = new URL(url).host;
      const delay = reconnectDelayByUrl.get(url) ?? RECONNECT_BASE;
      reconnectDelayByUrl.set(url, Math.min(delay * 2, RECONNECT_CAP));

      callbacks.onLog(`flare reconnecting via ${host} in ${(delay / 1000).toFixed(0)}s...`);

      const timer = setTimeout(async () => {
        reconnectTimers.delete(url);
        if (done) return;

        // Re-derive hashes in case epoch changed while disconnected.
        lastEpoch = Math.floor(Date.now() / EPOCH_WINDOW);
        currentHashes = await deriveInfoHashes(phrase);

        connectToTracker(url);
      }, delay);

      reconnectTimers.set(url, timer);
    }

    function connectToTracker(url: string): void {
      if (done) return;
      if (sockets.has(url)) return;

      const host = new URL(url).host;
      callbacks.onStatus("connecting to relay...");

      let opened = false;
      let closeHandled = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        connectTimer = null;
        if (closeHandled) return;
        const sock = sockets.get(url);
        if (sock) {
          try { sock.close(); } catch { /* noop */ }
        }
        scheduleReconnect(url);
      }, WS_CONNECT_TIMEOUT);

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        scheduleReconnect(url);
        return;
      }
      sockets.set(url, ws);

      const handleDrop = () => {
        if (closeHandled) return;
        closeHandled = true;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        const cur = sockets.get(url);
        if (cur === ws) sockets.delete(url);
        if (!done) {
          if (opened) callbacks.onLog(`flare connection dropped via ${host}, reconnecting...`);
          callbacks.onStatus("reconnecting...");
          scheduleReconnect(url);
        }
      };

      ws.onopen = () => {
        opened = true;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        if (done) return;

        reconnectDelayByUrl.set(url, RECONNECT_BASE); // Reset backoff on success

        callbacks.onLog(`flare connected via ${host}`);
        callbacks.onStatus("flare is burning");

        // Announce on all current hashes
        sendAll(makeAnnouncePayloads(currentHashes));

        // Start periodic re-announce / epoch check
        if (!reannounceTimer) {
          reannounceTimer = setInterval(() => {
            if (done) return;
            // Re-announce (tracker keepalive) + check epoch
            sendAll(makeAnnouncePayloads(currentHashes));
            void checkEpochRotation();
          }, REANNOUNCE_INTERVAL);
        }
      };

      ws.onmessage = (event) => {
        if (done) return;

        const raw = event.data;
        if (typeof raw !== "string" || raw.length > 8192) return;

        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg["failure reason"]) {
          callbacks.onLog(`flare message: ${msg["failure reason"]}`);
          return;
        }

        // ── Offer received → we may become the answerer ──
        if (msg.offer && typeof msg.offer === "object") {
          const offer = msg.offer as Record<string, unknown>;
          const peerOfferCode = unpadCode(String(offer.sdp ?? ""));
          const peerOfferId = String(msg.offer_id ?? "");
          const peerPeerId = String(msg.peer_id ?? "");

          if (!peerOfferCode || peerOfferCode.length < MIN_CODE_LEN) return;
          if (!peerOfferId) return;
          if (peerPeerId === peerId) return;
          if (!BASE64URL_RE.test(peerOfferCode)) return;

          const offerKey = `${peerPeerId}|${peerOfferId}|${peerOfferCode.slice(0, 24)}`;
          if (seenOffers.has(offerKey)) return;

          // Tie-break: lower peer_id becomes answerer
          if (peerId > peerPeerId) {
            callbacks.onLog("resolving connection order...");
            return;
          }
          seenOffers.add(offerKey);

          callbacks.onLog("someone found your flare");

          const replyHash = typeof msg.info_hash === "string" ? msg.info_hash : currentHashes[0];

          // Ask UI if user wants to accept
          void callbacks.onPeerArrived().then(async (accepted) => {
            if (done) return;
            if (!accepted) {
              callbacks.onLog("peer ignored, still listening");
              callbacks.onStatus("flare is burning");
              return;
            }

            callbacks.onStatus("connecting to peer...");
            callbacks.onLog("accepting peer offer");

            try {
              const myAnswerCode = await acceptOfferFn(peerOfferCode);
                if (done || ws.readyState !== WebSocket.OPEN) return;

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
            } catch {
              callbacks.onLog("accept failed");
              callbacks.onStatus("flare is burning");
            }
          });
          return;
        }

        // ── Answer received → we stay offerer ──
        if (msg.answer && typeof msg.answer === "object") {
          const answer = msg.answer as Record<string, unknown>;
          const peerAnswerCode = unpadCode(String(answer.sdp ?? ""));
          if (!peerAnswerCode || peerAnswerCode.length < MIN_CODE_LEN) return;
          if (!BASE64URL_RE.test(peerAnswerCode)) return;

          const answerKey = `${String(msg.peer_id ?? "")}|${String(msg.offer_id ?? "")}|${peerAnswerCode.slice(0, 24)}`;
          if (seenAnswers.has(answerKey)) return;
          seenAnswers.add(answerKey);

          callbacks.onStatus("found your peer!");
          callbacks.onLog("peer accepted our offer");
          finish({ role: "offerer", peerAnswerCode });
          return;
        }
      };

      ws.onerror = () => {
        // onclose handles reconnect consistently.
      };

      ws.onclose = handleDrop;
    }

    function connectAllTrackers(): void {
      for (const url of TRACKER_URLS) connectToTracker(url);
    }

    // Start by connecting to all trackers, so peers on different relays can still meet.
    connectAllTrackers();
  });
}
