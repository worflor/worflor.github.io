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
    let ws: WebSocket | null = null;
    let reannounceTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectDelay = RECONNECT_BASE;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectedUrl = "";

    const finish = (result?: FlareResult, error?: Error) => {
      if (done) return;
      done = true;

      if (reannounceTimer) { clearInterval(reannounceTimer); reannounceTimer = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

      // Send stopped for current hashes
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const h of currentHashes) {
          try {
            ws.send(JSON.stringify({
              action: "announce",
              info_hash: h,
              peer_id: peerId,
              event: "stopped",
            }));
          } catch { break; }
        }
        try { ws.close(1000); } catch { /* noop */ }
      } else {
        try { ws?.close(1000); } catch { /* noop */ }
      }
      ws = null;

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
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      for (const p of payloads) {
        try { ws.send(p); } catch { break; }
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

    function connectToTracker(url: string): void {
      if (done) return;

      const host = new URL(url).host;
      callbacks.onStatus("connecting to relay...");

      let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        connectTimer = null;
        if (ws) {
          try { ws.close(); } catch { /* noop */ }
          ws = null;
        }
        scheduleReconnect();
      }, WS_CONNECT_TIMEOUT);

      try {
        ws = new WebSocket(url);
      } catch {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        if (done) return;

        connectedUrl = url;
        reconnectDelay = RECONNECT_BASE; // Reset backoff on success

        callbacks.onLog(`flare connected via ${host}`);
        callbacks.onStatus("flare is burning");

        // Announce on all current hashes
        sendAll(makeAnnouncePayloads(currentHashes));

        // Start periodic re-announce / epoch check
        if (reannounceTimer) clearInterval(reannounceTimer);
        reannounceTimer = setInterval(() => {
          if (done) return;
          // Re-announce (tracker keepalive) + check epoch
          sendAll(makeAnnouncePayloads(currentHashes));
          void checkEpochRotation();
        }, REANNOUNCE_INTERVAL);
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
          if (peerPeerId === peerId) return;
          if (!BASE64URL_RE.test(peerOfferCode)) return;

          // Tie-break: lower peer_id becomes answerer
          if (peerId > peerPeerId) {
            callbacks.onLog("resolving connection order...");
            return;
          }

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
              if (done || !ws || ws.readyState !== WebSocket.OPEN) return;

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

          callbacks.onStatus("found your peer!");
          callbacks.onLog("peer accepted our offer");
          finish({ role: "offerer", peerAnswerCode });
          return;
        }
      };

      ws.onerror = () => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        if (!done) scheduleReconnect();
      };

      ws.onclose = () => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        if (!done) {
          callbacks.onLog("flare connection dropped, reconnecting...");
          callbacks.onStatus("reconnecting...");
          scheduleReconnect();
        }
      };
    }

    function scheduleReconnect(): void {
      if (done) return;
      if (reannounceTimer) { clearInterval(reannounceTimer); reannounceTimer = null; }
      ws = null;

      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_CAP);

      callbacks.onLog(`flare reconnecting in ${(delay / 1000).toFixed(0)}s...`);
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (done) return;

        // Re-derive hashes in case epoch changed during disconnect
        lastEpoch = Math.floor(Date.now() / EPOCH_WINDOW);
        currentHashes = await deriveInfoHashes(phrase);

        // Try preferred URL first, then fall back to racing all
        if (connectedUrl) {
          connectToTracker(connectedUrl);
        } else {
          connectFirst();
        }
      }, delay);
    }

    function connectFirst(): void {
      if (done) return;
      // Race all trackers — first to open wins
      let won = false;
      const sockets: WebSocket[] = [];

      for (const url of TRACKER_URLS) {
        try {
          const sock = new WebSocket(url);
          sockets.push(sock);

          sock.onopen = () => {
            if (won || done) {
              try { sock.close(1000); } catch { /* noop */ }
              return;
            }
            won = true;
            // Close all other sockets
            for (const s of sockets) {
              if (s !== sock) {
                try { s.close(1000); } catch { /* noop */ }
              }
            }
            // Reassign to main socket and set up handlers
            try { sock.close(1000); } catch { /* noop */ }
            connectToTracker(url);
          };

          sock.onerror = () => {
            // Will trigger onclose
          };

          sock.onclose = () => {
            if (!won && sockets.every((s) => s.readyState === WebSocket.CLOSED)) {
              // All failed
              if (!done) scheduleReconnect();
            }
          };
        } catch {
          // Skip this URL
        }
      }

      // Timeout for initial connection race
      setTimeout(() => {
        if (!won && !done) {
          for (const s of sockets) {
            try { s.close(); } catch { /* noop */ }
          }
          scheduleReconnect();
        }
      }, WS_CONNECT_TIMEOUT);
    }

    // Start by racing all trackers
    connectFirst();
  });
}
