import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { TRACKER_URLS, runLiveRendezvous } from "../../src/scripts/whisper/live-tracker.js";
import { hostCampfireViaFlare, joinCampfireViaFlare } from "../../src/scripts/whisper/campfire/flare.js";

type FakeMessageEvent = { data: unknown };
type Scenario = "live-flare" | "live-flare-abort" | "campfire-join" | "campfire-host";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function encodePayload(payload: unknown): string {
  return b64url(JSON.stringify(payload));
}

class FakeFlareWebSocket {
  static instances: FakeFlareWebSocket[] = [];
  static scenario: Scenario = "live-flare";
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readyState = FakeFlareWebSocket.CONNECTING;
  onopen: ((this: FakeFlareWebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: FakeFlareWebSocket, ev: FakeMessageEvent) => unknown) | null = null;
  onerror: ((this: FakeFlareWebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: FakeFlareWebSocket, ev: Event) => unknown) | null = null;
  sent: string[] = [];
  closeCodes: number[] = [];
  private responded = false;
  private flareIntentSent = false;

  constructor(url: string) {
    this.url = url;
    FakeFlareWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeFlareWebSocket.CONNECTING) return;
      this.readyState = FakeFlareWebSocket.OPEN;
      this.onopen?.call(this, new Event("open"));
    });
  }

  send(payload: string): void {
    this.sent.push(payload);
    const msg = JSON.parse(payload) as {
      action?: string;
      info_hash?: string;
      peer_id?: string;
      offer_id?: string;
      offers?: Array<{ offer_id?: string; offer?: { type?: string; sdp?: string } }>;
      answer?: { type?: string; sdp?: string };
    };
    if (msg.action !== "announce" || !msg.peer_id || !msg.info_hash) return;

    if (FakeFlareWebSocket.scenario === "live-flare" || FakeFlareWebSocket.scenario === "live-flare-abort") {
      const announceOffer = msg.offers?.[0]?.offer;
      if (Array.isArray(msg.offers) && msg.offers.length === 0 && !this.flareIntentSent) {
        this.flareIntentSent = true;
        queueMicrotask(() => {
          if (this.readyState !== FakeFlareWebSocket.OPEN) return;
          this.onmessage?.call(this, {
            data: JSON.stringify({
              offer: {
                type: "whisper-intent",
                sdp: encodePayload({ attemptId: "remote-attempt" }),
              },
              offer_id: "remote-intent",
              peer_id: "peer-remote",
              to_peer_id: msg.peer_id,
              info_hash: msg.info_hash,
            }),
          });
        });
        return;
      }
      if (msg.answer?.type === "whisper-match-ack" && FakeFlareWebSocket.scenario === "live-flare" && !this.responded) {
        const payloadJson = Buffer.from(String(msg.answer.sdp), "base64url").toString("utf8");
        const matchPayload = JSON.parse(payloadJson) as { rendezvousId: string };
        this.responded = true;
        queueMicrotask(() => {
          if (this.readyState !== FakeFlareWebSocket.OPEN) return;
          this.onmessage?.call(this, {
            data: JSON.stringify({
              offer: {
                type: "whisper-offer-code",
                sdp: `${encodePayload({ rendezvousId: matchPayload.rendezvousId, code: "A".repeat(64) })}.`.padEnd(1024, "."),
                whisper_session: matchPayload.rendezvousId,
                to_peer_id: msg.peer_id,
              },
              offer_id: "remote-live-offer",
              peer_id: "peer-remote",
              info_hash: msg.info_hash,
            }),
          });
        });
        return;
      }
      if (announceOffer?.type === "whisper-offer-code") return;
    }

    if (FakeFlareWebSocket.scenario === "campfire-host") {
      if (!Array.isArray(msg.offers) || msg.offers.length === 0) return;
      const offerId = msg.offers[0]?.offer_id;
      if (!offerId || this.responded) return;
      this.responded = true;
      queueMicrotask(() => {
        if (this.readyState !== FakeFlareWebSocket.OPEN) return;
        this.onmessage?.call(this, {
          data: JSON.stringify({
            answer: { type: "answer", sdp: "C".repeat(64) },
            peer_id: "campfire-joiner",
            to_peer_id: msg.peer_id,
            offer_id: offerId,
            info_hash: msg.info_hash,
          }),
        });
      });
      return;
    }

    if (FakeFlareWebSocket.scenario === "campfire-join") {
      if (Array.isArray(msg.offers)) return;
      if (this.responded) return;
      this.responded = true;
      queueMicrotask(() => {
        if (this.readyState !== FakeFlareWebSocket.OPEN) return;
        this.onmessage?.call(this, {
          data: JSON.stringify({
            offer: { type: "offer", sdp: "A".repeat(64) },
            offer_id: "campfire-offer",
            peer_id: "campfire-host",
            to_peer_id: msg.peer_id,
            info_hash: msg.info_hash,
          }),
        });
      });
    }
  }

  close(code = 1000): void {
    if (this.readyState === FakeFlareWebSocket.CLOSED) return;
    this.closeCodes.push(code);
    this.readyState = FakeFlareWebSocket.CLOSED;
  }
}

const realWebSocket = globalThis.WebSocket;
const TEST_TIMEOUT_MS = 3_000;

async function withAbortTimeout<T>(
  ac: AbortController,
  run: () => Promise<T>,
): Promise<T> {
  const timer = setTimeout(() => ac.abort(), TEST_TIMEOUT_MS);
  try {
    return await run();
  } finally {
    clearTimeout(timer);
  }
}

function closeAllFakeSockets(): void {
  for (const ws of FakeFlareWebSocket.instances) ws.close(1000);
}

function installFakeWebSocket(scenario: Scenario): void {
  FakeFlareWebSocket.instances = [];
  FakeFlareWebSocket.scenario = scenario;
  globalThis.WebSocket = FakeFlareWebSocket as unknown as typeof WebSocket;
}

function restoreWebSocket(): void {
  globalThis.WebSocket = realWebSocket;
}

afterEach(() => {
  closeAllFakeSockets();
  restoreWebSocket();
});

describe("flare cleanup", () => {
  it("signal flare removes external abort listener and closes tracker sockets after success", async () => {
    installFakeWebSocket("live-flare");
    const ac = new AbortController();
    let seenOfferCode = "";

    const result = await withAbortTimeout(ac, () => runLiveRendezvous({
      mode: "flare-listener",
      phrase: "tower phrase",
      acceptOfferCode: async (peerOfferCode) => {
        seenOfferCode = peerOfferCode;
        return "B".repeat(64);
      },
      callbacks: {
        onStatus: () => {},
        onLog: () => {},
        onPeerArrived: async () => true,
      },
      signal: ac.signal,
    }));

    assert.equal(result.role, "answerer");
    assert.equal(seenOfferCode, "A".repeat(64));
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
    assert.ok(result.relay);
    result.relay.destroy();
    assert.equal(FakeFlareWebSocket.instances.length, TRACKER_URLS.length);
    for (const ws of FakeFlareWebSocket.instances) {
      assert.equal(ws.readyState, FakeFlareWebSocket.CLOSED);
      assert.deepStrictEqual(ws.closeCodes, [1000]);
    }
  });

  it("campfire flare join removes external abort listener and closes relay sockets after success", async () => {
    installFakeWebSocket("campfire-join");
    const ac = new AbortController();
    let seenOfferCode = "";

    await withAbortTimeout(ac, () => joinCampfireViaFlare({
      phrase: "tower phrase",
      acceptOfferCode: async (offerCode) => {
        seenOfferCode = offerCode;
        return "C".repeat(64);
      },
      onStatus: () => {},
      onLog: () => {},
      signal: ac.signal,
    }));

    assert.equal(seenOfferCode, "A".repeat(64));
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
    assert.ok(FakeFlareWebSocket.instances.length >= 1);
    for (const ws of FakeFlareWebSocket.instances) {
      assert.ok(ws.closeCodes.length <= 1);
      if (ws.closeCodes.length === 1) assert.equal(ws.closeCodes[0], 1000);
      assert.notEqual(ws.readyState, FakeFlareWebSocket.OPEN);
    }
  });

  it("campfire host flare removes abort listener and closes tracker sockets on abort after handling an answer", async () => {
    installFakeWebSocket("campfire-host");
    const ac = new AbortController();
    const seenAnswers: string[] = [];

    const hostPromise = withAbortTimeout(ac, () => hostCampfireViaFlare({
      phrase: "tower phrase",
      getCurrentOfferCode: () => "B".repeat(64),
      applyAnswerCode: async (answerCode) => {
        seenAnswers.push(answerCode);
        ac.abort();
      },
      onStatus: () => {},
      onLog: () => {},
      signal: ac.signal,
    }));

    await hostPromise;
    await delay(0);

    assert.deepStrictEqual(seenAnswers, ["C".repeat(64)]);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
    assert.equal(FakeFlareWebSocket.instances.length, TRACKER_URLS.length);
    for (const ws of FakeFlareWebSocket.instances) {
      assert.equal(ws.readyState, FakeFlareWebSocket.CLOSED);
      assert.ok(ws.closeCodes.length <= 1);
      if (ws.closeCodes.length === 1) assert.equal(ws.closeCodes[0], 1000);
    }
  });

  it("signal flare removes abort listener and closes sockets when extinguished before accepting a peer", async () => {
    installFakeWebSocket("live-flare-abort");
    const ac = new AbortController();

    const flarePromise = withAbortTimeout(ac, () => runLiveRendezvous({
      mode: "flare-listener",
      phrase: "tower phrase",
      acceptOfferCode: async () => "B".repeat(64),
      callbacks: {
        onStatus: () => {},
        onLog: () => {},
        onPeerArrived: async () => {
          ac.abort();
          return false;
        },
      },
      signal: ac.signal,
    }));

    await assert.rejects(flarePromise, (err: unknown) => {
      assert.ok(err instanceof DOMException);
      assert.equal(err.name, "AbortError");
      return true;
    });

    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
    for (const ws of FakeFlareWebSocket.instances) {
      assert.notEqual(ws.readyState, FakeFlareWebSocket.OPEN);
    }
  });
});
