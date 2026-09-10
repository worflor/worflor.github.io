import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import {
  TRACKER_URLS,
  createTrackerPool,
  runLiveRendezvous,
  type TrackerRelaySignal,
} from "../../src/scripts/whisper/live-tracker.js";

type FakeMessageEvent = { data: unknown };

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function encodePayload(payload: unknown): string {
  return b64url(JSON.stringify(payload));
}

function decodePayload<T>(payload: string): T {
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
}

function createRendezvousId(
  localPeerId: string,
  localAttemptId: string,
  remotePeerId: string,
  remoteAttemptId: string,
): string {
  const peers = [`${localPeerId}:${localAttemptId}`, `${remotePeerId}:${remoteAttemptId}`].sort();
  return encodePayload({ peers });
}

class FakeTrackerWebSocket {
  static instances: FakeTrackerWebSocket[] = [];
  static lastRendezvousId = "";
  static lastLiveOfferId = "";
  static scenario: "normal" | "old-timestamp" = "normal";
  static echoSignals = false;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readyState = FakeTrackerWebSocket.CONNECTING;
  onopen: ((this: FakeTrackerWebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: FakeTrackerWebSocket, ev: FakeMessageEvent) => unknown) | null = null;
  onerror: ((this: FakeTrackerWebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: FakeTrackerWebSocket, ev: Event) => unknown) | null = null;
  sent: string[] = [];
  closeCodes: number[] = [];
  private sentMatchAck = false;
  private sentAnswer = false;
  private sentFreshIntent = false;

  constructor(url: string) {
    this.url = url;
    FakeTrackerWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeTrackerWebSocket.CONNECTING) return;
      this.readyState = FakeTrackerWebSocket.OPEN;
      this.onopen?.call(this, new Event("open"));
    });
  }

  send(payload: string): void {
    this.sent.push(payload);
    const msg = JSON.parse(payload) as {
      action?: string;
      info_hash?: string;
      peer_id?: string;
      to_peer_id?: string;
      offer_id?: string;
      offers?: Array<{ offer_id?: string; offer?: { type?: string; sdp?: string; whisper_session?: string } }>;
      answer?: { type?: string; sdp?: string };
    };
    if (msg.action !== "announce" || !msg.peer_id || !msg.info_hash) return;

    const announceOffer = msg.offers?.[0]?.offer;
    const offerSdp = typeof announceOffer?.sdp === "string" ? announceOffer.sdp : "";

    // echo any relay signal the local peer sends straight back as if it came
    // from the remote peer — this is what a real tracker's swarm delivery does,
    // and it exercises the sealed round-trip + the post-settle receive path.
    if (FakeTrackerWebSocket.echoSignals && offerSdp.startsWith("whisper-signal:")) {
      queueMicrotask(() => {
        if (this.readyState !== FakeTrackerWebSocket.OPEN) return;
        this.onmessage?.call(this, {
          data: JSON.stringify({
            offer: {
              type: "offer",
              sdp: offerSdp,
              whisper_session: announceOffer?.whisper_session ?? FakeTrackerWebSocket.lastRendezvousId,
              to_peer_id: msg.peer_id,
            },
            offer_id: msg.offers?.[0]?.offer_id,
            peer_id: "peer-remote",
            info_hash: msg.info_hash,
          }),
        });
      });
      return;
    }
    if (offerSdp.startsWith("whisper-intent:") && !this.sentMatchAck) {
      const intentPayload = offerSdp.slice("whisper-intent:".length);
      const localIntent = decodePayload<{
        attemptId: string;
        sessionTag: string;
        issuedAt: number;
      }>(intentPayload);
      const remoteSessionTag = "peer-remote-session";
      // unique per local attempt, as production attempt ids are: the
      // tracker's ghost denylist refuses identities from settled attempts,
      // so a fixed fixture id would read as a ghost across scenarios.
      const remoteAttemptId = `remote-attempt-${localIntent.attemptId}`;

      if (FakeTrackerWebSocket.scenario === "old-timestamp" && !this.sentFreshIntent) {
        // an intent stamped well outside the old 30s TTL must still be honored.
        // device clocks are independent and unsynced, so a wall-clock age gate
        // silently froze out drifted peers — that was the connection regression.
        const oldIntent = `whisper-intent:${encodePayload({
          attemptId: remoteAttemptId,
          sessionTag: remoteSessionTag,
          issuedAt: Date.now() - 90_000,
        })}`;
        this.sentFreshIntent = true;
        this.sentMatchAck = true;
        const rendezvousId = createRendezvousId(msg.peer_id, localIntent.attemptId, "peer-remote", remoteAttemptId);
        FakeTrackerWebSocket.lastRendezvousId = rendezvousId;
        queueMicrotask(() => {
          if (this.readyState !== FakeTrackerWebSocket.OPEN) return;
          this.onmessage?.call(this, {
            data: JSON.stringify({
              offer: {
                type: "offer",
                sdp: oldIntent,
              },
              offer_id: "remote-intent-old",
              peer_id: "peer-remote",
              to_peer_id: msg.peer_id,
              info_hash: msg.info_hash,
            }),
          });
          this.onmessage?.call(this, {
            data: JSON.stringify({
              answer: {
                type: "answer",
                sdp: `whisper-match-ack:${encodePayload({
                  rendezvousId,
                  fromAttemptId: remoteAttemptId,
                  fromSessionTag: remoteSessionTag,
                  toSessionTag: localIntent.sessionTag,
                  issuedAt: Date.now(),
                })}`,
              },
              peer_id: "peer-remote",
              to_peer_id: msg.peer_id,
              offer_id: msg.offers?.[0]?.offer_id,
              info_hash: msg.info_hash,
            }),
          });
        });
        return;
      }

      const rendezvousId = createRendezvousId(msg.peer_id, localIntent.attemptId, "peer-remote", remoteAttemptId);
      FakeTrackerWebSocket.lastRendezvousId = rendezvousId;
      this.sentMatchAck = true;
      queueMicrotask(() => {
        if (this.readyState !== FakeTrackerWebSocket.OPEN) return;
        this.onmessage?.call(this, {
          data: JSON.stringify({
            answer: {
              type: "answer",
              sdp: `whisper-match-ack:${encodePayload({
                rendezvousId,
                fromAttemptId: remoteAttemptId,
                fromSessionTag: remoteSessionTag,
                toSessionTag: localIntent.sessionTag,
                issuedAt: Date.now(),
              })}`,
            },
            peer_id: "peer-remote",
            to_peer_id: msg.peer_id,
            offer_id: msg.offers?.[0]?.offer_id,
            info_hash: msg.info_hash,
          }),
        });
      });
      return;
    }

    if (offerSdp.startsWith("whisper-offer-code:") && !this.sentAnswer) {
      const codePayload = offerSdp.replace(/\.+$/, "").slice("whisper-offer-code:".length);
      const offerPayload = decodePayload<{
        rendezvousId: string;
        toSessionTag: string;
        fromSessionTag: string;
      }>(codePayload);
      FakeTrackerWebSocket.lastLiveOfferId = String(msg.offers?.[0]?.offer_id ?? "");
      this.sentAnswer = true;
      queueMicrotask(() => {
        if (this.readyState !== FakeTrackerWebSocket.OPEN) return;
        this.onmessage?.call(this, {
          data: JSON.stringify({
            answer: {
              type: "answer",
              sdp: `whisper-answer-code:${encodePayload({
                rendezvousId: offerPayload.rendezvousId,
                code: "A".repeat(64),
                fromSessionTag: "peer-remote-session",
                toSessionTag: offerPayload.fromSessionTag,
                issuedAt: Date.now(),
              })}`.padEnd(1024, "."),
            },
            peer_id: "peer-remote",
            to_peer_id: msg.peer_id,
            offer_id: msg.offers?.[0]?.offer_id,
            info_hash: msg.info_hash,
          }),
        });
      });
    }
  }

  close(code = 1000): void {
    if (this.readyState === FakeTrackerWebSocket.CLOSED) return;
    this.closeCodes.push(code);
    this.readyState = FakeTrackerWebSocket.CLOSED;
  }
}

const realWebSocket = globalThis.WebSocket;
const TEST_TIMEOUT_MS = 3_000;

async function waitForTrackerSockets(count: number): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (FakeTrackerWebSocket.instances.length < count) {
    if (Date.now() >= deadline) throw new Error("tracker sockets did not start in time");
    await delay(0);
  }
}

function closeAllFakeSockets(): void {
  for (const ws of FakeTrackerWebSocket.instances) ws.close(1000);
}

function installFakeWebSocket(scenario: "normal" | "old-timestamp" = "normal", echoSignals = false): void {
  FakeTrackerWebSocket.instances = [];
  FakeTrackerWebSocket.lastRendezvousId = "";
  FakeTrackerWebSocket.lastLiveOfferId = "";
  FakeTrackerWebSocket.scenario = scenario;
  FakeTrackerWebSocket.echoSignals = echoSignals;
  globalThis.WebSocket = FakeTrackerWebSocket as unknown as typeof WebSocket;
}

function restoreWebSocket(): void {
  globalThis.WebSocket = realWebSocket;
}

afterEach(() => {
  closeAllFakeSockets();
  restoreWebSocket();
});

describe("live-tracker cleanup", () => {
  it("tracker pool destroy removes abort listener and closes tracker sockets", async () => {
    installFakeWebSocket();
    const ac = new AbortController();

    const pool = createTrackerPool(
      "tower phrase",
      "peer-id",
      ["hash-a"],
      {
        onLog: () => {},
        makeAnnounce: () => [],
        onMessage: () => {},
      },
      ac.signal,
    );

    await waitForTrackerSockets(TRACKER_URLS.length);
    assert.equal(FakeTrackerWebSocket.instances.length, TRACKER_URLS.length);
    assert.equal(getEventListeners(ac.signal, "abort").length, 1);

    pool.destroy();

    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
    for (const ws of FakeTrackerWebSocket.instances) {
      assert.equal(ws.readyState, FakeTrackerWebSocket.CLOSED);
      assert.deepStrictEqual(ws.closeCodes, [1000]);
    }
  });

  it("simultaneous rendezvous creates only one live offer and closes relay sockets after success", async () => {
    installFakeWebSocket();
    const ac = new AbortController();
    let offerCreates = 0;
    let acceptCreates = 0;

    const result = await runLiveRendezvous({
      mode: "simultaneous",
      phrase: "tower phrase",
      createOfferCode: async () => {
        offerCreates += 1;
        return "B".repeat(64);
      },
      acceptOfferCode: async () => {
        acceptCreates += 1;
        return "unused";
      },
      callbacks: {
        onStatus: () => {},
        onLog: () => {},
      },
      signal: ac.signal,
    });

    assert.equal(result.role, "offerer");
    assert.equal(result.peerAnswerCode, "A".repeat(64));
    assert.equal(offerCreates, 1);
    assert.equal(acceptCreates, 0);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
    assert.ok(result.relay);
    try {
      const sentBeforeRelay = FakeTrackerWebSocket.instances[0]?.sent.length ?? 0;
      result.relay.sendSignal({ kind: "answer-ack" });
      // sendSignal seals the payload (one AES-GCM op) before it hits the wire,
      // then (offerer) re-asserts the real offer in the same batch.
      await delay(20);
      const sent = FakeTrackerWebSocket.instances[0]?.sent ?? [];
      const signalSent = sent.slice(sentBeforeRelay).find((p) => p.includes("whisper-signal:")) ?? "";
      assert.ok(sent.length > sentBeforeRelay);
      assert.ok(signalSent, "a whisper-signal: announce was sent");
      assert.ok(signalSent.includes(FakeTrackerWebSocket.lastRendezvousId));
      assert.ok(signalSent.includes("\"to_peer_id\":\"peer-remote\""));
      // the real rendezvous offer is re-asserted alongside so a slow answer still routes
      assert.ok(sent.slice(sentBeforeRelay).some((p) => p.includes("whisper-offer-code:")),
        "the real offer is re-announced with the signal");
    } finally {
      result.relay.destroy();
    }
    assert.ok(FakeTrackerWebSocket.instances.length >= 1);
    for (const ws of FakeTrackerWebSocket.instances) {
      assert.ok(ws.closeCodes.length <= 1);
      if (ws.closeCodes.length === 1) assert.equal(ws.closeCodes[0], 1000);
      assert.notEqual(ws.readyState, FakeTrackerWebSocket.OPEN);
    }
  });

  it("simultaneous rendezvous honors clock-skewed intents and still completes", async () => {
    installFakeWebSocket("old-timestamp");
    const ac = new AbortController();
    const logs: string[] = [];

    const result = await runLiveRendezvous({
      mode: "simultaneous",
      phrase: "tower phrase",
      createOfferCode: async () => "B".repeat(64),
      acceptOfferCode: async () => "unused",
      callbacks: {
        onStatus: () => {},
        onLog: (line) => logs.push(line),
      },
      signal: ac.signal,
    });

    assert.ok(result.relay);
    // the old wall-clock gate would have dropped this peer; it must not anymore.
    assert.ok(!logs.some((line) => line.includes("ignoring")));
    result.relay.destroy();
  });

  it("relay signals reach setOnSignal AFTER the rendezvous settles, sealed end to end", async () => {
    // The regression this pins: the pool's onMessage used to `return` on `settled`
    // BEFORE forwarding relay signals, so every trickled ICE candidate and every
    // ICE-restart request after the match was silently dropped. With the fake
    // tracker echoing signals back as the remote peer, a full seal -> wire ->
    // unseal round trip must land on the handle's callback.
    installFakeWebSocket("normal", /* echoSignals */ true);
    const ac = new AbortController();
    const result = await runLiveRendezvous({
      mode: "simultaneous",
      phrase: "tower phrase",
      createOfferCode: async () => "B".repeat(64),
      acceptOfferCode: async () => "unused",
      callbacks: { onStatus: () => {}, onLog: () => {} },
      signal: ac.signal,
    });
    assert.ok(result.relay);
    try {
      const received: TrackerRelaySignal[] = [];
      result.relay.setOnSignal((s) => received.push(s));

      // rendezvous has settled by now. send a trickle ICE candidate.
      const candidate = { candidate: "candidate:1 1 udp 2113937151 203.0.113.9 51702 typ srflx raddr 0.0.0.0 rport 0", sdpMLineIndex: 0, sdpMid: "0" };
      result.relay.sendSignal({ kind: "ice", candidate });
      await delay(60);

      assert.equal(received.length, 1, "the echoed relay signal was forwarded post-settle");
      assert.equal(received[0].kind, "ice");
      assert.deepEqual((received[0] as { candidate: unknown }).candidate, candidate);

      // a second one, and a restart request, both post-settle
      result.relay.sendSignal({ kind: "ice", candidate: null });
      result.relay.sendSignal({ kind: "restart-offer", code: "R".repeat(80) });
      await delay(60);
      assert.equal(received.length, 3);
      assert.equal(received[1].kind, "ice");
      assert.equal((received[1] as { candidate: unknown }).candidate, null);
      assert.equal(received[2].kind, "restart-offer");
    } finally {
      result.relay.destroy();
    }
  });

  it("a relay signal from a peer_id that is not the locked one is ignored post-settle", async () => {
    installFakeWebSocket("normal", true);
    const ac = new AbortController();
    const result = await runLiveRendezvous({
      mode: "simultaneous",
      phrase: "tower phrase",
      createOfferCode: async () => "B".repeat(64),
      acceptOfferCode: async () => "unused",
      callbacks: { onStatus: () => {}, onLog: () => {} },
      signal: ac.signal,
    });
    try {
      const received: TrackerRelaySignal[] = [];
      result.relay!.setOnSignal((s) => received.push(s));
      // send a real signal, then hand-deliver the SAME wire bytes but attributed
      // to a stranger's peer_id — the locked-peer check must drop it.
      result.relay!.sendSignal({ kind: "ice", candidate: null });
      await delay(50);
      const legit = received.length;
      const sock = FakeTrackerWebSocket.instances.find((w) =>
        w.sent.some((p) => p.includes("whisper-signal:")))!;
      const signalAnnounce = JSON.parse(sock.sent.reverse().find((p) => p.includes("whisper-signal:"))!);
      sock.onmessage?.call(sock, { data: JSON.stringify({
        offer: {
          type: "offer",
          sdp: signalAnnounce.offers[0].offer.sdp,
          whisper_session: signalAnnounce.offers[0].offer.whisper_session,
          to_peer_id: JSON.parse(sock.sent.at(-1)!).peer_id,
        },
        offer_id: "x", peer_id: "some-stranger", info_hash: signalAnnounce.info_hash,
      }) });
      await delay(50);
      assert.equal(received.length, legit, "a signal from an unlocked peer is not forwarded");
    } finally {
      result.relay!.destroy();
    }
  });
});
