import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import {
  STREAM_FLAG,
  encodeStreamState,
  decodeStreamState,
  encodeCallAudio,
  decodeCallAudio,
} from "../../src/scripts/whisper/live-ctrl.js";
import {
  planFramePlayback,
  CALL_START_LEAD_S,
  CALL_MIN_LEAD_S,
  CALL_MAX_BACKLOG_S,
} from "../../src/scripts/whisper/live-call.js";

/** float comparison with a small epsilon for scheduling arithmetic. */
function assertClose(actual: number, expected: number, msg?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? "close"}: ${actual} vs ${expected}`);
}

describe("call wire", () => {
  describe("encodeCallAudio/decodeCallAudio", () => {
    it("round-trips seq and blob bytes for representative seqs", () => {
      for (const seq of [0, 1, 255, 256, 65535]) {
        const blob = randomBytes(24);
        const frame = encodeCallAudio(seq, blob);
        assert.equal(frame.length, 2 + blob.length, `frame length for seq ${seq}`);
        const decoded = decodeCallAudio(frame);
        assert.ok(decoded, `decode returned null for seq ${seq}`);
        assert.equal(decoded.seq, seq, `seq mismatch for ${seq}`);
        assertBytesEqual(decoded.blob, blob, `blob mismatch for seq ${seq}`);
      }
    });

    it("wraps seq mod 65536 on encode", () => {
      const blob = randomBytes(4);
      const decoded = decodeCallAudio(encodeCallAudio(65536, blob));
      assert.ok(decoded);
      assert.equal(decoded.seq, 0, "65536 should wrap to 0");
      const decoded2 = decodeCallAudio(encodeCallAudio(65537, blob));
      assert.ok(decoded2);
      assert.equal(decoded2.seq, 1, "65537 should wrap to 1");
    });

    it("decodes null when fewer than 3 bytes (empty blob has no room)", () => {
      // an empty blob encodes to just the 2-byte seq header, which cannot carry a frame.
      const emptyFrame = encodeCallAudio(7, new Uint8Array(0));
      assert.equal(emptyFrame.length, 2);
      assert.equal(decodeCallAudio(emptyFrame), null, "2-byte frame must decode to null");
      assert.equal(decodeCallAudio(new Uint8Array(0)), null);
      assert.equal(decodeCallAudio(new Uint8Array([0x01])), null);
      assert.equal(decodeCallAudio(new Uint8Array([0x01, 0x02])), null);
      // exactly 3 bytes is the minimum valid frame: seq + one blob byte.
      const min = decodeCallAudio(new Uint8Array([0x02, 0x01, 0xAB]));
      assert.ok(min);
      assert.equal(min.seq, 0x0102);
      assertBytesEqual(min.blob, new Uint8Array([0xAB]));
    });
  });

  describe("STREAM_FLAG.MUTED", () => {
    it("round-trips every combination of the four stream bits", () => {
      const bits = STREAM_FLAG.AUDIO | STREAM_FLAG.VIDEO | STREAM_FLAG.SCREEN | STREAM_FLAG.MUTED;
      for (let flags = 0; flags <= bits; flags++) {
        const decoded = decodeStreamState(encodeStreamState(flags));
        assert.ok(decoded, `decode null for flags ${flags}`);
        assert.equal(decoded.audio, (flags & STREAM_FLAG.AUDIO) !== 0, `audio for ${flags}`);
        assert.equal(decoded.video, (flags & STREAM_FLAG.VIDEO) !== 0, `video for ${flags}`);
        assert.equal(decoded.screen, (flags & STREAM_FLAG.SCREEN) !== 0, `screen for ${flags}`);
        assert.equal(decoded.muted, (flags & STREAM_FLAG.MUTED) !== 0, `muted for ${flags}`);
      }
    });

    it("MUTED is bit3 (0x08)", () => {
      assert.equal(STREAM_FLAG.MUTED, 0x08);
      const decoded = decodeStreamState(encodeStreamState(STREAM_FLAG.MUTED));
      assert.ok(decoded);
      assert.equal(decoded.muted, true);
      assert.equal(decoded.audio, false);
    });
  });

  describe("planFramePlayback", () => {
    const frameDur = 0.08;

    it("fresh start (nextTime === 0 sentinel) uses startLead", () => {
      const now = 10;
      const plan = planFramePlayback(now, 0, frameDur);
      assertClose(plan.startAt as number, now + CALL_START_LEAD_S, "fresh startAt");
      assertClose(plan.nextTime, now + CALL_START_LEAD_S + frameDur, "fresh nextTime");
    });

    it("steady state advances by exactly frameDur", () => {
      const now = 10;
      const nextTime = 10.2; // within backlog, in the future
      const plan = planFramePlayback(now, nextTime, frameDur);
      assertClose(plan.startAt as number, nextTime, "steady startAt");
      assertClose(plan.nextTime, nextTime + frameDur, "steady nextTime");
    });

    it("underrun (nextTime > 0 but in the past) re-anchors at now + minLead", () => {
      const now = 15;
      const nextTime = 10; // already elapsed, but not the first-frame sentinel
      const plan = planFramePlayback(now, nextTime, frameDur);
      assertClose(plan.startAt as number, now + CALL_MIN_LEAD_S, "underrun startAt");
      assertClose(plan.nextTime, now + CALL_MIN_LEAD_S + frameDur, "underrun nextTime");
    });

    it("backlog beyond maxBacklog drops the frame and leaves nextTime unchanged", () => {
      const now = 10;
      const nextTime = now + CALL_MAX_BACKLOG_S + 0.1; // too far ahead
      const plan = planFramePlayback(now, nextTime, frameDur);
      assert.equal(plan.startAt, null, "backlog startAt must be null");
      assertClose(plan.nextTime, nextTime, "backlog nextTime unchanged");
    });

    it("respects overridden lead/backlog opts", () => {
      const plan = planFramePlayback(5, 0, frameDur, { startLead: 0.3 });
      assertClose(plan.startAt as number, 5.3, "custom startLead");
    });
  });
});
