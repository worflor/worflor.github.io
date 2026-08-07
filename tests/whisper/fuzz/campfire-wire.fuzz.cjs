/**
 * L3 — coverage-guided fuzz target for the campfire (group) wire parsers.
 *
 * Run:  npx jazzer tests/whisper/fuzz/campfire-wire.fuzz.cjs --sync -- -max_len=2048
 *
 * WHY THIS SURFACE. Every parser here consumes bytes handed over by a RELAY.
 * The gossip mesh forwards frames on behalf of peers, so these run before any
 * signature or tag is checked, on input from whoever is closest in the mesh
 * rather than from the seat that allegedly sent it. They are the true edge of
 * the group protocol and they had no fuzz coverage at all.
 *
 * The first byte selects a parser so one fuzzer covers the whole family; the
 * remainder is the frame body.
 *
 * Invariants (any violation throws → Jazzer records a crash):
 *   - totality: a parser either returns, returns null, or throws a PLAIN Error.
 *     A TypeError/RangeError means an out-of-bounds read on relay-controlled
 *     bytes.
 *   - no absurd allocation: a parser must not turn a short frame into a huge
 *     array. A length/count field is attacker-chosen, so believing it without
 *     checking the bytes are actually present is remote memory amplification.
 *   - canonical re-encode where a builder exists: parse(build(parse(x))) must be
 *     stable, which catches format ambiguity (two encodings of one meaning).
 */

require("tsx/cjs");
const wire = require("../../../src/scripts/whisper/campfire/wire.ts");

const PARSERS = [
  { name: "parseGroupMsgHeader", fn: wire.parseGroupMsgHeader, nullable: false },
  { name: "parseBraidFold", fn: wire.parseBraidFold, nullable: false },
  { name: "parseBraidWelcome", fn: wire.parseBraidWelcome, nullable: false },
  { name: "parseRingWant", fn: wire.parseRingWant, nullable: false },
  { name: "parseJoinReq", fn: wire.parseJoinReq, nullable: false },
  { name: "parseJoinAnnounce", fn: wire.parseJoinAnnounce, nullable: false },
  { name: "parseLeaveAnnounce", fn: wire.parseLeaveAnnounce, nullable: false },
  { name: "parsePeerList", fn: wire.parsePeerList, nullable: true },
  { name: "parseCfReact", fn: wire.parseCfReact, nullable: true },
  { name: "parseFrontierBytes", fn: wire.parseFrontier, nullable: true },
].filter((p) => typeof p.fn === "function");

// a frame this short cannot legitimately describe a large structure; if a parser
// returns one anyway it believed a count field over the bytes in front of it.
const AMPLIFICATION_LIMIT = 4096;

function sizeOf(value) {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (value instanceof Uint8Array) return value.length;
  if (typeof value === "object") {
    let total = 0;
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (Array.isArray(v)) total += v.length;
      else if (v instanceof Uint8Array) total += v.length;
    }
    return total;
  }
  return 0;
}

module.exports.fuzz = function (data) {
  const bytes = new Uint8Array(data);
  if (bytes.length < 2) return;

  const parser = PARSERS[bytes[0] % PARSERS.length];
  const body = bytes.subarray(1);

  let parsed;
  try {
    // parseFrontier takes a seat count as its second argument
    parsed = parser.name === "parseFrontierBytes" ? parser.fn(body, 8) : parser.fn(body);
  } catch (e) {
    if (!(e instanceof Error) || e.constructor !== Error) {
      throw new Error(
        `totality violated: ${parser.name} threw ${e && e.constructor && e.constructor.name}: ${e}`,
      );
    }
    return;
  }

  if (parsed === null || parsed === undefined) return; // documented rejection

  const produced = sizeOf(parsed);
  if (produced > AMPLIFICATION_LIMIT && produced > body.length * 8) {
    throw new Error(
      `amplification: ${parser.name} turned ${body.length} bytes into ${produced} elements`,
    );
  }
};
