/**
 * confirm-context-stability.test.ts — the confirm transcript must stop moving.
 *
 * The confirm proof is a MAC over `confirmContextHash`, so it verifies only if
 * both sides hash identical bytes. That makes the context a TRANSCRIPT, and a
 * transcript field that keeps changing after the proof is built is not one.
 *
 * Two of its four fields are ratchet public keys, and both live in a structure
 * built to change: `dhRatchetStep` replaces `dhSelf` AND zeroes and replaces
 * `dhPeer` on any received message carrying a new header key. The code already
 * knew this for one half — `ratchetInitSentPubKey` exists precisely because
 * `dhSelf` is regenerated — and read the other half live off `dhPeer`. One
 * field pinned, its mirror not.
 *
 * The consequence is a session that fails at the last step of an otherwise
 * perfect handshake. Any peer message arriving while we are still `verifying`
 * moves `dhPeer`, our context hash changes underneath us, and the peer's honest
 * proof no longer verifies: "handshake proof mismatch, reconnect to continue".
 * That explains the reported shape exactly — fresh connections are fine because
 * nothing is queued to send, reconnects fail intermittently because buffered
 * traffic goes out the moment the channel opens, landing inside the window.
 *
 * So the property under test is not "the hash is correct" but "the hash is
 * STABLE": once both RATCHET_INIT keys are known, no amount of ratcheting may
 * change it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { randomKey } from "./_helpers/generators.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";
import { verifyConfirmProof } from "../../src/scripts/whisper/live-handshake.js";
import {
  generateDHKeyPair, dhRatchetStep, initRatchetAsReceiver,
  type RatchetState,
} from "../../src/scripts/whisper/live-ratchet.js";
import { WhisperLiveSession, type LiveState } from "../../src/scripts/whisper/live.js";

interface Internals {
  _state: LiveState;
  isOfferer: boolean;
  sharedSecret: Uint8Array | null;
  transcriptHash: Uint8Array | null;
  kizunaWitness: Uint8Array | null;
  confirmContextHash: Uint8Array | null;
  ratchetState: RatchetState | null;
  ratchetInitSentPubKey: Uint8Array | null;
  ratchetInitRecvPubKey: Uint8Array | null;
  ratchetInitReceived: boolean;
  localConfirmRequested: boolean;
  localConfirmSent: boolean;
  updateConfirmContext: () => Promise<void>;
  handleRatchetInit: (peerKey: Uint8Array) => Promise<void>;
  startHeartbeat: () => void;
}

function makeSession(): { session: WhisperLiveSession; internals: Internals } {
  const session = new WhisperLiveSession({
    onStateChange: () => {},
    onFingerprint: () => {},
    onMessage: () => {},
    onLog: () => {},
  });
  const internals = session as unknown as Internals;
  internals.startHeartbeat = () => {};
  return { session, internals };
}

/**
 * Both peers of one handshake, sharing the fields that are equal by
 * construction (ECDH secret, SDP transcript, kizuna witness) and holding the
 * mirrored view of the two RATCHET_INIT keys.
 */
async function pairedSessions() {
  const sharedSecret = randomKey();
  const transcriptHash = randomKey();
  const kizunaWitness = randomKey();

  const offererInit = await generateDHKeyPair();
  const answererInit = await generateDHKeyPair();

  const setup = (side: Internals, isOfferer: boolean) => {
    side._state = "verifying";
    side.isOfferer = isOfferer;
    side.sharedSecret = sharedSecret.slice();
    side.transcriptHash = transcriptHash.slice();
    side.kizunaWitness = kizunaWitness.slice();
    side.ratchetInitSentPubKey = (isOfferer ? offererInit : answererInit).publicKey.slice();
    side.ratchetInitRecvPubKey = (isOfferer ? answererInit : offererInit).publicKey.slice();
  };

  const a = makeSession();
  const b = makeSession();
  setup(a.internals, true);
  setup(b.internals, false);
  await a.internals.updateConfirmContext();
  await b.internals.updateConfirmContext();
  return { a, b, sharedSecret, offererInit, answererInit };
}

describe("the confirm context is a transcript, so it must stop moving", () => {
  it("both sides derive the SAME context from mirrored inputs", async () => {
    // The precondition everything else rests on. If this were false the proof
    // could never verify and the stability tests below would be vacuous.
    const { a, b } = await pairedSessions();
    assert.ok(a.internals.confirmContextHash, "offerer must have a context");
    assert.equal(
      toHex(a.internals.confirmContextHash!),
      toHex(b.internals.confirmContextHash!),
      "offerer and answerer must hash identical bytes, or no honest proof can verify",
    );
  });

  it("a DH ratchet step must NOT move the context", async () => {
    // The bug, stated directly. dhRatchetStep replaces dhPeer, which the context
    // used to read live. Ratchet the offerer and require its context unchanged.
    const { a } = await pairedSessions();
    const before = toHex(a.internals.confirmContextHash!);

    const self = await generateDHKeyPair();
    a.internals.ratchetState = await initRatchetAsReceiver(
      a.internals.sharedSecret!.slice(),
      self.publicKey.slice(),
    );
    const moved = await generateDHKeyPair();
    await dhRatchetStep(a.internals.ratchetState!, moved.publicKey.slice());
    await a.internals.updateConfirmContext();

    assert.equal(toHex(a.internals.confirmContextHash!), before,
      "the context is the RATCHET_INIT pair, not the live ratchet: a step must not change it");
  });

  it("a peer proof still verifies after the ratchet has moved on", async () => {
    // The user-visible consequence, end to end. The answerer builds its proof
    // at RATCHET_INIT time; the offerer ratchets (as it would on any message
    // arriving during `verifying`) and must still accept that proof.
    const { a, b, sharedSecret } = await pairedSessions();

    const proofFromAnswerer = await (async () => {
      const { buildConfirmProof } = await import("../../src/scripts/whisper/live-handshake.js");
      return buildConfirmProof(sharedSecret, b.internals.confirmContextHash!, "answerer");
    })();

    const self = await generateDHKeyPair();
    a.internals.ratchetState = await initRatchetAsReceiver(sharedSecret.slice(), self.publicKey.slice());
    for (let i = 0; i < 3; i++) {
      const moved = await generateDHKeyPair();
      await dhRatchetStep(a.internals.ratchetState!, moved.publicKey.slice());
      await a.internals.updateConfirmContext();
    }

    const ok = await verifyConfirmProof(
      sharedSecret, a.internals.confirmContextHash!, "answerer", proofFromAnswerer,
    );
    assert.ok(ok,
      "an honest peer's proof must survive our own ratchet — this failing IS the reported \"handshake proof mismatch, reconnect to continue\"");
  });

  it("handleRatchetInit PINS the peer key, taking its own copy", async () => {
    // The capture has to happen before either branch hands the key to the
    // ratchet, and it has to be a copy: dhRatchetStep zeroes the array it holds,
    // so keeping the same reference would blank the context field in place.
    const { internals } = makeSession();
    internals._state = "verifying";
    internals.isOfferer = false;
    internals.sharedSecret = randomKey();

    const peer = await generateDHKeyPair();
    const handed = peer.publicKey.slice();
    await internals.handleRatchetInit(handed);

    assert.ok(internals.ratchetInitRecvPubKey, "the peer's RATCHET_INIT key must be pinned");
    assert.equal(toHex(internals.ratchetInitRecvPubKey!), toHex(peer.publicKey),
      "and must be exactly what the peer sent");

    handed.fill(0);
    assert.notEqual(toHex(internals.ratchetInitRecvPubKey!), toHex(new Uint8Array(peer.publicKey.length)),
      "it must be an independent copy, or wiping the source blanks the transcript");
  });

  it("no context is produced until BOTH halves are pinned", async () => {
    // Half a transcript must never be hashed into a usable one: that would let
    // a proof be built against a context the peer cannot reproduce.
    const { internals } = makeSession();
    internals._state = "verifying";
    internals.isOfferer = true;
    internals.sharedSecret = randomKey();
    internals.transcriptHash = randomKey();
    internals.kizunaWitness = randomKey();
    internals.ratchetInitSentPubKey = (await generateDHKeyPair()).publicKey.slice();
    internals.ratchetInitRecvPubKey = null;

    await internals.updateConfirmContext();
    assert.equal(internals.confirmContextHash, null,
      "with only our own half known, there is nothing to agree on yet");

    internals.ratchetInitRecvPubKey = (await generateDHKeyPair()).publicKey.slice();
    await internals.updateConfirmContext();
    assert.ok(internals.confirmContextHash, "and once both halves are known, the context exists");
  });
});
