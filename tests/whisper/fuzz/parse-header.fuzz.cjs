/**
 * L3 — coverage-guided fuzz target for the wire header parser.
 *
 * Run:  npx jazzer tests/whisper/fuzz/parse-header.fuzz.cjs --sync
 * Crash artifacts are written to ./ and can be replayed via fuzz-regression.test.ts.
 *
 * Invariants (any violation throws → Jazzer records a crash):
 *   - totality: parseHeader must throw only a PLAIN Error (deliberate validation),
 *     never a TypeError/RangeError from an out-of-bounds DataView/subarray.
 *   - canonical re-encode: if it parses, buildHeader(parsed) must reproduce the
 *     header region byte-for-byte (a malleability / format-ambiguity detector).
 */

// enable requiring .ts modules from this plain-Node (Jazzer) process
require("tsx/cjs");
const { parseHeader, buildHeader, HEADER_SIZE, HEADER_SIZE_COMPACT, LIVE_FLAG_SAME_KEY } = require("../../../src/scripts/whisper/live-wire.ts");

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

module.exports.fuzz = function (data) {
  const bytes = new Uint8Array(data);
  let parsed;
  try {
    parsed = parseHeader(bytes);
  } catch (e) {
    // a plain validation Error is fine; anything else (OOB access) is a finding
    if (!(e instanceof Error) || e.constructor !== Error) {
      throw new Error(`totality violated: parseHeader threw ${e && e.constructor && e.constructor.name}: ${e}`);
    }
    return;
  }

  // canonical re-encode of the header region
  const headerLen = parsed.pubKey === null ? HEADER_SIZE_COMPACT : HEADER_SIZE;
  if (bytes.length < headerLen) return; // shouldn't happen if it parsed, but be safe
  const rebuilt = buildHeader(
    parsed.flags,
    parsed.pubKey === null ? new Uint8Array(0) : parsed.pubKey,
    parsed.counter,
    parsed.prevChainLen,
    parsed.salt,
  );
  if (!bytesEqual(rebuilt, bytes.subarray(0, headerLen))) {
    throw new Error("canonical re-encode violated: buildHeader(parse(x)) != header region");
  }
};
