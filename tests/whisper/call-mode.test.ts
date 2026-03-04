import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeMediaCaps,
  decodeMediaCaps,
  encodeMediaIntent,
  decodeMediaIntent,
} from "../../src/scripts/whisper/live-ctrl";
import { chooseTier, classifyNetwork } from "../../src/scripts/whisper/live-media-adaptation";

test("media caps round trip", () => {
  const encoded = encodeMediaCaps({
    supportsHarmonic: true,
    supportsLumen: true,
    canSendAudio: true,
    canRecvAudio: true,
    canSendVideo: false,
    canRecvVideo: true,
  });
  const decoded = decodeMediaCaps(encoded);
  assert.ok(decoded);
  assert.equal(decoded.supportsHarmonic, true);
  assert.equal(decoded.supportsLumen, true);
  assert.equal(decoded.canSendVideo, false);
  assert.equal(decoded.canRecvVideo, true);
});

test("media intent round trip", () => {
  const encoded = encodeMediaIntent({ audio: true, video: false });
  assert.deepEqual(decodeMediaIntent(encoded), { audio: true, video: false });
});

test("adaptation selects lower tiers on poor links", () => {
  assert.equal(classifyNetwork({ rttMs: 1000, packetLoss: 0.2, cpuPressure: 0.2 }), "poor");
  assert.equal(chooseTier("poor", "high", 0.1), "P0");
  assert.equal(chooseTier("good", "low", 0.9), "P2");
});
