import { describe, it } from "node:test";
import assert from "node:assert/strict";

// these tests swap the global RTCPeerConnection constructor, so they cannot run
// concurrently with each other.

import { WhisperLiveSession } from "../../src/scripts/whisper/live.js";

const BASE_SDP = [
  "v=0", "o=- 1 1 IN IP4 0.0.0.0", "s=-", "t=0 0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "a=ice-ufrag:aaaa", "a=ice-pwd:bbbbbbbbbbbbbbbbbbbbbbbb",
  "a=fingerprint:sha-256 AA:BB:CC:DD", "a=setup:actpass",
].join("\r\n") + "\r\n";

/** A DataChannel + PeerConnection just capable enough to run createOffer ->
 *  waitForICE, with the test in control of when candidates "gather". */
class GatherFakePC {
  static latest: GatherFakePC | null = null;
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => unknown) | null = null;
  oniceconnectionstatechange: (() => unknown) | null = null;
  onconnectionstatechange: (() => unknown) | null = null;
  onicegatheringstatechange: (() => unknown) | null = null;
  ondatachannel: (() => unknown) | null = null;
  private candidateListeners: Array<(ev: RTCPeerConnectionIceEvent) => unknown> = [];
  private sdpCandidates: string[] = [];

  constructor(_cfg?: RTCConfiguration) { GatherFakePC.latest = this; }

  addEventListener(type: string, cb: (ev: RTCPeerConnectionIceEvent) => unknown): void {
    if (type === "icecandidate") this.candidateListeners.push(cb);
  }
  removeEventListener(type: string, cb: (ev: RTCPeerConnectionIceEvent) => unknown): void {
    if (type === "icecandidate") this.candidateListeners = this.candidateListeners.filter((x) => x !== cb);
  }
  createDataChannel(): { close(): void } { return { close() {} }; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: "offer", sdp: BASE_SDP }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: "answer", sdp: BASE_SDP }; }
  async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { type: d.type, sdp: () => BASE_SDP + this.sdpCandidates.join("") } as unknown as RTCSessionDescriptionInit;
    Object.defineProperty(this.localDescription, "sdp", { get: () => BASE_SDP + this.sdpCandidates.join("") });
    this.iceGatheringState = "gathering";
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> { this.remoteDescription = d; }
  async addIceCandidate(): Promise<void> {}
  getConfiguration(): RTCConfiguration { return {}; }
  setConfiguration(): void {}
  close(): void {}

  /** test hook: a candidate of `typ` was gathered */
  emitCandidate(typ: "host" | "srflx" | "relay", ip = "1.2.3.4"): void {
    this.sdpCandidates.push(`a=candidate:1 1 udp 1 ${ip} 5000 typ ${typ} raddr 0.0.0.0 rport 0\r\n`);
    const ev = { candidate: { candidate: `candidate:1 1 udp 1 ${ip} 5000 typ ${typ}` } } as unknown as RTCPeerConnectionIceEvent;
    for (const cb of this.candidateListeners) cb(ev);
  }
  finishGathering(): void {
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.();
  }
}

function mkOffer(opts: Record<string, unknown>) {
  const RealPC = globalThis.RTCPeerConnection;
  // @ts-expect-error test stub
  globalThis.RTCPeerConnection = GatherFakePC;
  const session = new WhisperLiveSession(
    { onStateChange: () => {}, onFingerprint: () => {}, onMessage: () => {}, onLog: () => {} },
    opts,
  );
  GatherFakePC.latest = null;
  const promise = session.createOffer("a shared phrase").finally(() => { globalThis.RTCPeerConnection = RealPC; });
  let resolved = false;
  promise.then(() => { resolved = true; }, (e) => { resolved = true; console.error("createOffer rejected:", (e as Error).message); });
  const pcReady = (async () => {
    const deadline = Date.now() + 5000;
    while (!GatherFakePC.latest && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    if (!GatherFakePC.latest) throw new Error("fake PC was never constructed");
    return GatherFakePC.latest;
  })();
  return { session, promise, pcReady, get resolved() { return resolved; }, pc: () => GatherFakePC.latest! };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("waitForICE — with assist, hold for a routable candidate", { concurrency: 1 }, () => {
  it("does NOT finish the offer on a host candidate alone while assist is configured", async () => {
    const o = mkOffer({ rtcConfig: { iceServers: [{ urls: "stun:stun.example:3478" }] }, enableDefaultTurn: false });
    const pc = await o.pcReady;
    pc.emitCandidate("host");
    await tick(1800); // well past the 1500ms settle window
    assert.equal(o.resolved, false, "still waiting: host is not enough when assist is on");

    pc.emitCandidate("srflx");
    await tick(1800);
    assert.equal(o.resolved, true, "settles once a server-reflexive candidate arrives");
    await o.promise;
  });

  it("a srflx candidate alone is enough (does not additionally block on relay)", async () => {
    const o = mkOffer({ rtcConfig: { iceServers: [{ urls: "stun:stun.example:3478" }] }, enableDefaultTurn: true });
    const pc = await o.pcReady;
    pc.emitCandidate("host");
    pc.emitCandidate("srflx");
    await tick(1800);
    assert.equal(o.resolved, true, "srflx settles even though TURN is configured (relay trickles later)");
    await o.promise;
  });

  it("host-only settles once the assist ceiling elapses (dead STUN must not hang the firewall cohort)", async () => {
    const o = mkOffer({ rtcConfig: { iceServers: [{ urls: "stun:stun.example:3478" }] }, enableDefaultTurn: false });
    const pc = await o.pcReady;
    pc.emitCandidate("host");
    await tick(2000);
    assert.equal(o.resolved, false, "still holding while the ceiling has not passed");
    await tick(2500); // now well past ICE_ASSIST_SETTLE_CEILING (3s)
    assert.equal(o.resolved, true, "proceeds on host alone — a late srflx would still trickle to the peer");
    await o.promise;
  });

  it("without assist, a host candidate settles fast", async () => {
    const o = mkOffer({ rtcConfig: { iceServers: [] }, enableDefaultTurn: false });
    const pc = await o.pcReady;
    pc.emitCandidate("host");
    await tick(1700);
    assert.equal(o.resolved, true);
    await o.promise;
  });

  it("gathering-complete resolves immediately even host-only (a same-LAN pair that already connected)", async () => {
    const o = mkOffer({ rtcConfig: { iceServers: [{ urls: "stun:stun.example:3478" }] }, enableDefaultTurn: false });
    const pc = await o.pcReady;
    pc.emitCandidate("host");
    pc.finishGathering();
    await tick(50);
    assert.equal(o.resolved, true, "gathering-complete is terminal regardless of candidate types");
    await o.promise;
  });
});
