import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { randomKey } from "./_helpers/generators.js";
import { buildConfirmProof } from "../../src/scripts/whisper/live-handshake.js";
import { WhisperLiveSession, type LiveState, type LiveMessage } from "../../src/scripts/whisper/live.js";

function createSession() {
  const states: Array<{ state: LiveState; detail?: string }> = [];
  const logs: string[] = [];
  const messages: LiveMessage[] = [];

  const session = new WhisperLiveSession({
    onStateChange: (state, detail) => states.push({ state, detail }),
    onFingerprint: () => {},
    onMessage: (msg) => messages.push(msg),
    onLog: (line) => logs.push(line),
  });

  return { session, states, logs, messages };
}

function attachOpenChannel(session: WhisperLiveSession, sentFrames: Uint8Array[]): void {
  const internals = session as unknown as {
    dc: {
      readyState: string;
      send: (data: Uint8Array) => void;
      close: () => void;
      onopen: unknown;
      onclose: unknown;
      onerror: unknown;
      onmessage: unknown;
    } | null;
  };

  internals.dc = {
    readyState: "open",
    send: (data: Uint8Array) => sentFrames.push(new Uint8Array(data)),
    close: () => {},
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
}

describe("WhisperLiveSession confirmation", () => {
  it("confirmFingerprint does not enter live without a verified peer proof", async () => {
    const { session, states } = createSession();
    const sentFrames: Uint8Array[] = [];
    attachOpenChannel(session, sentFrames);

    const internals = session as unknown as {
      _state: LiveState;
      isOfferer: boolean;
      sharedSecret: Uint8Array | null;
      confirmContextHash: Uint8Array | null;
      startHeartbeat: () => void;
      sendQueue: Promise<void>;
      localConfirmSent: boolean;
    };

    internals._state = "verifying";
    internals.isOfferer = true;
    internals.sharedSecret = randomKey();
    internals.confirmContextHash = randomKey();
    internals.startHeartbeat = () => {};

    session.confirmFingerprint();
    await internals.sendQueue;

    assert.equal(internals.localConfirmSent, true);
    assert.equal(internals._state, "verifying");
    assert.equal(sentFrames.length, 1);
    assert.equal(sentFrames[0][0], 0x30);
    assert.equal(states.some((entry) => entry.state === "live"), false);
  });

  it("auto-confirm path still rejects an invalid peer proof", async () => {
    const { session, states, logs } = createSession();
    const sentFrames: Uint8Array[] = [];
    attachOpenChannel(session, sentFrames);

    const internals = session as unknown as {
      _state: LiveState;
      isOfferer: boolean;
      sharedSecret: Uint8Array | null;
      confirmContextHash: Uint8Array | null;
      startHeartbeat: () => void;
      sendQueue: Promise<void>;
      handlePeerConfirmProof: (proof: Uint8Array) => Promise<void>;
      localConfirmSent: boolean;
      remoteConfirmVerified: boolean;
    };

    internals._state = "verifying";
    internals.isOfferer = true;
    internals.sharedSecret = randomKey();
    internals.confirmContextHash = randomKey();
    internals.startHeartbeat = () => {};

    session.confirmFingerprint();
    await internals.sendQueue;
    await internals.handlePeerConfirmProof(new Uint8Array(16));

    assert.equal(internals.remoteConfirmVerified, false);
    assert.equal(internals._state, "error");
    assert.ok(logs.some((line) => line.includes("proof mismatch")));
    assert.equal(states.some((entry) => entry.state === "live"), false);
  });

  it("auto-confirm path reaches live only after a valid peer proof", async () => {
    const { session, states } = createSession();
    const sentFrames: Uint8Array[] = [];
    attachOpenChannel(session, sentFrames);

    const internals = session as unknown as {
      _state: LiveState;
      isOfferer: boolean;
      sharedSecret: Uint8Array | null;
      confirmContextHash: Uint8Array | null;
      startHeartbeat: () => void;
      sendQueue: Promise<void>;
      handlePeerConfirmProof: (proof: Uint8Array) => Promise<void>;
      localConfirmSent: boolean;
      remoteConfirmVerified: boolean;
    };

    const sharedSecret = randomKey();
    const confirmContextHash = randomKey();

    internals._state = "verifying";
    internals.isOfferer = true;
    internals.sharedSecret = sharedSecret;
    internals.confirmContextHash = confirmContextHash;
    internals.startHeartbeat = () => {};

    session.confirmFingerprint();
    await internals.sendQueue;

    const peerProof = await buildConfirmProof(sharedSecret, confirmContextHash, "answerer");
    await internals.handlePeerConfirmProof(peerProof);
    peerProof.fill(0);

    assert.equal(internals.localConfirmSent, true);
    assert.equal(internals.remoteConfirmVerified, true);
    assert.equal(internals._state, "live");
    assert.equal(states.some((entry) => entry.state === "live"), true);
    assert.equal(sentFrames.length, 1);
  });
});