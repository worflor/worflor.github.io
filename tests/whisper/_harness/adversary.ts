/**
 * Adversary frame constructors for injection testing. Each builds a wire frame a
 * malicious on-path party (who does NOT hold the session keys) could splice into
 * the stream, using knowledge of the receiver's public state (its current peer
 * pubkey, counters) to target the interesting branches of protocolDecrypt that
 * random noise never reaches: the DH-ratchet-before-auth path, prevChainLen lies,
 * counter jumps around the MAX_SKIP boundary, and compact-vs-full confusion.
 *
 * None of these can ever authenticate (the attacker lacks the membrane key), so
 * every one must be rejected. The security claims are: never accepted, never a
 * plaintext leak, decrypt stays total, and the committed state is untouched, so
 * the session survives any volume of them (finding F1, now closed).
 */

import type { Rng } from "./rng.js";
import type { Peer } from "./channel.js";
import { generateDHKeyPair } from "../../../src/scripts/whisper/live-ratchet.js";
import { buildHeader, HEADER_SIZE, HEADER_SIZE_COMPACT, LIVE_FLAG_SAME_KEY } from "../../../src/scripts/whisper/live-wire.js";

export { MAX_SKIP } from "../../../src/scripts/whisper/live-ratchet.js";
import { MAX_SKIP } from "../../../src/scripts/whisper/live-ratchet.js";

export type AdversaryKind =
  | "garbage" // random bytes, any length
  | "tampered" // a real wire with flipped bytes
  | "replay" // a verbatim prior honest wire
  | "rogue-fullkey" // full header, fresh valid on-curve pubkey (drives DH-ratchet-before-auth)
  | "prevchain-lie" // full header, new key, prevChainLen at/over MAX_SKIP
  | "counter-jump" // compact header, counter jumped around MAX_SKIP
  | "compact-unknown" // compact header when receiver has no cached key
  | "wrong-parity-dirbit"; // header salt/counter valid but body is noise

/** Build one hostile frame of the given kind against `recv`'s current state. */
export async function buildHostile(kind: AdversaryKind, recv: Peer, rng: Rng, priorWires: Uint8Array[]): Promise<Uint8Array> {
  const nRecv = recv.state.ratchet.nRecv;
  const salt = () => rng.bytes(4);
  const noiseBody = (min: number, max: number) => rng.bytes(rng.intBetween(min, max));

  switch (kind) {
    case "garbage":
      return rng.bytes(rng.intBetween(0, 120));

    case "tampered": {
      if (priorWires.length === 0) return rng.bytes(64);
      const w = priorWires[rng.int(priorWires.length)].slice();
      // flip 1-3 bytes anywhere
      const flips = rng.intBetween(1, 3);
      for (let i = 0; i < flips && w.length > 0; i++) w[rng.int(w.length)] ^= 1 << rng.int(8);
      return w;
    }

    case "replay":
      return priorWires.length > 0 ? priorWires[rng.int(priorWires.length)].slice() : rng.bytes(64);

    case "rogue-fullkey": {
      const rogue = await generateDHKeyPair();
      const counter = rng.weighted([0, nRecv, nRecv + 1, MAX_SKIP, rng.int(4000)], [3, 2, 1, 1, 1]);
      const hdr = buildHeader(0, rogue.publicKey, counter, 0, salt());
      return concat(hdr, noiseBody(16, 48));
    }

    case "prevchain-lie": {
      const rogue = await generateDHKeyPair();
      // a new-chain frame claiming a huge previous chain length forces the
      // prev-chain skip path; at/over MAX_SKIP it must be rejected as a gap.
      const prev = rng.weighted([MAX_SKIP, MAX_SKIP + 1, MAX_SKIP + 500, nRecv], [2, 2, 1, 1]);
      const hdr = buildHeader(0, rogue.publicKey, nRecv, prev, salt());
      return concat(hdr, noiseBody(16, 48));
    }

    case "counter-jump": {
      // compact header (reuses the cached peer key) with a counter jumped far
      // beyond the receive window — must be rejected as a gap, not processed.
      const counter = rng.weighted([nRecv + MAX_SKIP, nRecv + MAX_SKIP + 1, nRecv + 5000], [2, 2, 1]);
      const hdr = buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(0), counter, 0, salt());
      return concat(hdr, noiseBody(16, 48));
    }

    case "compact-unknown": {
      // a compact frame is meaningless before any full-header message cached a
      // key; against a bootstrapped receiver it still cannot authenticate.
      const hdr = buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(0), rng.int(1000), 0, salt());
      return concat(hdr, noiseBody(16, 48));
    }

    case "wrong-parity-dirbit": {
      // a full header with the receiver's OWN peer key bytes would be ideal, but
      // the attacker cannot read them; use a rogue key and plausible counter, body
      // is noise so AEAD fails.
      const rogue = await generateDHKeyPair();
      const hdr = buildHeader(0, rogue.publicKey, nRecv, 0, salt());
      return concat(hdr, noiseBody(1, 15)); // sub-minimum ciphertext too
    }
  }
}

export const ALL_KINDS: AdversaryKind[] = [
  "garbage",
  "tampered",
  "replay",
  "rogue-fullkey",
  "prevchain-lie",
  "counter-jump",
  "compact-unknown",
  "wrong-parity-dirbit",
];

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export { HEADER_SIZE, HEADER_SIZE_COMPACT };
