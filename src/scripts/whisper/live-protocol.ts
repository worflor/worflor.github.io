/**
 * live-protocol.ts
 *
 * The PURE Whisper Live message protocol, extracted from live.ts and free of
 * transport, session-lifecycle, and UI concerns. This is the real dual ratchet:
 *
 *   DH ratchet (live-ratchet) yields chain keys.
 *   Each chain key is expanded into a membrane LoopState (chainKey -> loopExpand
 *   -> loopInit). The membrane's loopStep produces the actual per-message key AND
 *   evolves the adaptive compression model; loopEncode/loopDecode compress the
 *   plaintext. AES-GCM binds the wire header as associated data.
 *
 * live.ts drives these exact functions for every real message (encryptAndSend /
 * handleEncryptedMessage delegate here), and so does the test harness — there is
 * one implementation, no reconstruction. Everything here is a pure function of
 * its ProtocolState + inputs (the only randomness, the 4-byte nonce salt, is an
 * explicit parameter), so it is deterministic and directly testable.
 */

import { aesGcmEncrypt, aesGcmDecrypt } from "./live-crypto";
import { type RatchetState, dhRatchetStep, MAX_SKIP } from "./live-ratchet";
import { purgeDead } from "./retention";
import {
  type LoopState,
  loopExpand,
  loopInit,
  loopStep,
  loopEncode,
  loopDecode,
  loopWipe,
} from "./live-loop";
import {
  HEADER_SIZE,
  HEADER_SIZE_COMPACT,
  LIVE_FLAG_SAME_KEY,
  buildHeader,
  parseHeader,
  buildNonce,
} from "./live-wire";
import { toHex } from "./buf";


/**
 * Ceiling on a frame's claimed decoded length.
 *
 * The field is four attacker-chosen bytes and the decoder will produce that many
 * bytes from whatever follows, synchronously, on the only thread there is. So
 * the cap is not a sanity check, it is the ONLY bound on how much work one frame
 * can buy: measured, a 110-byte authenticated frame yields 4MB in 535ms, and the
 * cost is linear in the claim.
 *
 * It is therefore sized to the largest payload the protocol can legitimately
 * produce, not to a round number. FILE_CHUNK_SIZE is 4MB, and a chunk is the
 * biggest thing that ever crosses this boundary; 8MB leaves a full factor of two
 * of headroom and still refuses everything above it. The previous 64MB sat 16x
 * above anything real, which bought nothing and cost about eight seconds of a
 * frozen main thread per frame — a libFuzzer timeout found it as a six-second
 * single input before this was tightened.
 */
const MAX_DECODED_LEN = 8 * 1024 * 1024;

/**
 * The complete pure-protocol state for one endpoint. live.ts holds these as
 * separate instance fields and bundles them for each call; the harness holds a
 * ProtocolState directly. `ratchet`, `loopSend`, `loopRecv`, and `skippedLoopKeys`
 * are mutable objects; the scalar fields are read/written by the transforms.
 */
export interface ProtocolState {
  ratchet: RatchetState;
  loopSend: LoopState | null;
  loopRecv: LoopState | null;
  skippedLoopKeys: Map<string, Uint8Array>;
  lastSentPubKeyHex: string;
  lastRecvPubKeyHex: string;
  nSentTotal: number;
  nRecvTotal: number;
  isOfferer: boolean;
}

// ── pure helpers (moved verbatim from live.ts) ──────────────────────────────

/** Expand a 32-byte ratchet chain key into a fresh membrane LoopState. */
export async function buildLoopStateFromChainKey(chainKey: Uint8Array): Promise<LoopState> {
  const expanded = await loopExpand(chainKey);
  try {
    return loopInit(expanded);
  } finally {
    expanded.fill(0);
  }
}

/** Derive the send/recv membrane states from a ratchet state's chain keys. */
export async function loopStatesFromRatchetState(state: RatchetState): Promise<{ send: LoopState | null; recv: LoopState | null }> {
  return {
    send: state.chainKeySend ? await buildLoopStateFromChainKey(state.chainKeySend) : null,
    recv: state.chainKeyRecv ? await buildLoopStateFromChainKey(state.chainKeyRecv) : null,
  };
}

/**
 * Advance the receive membrane + ratchet counter to `until`, stashing each
 * skipped message key under "pubHex:counter" for out-of-order delivery. Throws
 * if the gap exceeds MAX_SKIP (the bounded-skip DoS guard). Mutates the ratchet
 * nRecv and wipes intermediate loop states.
 */
export async function skipMessagesWithLoopState(
  ratchetState: RatchetState,
  loopStateRecv: LoopState,
  skippedLoopKeys: Map<string, Uint8Array>,
  until: number,
): Promise<LoopState> {
  if (until - ratchetState.nRecv > MAX_SKIP) throw new Error("Too many skipped messages");
  const pubHex = ratchetState.dhPeerHex;
  let current = loopStateRecv;
  while (ratchetState.nRecv < until) {
    const counter = ratchetState.nRecv;
    const { next, messageKey } = await loopStep(current);
    skippedLoopKeys.set(`${pubHex}:${counter}`, messageKey);
    loopWipe(current);
    current = next;
    ratchetState.nRecv++;
  }
  pruneSkippedLoopKeys(skippedLoopKeys, pubHex);
  return current;
}

/**
 * The retention floor for stashed skipped keys.
 *
 * Their demand order is (DH GENERATION, counter): a stashed key is asked for by
 * a frame naming the generation it belongs to. Once the receiver has ratcheted
 * two generations past g, a frame from g can no longer be accepted at all — it
 * takes the new-key branch and derives a root from a stale DH, which fails — so
 * every key from g is dead by construction and no reader can ever ask again.
 *
 * That makes the floor exact: keep the current generation and its immediate
 * predecessor, drop the rest. Within a generation, MAX_SKIP already bounds how
 * far back a counter may be requested, so the count is bounded too.
 *
 * Before this, nothing pruned the map. Keys were inserted and only removed when
 * CONSUMED, so a key belonging to a frame that never arrived was retained for
 * the life of the session. That is unbounded growth holding live message keys,
 * which is the one thing a ratchet exists to stop keeping.
 */
export function pruneSkippedLoopKeys(
  skippedLoopKeys: Map<string, Uint8Array>,
  currentPubHex: string,
): void {
  // A single chain can hold at most MAX_SKIP entries, so below that nothing can
  // possibly be stale and the sweep has nothing to find. The guard matters: this
  // runs on every catch-up, and scanning the map each time would make skipping
  // quadratic in the number of skips.
  if (skippedLoopKeys.size <= MAX_SKIP) return;

  const generations: string[] = [];
  const seen = new Set<string>();
  for (const key of skippedLoopKeys.keys()) {
    const gen = key.slice(0, key.lastIndexOf(":"));
    if (seen.has(gen)) continue;
    seen.add(gen);
    generations.push(gen);
  }
  if (generations.length <= 2) return; // both are live by definition

  // insertion order is generation order, so the live pair is the current
  // generation plus whichever one preceded it.
  const live = new Set<string>([currentPubHex]);
  const priorIndex = generations.indexOf(currentPubHex) - 1;
  if (priorIndex >= 0) live.add(generations[priorIndex]);
  else live.add(generations[generations.length - 1]);

  purgeDead(
    skippedLoopKeys,
    (key) => !live.has(key.slice(0, key.lastIndexOf(":"))),
    (_key, mk) => mk.fill(0), // a dropped message key must not survive in the heap
  );
}

/** bytes of padding granularity; matches BRAID_PAD_BUCKET so both paths leak alike. */
export const PAD_BUCKET = 64;

/**
 * Round a pre-encryption payload up to the next bucket boundary.
 *
 * The `+ 1` means an exact multiple still grows a whole bucket, so the padded
 * length never reveals that the plaintext landed exactly on a boundary.
 */
function padToBucket(inner: Uint8Array): Uint8Array {
  const target = Math.ceil((inner.length + 1) / PAD_BUCKET) * PAD_BUCKET;
  if (target === inner.length) return inner;
  const out = new Uint8Array(target);
  out.set(inner, 0);
  return out;
}

/** Take (and remove) a stashed skipped message key, if present. */
export function takeSkippedLoopKey(
  skippedLoopKeys: Map<string, Uint8Array>,
  pubHex: string,
  nr: number,
): Uint8Array | null {
  const key = `${pubHex}:${nr}`;
  const mk = skippedLoopKeys.get(key);
  if (!mk) return null;
  skippedLoopKeys.delete(key);
  return mk;
}

/** Deep-copy a LoopState (all typed arrays). */
export function cloneLoopState(state: LoopState): LoopState {
  return {
    chain: state.chain.slice(),
    countsBitM: state.countsBitM.slice(),
    countsBit1: state.countsBit1.slice(),
    countsBitX: state.countsBitX.slice(),
    step: state.step,
  };
}

/** Deep-copy a RatchetState (keeps the non-extractable private CryptoKey by ref). */
export function cloneRatchetState(state: RatchetState): RatchetState {
  const skippedKeys = new Map<string, Uint8Array>();
  for (const [key, value] of state.skippedKeys.entries()) skippedKeys.set(key, value.slice());
  return {
    rootKey: state.rootKey.slice(),
    dhSelf: { publicKey: state.dhSelf.publicKey.slice(), privateKey: state.dhSelf.privateKey },
    dhPeer: state.dhPeer ? state.dhPeer.slice() : null,
    dhPeerHex: state.dhPeerHex,
    chainKeySend: state.chainKeySend ? state.chainKeySend.slice() : null,
    chainKeyRecv: state.chainKeyRecv ? state.chainKeyRecv.slice() : null,
    nSend: state.nSend,
    nRecv: state.nRecv,
    prevChainLength: state.prevChainLength,
    skippedKeys,
  };
}

/** Deep-copy a full ProtocolState — used to run a speculative decrypt that is
 *  committed only if it succeeds and the session is still current. */
export function cloneProtocolState(s: ProtocolState): ProtocolState {
  const skippedLoopKeys = new Map<string, Uint8Array>();
  for (const [k, v] of s.skippedLoopKeys.entries()) skippedLoopKeys.set(k, v.slice());
  return {
    ratchet: cloneRatchetState(s.ratchet),
    loopSend: s.loopSend ? cloneLoopState(s.loopSend) : null,
    loopRecv: s.loopRecv ? cloneLoopState(s.loopRecv) : null,
    skippedLoopKeys,
    lastSentPubKeyHex: s.lastSentPubKeyHex,
    lastRecvPubKeyHex: s.lastRecvPubKeyHex,
    nSentTotal: s.nSentTotal,
    nRecvTotal: s.nRecvTotal,
    isOfferer: s.isOfferer,
  };
}

// ── the two core transforms ─────────────────────────────────────────────────

/**
 * RatchetEncrypt (dual): derive the message key via the membrane's loopStep,
 * compress the plaintext, build the wire header, and AEAD-seal with the header
 * as associated data. Mutates `s` in place (advances the send membrane, nSend,
 * nSentTotal, lastSentPubKeyHex). Returns the reassembled wire ([header]
 * [ciphertext]) and the global msgId. `salt` is the 4-byte nonce salt (random
 * in production, seeded in tests).
 */
export async function protocolEncrypt(
  s: ProtocolState,
  plaintext: Uint8Array,
  flags: number,
  salt: Uint8Array,
): Promise<{ wire: Uint8Array; msgId: number }> {
  if (!s.loopSend) throw new Error("No sending loop state, ratchet not fully initialized");
  if (s.ratchet.nSend >= 0xffffffff) throw new Error("Message counter exhausted — session must be restarted");

  const msgId = s.nSentTotal * 2 + (s.isOfferer ? 0 : 1);
  s.nSentTotal++;

  // derive message key via loopStep (advances chain, primes counts)
  const { next: nextLoopSend, messageKey } = await loopStep(s.loopSend);
  loopWipe(s.loopSend);
  s.loopSend = nextLoopSend;

  // compress plaintext with the loop codec (advances counts)
  const { encoded, raw, next: afterEncode } = loopEncode(s.loopSend, plaintext);
  s.loopSend = afterEncode;

  // pre-encryption payload: [decodedLen:4B LE][encoded with mode prefix]
  let compressedPayload: Uint8Array;
  if (raw) {
    compressedPayload = new Uint8Array(5 + encoded.length);
    new DataView(compressedPayload.buffer).setUint32(0, encoded.length, true);
    compressedPayload[4] = 0xff;
    compressedPayload.set(encoded, 5);
  } else {
    compressedPayload = new Uint8Array(4 + encoded.length);
    new DataView(compressedPayload.buffer).setUint32(0, plaintext.length, true);
    compressedPayload.set(encoded, 4);
  }

  // LENGTH BUCKETING, matching the braid.
  //
  // The coder is adaptive and its model is shared, so ciphertext LENGTH is a
  // function of how well a guess matches what was already said: a measured
  // byte-at-a-time distinguisher of the CRIME/BREACH family. The group path has
  // padded since that oracle was demonstrated; this path had not, which left the
  // PRIMARY surface more exposed than the secondary one for no reason.
  //
  // Trailing zeros are safe to append because the decoder is driven by the
  // decodedLen prefix, not by the buffer end: it consumes exactly what it was
  // told to and ignores the rest. Bucketing raises the attacker's cost to
  // roughly the bucket size rather than eliminating the channel, which constant
  // -size records would, and a chat transport cannot afford those.
  compressedPayload = padToBucket(compressedPayload);

  const counter = s.ratchet.nSend;
  const prevChainLen = s.ratchet.prevChainLength;
  const dirBit = s.isOfferer ? 0 : 1;
  const nonce = buildNonce(counter, dirBit, salt);
  const pubKeyHex = toHex(s.ratchet.dhSelf.publicKey);
  const sameKey = pubKeyHex === s.lastSentPubKeyHex;

  const header = buildHeader(
    sameKey ? flags | LIVE_FLAG_SAME_KEY : flags,
    s.ratchet.dhSelf.publicKey,
    counter,
    prevChainLen,
    salt,
  );
  s.lastSentPubKeyHex = pubKeyHex;

  const ciphertext = await aesGcmEncrypt(messageKey, compressedPayload, nonce, header);
  messageKey.fill(0);
  s.ratchet.nSend++;

  const wire = new Uint8Array(header.length + ciphertext.length);
  wire.set(header, 0);
  wire.set(ciphertext, header.length);
  return { wire, msgId };
}

export type DecryptOutcome =
  | { ok: true; plaintext: Uint8Array; msgId: number; flags: number; didDHRatchet: boolean; recvSkipped: number }
  | { ok: false; reason: string };

/**
 * RatchetDecrypt (dual): resolve the peer key, apply a DH ratchet + skip if a
 * new chain key arrived, derive this message's key via the membrane (skipped
 * key or loopStep), AEAD-open (bound to the header), strip the length prefix,
 * and loopDecode to plaintext. Mutates `s` in place as it advances; on any
 * failure `s` may be partially advanced, so callers run it on a clone and commit
 * only on success. a failure therefore never advances committed state, not even
 * one that happens after a DH ratchet step: the clone is discarded whole. no
 * rejection here is fatal, because nothing an unauthenticated frame touches
 * survives it. a frame that fails to authenticate is, by definition, not the
 * peer's, so it must never be able to decide the session's fate.
 */
/**
 * TOTALITY IS STRUCTURAL, NOT A LIST OF GUARDS.
 *
 * Every byte reaching this function is attacker-chosen: it is the receive path,
 * and nothing has been authenticated yet at the point the header is parsed and
 * the ratchet is walked. So "returns an outcome, never throws" is a property of
 * the SIGNATURE, and the only way to hold it is at the boundary. Guarding awaits
 * one at a time is whack-a-mole — `dhRatchetStep` sat unguarded between two
 * carefully wrapped `skipMessagesWithLoopState` calls precisely because someone
 * did the enumeration and missed one, and P-256 point decompression throws on
 * roughly half of all bit-flipped headers.
 *
 * The inner try/catches below stay: they are not safety, they are DIAGNOSIS, and
 * a specific reason string is worth more than a generic one when a real session
 * desyncs. This wrapper is the floor underneath them.
 *
 * Same shape as the Cursor algebra in the campfire parsers: make failure an
 * absorbing state the type system can see, rather than a control-flow escape the
 * caller has to remember to catch.
 */
export async function protocolDecrypt(s: ProtocolState, complete: Uint8Array): Promise<DecryptOutcome> {
  try {
    return await protocolDecryptInner(s, complete);
  } catch (e) {
    return { ok: false, reason: `unexpected: ${(e as Error)?.message ?? String(e)}` };
  }
}

async function protocolDecryptInner(s: ProtocolState, complete: Uint8Array): Promise<DecryptOutcome> {
  const isCompact = (complete[0] & LIVE_FLAG_SAME_KEY) !== 0;
  const headerSize = isCompact ? HEADER_SIZE_COMPACT : HEADER_SIZE;
  if (complete.length < headerSize + 16) return { ok: false, reason: "too short" };

  let header: ReturnType<typeof parseHeader>;
  try {
    header = parseHeader(complete);
  } catch {
    return { ok: false, reason: "unparseable header" };
  }

  // resolve pubkey: compact headers reuse the cached peer key
  let pubKeyHex: string;
  if (header.pubKey) {
    pubKeyHex = toHex(header.pubKey);
  } else {
    pubKeyHex = s.lastRecvPubKeyHex;
    if (!pubKeyHex) return { ok: false, reason: "no cached peer key" };
  }

  let messageKey = takeSkippedLoopKey(s.skippedLoopKeys, pubKeyHex, header.counter);
  let didDHRatchet = false;
  let recvSkipped = 0;

  if (!messageKey) {
    // new DH ratchet key?
    if (pubKeyHex !== s.ratchet.dhPeerHex) {
      if (!header.pubKey) return { ok: false, reason: "DH ratchet needs key bytes" };
      if (s.ratchet.chainKeyRecv && s.loopRecv) {
        const beforeSkip = s.ratchet.nRecv;
        try {
          s.loopRecv = await skipMessagesWithLoopState(s.ratchet, s.loopRecv, s.skippedLoopKeys, header.prevChainLen);
        } catch (e) {
          return { ok: false, reason: `prev-chain skip: ${(e as Error).message}` };
        }
        recvSkipped += s.ratchet.nRecv - beforeSkip;
      }
      // The 33 pubkey bytes are attacker-chosen and unauthenticated at this
      // point, and P-256 point decompression throws on anything that is not a
      // point on the curve — which is most of what a flipped bit produces. That
      // is a REJECTION, not a surprise, and it deserves a reason of its own: the
      // boundary wrapper would otherwise report it as "unexpected", which is the
      // label reserved for defects rather than for hostile input doing its job.
      try {
        await dhRatchetStep(s.ratchet, header.pubKey.slice());
      } catch (e) {
        return { ok: false, reason: `invalid peer ratchet key: ${(e as Error).message}` };
      }
      const reinit = await loopStatesFromRatchetState(s.ratchet);
      s.loopSend = reinit.send;
      s.loopRecv = reinit.recv;
      didDHRatchet = true;
    }

    if (!s.loopRecv) return { ok: false, reason: "no receiving loop state" };
    const beforeSkip = s.ratchet.nRecv;
    try {
      s.loopRecv = await skipMessagesWithLoopState(s.ratchet, s.loopRecv, s.skippedLoopKeys, header.counter);
    } catch (e) {
      return { ok: false, reason: `skip to counter: ${(e as Error).message}` };
    }
    recvSkipped += s.ratchet.nRecv - beforeSkip;

    // derive this message's key via loopStep — speculative until decrypt succeeds
    const stepResult = await loopStep(s.loopRecv);
    loopWipe(s.loopRecv);
    s.loopRecv = stepResult.next;
    messageKey = stepResult.messageKey;
    s.ratchet.nRecv++;
  }

  const aad = complete.subarray(0, headerSize);
  const peerDirBit = s.isOfferer ? 1 : 0; // the peer's direction is the opposite of ours
  const nonce = buildNonce(header.counter, peerDirBit, header.salt);

  let compressedPayload: Uint8Array;
  try {
    compressedPayload = await aesGcmDecrypt(messageKey, header.ciphertext, nonce, aad);
  } catch {
    messageKey.fill(0);
    return { ok: false, reason: "auth failure" };
  }
  messageKey.fill(0);

  // reserve this message's global msgId slot (+ any skipped ones)
  s.nRecvTotal += recvSkipped;
  const msgId = s.nRecvTotal * 2 + (s.isOfferer ? 1 : 0);
  s.nRecvTotal++;

  if (compressedPayload.length < 4) return { ok: false, reason: "payload too short" };
  const decodedLen = new DataView(compressedPayload.buffer, compressedPayload.byteOffset).getUint32(0, true);
  if (decodedLen > MAX_DECODED_LEN) return { ok: false, reason: "decodedLen exceeds safety limit" };
  const compressed = compressedPayload.subarray(4);

  if (!s.loopRecv) return { ok: false, reason: "no receiving loop state after step" };
  // The coder stream is attacker-chosen too. Authentication proves the frame came
  // from the peer; it says nothing about whether the bytes inside it are a valid
  // stream, and a peer running modified software is exactly the case these
  // post-authentication checks exist for. loopDecode throws on an unknown mode
  // byte, which is a REJECTION and deserves a reason of its own rather than
  // arriving at the boundary wrapper labelled "unexpected", a label that should
  // only ever mean "we have a bug".
  let plaintext: Uint8Array;
  let afterDecode: LoopState;
  try {
    ({ decoded: plaintext, next: afterDecode } = loopDecode(s.loopRecv, compressed, decodedLen));
  } catch (e) {
    return { ok: false, reason: `malformed coder stream: ${(e as Error).message}` };
  }
  s.loopRecv = afterDecode;
  s.lastRecvPubKeyHex = pubKeyHex;

  return { ok: true, plaintext, msgId, flags: header.flags, didDHRatchet, recvSkipped };
}
