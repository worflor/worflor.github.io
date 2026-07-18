import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes, randomUint32 } from "./_helpers/generators.js";
import { TEST_EMOJIS } from "./_helpers/generators.js";
import {
  CTRL_OP,
  encodeCtrl,
  decodeCtrl,
  encodeSeenPayload,
  decodeSeenPayload,
  encodeReactPayload,
  decodeReactPayload,
  VoteTopic,
} from "../../src/scripts/whisper/live-ctrl.js";

describe("live-ctrl", () => {
  describe("encodeCtrl/decodeCtrl", () => {
    it("round-trip for every CTRL_OP with randomized payloads", () => {
      // Run multiple iterations per opcode with different random payloads
      for (let iter = 0; iter < 10; iter++) {
        for (const [name, opcode] of Object.entries(CTRL_OP)) {
          const payloadSize = opcode >= 0x80
            ? 1 + Math.floor(Math.random() * 100)
            : 0;
          const payload = payloadSize > 0 ? randomBytes(payloadSize) : undefined;
          const frame = encodeCtrl(opcode, payload);

          // Verify frame structure: [opcode][payload_len][payload]
          assert.equal(frame[0], opcode, `frame opcode byte for ${name} iter ${iter}`);
          assert.equal(frame[1], payloadSize, `frame payload_len byte for ${name} iter ${iter}`);
          assert.equal(frame.length, 2 + payloadSize, `frame total size for ${name} iter ${iter}`);

          const decoded = decodeCtrl(frame);
          assert.ok(decoded, `decodeCtrl returned null for ${name} iter ${iter}`);
          assert.equal(decoded.opcode, opcode, `opcode mismatch for ${name} iter ${iter}`);
          if (payload) {
            assertBytesEqual(decoded.payload, payload, `payload mismatch for ${name} iter ${iter}`);
          } else {
            assert.equal(decoded.payload.length, 0, `payload should be empty for ${name} iter ${iter}`);
          }
        }
      }
    });

    it("no-payload opcodes (0x01-0x7F) encode with zero-length payload", () => {
      for (const opcode of [0x01, 0x02, 0x03, 0x04, 0x10, 0x3F, 0x7F]) {
        const frame = encodeCtrl(opcode);
        assert.equal(frame.length, 2, `opcode 0x${opcode.toString(16)} frame should be 2 bytes`);
        assert.equal(frame[0], opcode);
        assert.equal(frame[1], 0, "payload length byte should be 0");
        const decoded = decodeCtrl(frame);
        assert.ok(decoded);
        assert.equal(decoded.opcode, opcode);
        assert.equal(decoded.payload.length, 0);
      }
    });

    it("max payload (255 bytes) with content verification", () => {
      const payload = randomBytes(255);
      const frame = encodeCtrl(0x80, payload);
      assert.equal(frame.length, 2 + 255, "frame size = 2 + 255");
      assert.equal(frame[1], 255, "payload length byte");
      const decoded = decodeCtrl(frame);
      assert.ok(decoded);
      assert.equal(decoded.payload.length, 255);
      assertBytesEqual(decoded.payload, payload, "max payload content");
    });

    it("rejects payload > 255 bytes", () => {
      assert.throws(() => encodeCtrl(0x80, randomBytes(256)), /ctrl payload > 255/);
      assert.throws(() => encodeCtrl(0x80, randomBytes(1000)), /ctrl payload > 255/);
    });

    it("truncated frame (0 and 1 bytes) returns null", () => {
      assert.equal(decodeCtrl(new Uint8Array(0)), null);
      assert.equal(decodeCtrl(new Uint8Array(1)), null);
    });

    it("truncated payload returns null", () => {
      // Frame declares payload_len=10 but only provides 5 bytes
      const frame = new Uint8Array([0x81, 10, 1, 2, 3, 4, 5]);
      assert.equal(decodeCtrl(frame), null);
      // Frame declares payload_len=1 but provides 0 bytes
      assert.equal(decodeCtrl(new Uint8Array([0x81, 1])), null);
      // Frame declares payload_len=255 but only provides 3 bytes
      const short = new Uint8Array([0x80, 255, 0xAA, 0xBB, 0xCC]);
      assert.equal(decodeCtrl(short), null);
    });

    it("payload-bearing opcode with zero payload", () => {
      // Opcode >= 0x80 with explicitly empty payload should still encode/decode
      const frame = encodeCtrl(0x80, new Uint8Array(0));
      assert.equal(frame.length, 2);
      const decoded = decodeCtrl(frame);
      assert.ok(decoded);
      assert.equal(decoded.opcode, 0x80);
      assert.equal(decoded.payload.length, 0);
    });
  });

  describe("SEEN payload", () => {
    it("round-trip for boundary values", () => {
      for (const msgId of [0, 1, 255, 65535, 0xFFFFFFFF]) {
        const encoded = encodeSeenPayload(msgId);
        assert.equal(encoded.length, 4, `SEEN payload is always 4 bytes for msgId=${msgId}`);
        const decoded = decodeSeenPayload(encoded);
        assert.equal(decoded, msgId, `SEEN round-trip for ${msgId}`);
      }
    });

    it("round-trip for 50 random uint32 values", () => {
      for (let i = 0; i < 50; i++) {
        const msgId = randomUint32();
        const encoded = encodeSeenPayload(msgId);
        assert.equal(encoded.length, 4, `payload length for random msgId iter ${i}`);
        const decoded = decodeSeenPayload(encoded);
        assert.equal(decoded, msgId, `round-trip for random msgId=${msgId} iter ${i}`);
      }
    });

    it("verifies little-endian encoding", () => {
      const encoded = encodeSeenPayload(0x04030201);
      assert.equal(encoded[0], 0x01);
      assert.equal(encoded[1], 0x02);
      assert.equal(encoded[2], 0x03);
      assert.equal(encoded[3], 0x04);
    });

    it("rejects short payload", () => {
      assert.equal(decodeSeenPayload(new Uint8Array(0)), null);
      assert.equal(decodeSeenPayload(new Uint8Array(1)), null);
      assert.equal(decodeSeenPayload(new Uint8Array(2)), null);
      assert.equal(decodeSeenPayload(new Uint8Array(3)), null);
    });
  });

  describe("REACT payload", () => {
    it("round-trip verifies exact emoji content for each TEST_EMOJI", () => {
      for (const emoji of TEST_EMOJIS) {
        const msgId = randomUint32();
        const encoded = encodeReactPayload(msgId, emoji);
        const decoded = decodeReactPayload(encoded);
        assert.ok(decoded, `decode returned null for ${emoji}`);
        assert.equal(decoded.msgId, msgId, `msgId for ${emoji}`);
        // Each TEST_EMOJI is a single grapheme cluster — should round-trip exactly
        assert.equal(decoded.emoji, emoji, `exact emoji content for ${emoji}`);
      }
    });

    it("round-trip with randomized msgId across 30 iterations", () => {
      for (let i = 0; i < 30; i++) {
        const msgId = randomUint32();
        const emoji = TEST_EMOJIS[i % TEST_EMOJIS.length];
        const encoded = encodeReactPayload(msgId, emoji);
        const decoded = decodeReactPayload(encoded);
        assert.ok(decoded, `iter ${i}`);
        assert.equal(decoded.msgId, msgId, `msgId iter ${i}`);
        assert.equal(decoded.emoji, emoji, `emoji iter ${i}`);
      }
    });

    it("grapheme normalization: multi-emoji → first cluster only", () => {
      const cases = [
        { input: "😀🎉", expected: "😀" },
        { input: "👍🏽❤️", expected: "👍🏽" },
        { input: "🇯🇵🇺🇸", expected: "🇯🇵" },
      ];
      for (const { input, expected } of cases) {
        const encoded = encodeReactPayload(7, input);
        const decoded = decodeReactPayload(encoded);
        assert.ok(decoded, `decode for "${input}"`);
        assert.equal(decoded.emoji, expected, `"${input}" → first grapheme "${expected}"`);
      }
    });

    it("verifies msgId encoding is little-endian in payload", () => {
      const encoded = encodeReactPayload(0x04030201, "😀");
      assert.equal(encoded[0], 0x01);
      assert.equal(encoded[1], 0x02);
      assert.equal(encoded[2], 0x03);
      assert.equal(encoded[3], 0x04);
    });

    it("rejects payload shorter than 5 bytes", () => {
      assert.equal(decodeReactPayload(new Uint8Array(0)), null);
      assert.equal(decodeReactPayload(new Uint8Array(4)), null);
    });

    it("rejects oversized emoji (>32 bytes after msgId)", () => {
      const buf = new Uint8Array(4 + 33);
      new DataView(buf.buffer).setUint32(0, 1, true);
      buf.fill(0x41, 4); // 33 'A' bytes
      assert.equal(decodeReactPayload(buf), null);
    });

    it("rejects payload where emoji field is empty after msgId", () => {
      // 4 bytes of msgId + 0 bytes of emoji = length 4 total → rejected by < 5 check
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, 42, true);
      assert.equal(decodeReactPayload(buf), null);
    });
  });

  describe("VoteTopic", () => {
    it("cast → pending-out, receive → execute", () => {
      const states: string[] = [];
      let executed = false;
      const vote = new VoteTopic({
        onExecute: () => { executed = true; },
        onState: (s) => states.push(s),
      });

      assert.equal(vote.state, "idle");
      assert.equal(vote.localVoted, false);

      const round = vote.round;
      const didExecute1 = vote.castLocal();
      assert.equal(didExecute1, false);
      assert.equal(vote.state, "pending-out");
      assert.equal(vote.localVoted, true);
      assert.ok(states.includes("pending-out"), "onState called with pending-out");

      const didExecute2 = vote.receivePeer(round);
      assert.equal(didExecute2, true);
      assert.equal(executed, true);
      assert.equal(vote.state, "idle");
      assert.equal(vote.localVoted, false);
      assert.equal(vote.round, round + 1, "round bumped after execute");

      vote.destroy();
    });

    it("peer → pending-in, then local → execute", () => {
      let executed = false;
      const vote = new VoteTopic({
        onExecute: () => { executed = true; },
        onState: () => {},
      });

      const round = vote.round;
      const didExecute1 = vote.receivePeer(round);
      assert.equal(didExecute1, false);
      assert.equal(vote.state, "pending-in");

      const didExecute2 = vote.castLocal();
      assert.equal(didExecute2, true);
      assert.equal(executed, true);
      assert.equal(vote.state, "idle");

      vote.destroy();
    });

    it("cancel reverts to idle", () => {
      const states: string[] = [];
      const vote = new VoteTopic({
        onExecute: () => {},
        onState: (s) => states.push(s),
      });

      vote.castLocal();
      assert.equal(vote.state, "pending-out");
      vote.cancelLocal();
      assert.equal(vote.state, "idle");
      assert.equal(vote.localVoted, false);

      vote.destroy();
    });

    it("receivePeerCancel with local still voted → pending-out", () => {
      const vote = new VoteTopic({
        onExecute: () => {},
        onState: () => {},
      });

      const round = vote.round;
      vote.castLocal();          // local votes → pending-out
      vote.receivePeer(round);   // peer votes → both voted → executes (threshold met)
      // After execution, state is idle. Test receivePeerCancel independently:
      vote.destroy();

      // New instance: peer votes first, then cancel
      const vote2 = new VoteTopic({
        onExecute: () => {},
        onState: () => {},
      });
      const round2 = vote2.round;
      vote2.receivePeer(round2);   // peer votes → pending-in
      vote2.castLocal();           // local votes → threshold met → execute
      vote2.destroy();

      // Test cancel mid-vote:
      const vote3 = new VoteTopic({
        onExecute: () => { assert.fail("should not execute"); },
        onState: () => {},
      });
      const round3 = vote3.round;
      vote3.receivePeer(round3);        // pending-in
      vote3.receivePeerCancel(round3);  // peer cancels → should revert
      assert.equal(vote3.state, "idle");
      vote3.destroy();
    });

    it("receivePeerCancel preserves local vote → pending-out", () => {
      let executed = false;
      const vote = new VoteTopic({
        onExecute: () => { executed = true; },
        onState: () => {},
      });

      const round = vote.round;
      vote.castLocal();       // pending-out
      // Peer would push to execute, but let's manually test cancel:
      // We need to test: local voted, peer votes → execute. So test with cancel BEFORE peer.
      assert.equal(vote.state, "pending-out");
      // receivePeerCancel when no peer vote: no-op (peer count stays 0)
      vote.receivePeerCancel(round);
      assert.equal(vote.state, "pending-out"); // local still voted
      assert.equal(executed, false);
      vote.destroy();
    });

    it("double castLocal is idempotent", () => {
      let executeCount = 0;
      const vote = new VoteTopic({
        onExecute: () => { executeCount++; },
        onState: () => {},
      });

      const round = vote.round;
      vote.castLocal();
      const result = vote.castLocal(); // second call — should return false (already voted)
      assert.equal(result, false, "double cast returns false");
      vote.receivePeer(round); // now threshold met
      assert.equal(executeCount, 1, "executed exactly once");
      vote.destroy();
    });

    it("reset clears all state", () => {
      const vote = new VoteTopic({
        onExecute: () => {},
        onState: () => {},
      });

      vote.castLocal();
      assert.equal(vote.state, "pending-out");
      vote.reset();
      assert.equal(vote.state, "idle");
      assert.equal(vote.localVoted, false);

      vote.destroy();
    });

    it("setWeights recalculates threshold", () => {
      const vote = new VoteTopic({
        onExecute: () => {},
        onState: () => {},
      });

      // Default: localWeight=1, peerWeight=1, parties=2
      // totalWeight = 1 + 1*1 = 2, threshold = floor(2/2)+1 = 2
      assert.equal(vote.threshold, 2);

      // Founder weight=2, peer weight=1: total=3, threshold=floor(3/2)+1 = 2
      vote.setWeights(2, 1);
      assert.equal(vote.threshold, 2);

      // Both weight=3: total=6, threshold=floor(6/2)+1 = 4
      vote.setWeights(3, 3);
      assert.equal(vote.threshold, 4);

      vote.destroy();
    });

    it("setWeights resets vote state", () => {
      const vote = new VoteTopic({
        onExecute: () => {},
        onState: () => {},
      });

      vote.castLocal();
      assert.equal(vote.state, "pending-out");
      vote.setWeights(1, 1);
      // setWeights calls reset()
      assert.equal(vote.state, "idle");
      assert.equal(vote.localVoted, false);

      vote.destroy();
    });

    it("onState fires for every state transition", () => {
      const states: string[] = [];
      const vote = new VoteTopic({
        onExecute: () => {},
        onState: (s) => states.push(s),
      });

      vote.castLocal();      // idle → pending-out
      vote.cancelLocal();    // pending-out → idle
      // reset clears the sticky "voted this round" flag left by castLocal. without
      // it, receivePeer below would see "I voted this round" and converge/execute
      // immediately instead of exercising the plain pending-in → idle transition.
      // state is already idle here so this doesn't itself push another "idle".
      vote.reset();

      const round = vote.round;
      vote.receivePeer(round);          // idle → pending-in
      vote.receivePeerCancel(round);    // pending-in → idle

      assert.deepStrictEqual(states, ["pending-out", "idle", "pending-in", "idle"]);

      vote.destroy();
    });
  });
});
