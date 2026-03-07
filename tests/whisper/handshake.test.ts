import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { randomKey } from "./_helpers/generators.ts";
import {
  derivePhraseRoot,
  derivePhraseScopedKey,
  deriveSessionRoot,
  deriveKizunaWitness,
  deriveConfirmContextHash,
  buildConfirmProof,
  verifyConfirmProof,
} from "../../src/scripts/whisper/live-handshake.js";
import {
  sdpToCode,
  codeToSdp,
  canonicalizeSdpForTranscript,
} from "../../src/scripts/whisper/live-sdp.js";

function sampleSdp(setup: "active" | "passive" | "actpass", candidates: string[]): string {
  return [
    "v=0",
    "o=- 0 0 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:testUfrag",
    "a=ice-pwd:testPwd123456789",
    "a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00",
    `a=setup:${setup}`,
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
    ...candidates,
    "a=end-of-candidates",
    "",
  ].join("\r\n");
}

describe("live-handshake", () => {
  it("phrase root and scoped keys are deterministic and domain separated", async () => {
    const rootA = await derivePhraseRoot("tower lantern signal");
    const rootB = await derivePhraseRoot("tower lantern signal");
    assert.deepStrictEqual(Array.from(rootA), Array.from(rootB));

    const keyA = await derivePhraseScopedKey(rootA, "tracker-root", 32);
    const keyB = await derivePhraseScopedKey(rootA, "sdp-seal", 32);
    assert.notDeepStrictEqual(Array.from(keyA), Array.from(keyB));

    rootA.fill(0);
    rootB.fill(0);
    keyA.fill(0);
    keyB.fill(0);
  });

  it("session root changes when transcript changes", async () => {
    const ecdh = randomKey();
    const phraseRoot = await derivePhraseRoot("same phrase");
    const transcriptA = new Uint8Array(32).fill(0x11);
    const transcriptB = new Uint8Array(32).fill(0x22);

    const rootA = await deriveSessionRoot(new Uint8Array(ecdh), transcriptA, phraseRoot);
    const rootB = await deriveSessionRoot(new Uint8Array(ecdh), transcriptB, phraseRoot);

    assert.notDeepStrictEqual(Array.from(rootA), Array.from(rootB));

    phraseRoot.fill(0);
    rootA.fill(0);
    rootB.fill(0);
  });

  it("kizuna witness and confirmation proofs are deterministic and role bound", async () => {
    const sessionRoot = randomKey();
    const transcriptHash = new Uint8Array(32).fill(0x33);
    const offererRatchet = new Uint8Array(65).fill(0x04);
    const answererRatchet = new Uint8Array(65).fill(0x08);
    offererRatchet[0] = 0x04;
    answererRatchet[0] = 0x04;

    const witnessA = await deriveKizunaWitness(sessionRoot);
    const witnessB = await deriveKizunaWitness(sessionRoot);
    assert.deepStrictEqual(Array.from(witnessA), Array.from(witnessB));

    const confirmContext = await deriveConfirmContextHash({
      transcriptHash,
      offererRatchetKey: offererRatchet,
      answererRatchetKey: answererRatchet,
      kizunaWitness: witnessA,
    });

    const offererProof = await buildConfirmProof(sessionRoot, confirmContext, "offerer");
    const answererProof = await buildConfirmProof(sessionRoot, confirmContext, "answerer");

    assert.equal(await verifyConfirmProof(offererProof, sessionRoot, confirmContext, "offerer"), true);
    assert.equal(await verifyConfirmProof(offererProof, sessionRoot, confirmContext, "answerer"), false);
    assert.notDeepStrictEqual(Array.from(offererProof), Array.from(answererProof));

    sessionRoot.fill(0);
    witnessA.fill(0);
    witnessB.fill(0);
    confirmContext.fill(0);
  });
});

describe("live-sdp hardening", () => {
  const candidateA = "a=candidate:1 1 udp 2130706431 192.168.1.10 5000 typ host";
  const candidateB = "a=candidate:2 1 udp 1694498815 203.0.113.20 3478 typ srflx raddr 192.168.1.10 rport 5000";

  it("canonical transcript bytes are stable across candidate ordering", () => {
    const sdpA = sampleSdp("actpass", [candidateA, candidateB]);
    const sdpB = sampleSdp("actpass", [candidateB, candidateA]);
    const canonA = canonicalizeSdpForTranscript(sdpA, "offer");
    const canonB = canonicalizeSdpForTranscript(sdpB, "offer");
    assert.deepStrictEqual(Array.from(canonA), Array.from(canonB));
  });

  it("sealed SDP rejects role confusion", async () => {
    const offerSdp = sampleSdp("actpass", [candidateA, candidateB]);
    const phraseRoot = await derivePhraseRoot("shared tower phrase");
    const code = await sdpToCode(offerSdp, "offer", phraseRoot);
    await assert.rejects(() => codeToSdp(code, "answer", phraseRoot));
    const unsealed = await codeToSdp(code, "offer", phraseRoot);
    assert.match(unsealed, /a=setup:actpass/);
  });
});