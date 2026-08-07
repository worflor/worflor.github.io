/**
 * L3 — coverage-guided fuzz target for the CTRL protocol decoders.
 *
 * Run:  npx jazzer tests/whisper/fuzz/ctrl.fuzz.cjs --sync
 *
 * CTRL decoders are designed to return null (never throw) on malformed input, so
 * the invariant is simple and strong: NONE of them may throw on ANY bytes. A
 * thrown value is a finding. Also drives the payload decoders with the payload
 * carved out of a decoded frame, so structurally-valid payloads are reached.
 */

require("tsx/cjs");
const ctrl = require("../../../src/scripts/whisper/live-ctrl.ts");

const decoders = [
  ctrl.decodeCtrl,
  ctrl.decodeSeenPayload,
  ctrl.decodeReactPayload,
  ctrl.decodeVotePayload,
  ctrl.decodeStreamState,
  ctrl.decodeFileCancelPayload,
  ctrl.decodeCallAudio,
];

module.exports.fuzz = function (data) {
  const bytes = new Uint8Array(data);

  // every decoder must be total (return null/value, never throw) on raw bytes
  for (const dec of decoders) {
    try {
      dec(bytes);
    } catch (e) {
      throw new Error(`totality violated: ${dec.name} threw on raw bytes: ${e}`);
    }
  }

  // reach the payload decoders through a validly-framed CTRL payload
  let frame;
  try {
    frame = ctrl.decodeCtrl(bytes);
  } catch (e) {
    throw new Error(`decodeCtrl threw: ${e}`);
  }
  if (frame && frame.payload) {
    for (const dec of decoders) {
      try {
        dec(frame.payload);
      } catch (e) {
        throw new Error(`totality violated on framed payload: ${dec.name} threw: ${e}`);
      }
    }
  }
};
