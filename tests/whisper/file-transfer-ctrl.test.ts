import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUint32 } from "./_helpers/generators.js";
import {
  CTRL_OP,
  FILE_CANCEL_ROLE,
  encodeCtrl,
  decodeCtrl,
  encodeFileCancelPayload,
  decodeFileCancelPayload,
} from "../../src/scripts/whisper/live-ctrl.js";
import { estimateChunkedPrefixedSize } from "../../src/scripts/whisper/live-chunking.js";

describe("FILE_CANCEL ctrl frame", () => {
  it("CTRL_OP.FILE_CANCEL occupies the next free payload-bearing opcode (0x84)", () => {
    // locks in the wire value — SEEN/REACT/UNREACT occupy 0x81-0x83.
    assert.equal(CTRL_OP.FILE_CANCEL, 0x84);
  });

  it("FILE_CANCEL_ROLE distinguishes sender-abort (0) from receiver-reject (1)", () => {
    assert.equal(FILE_CANCEL_ROLE.SENDER, 0);
    assert.equal(FILE_CANCEL_ROLE.RECEIVER, 1);
  });

  describe("encodeFileCancelPayload/decodeFileCancelPayload", () => {
    it("round-trips transferId + role for boundary values", () => {
      for (const transferId of [0, 1, 255, 65535, 0xFFFFFFFF]) {
        for (const role of [FILE_CANCEL_ROLE.SENDER, FILE_CANCEL_ROLE.RECEIVER]) {
          const encoded = encodeFileCancelPayload(transferId, role);
          assert.equal(encoded.length, 5, "payload is always 5 bytes");
          const decoded = decodeFileCancelPayload(encoded);
          assert.ok(decoded, `decode failed for transferId=${transferId} role=${role}`);
          assert.equal(decoded.transferId, transferId, `transferId round-trip for ${transferId}`);
          assert.equal(decoded.role, role, `role round-trip for ${role}`);
        }
      }
    });

    it("round-trips 50 random transferIds", () => {
      for (let i = 0; i < 50; i++) {
        const transferId = randomUint32();
        const role = i % 2;
        const encoded = encodeFileCancelPayload(transferId, role);
        const decoded = decodeFileCancelPayload(encoded);
        assert.ok(decoded, `iter ${i}`);
        assert.equal(decoded.transferId, transferId, `transferId iter ${i}`);
        assert.equal(decoded.role, role, `role iter ${i}`);
      }
    });

    it("transferId is little-endian in the payload", () => {
      const encoded = encodeFileCancelPayload(0x04030201, FILE_CANCEL_ROLE.SENDER);
      assert.equal(encoded[0], 0x01);
      assert.equal(encoded[1], 0x02);
      assert.equal(encoded[2], 0x03);
      assert.equal(encoded[3], 0x04);
      assert.equal(encoded[4], FILE_CANCEL_ROLE.SENDER);
    });

    it("role byte follows the 4-byte transferId at offset 4", () => {
      const encoded = encodeFileCancelPayload(1, FILE_CANCEL_ROLE.RECEIVER);
      assert.equal(encoded[4], 1);
    });

    it("rejects a payload shorter than 5 bytes", () => {
      assert.equal(decodeFileCancelPayload(new Uint8Array(0)), null);
      assert.equal(decodeFileCancelPayload(new Uint8Array(4)), null);
    });

    it("tolerates a trailing byte beyond the 5-byte payload (only reads what it needs)", () => {
      const buf = new Uint8Array(6);
      new DataView(buf.buffer).setUint32(0, 42, true);
      buf[4] = FILE_CANCEL_ROLE.RECEIVER;
      buf[5] = 0xAA; // extra byte, should be ignored
      const decoded = decodeFileCancelPayload(buf);
      assert.ok(decoded);
      assert.equal(decoded.transferId, 42);
      assert.equal(decoded.role, FILE_CANCEL_ROLE.RECEIVER);
    });
  });

  describe("full CTRL frame round-trip (encodeCtrl -> decodeCtrl -> decodeFileCancelPayload)", () => {
    it("matches the wire path live.ts actually uses (sendCtrl / handleSealedMessage)", () => {
      for (let i = 0; i < 20; i++) {
        const transferId = randomUint32();
        const role = i % 2;
        const frame = encodeCtrl(CTRL_OP.FILE_CANCEL, encodeFileCancelPayload(transferId, role));

        assert.equal(frame[0], CTRL_OP.FILE_CANCEL);
        assert.equal(frame[1], 5, "FILE_CANCEL payload length byte is always 5");

        const ctrl = decodeCtrl(frame);
        assert.ok(ctrl, `decodeCtrl failed iter ${i}`);
        assert.equal(ctrl.opcode, CTRL_OP.FILE_CANCEL);

        const cancel = decodeFileCancelPayload(ctrl.payload);
        assert.ok(cancel, `decodeFileCancelPayload failed iter ${i}`);
        assert.equal(cancel.transferId, transferId, `transferId iter ${i}`);
        assert.equal(cancel.role, role, `role iter ${i}`);
      }
    });
  });
});

describe("estimateChunkedPrefixedSize — large payload (| 0 truncation fix)", () => {
  const CHUNK_SIZE = 15_360;

  /** Reference implementation mirroring the function's own documented formula,
   *  used only to cross-check — never truncates through a 32-bit int. */
  function manualEstimate(len: number): number {
    if (len <= CHUNK_SIZE) return 2 + len;
    const startPayload = Math.min(CHUNK_SIZE - 4, len);
    const remaining = len - startPayload;
    let total = 6 + startPayload;
    if (remaining <= 0) return total;
    const tailChunks = Math.ceil(remaining / CHUNK_SIZE);
    total += tailChunks * 2 + remaining;
    return total;
  }

  it("matches the manual formula straddling the 32-bit signed int boundary (2^31)", () => {
    const sizes = [2 ** 31 - 1, 2 ** 31, 2 ** 31 + 1, 3 * 1024 ** 3];
    for (const size of sizes) {
      assert.equal(estimateChunkedPrefixedSize(size), manualEstimate(size), `size=${size}`);
    }
  });

  it("stays positive and at least payload-sized well beyond 32-bit range", () => {
    // `payloadBytes | 0` on a pre-fix build wraps these negative, collapsing the
    // estimate to 2 (empty payload) via the Math.max(0, ...) guard. 5 GB and 8 PB
    // (~2^53, the documented float64-exact ceiling for a file transfer) must not.
    for (const size of [5 * 1024 ** 3, 8 * 1024 ** 5]) {
      const estimate = estimateChunkedPrefixedSize(size);
      assert.ok(estimate > 0, `estimate for ${size} should be positive, got ${estimate}`);
      assert.ok(estimate >= size, `estimate for ${size} should be at least the payload size, got ${estimate}`);
      assert.equal(estimate, manualEstimate(size), `size=${size}`);
    }
  });

  it("clamps negative payloadBytes to a zero-length estimate", () => {
    assert.equal(estimateChunkedPrefixedSize(-100), 2);
  });

  it("floors fractional payloadBytes instead of bitwise-truncating them", () => {
    // Math.floor(99.9) = 99, matching a plain integer byte length of 99.
    // The old `| 0` happened to floor small positive fractions too — this guards
    // the *replacement* stays correct, not just the large-value regression.
    assert.equal(estimateChunkedPrefixedSize(99.9), manualEstimate(99));
  });
});
