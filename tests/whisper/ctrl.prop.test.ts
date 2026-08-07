/**
 * L1 — property tests for the control protocol (live-ctrl).
 *
 * CTRL decoders are designed to return null (not throw) on malformed input, so
 * totality here means "never throws on any bytes." Plus: canonical round-trips
 * for every payload codec, nonzero-offset views (DataView offset correctness),
 * length-lie / truncation resistance, and the REACT grapheme-normalization law.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { TEST_EMOJIS } from "./_helpers/generators.js";
import {
  CTRL_OP,
  encodeCtrl,
  decodeCtrl,
  encodeSeenPayload,
  decodeSeenPayload,
  encodeReactPayload,
  decodeReactPayload,
  encodeVotePayload,
  decodeVotePayload,
  encodeStreamState,
  decodeStreamState,
  encodeFileCancelPayload,
  decodeFileCancelPayload,
  encodeCallAudio,
  decodeCallAudio,
} from "../../src/scripts/whisper/live-ctrl.js";

const opcodeArb = fc.oneof(
  fc.constantFrom(...Object.values(CTRL_OP)),
  fc.nat(255), // include unknown opcodes
);

function neverThrows(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    assert.fail(`decoder threw instead of returning null: ${String(e)}`);
  }
}

// place bytes at a nonzero offset inside a larger buffer, return the view
function atOffset(bytes: Uint8Array, pre: number): Uint8Array {
  const backing = new Uint8Array(pre + bytes.length + 7);
  backing.fill(0xa5);
  backing.set(bytes, pre);
  return backing.subarray(pre, pre + bytes.length);
}

describe("live-ctrl — L1 property", () => {
  // ── frame envelope ──
  it("encodeCtrl/decodeCtrl round-trip over structured opcode+payload", () => {
    fc.assert(
      fc.property(opcodeArb, fc.uint8Array({ minLength: 0, maxLength: 255 }), (opcode, payload) => {
        const frame = encodeCtrl(opcode, payload);
        assert.equal(frame[0], opcode, "opcode byte");
        assert.equal(frame[1], payload.length, "length byte");
        const dec = decodeCtrl(frame);
        assert.ok(dec, "decode not null");
        assert.equal(dec.opcode, opcode, "opcode");
        assertBytesEqual(dec.payload, payload, "payload");
      }),
      { numRuns: 400 },
    );
  });

  it("encodeCtrl rejects payload > 255 with a RangeError (intentional)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 256, max: 4096 }), (n) => {
        assert.throws(() => encodeCtrl(0x80, new Uint8Array(n)), RangeError);
      }),
      { numRuns: 40 },
    );
  });

  it("totality: decodeCtrl on ANY bytes returns null or a value, never throws", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 300 }), (bytes) => {
        neverThrows(() => decodeCtrl(bytes));
      }),
      { numRuns: 1000 },
    );
  });

  it("length-lie / truncation: a declared length exceeding the frame yields null (no crash)", () => {
    fc.assert(
      fc.property(fc.nat(255), fc.uint8Array({ minLength: 0, maxLength: 20 }), (declaredLen, body) => {
        // frame = [opcode][declaredLen][body...] where body may be shorter than declaredLen
        const frame = new Uint8Array(2 + body.length);
        frame[0] = 0x81;
        frame[1] = declaredLen;
        frame.set(body, 2);
        const dec = decodeCtrl(frame);
        if (declaredLen > body.length) {
          assert.equal(dec, null, "underflow declared length must yield null");
        }
      }),
      { numRuns: 400 },
    );
  });

  // ── SEEN ──
  it("SEEN payload: round-trips every uint32 (boundary + random), incl. nonzero offset", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(0, 1, 255, 65535, 0xffffffff), fc.integer({ min: 0, max: 0xffffffff })),
        fc.nat(32),
        (msgId, pre) => {
          const enc = encodeSeenPayload(msgId);
          assert.equal(decodeSeenPayload(enc), msgId, "flat");
          assert.equal(decodeSeenPayload(atOffset(enc, pre)), msgId, "offset view");
        },
      ),
      { numRuns: 300 },
    );
  });
  it("totality: decodeSeenPayload never throws", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 12 }), (b) => neverThrows(() => decodeSeenPayload(b))), { numRuns: 300 });
  });

  // ── REACT / UNREACT ──
  it("REACT payload: round-trips msgId + single-grapheme emoji (incl. nonzero offset)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.constantFrom(...TEST_EMOJIS), fc.nat(24), (msgId, emoji, pre) => {
        const enc = encodeReactPayload(msgId, emoji);
        const dec = decodeReactPayload(enc);
        assert.ok(dec, "decode not null");
        assert.equal(dec.msgId, msgId, "msgId");
        assert.equal(dec.emoji, emoji, "emoji");
        const decOff = decodeReactPayload(atOffset(enc, pre));
        assert.ok(decOff, "decode at offset not null");
        assert.equal(decOff.msgId, msgId, "msgId at offset");
        assert.equal(decOff.emoji, emoji, "emoji at offset");
      }),
      { numRuns: 300 },
    );
  });
  it("REACT grapheme normalization: multi-emoji input collapses to the first cluster", () => {
    const cases: [string, string][] = [
      ["😀🎉", "😀"],
      ["👍🏽❤️", "👍🏽"],
      ["🇯🇵🇺🇸", "🇯🇵"],
    ];
    for (const [input, expected] of cases) {
      const dec = decodeReactPayload(encodeReactPayload(7, input));
      assert.ok(dec, `decode for ${input}`);
      // guard: some multi-emoji encode past the 32-byte emoji cap and are rejected (null);
      // when accepted, the first grapheme must be exactly `expected`.
      if (dec) assert.equal(dec.emoji, expected, `${input} → ${expected}`);
    }
  });
  it("totality: decodeReactPayload never throws on arbitrary bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 48 }), (b) => neverThrows(() => decodeReactPayload(b))), { numRuns: 500 });
  });

  // ── VOTE ──
  it("VOTE payload: round-trips topic + round", () => {
    fc.assert(
      fc.property(fc.nat(255), fc.nat(255), (topic, round) => {
        const dec = decodeVotePayload(encodeVotePayload(topic, round));
        assert.ok(dec);
        assert.equal(dec.topic, topic, "topic");
        assert.equal(dec.round, round, "round");
      }),
      { numRuns: 200 },
    );
  });
  it("totality: decodeVotePayload never throws", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 6 }), (b) => neverThrows(() => decodeVotePayload(b))), { numRuns: 200 });
  });

  // ── STREAM_STATE ──
  it("STREAM_STATE: flags round-trip bit-for-bit", () => {
    fc.assert(
      fc.property(fc.nat(255), (flags) => {
        const dec = decodeStreamState(encodeStreamState(flags));
        assert.ok(dec);
        assert.equal(dec.audio, (flags & 0x01) !== 0, "audio");
        assert.equal(dec.video, (flags & 0x02) !== 0, "video");
        assert.equal(dec.screen, (flags & 0x04) !== 0, "screen");
        assert.equal(dec.muted, (flags & 0x08) !== 0, "muted");
      }),
      { numRuns: 200 },
    );
  });

  // ── FILE_CANCEL ──
  it("FILE_CANCEL: transferId + role round-trip (incl. nonzero offset)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.nat(255), fc.nat(16), (transferId, role, pre) => {
        const enc = encodeFileCancelPayload(transferId, role);
        const dec = decodeFileCancelPayload(atOffset(enc, pre));
        assert.ok(dec);
        assert.equal(dec.transferId, transferId, "transferId");
        assert.equal(dec.role, role, "role");
      }),
      { numRuns: 200 },
    );
  });
  it("totality: decodeFileCancelPayload never throws", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 10 }), (b) => neverThrows(() => decodeFileCancelPayload(b))), { numRuns: 200 });
  });

  // ── CALL_AUDIO ──
  it("CALL_AUDIO: seq (mod 65536) + blob round-trip (incl. nonzero offset)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff }), fc.uint8Array({ minLength: 1, maxLength: 400 }), fc.nat(16), (seq, blob, pre) => {
        const enc = encodeCallAudio(seq, blob);
        const dec = decodeCallAudio(atOffset(enc, pre));
        assert.ok(dec);
        assert.equal(dec.seq, seq, "seq");
        assertBytesEqual(dec.blob, blob, "blob");
      }),
      { numRuns: 200 },
    );
  });
  it("totality: decodeCallAudio never throws", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 10 }), (b) => neverThrows(() => decodeCallAudio(b))), { numRuns: 200 });
  });
});
