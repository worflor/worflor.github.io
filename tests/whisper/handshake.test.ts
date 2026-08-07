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
  deriveSilentKey,
  deriveAudioKey,
  deriveCtrlKey,
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

function exactTransportSdp(): string {
  return [
    "v=0",
    "o=- 123456789 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE data",
    "a=extmap-allow-mixed",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:rawUfrag",
    "a=ice-pwd:rawPwd1234567890",
    "a=ice-options:trickle renomination",
    "a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00",
    "a=setup:actpass",
    "a=mid:data",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
    "a=candidate:1 1 udp 2130706431 192.168.1.10 5000 typ host generation 0 network-id 1 network-cost 10",
    "a=candidate:2 1 udp 1694498815 203.0.113.20 3478 typ srflx raddr 192.168.1.10 rport 5000 generation 0 network-id 1 network-cost 10",
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

  it("different phrases produce different roots (phrase separation)", async () => {
    const phrases = [
      "alpha bravo charlie",
      "alpha bravo charli",  // one char difference
      "Alpha Bravo Charlie", // case difference
      "delta echo foxtrot",
      "",                    // empty phrase
      " ",                   // whitespace-only
      "tower",
      "tower ",              // trailing space
    ];
    const roots: Uint8Array[] = [];
    for (const phrase of phrases) {
      roots.push(await derivePhraseRoot(phrase));
    }
    // Every pair must differ
    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        assert.notDeepStrictEqual(
          Array.from(roots[i]), Array.from(roots[j]),
          `"${phrases[i]}" and "${phrases[j]}" must produce different roots`,
        );
      }
    }
    for (const r of roots) r.fill(0);
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

    assert.equal(await verifyConfirmProof(sessionRoot, confirmContext, "offerer", offererProof), true);
    assert.equal(await verifyConfirmProof(sessionRoot, confirmContext, "answerer", offererProof), false);
    assert.notDeepStrictEqual(Array.from(offererProof), Array.from(answererProof));

    sessionRoot.fill(0);
    witnessA.fill(0);
    witnessB.fill(0);
    confirmContext.fill(0);
  });

  it("answerer proof verified by answerer role, rejected by offerer role", async () => {
    const sessionRoot = randomKey();
    const confirmContext = randomKey();

    const answererProof = await buildConfirmProof(sessionRoot, confirmContext, "answerer");
    assert.equal(await verifyConfirmProof(sessionRoot, confirmContext, "answerer", answererProof), true);
    assert.equal(await verifyConfirmProof(sessionRoot, confirmContext, "offerer", answererProof), false);

    sessionRoot.fill(0);
    confirmContext.fill(0);
  });

  it("deriveCtrlKey is deterministic and domain-separated from other keys", async () => {
    const sessionRoot = randomKey();

    const ctrl1 = await deriveCtrlKey(sessionRoot);
    const ctrl2 = await deriveCtrlKey(sessionRoot);
    assert.deepStrictEqual(Array.from(ctrl1), Array.from(ctrl2), "deterministic");
    assert.equal(ctrl1.length, 32, "32 bytes");

    // Domain separation from silent and audio keys
    const silent = await deriveSilentKey(sessionRoot);
    const audio = await deriveAudioKey(sessionRoot);
    assert.notDeepStrictEqual(Array.from(ctrl1), Array.from(silent), "ctrl ≠ silent");
    assert.notDeepStrictEqual(Array.from(ctrl1.subarray(0, 16)), Array.from(audio), "ctrl ≠ audio");

    // Different session roots produce different ctrl keys
    const otherRoot = randomKey();
    const ctrlOther = await deriveCtrlKey(otherRoot);
    assert.notDeepStrictEqual(Array.from(ctrl1), Array.from(ctrlOther), "different roots → different keys");

    ctrl1.fill(0); ctrl2.fill(0); silent.fill(0); audio.fill(0); ctrlOther.fill(0);
    sessionRoot.fill(0); otherRoot.fill(0);
  });

  it("deriveSilentKey and deriveAudioKey are deterministic and domain-separated", async () => {
    const sessionRoot = randomKey();

    const silent1 = await deriveSilentKey(sessionRoot);
    const silent2 = await deriveSilentKey(sessionRoot);
    assert.deepStrictEqual(Array.from(silent1), Array.from(silent2));
    assert.equal(silent1.length, 32);

    const audio1 = await deriveAudioKey(sessionRoot);
    const audio2 = await deriveAudioKey(sessionRoot);
    assert.deepStrictEqual(Array.from(audio1), Array.from(audio2));
    assert.equal(audio1.length, 16);

    // Domain separation: silent key !== audio key (different lengths, but also different derivation)
    assert.notDeepStrictEqual(Array.from(silent1.subarray(0, 16)), Array.from(audio1));

    // Different session roots produce different keys
    const otherRoot = randomKey();
    const silentOther = await deriveSilentKey(otherRoot);
    const audioOther = await deriveAudioKey(otherRoot);
    assert.notDeepStrictEqual(Array.from(silent1), Array.from(silentOther));
    assert.notDeepStrictEqual(Array.from(audio1), Array.from(audioOther));

    sessionRoot.fill(0);
    otherRoot.fill(0);
    silent1.fill(0);
    silent2.fill(0);
    audio1.fill(0);
    audio2.fill(0);
    silentOther.fill(0);
    audioOther.fill(0);
  });

  it("session root differs with vs without phraseRoot", async () => {
    const ecdh = randomKey();
    const transcript = randomKey();
    const phraseRoot = await derivePhraseRoot("some phrase");

    const withPhrase = await deriveSessionRoot(new Uint8Array(ecdh), transcript, phraseRoot);
    const without = await deriveSessionRoot(new Uint8Array(ecdh), transcript, null);
    assert.notDeepStrictEqual(Array.from(withPhrase), Array.from(without));

    phraseRoot.fill(0);
    withPhrase.fill(0);
    without.fill(0);
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
    const restored = await codeToSdp(code, "offer", phraseRoot);
    assert.equal(restored, offerSdp);
  });

  it("sealed SDP rejects wrong phrase", async () => {
    const offerSdp = sampleSdp("actpass", [candidateA, candidateB]);
    const phraseRoot = await derivePhraseRoot("correct phrase");
    const wrongRoot = await derivePhraseRoot("wrong phrase");
    const code = await sdpToCode(offerSdp, "offer", phraseRoot);
    await assert.rejects(() => codeToSdp(code, "offer", wrongRoot), /unseal/i);
    phraseRoot.fill(0);
    wrongRoot.fill(0);
  });

  it("sealed SDP rejects truncated code", async () => {
    const offerSdp = sampleSdp("actpass", [candidateA]);
    const phraseRoot = await derivePhraseRoot("truncation test");
    const code = await sdpToCode(offerSdp, "offer", phraseRoot);
    // Truncate the base64url code to simulate corruption
    const truncated = code.slice(0, 10);
    await assert.rejects(() => codeToSdp(truncated, "offer", phraseRoot));
    phraseRoot.fill(0);
  });

  it("unsealed SDP round-trips exactly", async () => {
    const original = exactTransportSdp();
    const code = await sdpToCode(original, "answer");
    const restored = await codeToSdp(code, "answer");
    assert.equal(restored, original);
  });

  it("sealed SDP round-trips exactly for transport compatibility", async () => {
    const original = exactTransportSdp();
    const phraseRoot = await derivePhraseRoot("exact transport sdp");
    const code = await sdpToCode(original, "offer", phraseRoot);
    const restored = await codeToSdp(code, "offer", phraseRoot);

    assert.equal(restored, original);
    phraseRoot.fill(0);
  });
});
