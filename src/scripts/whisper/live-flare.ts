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
  TRACKER_URLS,
  EPOCH_WINDOW,
  MIN_CODE_LEN,
  BASE64URL_RE,
  makeTrackerPresencePayloads,
  makeTrackerStoppedPayloads,
  parseTrackerMessage,
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

const EPOCH_CHECK_INTERVAL = 30_000;
const WS_CONNECT_TIMEOUT = 8_000;
const RECONNECT_BASE = 2_000;
const RECONNECT_CAP = 30_000;
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
    let awaitingPeerDecision = false;

    const finish = (result?: FlareResult, error?: Error) => {
      if (done) return;
      done = true;

      if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
      for (const t of reconnectTimers.values()) clearTimeout(t);
      reconnectTimers.clear();

      // send stopped for current hashes on all open sockets
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

    function makePresencePayloads(hashes: string[]): string[] {
      return makeTrackerPresencePayloads(hashes, peerId);
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

    function rememberSeen(key: string): boolean {
      if (seenOffers.has(key)) return false;
      seenOffers.add(key);
      if (seenOffers.size > MAX_SEEN_OFFERS) {
        const oldest = seenOffers.values().next().value;
        if (oldest) seenOffers.delete(oldest);
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

      let nextHashes: string[];
      try {
        nextHashes = await deriveInfoHashes(phrase);
      } catch {
        callbacks.onLog("flare renewal skipped (hash refresh failed)");
        return;
      }

      if (done) return;

      // stop old hashes, switch, announce new
      sendAll(makeStoppedPayloads(oldHashes));
      lastEpoch = epoch;
      currentHashes = nextHashes;
      sendAll(makePresencePayloads(currentHashes));
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
          lastEpoch = Math.floor(Date.now() / EPOCH_WINDOW);
          currentHashes = await deriveInfoHashes(phrase);
        } catch {
          if (!done) scheduleReconnect(url);
          return;
        }

        if (done) return;
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

        reconnectDelayByUrl.set(url, RECONNECT_BASE);

        callbacks.onLog(`flare connected via ${host}`);
        callbacks.onStatus("flare is burning");

        // presence-only announce, no SDP offer attached
        sendOnSocket(ws, makePresencePayloads(currentHashes));

        // periodic re-announce keeps the tracker socket alive (servers drop
        // idle connections after ~60s) and refreshes epoch hashes
        if (!maintenanceTimer) {
          maintenanceTimer = setInterval(() => {
            if (done) return;
            void refreshEpochPresence().then(() => {
              if (!done) sendAll(makePresencePayloads(currentHashes));
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

        const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : "";
        if (infoHash && !currentHashes.includes(infoHash)) return;

        // flare only handles incoming offers, it never sends offers
        if (!msg.offer || typeof msg.offer !== "object") return;
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
        if (!rememberSeen(offerKey)) return;

        callbacks.onLog("someone found your flare");

        const replyHash = typeof msg.info_hash === "string" ? msg.info_hash : currentHashes[0];

        // ask the UI if the user wants to accept
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
            if (done) return;
            if (ws.readyState !== WebSocket.OPEN) {
              // socket dropped while we were processing the accept, so the answer
              // can't be delivered. clean up the entire flare so the peer isn't
              // left waiting on a dead offer.
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
            callbacks.onLog("accept failed, still listening");
            callbacks.onStatus("flare is burning");
          }
        }).catch(() => {
          awaitingPeerDecision = false;
        });
      };

      ws.onerror = () => {
        // onclose handles reconnect consistently
      };

      ws.onclose = handleDrop;
    }

    // connect to all trackers so peers on different relays can still meet
    for (const url of TRACKER_URLS) connectToTracker(url);
  });
}
