import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  WhisperLiveSession,
  buildDefaultTurnPool,
  WHISPER_LIVE_RTC_PUBLIC_STUN,
} from "../../src/scripts/whisper/live.js";
import { canonicalizeSdpForTranscript } from "../../src/scripts/whisper/live-sdp.js";
import { deriveHandshakeTranscriptHash } from "../../src/scripts/whisper/live-handshake.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";

const NOOP_CB = { onStateChange: () => {}, onFingerprint: () => {}, onMessage: () => {}, onLog: () => {} };

/** Capture the RTCConfiguration a session hands to RTCPeerConnection, by
 *  stubbing the constructor to record it and abort. */
async function captureRtcConfig(
  opts: Record<string, unknown>,
  drive: (s: WhisperLiveSession) => Promise<unknown>,
): Promise<RTCConfiguration> {
  const captured: RTCConfiguration[] = [];
  const RealPC = globalThis.RTCPeerConnection;
  // @ts-expect-error test stub
  globalThis.RTCPeerConnection = class {
    constructor(cfg: RTCConfiguration) { captured.push(cfg); throw new Error("stop"); }
  };
  try {
    await drive(new WhisperLiveSession(NOOP_CB, opts)).catch(() => {});
  } finally {
    globalThis.RTCPeerConnection = RealPC;
  }
  assert.ok(captured.length >= 1, "RTCPeerConnection was constructed");
  return captured[0];
}

const allUrls = (cfg: RTCConfiguration): string[] =>
  (cfg.iceServers ?? []).flatMap((x) => (Array.isArray(x.urls) ? x.urls : [x.urls]));

describe("buildDefaultTurnPool — no-account TURN credentials", () => {
  it("produces a coturn TURN-REST credential: username is a future expiry, credential is base64(HMAC-SHA1(secret, username))", async () => {
    const before = Math.floor(Date.now() / 1000);
    const pool = await buildDefaultTurnPool();
    const after = Math.floor(Date.now() / 1000);

    assert.equal(pool.length, 1);
    const entry = pool[0];
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];

    const expiry = Number(entry.username);
    assert.ok(Number.isInteger(expiry));
    assert.ok(expiry >= before + 24 * 3600 - 5 && expiry <= after + 24 * 3600 + 5, `expiry ${expiry} is ~24h ahead`);

    const expected = createHmac("sha1", "openrelayprojectsecret").update(entry.username!).digest("base64");
    assert.equal(entry.credential, expected);

    assert.ok(urls.some((u) => /^turn:.*:80$/.test(u)), "udp/tcp on 80");
    assert.ok(urls.some((u) => /^turns:.*:443\?transport=tcp$/.test(u)), "tls on 443");
    assert.ok(urls.every((u) => u.includes("openrelay.metered.ca")));
    assert.ok(urls.length <= 2, "kept to two URLs so STUN still fits under the 5-URL ICE slowdown threshold");
  });

  it("each call mints a fresh credential (they are time-limited)", async () => {
    const a = await buildDefaultTurnPool();
    await new Promise((r) => setTimeout(r, 1100));
    const b = await buildDefaultTurnPool();
    assert.notEqual(a[0].username, b[0].username);
    assert.notEqual(a[0].credential, b[0].credential);
  });
});

describe("TURN is opt-in, phrase-scoped, and overridable", () => {
  it("enableDefaultTurn without a phrase (in-person QR) never forms a relay candidate", async () => {
    const cfg = await captureRtcConfig(
      { rtcConfig: WHISPER_LIVE_RTC_PUBLIC_STUN, enableDefaultTurn: true },
      (s) => s.createLocalOffer(),
    );
    assert.ok(!allUrls(cfg).some((u) => u.startsWith("turn:") || u.startsWith("turns:")),
      "no TURN URL for a phraseless session");
  });

  it("enableDefaultTurn WITH a phrase adds exactly one TURN entry alongside a trimmed STUN set", async () => {
    const cfg = await captureRtcConfig(
      { rtcConfig: WHISPER_LIVE_RTC_PUBLIC_STUN, enableDefaultTurn: true },
      (s) => s.createOffer("a shared phrase"),
    );
    const servers = cfg.iceServers ?? [];
    const turnEntries = servers.filter((x) =>
      (Array.isArray(x.urls) ? x.urls : [x.urls]).some((u) => u.startsWith("turn:") || u.startsWith("turns:")));
    assert.equal(turnEntries.length, 1, "one TURN entry");
    assert.ok(turnEntries[0].username && turnEntries[0].credential, "TURN entry carries credentials");

    const stunUrls = allUrls(cfg).filter((u) => u.startsWith("stun:"));
    assert.ok(stunUrls.some((u) => u.includes("google")), "Google STUN survives the trim (it is selectable now)");
    assert.ok(allUrls(cfg).length <= 4, `STUN+TURN URL total kept <=4, got ${allUrls(cfg).length}`);
  });

  it("without external assist there is no STUN and no TURN", async () => {
    const cfg = await captureRtcConfig(
      { rtcConfig: { iceServers: [] }, enableDefaultTurn: false },
      (s) => s.createOffer("a shared phrase"),
    );
    assert.deepEqual(allUrls(cfg).filter(Boolean), []);
  });

  it("an explicit turnPool overrides the built-in default", async () => {
    const cfg = await captureRtcConfig(
      {
        rtcConfig: WHISPER_LIVE_RTC_PUBLIC_STUN,
        enableDefaultTurn: true,
        turnPool: [{ urls: "turn:my.coturn.example:3478", username: "u", credential: "p" }],
      },
      (s) => s.createOffer("a shared phrase"),
    );
    const urls = allUrls(cfg);
    assert.ok(urls.includes("turn:my.coturn.example:3478"));
    assert.ok(!urls.some((u) => u.includes("openrelay")), "built-in pool is not used when an override is given");
  });
});

describe("the handshake transcript freezes at the sealed SDP, not the live description", () => {
  // Fix for the failure TURN + trickle would otherwise cause: ICE keeps gathering
  // after we seal the offer/answer (a relay candidate lands hundreds of ms late),
  // and the browser APPENDS every trickled candidate to remoteDescription.sdp — so
  // both live descriptions grow past the bytes the peer canonicalizes from our
  // code, and the confirm proof then fails ("handshake proof mismatch").

  const OFFER_SEALED = [
    "v=0", "o=- 1 1 IN IP4 0.0.0.0", "s=-", "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=ice-ufrag:aaaa", "a=ice-pwd:bbbbbbbbbbbbbbbbbbbbbbbb",
    "a=fingerprint:sha-256 AA:BB:CC:DD", "a=setup:actpass",
    "a=candidate:1 1 udp 2113937151 10.0.0.5 40000 typ host",
    "a=candidate:2 1 udp 1677729535 203.0.113.7 40000 typ srflx raddr 10.0.0.5 rport 40000",
  ].join("\r\n") + "\r\n";

  const ANSWER_SEALED = [
    "v=0", "o=- 2 2 IN IP4 0.0.0.0", "s=-", "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=ice-ufrag:cccc", "a=ice-pwd:dddddddddddddddddddddddd",
    "a=fingerprint:sha-256 EE:FF:00:11", "a=setup:active",
    "a=candidate:1 1 udp 2113937151 10.9.9.9 50000 typ host",
    "a=candidate:2 1 udp 1677729535 198.51.100.4 50000 typ srflx raddr 10.9.9.9 rport 50000",
  ].join("\r\n") + "\r\n";

  const withRelay = (sdp: string, ip: string) =>
    sdp + `a=candidate:3 1 udp 41885439 ${ip} 3478 typ relay raddr 0.0.0.0 rport 0\r\n`;

  type TranscriptInternals = {
    isOfferer: boolean;
    localEphPublicKey: Uint8Array | null;
    localSdpForTranscript: string | null;
    remoteSdpForTranscript: string | null;
    pc: { localDescription: { sdp: string }; remoteDescription: { sdp: string } } | null;
    buildTranscriptHash: (peerPubKeyRaw: Uint8Array) => Promise<Uint8Array>;
  };

  it("buildTranscriptHash hashes the frozen bytes even when the live descriptions have grown", async () => {
    const eph = new Uint8Array(33).fill(7);
    const peerEph = new Uint8Array(33).fill(9);

    const s = new WhisperLiveSession(NOOP_CB, {}) as unknown as TranscriptInternals;
    s.isOfferer = true;
    s.localEphPublicKey = eph;
    s.localSdpForTranscript = OFFER_SEALED;
    s.remoteSdpForTranscript = ANSWER_SEALED;
    s.pc = {
      localDescription: { sdp: withRelay(OFFER_SEALED, "203.0.113.7") },
      remoteDescription: { sdp: withRelay(ANSWER_SEALED, "198.51.100.4") },
    };

    const got = await s.buildTranscriptHash(peerEph);
    const expected = await deriveHandshakeTranscriptHash({
      offerSdpBytes: canonicalizeSdpForTranscript(OFFER_SEALED, "offer"),
      answerSdpBytes: canonicalizeSdpForTranscript(ANSWER_SEALED, "answer"),
      offererEphemeralKey: eph,
      answererEphemeralKey: peerEph,
    });
    assert.equal(toHex(got), toHex(expected), "transcript is over the SEALED SDP, not the grown live one");

    const withGrowth = await deriveHandshakeTranscriptHash({
      offerSdpBytes: canonicalizeSdpForTranscript(withRelay(OFFER_SEALED, "203.0.113.7"), "offer"),
      answerSdpBytes: canonicalizeSdpForTranscript(withRelay(ANSWER_SEALED, "198.51.100.4"), "answer"),
      offererEphemeralKey: eph,
      answererEphemeralKey: peerEph,
    });
    assert.notEqual(toHex(got), toHex(withGrowth));
  });

  it("a restart SDP that changes the peer's DTLS fingerprint is rejected", () => {
    type RestartInternals = {
      remoteSdpForTranscript: string | null;
      restartFingerprintOk: (sdp: string) => boolean;
    };
    const s = new WhisperLiveSession(NOOP_CB, {}) as unknown as RestartInternals;
    s.remoteSdpForTranscript = OFFER_SEALED; // pins "sha-256 AA:BB:CC:DD"

    const sameFp = ANSWER_SEALED.replace("EE:FF:00:11", "AA:BB:CC:DD");
    assert.equal(s.restartFingerprintOk(sameFp), true, "same fingerprint after re-gather is fine");
    assert.equal(s.restartFingerprintOk(ANSWER_SEALED), false, "a swapped DTLS identity is refused");

    s.remoteSdpForTranscript = null;
    assert.equal(s.restartFingerprintOk(ANSWER_SEALED), true, "no pin: transcript-bound handshake is the authenticator");
  });

  it("offerer and answerer derive the SAME transcript from mirrored frozen SDPs", async () => {
    const offEph = new Uint8Array(33).fill(1);
    const ansEph = new Uint8Array(33).fill(2);
    const mk = (isOfferer: boolean) => {
      const s = new WhisperLiveSession(NOOP_CB, {}) as unknown as TranscriptInternals;
      s.isOfferer = isOfferer;
      s.localEphPublicKey = isOfferer ? offEph : ansEph;
      s.localSdpForTranscript = isOfferer ? OFFER_SEALED : ANSWER_SEALED;
      s.remoteSdpForTranscript = isOfferer ? ANSWER_SEALED : OFFER_SEALED;
      s.pc = {
        localDescription: { sdp: withRelay(isOfferer ? OFFER_SEALED : ANSWER_SEALED, "1.1.1.1") },
        remoteDescription: { sdp: withRelay(isOfferer ? ANSWER_SEALED : OFFER_SEALED, "2.2.2.2") },
      };
      return s;
    };
    const hOff = await mk(true).buildTranscriptHash(ansEph);
    const hAns = await mk(false).buildTranscriptHash(offEph);
    assert.equal(toHex(hOff), toHex(hAns));
  });
});
