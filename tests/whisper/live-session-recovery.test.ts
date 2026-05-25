import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { WhisperLiveSession, type LiveState, type WhisperLiveSessionOptions } from "../../src/scripts/whisper/live.js";
import type { TrackerRelaySignal } from "../../src/scripts/whisper/live-tracker.js";

class FakePeerConnection {
  iceConnectionState: RTCPeerConnectionIceConnectionState = "connected";
  iceGatheringState: RTCPeerConnectionIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((this: FakePeerConnection, ev: RTCPeerConnectionIceEvent) => unknown) | null = null;
  oniceconnectionstatechange: ((this: FakePeerConnection, ev: Event) => unknown) | null = null;
  onconnectionstatechange: ((this: FakePeerConnection, ev: Event) => unknown) | null = null;
  onicegatheringstatechange: ((this: FakePeerConnection, ev: Event) => unknown) | null = null;
  ondatachannel: ((this: FakePeerConnection, ev: RTCDataChannelEvent) => unknown) | null = null;
  private iceServers: RTCIceServer[];
  readonly setConfigurationCalls: RTCConfiguration[] = [];

  constructor(iceServers: RTCIceServer[] = []) {
    this.iceServers = iceServers;
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
    this.iceGatheringState = "complete";
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
  }

  async addIceCandidate(): Promise<void> {}

  close(): void {}

  getConfiguration(): RTCConfiguration {
    return { iceServers: this.iceServers };
  }

  setConfiguration(config: RTCConfiguration): void {
    this.setConfigurationCalls.push(config);
    this.iceServers = (config.iceServers ?? []).slice();
  }
}

function createSession(options: WhisperLiveSessionOptions = {}) {
  const logs: string[] = [];
  const states: Array<{ state: LiveState; detail?: string }> = [];
  const session = new WhisperLiveSession({
    onStateChange: (state, detail) => states.push({ state, detail }),
    onFingerprint: () => {},
    onMessage: () => {},
    onLog: (line) => logs.push(line),
  }, options);

  return { session, logs, states };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("WhisperLiveSession recovery", () => {
  it("requests a relay restart on live ICE loss and completes the relay restart path", async () => {
    const offer = createSession();
    const answer = createSession();
    const offerPc = new FakePeerConnection();
    const answerPc = new FakePeerConnection();
    const offerSignals: TrackerRelaySignal[] = [];
    const answerSignals: TrackerRelaySignal[] = [];
    const nextOfferSignal = deferred<TrackerRelaySignal>();
    const nextAnswerSignal = deferred<TrackerRelaySignal>();

    offer.session.setRelaySignalSender((signal) => {
      offerSignals.push(signal);
      if (offerSignals.length === 1) nextOfferSignal.resolve(signal);
    });
    answer.session.setRelaySignalSender((signal) => {
      answerSignals.push(signal);
      if (answerSignals.length === 1) nextAnswerSignal.resolve(signal);
    });

    const offerInternals = offer.session as unknown as {
      _state: LiveState;
      isOfferer: boolean;
      pc: FakePeerConnection | null;
      setupPeerConnection: (pc: FakePeerConnection) => void;
      liveRestartPending: boolean;
    };
    offerInternals._state = "live";
    offerInternals.isOfferer = true;
    offerInternals.pc = offerPc;
    offerInternals.setupPeerConnection(offerPc);

    offerPc.iceConnectionState = "disconnected";
    offerPc.oniceconnectionstatechange?.call(offerPc, new Event("iceconnectionstatechange"));
    const restartOffer = await Promise.race([
      nextOfferSignal.promise,
      delay(500).then(() => { throw new Error("restart offer was not signaled"); }),
    ]);

    assert.equal(offerInternals.liveRestartPending, true);
    assert.equal(offerSignals.length, 1);
    assert.equal(restartOffer.kind, "restart-offer");
    assert.ok(offer.session.state === "recovering");
    assert.ok(offer.logs.some((line) => line.includes("recovery: requesting fresh network paths")));

    const answerInternals = answer.session as unknown as {
      _state: LiveState;
      isOfferer: boolean;
      pc: FakePeerConnection | null;
      handleRelaySignal: (signal: TrackerRelaySignal) => Promise<void>;
    };
    answerInternals._state = "recovering";
    answerInternals.isOfferer = false;
    answerInternals.pc = answerPc;

    await answerInternals.handleRelaySignal(restartOffer);
    const restartAnswer = await Promise.race([
      nextAnswerSignal.promise,
      delay(500).then(() => { throw new Error("restart answer was not signaled"); }),
    ]);

    assert.ok(answerPc.remoteDescription);
    assert.equal(answerSignals.length, 1);
    assert.equal(restartAnswer.kind, "restart-answer");

    await offer.session.handleRelaySignal(restartAnswer);
    assert.ok(offerPc.remoteDescription);

    offerPc.iceConnectionState = "connected";
    offerPc.oniceconnectionstatechange?.call(offerPc, new Event("iceconnectionstatechange"));

    assert.equal(offerInternals.liveRestartPending, false);
    assert.equal(offer.session.state, "live");
  });

  it("keeps external assist for the full session only when requested", () => {
    const keep = createSession({
      rtcConfig: { iceServers: [{ urls: "stun:test.example" }] },
      externalAssistPolicy: "keep-for-session",
    });
    const drop = createSession({
      rtcConfig: { iceServers: [{ urls: "stun:test.example" }] },
      externalAssistPolicy: "drop-after-connect",
    });
    const seedIce = [{ urls: "stun:test.example" }];
    const keepPc = new FakePeerConnection(seedIce);
    const dropPc = new FakePeerConnection(seedIce);

    const keepInternals = keep.session as unknown as {
      dropExternalAssist: (pc: FakePeerConnection) => void;
    };
    const dropInternals = drop.session as unknown as {
      dropExternalAssist: (pc: FakePeerConnection) => void;
    };

    keepInternals.dropExternalAssist(keepPc);
    dropInternals.dropExternalAssist(dropPc);

    assert.equal(keepPc.setConfigurationCalls.length, 0);
    assert.equal(keepPc.getConfiguration().iceServers?.length ?? 0, 1);
    assert.equal(dropPc.setConfigurationCalls.length, 1);
    assert.equal(dropPc.getConfiguration().iceServers?.length ?? 0, 0);
  });
});
