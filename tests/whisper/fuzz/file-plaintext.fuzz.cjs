/**
 * L3 — coverage-guided fuzz target for the file plaintext decoders.
 *
 * Run:  npx jazzer tests/whisper/fuzz/file-plaintext.fuzz.cjs --sync
 *
 * These decoders read length fields (a 4-byte nameLen; a totalFileSize float),
 * so they are the natural home for allocation-bomb / out-of-bounds bugs. The
 * invariant: they throw only a PLAIN Error (deliberate validation), never a
 * TypeError/RangeError from an OOB access, and never hang/OOM (Jazzer's timeout
 * + rss guard catch the latter). A declared 4GB length must be rejected, not
 * allocated — which surfaces here as either a fast plain-Error or a Jazzer OOM.
 */

require("tsx/cjs");
const { decodeFilePlaintext, decodeFilePartPlaintext } = require("../../../src/scripts/whisper/live-wire.ts");

function drive(fn, bytes) {
  try {
    fn(bytes);
  } catch (e) {
    if (!(e instanceof Error) || e.constructor !== Error) {
      throw new Error(`totality violated: ${fn.name} threw ${e && e.constructor && e.constructor.name}: ${e}`);
    }
  }
}

module.exports.fuzz = function (data) {
  const bytes = new Uint8Array(data);
  drive(decodeFilePlaintext, bytes);
  drive(decodeFilePartPlaintext, bytes);
};
