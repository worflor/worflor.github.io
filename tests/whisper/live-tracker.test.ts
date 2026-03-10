import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import {
  TRACKER_URLS,
  createTrackerPool,
  exchangeViaTracker,
} from "../../src/scripts/whisper/live-tracker.js";

type FakeMessageEvent = { data: unknown };

class FakeTrackerWebSocket {
  static instances: FakeTrackerWebSocket[] = [];
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
  private responded = false;

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
    if (this.responded) return;
    const msg = JSON.parse(payload) as {
      action?: string;
      info_hash?: string;
      peer_id?: string;
      offers?: Array<{ offer_id: string }>;
    };
    if (msg.action !== "announce" || !msg.peer_id || !msg.info_hash || !msg.offers?.length) return;
    const offerId = msg.offers[0]?.offer_id;
    if (!offerId) return;
    this.responded = true;
    queueMicrotask(() => {
      if (this.readyState !== FakeTrackerWebSocket.OPEN) return;
      this.onmessage?.call(this, {
        data: JSON.stringify({
          answer: { type: "answer", sdp: "A".repeat(64) },
          peer_id: "peer-remote",
          to_peer_id: msg.peer_id,
          offer_id: offerId,
          info_hash: msg.info_hash,
        }),
      });
    });
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

function installFakeWebSocket(): void {
  FakeTrackerWebSocket.instances = [];
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

  it("relay exchange removes external abort listener and closes relay sockets after success", async () => {
    installFakeWebSocket();
    const ac = new AbortController();

    const result = await exchangeViaTracker(
      "tower phrase",
      "B".repeat(64),
      async () => "unused",
      {
        onStatus: () => {},
        onLog: () => {},
      },
      ac.signal,
    );

    assert.equal(result.role, "offerer");
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
    assert.ok(result.relay);
    result.relay.destroy();
    assert.ok(FakeTrackerWebSocket.instances.length >= 1);
    for (const ws of FakeTrackerWebSocket.instances) {
      assert.ok(ws.closeCodes.length <= 1);
      if (ws.closeCodes.length === 1) assert.equal(ws.closeCodes[0], 1000);
      assert.notEqual(ws.readyState, FakeTrackerWebSocket.OPEN);
    }
  });
});
