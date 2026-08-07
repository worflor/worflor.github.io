/**
 * L3 — coverage-guided fuzz target for the membrane decoder, driven ADVERSARIALLY.
 *
 * Run:  npx jazzer tests/whisper/fuzz/loop-decode-hostile.fuzz.cjs --sync
 *
 * WHY THIS SURFACE. loopDecode runs AFTER the AEAD tag verifies, so everything
 * it sees is attacker-chosen bytes that a seated member (or one with a stolen
 * key) can deliver at will. The tag proves the frame came from a member; it
 * proves nothing about the shape of what is inside. This is the largest piece
 * of attacker-controlled parsing in the protocol and it had no fuzz coverage.
 *
 * The declared length is fuzzed SEPARATELY from the payload, because the two
 * disagreeing is the interesting case: a frame claiming more bytes than it
 * carries used to silently deliver a truncated plaintext in RAW mode, which
 * desynced both sides' count models. That bug is fixed; this keeps it fixed and
 * looks for its siblings.
 *
 * Invariants (any violation throws → Jazzer records a crash):
 *   - totality: loopDecode either returns or throws a PLAIN Error. A TypeError
 *     or RangeError means an out-of-bounds read reached the decoder.
 *   - length honesty: if it returns, decoded.length MUST equal the declared
 *     length. Returning fewer bytes than claimed is the truncation bug.
 *   - no state leak on failure: a throw must not have advanced the caller's
 *     state. The caller decodes speculatively and commits only on success, so a
 *     decoder that mutates its input state on the way out corrupts a lane that
 *     merely received a bad frame.
 */

require("tsx/cjs");
const {
  loopInit,
  loopDecode,
  loopFingerprint,
} = require("../../../src/scripts/whisper/live-loop.ts");

// a fixed, deterministic starting state: the fuzzer explores the INPUT space,
// not the key space, so the model base is held constant on purpose.
function freshState() {
  const block = new Uint8Array(65536);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff;
  return loopInit(block);
}

// cap the declared length so we are testing the DECODER, not the allocator.
// production bounds this at BRAID_MAX_DECODED_LEN / MAX_DECODED_LEN before ever
// reaching here; without a cap the fuzzer just finds OOM over and over.
const MAX_LEN = 4096;

module.exports.fuzz = function (data) {
  const bytes = new Uint8Array(data);
  if (bytes.length < 5) return;

  // first 4 bytes choose the declared length, the rest is the coder payload.
  const declared = ((bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0) % MAX_LEN;
  const payload = bytes.subarray(4);

  const state = freshState();
  const before = loopFingerprint(state);

  let result;
  try {
    result = loopDecode(state, payload, declared);
  } catch (e) {
    if (!(e instanceof Error) || e.constructor !== Error) {
      throw new Error(
        `totality violated: loopDecode threw ${e && e.constructor && e.constructor.name}: ${e}`,
      );
    }
    // a rejected frame must leave the caller's state exactly as it found it
    const after = loopFingerprint(state);
    if (after !== before) {
      throw new Error(`state leak: loopDecode mutated its input state on a throw (${before} -> ${after})`);
    }
    return;
  }

  if (result.decoded.length !== declared) {
    throw new Error(
      `length dishonesty: declared ${declared} but returned ${result.decoded.length} bytes`,
    );
  }

  // the input state is the caller's committed state; only `next` may differ
  const after = loopFingerprint(state);
  if (after !== before) {
    throw new Error(`state leak: loopDecode mutated its input state on success (${before} -> ${after})`);
  }
};
