import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUint32 } from "./_helpers/generators.js";
import {
  CTRL_OP,
  FILE_CANCEL_ROLE,
  VOTE_TOPIC,
  VoteTopic,
  encodeCtrl,
  decodeCtrl,
  encodeFileCancelPayload,
  decodeFileCancelPayload,
  encodeVotePayload,
  decodeVotePayload,
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

describe("VOTE/CANCEL round-aware ctrl frame", () => {
  describe("encodeVotePayload/decodeVotePayload", () => {
    it("round-trips topic + round for boundary values", () => {
      for (const topic of [0, 1, 2, 255]) {
        for (const round of [0, 1, 128, 255]) {
          const encoded = encodeVotePayload(topic, round);
          assert.equal(encoded.length, 2, "payload is always 2 bytes");
          const decoded = decodeVotePayload(encoded);
          assert.ok(decoded, `decode failed for topic=${topic} round=${round}`);
          assert.equal(decoded.topic, topic);
          assert.equal(decoded.round, round);
        }
      }
    });

    it("round wraps mod 256 when encoding an out-of-range value", () => {
      const encoded = encodeVotePayload(VOTE_TOPIC.CLEAR, 256 + 5);
      assert.equal(encoded[1], 5);
    });

    it("rejects a payload shorter than 2 bytes", () => {
      assert.equal(decodeVotePayload(new Uint8Array(0)), null);
      assert.equal(decodeVotePayload(new Uint8Array(1)), null);
    });

    it("tolerates a trailing byte beyond the 2-byte payload", () => {
      const buf = new Uint8Array([VOTE_TOPIC.CLEAR, 7, 0xAA, 0xBB]);
      const decoded = decodeVotePayload(buf);
      assert.ok(decoded);
      assert.equal(decoded.topic, VOTE_TOPIC.CLEAR);
      assert.equal(decoded.round, 7);
    });

    it("full CTRL frame round-trip matches the wire path (encodeCtrl -> decodeCtrl -> decodeVotePayload)", () => {
      const frame = encodeCtrl(CTRL_OP.VOTE, encodeVotePayload(VOTE_TOPIC.CAMPFIRE, 3));
      assert.equal(frame[1], 2, "VOTE payload length byte is always 2");
      const ctrl = decodeCtrl(frame);
      assert.ok(ctrl);
      assert.equal(ctrl.opcode, CTRL_OP.VOTE);
      const vote = decodeVotePayload(ctrl.payload);
      assert.ok(vote);
      assert.equal(vote.topic, VOTE_TOPIC.CAMPFIRE);
      assert.equal(vote.round, 3);
    });
  });

  // pure FSM tests: two independent VoteTopic instances stand in for the two
  // peers, wired by hand exactly the way live-ui.ts wires session.sendCtrl /
  // handleCtrl. castLocal()'s wire send uses `.round` before calling castLocal,
  // and receivePeer(round)/receivePeerCancel(round) take the decoded round byte.
  describe("VoteTopic FSM: round convergence", () => {
    function makeTopic(onExecute: () => void) {
      return new VoteTopic({ timeoutMs: 60_000, onExecute, onState: () => {} });
    }

    it("plain convergence: both cast, no cancel, both sides execute and bump round", () => {
      let execA = 0, execB = 0;
      const a = makeTopic(() => execA++);
      const b = makeTopic(() => execB++);

      const roundA = a.round; // read before castLocal, as the wire send site does
      assert.equal(a.castLocal(), false, "A alone doesn't cross a 2-party threshold");

      assert.equal(b.receivePeer(roundA), false, "B hasn't voted yet, still short");
      assert.equal(b.castLocal(), true, "B's own cast crosses threshold");
      assert.equal(execB, 1);

      assert.equal(a.receivePeer(roundA), true, "A converges on receiving B's vote");
      assert.equal(execA, 1);

      assert.equal(a.round, 1, "A's round bumped after execute");
      assert.equal(b.round, 1, "B's round bumped after execute");
    });

    it("crossing cancel: peer's completing VOTE arrives after a local cancel, local still converges", () => {
      // this is the exact divergence the audit flagged: B commits to executing
      // because it already saw A's vote, before A's CANCEL (sent after A changed
      // its mind) has a chance to arrive. A must still execute to match B, even
      // though A's own live vote state was retracted first.
      let execA = 0, execB = 0;
      const a = makeTopic(() => execA++);
      const b = makeTopic(() => execB++);

      const round = a.round;
      a.castLocal(); // → sends VOTE(topic, round) to B

      b.receivePeer(round); // B sees A's vote, not yet enough alone
      assert.equal(b.castLocal(), true, "B's cast crosses threshold and executes on B's side");
      assert.equal(execB, 1);
      // B's own VOTE(topic, round) is now conceptually "on the wire" to A.

      a.cancelLocal(); // A changes its mind locally BEFORE B's vote arrives
      assert.equal(a.localVoted, false, "A's live vote flag is retracted");

      // B's already-sent VOTE(topic, round) now arrives at A.
      assert.equal(a.receivePeer(round), true,
        "A converges with B's already-executed decision despite the local cancel");
      assert.equal(execA, 1);

      assert.equal(a.round, 1);
      assert.equal(b.round, 1);
    });

    it("a CANCEL for an already-executed round is a no-op", () => {
      let exec = 0;
      const a = makeTopic(() => exec++);
      const round = a.round;
      a.castLocal();
      assert.equal(a.receivePeer(round), true, "peer's vote crosses threshold");
      assert.equal(a.round, round + 1, "round advanced past the executed round");

      const stateBefore = a.state;
      a.receivePeerCancel(round); // stale, arrives for the now-resolved round
      assert.equal(a.state, stateBefore, "no-op: state unchanged");
      assert.equal(exec, 1, "no second execution");
    });

    it("receivePeer/receivePeerCancel ignore a round that hasn't been reached yet", () => {
      let exec = 0;
      const a = makeTopic(() => exec++);
      assert.equal(a.receivePeer(a.round + 1), false, "future round is ignored, not treated as current");
      assert.equal(exec, 0);
      assert.equal(a.state, "idle");
    });

    it("receivePeerCancel decrements tally and transitions back to idle for the current round", () => {
      let exec = 0;
      const a = makeTopic(() => exec++);
      const round = a.round;
      a.receivePeer(round); // peer votes first, not enough alone
      assert.equal(a.state, "pending-in");
      a.receivePeerCancel(round);
      assert.equal(a.state, "idle");
      assert.equal(exec, 0);
    });

    it("round wraps mod 256 across repeated execute cycles", () => {
      let exec = 0;
      const a = makeTopic(() => exec++);
      const b = makeTopic(() => {});
      for (let i = 0; i < 300; i++) {
        const round = a.round;
        assert.equal(a.round, b.round, `rounds stay in lockstep at cycle ${i}`);
        a.castLocal();
        b.receivePeer(round);
        b.castLocal();
        a.receivePeer(round);
      }
      assert.equal(exec, 300);
      assert.equal(a.round, 300 & 0xFF, "round wraps mod 256");
    });
  });

  describe("sendSealed ctrl counter atomicity (live.ts)", () => {
    it.skip("counter and chain only commit after dc.send() succeeds", () => {
      // not unit-testable in isolation: sendSealed is a private method on
      // WhisperLiveSession closing over live RTCDataChannel state, the CTRL AEAD
      // chain (kdfChainDirect/importCtrlKey/sealCtrl), and an internal
      // sealedSendQueue promise chain. Exercising the fix (a throw from kdf/
      // import/seal/send must never advance ctrlSendCounter or ctrlChainSend)
      // needs a live two-party session with an injectable failing DataChannel,
      // which belongs in an integration/e2e harness, not a pure unit test.
      // verified by code review instead: live.ts sendSealed now reads `counter`
      // and commits `this.ctrlChainSend` / `this.ctrlSendCounter` only after
      // `this.dc.send(wire)` returns without throwing, and the dc-not-open /
      // nonce-exhausted early returns happen before `counter` is even read.
    });
  });
});
