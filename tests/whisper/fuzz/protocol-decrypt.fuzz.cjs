/**
 * L3 — coverage-guided fuzz target for protocolDecrypt TOTALITY.
 *
 * Run:  npx jazzer tests/whisper/fuzz/protocol-decrypt.fuzz.cjs --sync -- -max_len=512
 *
 * WHY THIS SURFACE, AND WHY IT WAS MISSING. Every other target in this directory
 * hits a pure parser. protocolDecrypt is the STATEFUL transform behind them: it
 * parses a header, walks the double ratchet, may perform a DH step on an
 * attacker-supplied public key, skips message keys, and only then checks a tag.
 * All of that runs on unauthenticated bytes, and none of it was fuzzed.
 *
 * The gap was not theoretical. `dhRatchetStep` sat unguarded between two
 * carefully wrapped calls, and P-256 point decompression throws on almost any
 * bit-flipped pubkey — roughly half of tampered full headers were escaping by
 * exception rather than being rejected. The simulation could not see it because
 * its harness caught the throw and re-minted it as an ordinary rejection.
 *
 * THE INVARIANT: protocolDecrypt RETURNS a DecryptOutcome for every input. Not
 * "does not crash the process" — a throw is a totality violation even when a
 * caller happens to contain it, because containment is the caller's choice and
 * this function's contract is its signature.
 *
 * The state is REAL and ADVANCING: a fresh channel is established once, honest
 * traffic is interleaved so the ratchet moves through its interesting positions
 * (new chain, same chain, skipped keys), and each hostile input runs against a
 * clone so one input cannot poison the next.
 */

require("tsx/cjs");
const { protocolDecrypt, cloneProtocolState } = require("../../../src/scripts/whisper/live-protocol.ts");
const { establishChannel, encrypt, decrypt } = require("../_harness/channel.ts");

const TE = new TextEncoder();

/** established once; the fuzz loop is sync-per-input but setup is async. */
let CH = null;
let ready = null;
let honestCounter = 0;

function ensureReady() {
  if (CH) return null;
  if (!ready) {
    ready = (async () => {
      CH = await establishChannel(new Uint8Array(32).fill(0x5a));
      // bootstrap: one honest frame each way so both sides have a cached peer key
      // and a DH ratchet has actually fired, which is the branch that throws.
      const a = await encrypt(CH.offerer, TE.encode("boot-0"), new Uint8Array([1, 2, 3, 4]));
      await decrypt(CH.answerer, a);
      const b = await encrypt(CH.answerer, TE.encode("boot-1"), new Uint8Array([5, 6, 7, 8]));
      await decrypt(CH.offerer, b);
    })();
  }
  return ready;
}

/**
 * Periodically advance the honest session so the fuzzer meets a moving ratchet
 * rather than one frozen position. A stationary state would leave the skip
 * logic and the new-chain branch permanently cold.
 */
async function maybeAdvance(data) {
  if (data.length === 0 || data[0] % 17 !== 0) return;
  const n = honestCounter++;
  const from = n % 2 === 0 ? CH.offerer : CH.answerer;
  const to = n % 2 === 0 ? CH.answerer : CH.offerer;
  const wire = await encrypt(from, TE.encode(`honest-${n}`), new Uint8Array([n & 0xff, 0, 0, 0]));
  await decrypt(to, wire);
}

module.exports.fuzz = async function (data) {
  const pending = ensureReady();
  if (pending) await pending;

  const buf = Uint8Array.from(data);
  await maybeAdvance(buf);

  for (const peer of [CH.offerer, CH.answerer]) {
    // a clone per input: the transform is documented to leave state partially
    // advanced on failure, so reusing it would make results order-dependent and
    // the crashes irreproducible.
    const clone = cloneProtocolState(peer.state);

    let outcome;
    try {
      outcome = await protocolDecrypt(clone, buf);
    } catch (e) {
      throw new Error(
        `TOTALITY VIOLATED: protocolDecrypt threw on ${buf.length} bytes: ${e && e.message}`,
      );
    }

    if (!outcome || typeof outcome.ok !== "boolean") {
      throw new Error(`protocolDecrypt returned a non-outcome: ${JSON.stringify(outcome)}`);
    }

    if (outcome.ok) {
      // Accepting unauthenticated bytes is the catastrophic case. The fuzzer has
      // no key, so no input it invents may ever authenticate.
      throw new Error(`FORGERY: protocolDecrypt accepted ${buf.length} unauthenticated bytes`);
    }

    if (typeof outcome.reason !== "string") {
      throw new Error("a rejection must carry a reason string");
    }

    // "unexpected:" is the boundary wrapper's label for an escaped exception. It
    // is contained, so the process survives, but it means some path is still
    // throwing where it should be returning a diagnosis — the exact defect this
    // target exists to find. Reaching it is a finding, not a pass.
    if (outcome.reason.startsWith("unexpected:")) {
      throw new Error(`UNDIAGNOSED THROW reached the boundary wrapper: ${outcome.reason}`);
    }

    if ("plaintext" in outcome) {
      throw new Error("a rejected frame surfaced plaintext");
    }
  }
};
