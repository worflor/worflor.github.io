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
  makeTrackerAnnouncePayloads,
  makeTrackerStoppedPayloads,
  parseTrackerMessage,
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

const EPOCH_CHECK_INTERVAL = 30_000;
const WS_CONNECT_TIMEOUT = 8_000;
const RECONNECT_BASE = 2_000;
const RECONNECT_CAP = 30_000;
const MAX_SEEN_MESSAGES = 1024;

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
    let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
    const sockets = new Map<string, WebSocket>();
    const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const reconnectDelayByUrl = new Map<string, number>();
    const seenOffers = new Set<string>();
    const seenAnswers = new Set<string>();
    let awaitingPeerDecision = false;

    const finish = (result?: FlareResult, error?: Error) => {
      if (done) return;
      done = true;

      if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
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
      return makeTrackerAnnouncePayloads(hashes, peerId, offerId, paddedOffer);
    }

    function makeStoppedPayloads(hashes: string[]): string[] {
      return makeTrackerStoppedPayloads(hashes, peerId);
    }

    function sendAll(payloads: string[]): void {
      for (const ws of sockets.values()) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        for (const p of payloads) {
          try { ws.send(p); } catch { break; }
        }
      }
    }

    function sendOnSocket(ws: WebSocket, payloads: string[]): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      for (const p of payloads) {
        try { ws.send(p); } catch { break; }
      }
    }

    function rememberSeen(set: Set<string>, key: string): boolean {
      if (set.has(key)) return false;
      set.add(key);
      if (set.size > MAX_SEEN_MESSAGES) {
        const oldest = set.values().next().value;
        if (oldest) set.delete(oldest);
      }
      return true;
    }

    async function refreshEpochPresence(): Promise<void> {
      if (done) return;
      const now = Date.now();
      const epoch = Math.floor(now / EPOCH_WINDOW);
      if (epoch === lastEpoch) return;

      callbacks.onLog("flare renewing presence");

      const oldHashes = currentHashes;

      // Derive new first. If this fails, keep old presence unchanged.
      let nextHashes: string[];
      try {
        nextHashes = await deriveInfoHashes(phrase);
      } catch {
        callbacks.onLog("flare renewal skipped (hash refresh failed)");
        return;
      }

      // Stop old hashes
      sendAll(makeStoppedPayloads(oldHashes));

      // Derive new
      lastEpoch = epoch;
      currentHashes = nextHashes;

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

        try {
          // Re-derive hashes in case epoch changed while disconnected.
          lastEpoch = Math.floor(Date.now() / EPOCH_WINDOW);
          currentHashes = await deriveInfoHashes(phrase);
        } catch {
          if (!done) scheduleReconnect(url);
          return;
        }

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
        closeHandled = true;
        const sock = sockets.get(url);
        if (sock) sockets.delete(url);
        if (sock) {
          try { sock.close(); } catch { /* noop */ }
        }
        if (!done) scheduleReconnect(url);
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
          const anyOpen = [...sockets.values()].some(s => s.readyState === WebSocket.OPEN);
          if (!anyOpen) callbacks.onStatus("reconnecting...");
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

        // Announce on this tracker connection.
        sendOnSocket(ws, makeAnnouncePayloads(currentHashes));

        // Periodic re-announce: keeps the tracker socket alive (servers drop
        // idle connections after ~60s) and re-advertises our offer so late
        // joiners can discover us.
        if (!maintenanceTimer) {
          maintenanceTimer = setInterval(() => {
            if (done) return;
            void refreshEpochPresence().then(() => {
              if (!done) sendAll(makeAnnouncePayloads(currentHashes));
            });
          }, EPOCH_CHECK_INTERVAL);
        }
      };

      ws.onmessage = (event) => {
        if (done) return;

        const msg = parseTrackerMessage(event.data);
        if (!msg) return;

        if (msg["failure reason"]) {
          callbacks.onLog(`flare message: ${msg["failure reason"]}`);
          return;
        }

        // Keep compatibility with tracker messages that omit info_hash,
        // but reject explicit hashes outside our active phrase window.
        const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : "";
        if (infoHash && !currentHashes.includes(infoHash)) return;

        // ── Offer received → we may become the answerer ──
        if (msg.offer && typeof msg.offer === "object") {
          if (awaitingPeerDecision) return;

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
          if (!rememberSeen(seenOffers, offerKey)) return;

          // Tie-break: lower peer_id becomes answerer
          if (peerId > peerPeerId) {
            callbacks.onLog("resolving connection order...");
            return;
          }

          callbacks.onLog("someone found your flare");

          const replyHash = typeof msg.info_hash === "string" ? msg.info_hash : currentHashes[0];

          // Ask UI if user wants to accept
          awaitingPeerDecision = true;
          void callbacks.onPeerArrived().then(async (accepted) => {
            awaitingPeerDecision = false;
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
          }).catch(() => {
            awaitingPeerDecision = false;
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
          if (!peerAnswerCode || peerAnswerCode.length < MIN_CODE_LEN) return;
          if (!fromPeerId || fromPeerId === peerId) return;
          if (toPeerId && toPeerId !== peerId) return;
          if (incomingOfferId && incomingOfferId !== offerId) return;
          if (!BASE64URL_RE.test(peerAnswerCode)) return;

          const answerKey = `${fromPeerId}|${incomingOfferId}|${peerAnswerCode.slice(0, 24)}`;
          if (!rememberSeen(seenAnswers, answerKey)) return;

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
