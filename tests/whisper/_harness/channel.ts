/**
 * A two-party driver over the REAL Whisper Live protocol core (live-protocol.ts)
 * — the exact functions live.ts calls for every message (protocolEncrypt /
 * protocolDecrypt), the true dual ratchet (DH ratchet chain keys + membrane
 * loopStep message keys + loop compression). This is NOT a reconstruction: there
 * is one protocol implementation, shared by production and the tests.
 *
 * decrypt uses the same clone-and-commit discipline as live.ts: run the transform
 * on a clone, commit only on success, discard on failure — which is what makes a
 * rejected frame state-neutral (there is no explicit replay path in Whisper; a
 * replayed counter derives the wrong membrane key and fails AEAD authentication,
 * and the clone is discarded).
 */

import {
  type ProtocolState,
  protocolEncrypt,
  protocolDecrypt,
  cloneProtocolState,
  buildLoopStateFromChainKey,
  loopStatesFromRatchetState,
} from "../../../src/scripts/whisper/live-protocol.js";
import {
  generateDHKeyPair,
  initRatchetAsOfferer,
  initRatchetAsReceiver,
  dhRatchetStep,
  ratchetFingerprint,
} from "../../../src/scripts/whisper/live-ratchet.js";
import { loopFingerprint, loopStep, loopWipe } from "../../../src/scripts/whisper/live-loop.js";
import { aesGcmEncrypt } from "../../../src/scripts/whisper/live-crypto.js";
import { buildHeader, buildNonce, LIVE_FLAG_SAME_KEY } from "../../../src/scripts/whisper/live-wire.js";
import { toHex } from "../../../src/scripts/whisper/buf.js";

// re-exported from the real definition rather than restated. "must match" in a
// comment is not a mechanism.
export { MAX_SKIP } from "../../../src/scripts/whisper/live-ratchet.js";

/**
 * `msgId` is the global session id the receiver derived (parity encodes the sender).
 *
 * `threw` records that protocolDecrypt escaped by exception rather than returning
 * an outcome. It exists because the harness used to swallow that distinction: it
 * caught the throw, minted an ordinary rejection, and every invariant downstream
 * read "rejected safely" while roughly half of all bit-flipped headers were in
 * fact crashing out of P-256 point decompression. A harness that is SAFER than
 * production does not test production. Post-fix this must always be false, and an
 * invariant says so out loud instead of the harness quietly making it true.
 */
export type DecryptResult =
  | { status: "accept"; plaintext: Uint8Array; msgId: number; threw?: false }
  | { status: "reject-gap"; reason: string; threw?: boolean }
  | { status: "reject-auth"; reason: string; threw?: boolean };

/**
 * A FULL digest of the mutable protocol state — every field a partial-decrypt bug
 * could corrupt: ratchet position AND secret key bytes, both membrane fingerprints,
 * the skipped-loop-key entries (ids + values), the pubkey caches, and the totals.
 * ratchetFingerprint alone is insufficient (it omits the membrane, skipped keys, and
 * counters), which made the old state-neutrality assertions vacuous.
 */
export function fullStateDigest(s: ProtocolState): string {
  return JSON.stringify({
    ratchet: ratchetFingerprint(s.ratchet),
    rootKey: toHex(s.ratchet.rootKey),
    chainSend: s.ratchet.chainKeySend ? toHex(s.ratchet.chainKeySend) : null,
    chainRecv: s.ratchet.chainKeyRecv ? toHex(s.ratchet.chainKeyRecv) : null,
    loopSend: s.loopSend ? loopFingerprint(s.loopSend) : null,
    loopRecv: s.loopRecv ? loopFingerprint(s.loopRecv) : null,
    skipped: Array.from(s.skippedLoopKeys.entries())
      .map(([k, v]) => `${k}=${toHex(v)}`)
      .sort(),
    lastSent: s.lastSentPubKeyHex,
    lastRecv: s.lastRecvPubKeyHex,
    nSent: s.nSentTotal,
    nRecv: s.nRecvTotal,
  });
}

/**
 * One peer: its full protocol state, the direction bit it sends with, and the
 * CALLER-side accounting that decides whether the session survives.
 *
 * `failures`/`alive` are not decoration. live.ts keeps a consecutive-failure
 * counter outside ProtocolState and tears the session down at three; a harness
 * that models only ProtocolState cannot observe a teardown at all, so "no
 * injected frame can end the session" was being asserted against a machine with
 * no way to end. The counter is the state the attack actually targets.
 */
export interface Peer {
  state: ProtocolState;
  sendDirBit: number;
  /** consecutive decrypt failures, mirroring live.ts's consecutiveDecryptFailures. */
  failures: number;
  /** ms timestamp of the last successful decrypt, mirroring lastDecryptSuccessAt. */
  lastSuccessAt: number;
  /** false once BOTH teardown witnesses agree, mirroring live.ts's catch arm. */
  alive: boolean;
  /** injectable clock so a test can age a session without sleeping. */
  now: () => number;
  /**
   * Serializes ratchet operations, mirroring live.ts's `withRatchetLock`.
   *
   * This is not harness convenience. `buildProtoState()` in live.ts hands out
   * REFERENCES to the live ratchet, membranes and skipped-key map, and
   * protocolEncrypt mutates them in place. Two encrypts that interleave both
   * read `nSend` before either writes it, so both frames go out on counter N
   * with the same message key: AES-GCM nonce reuse, which is keystream reuse,
   * which is plaintext recovery by XOR. Measured on this harness without the
   * lock, eight concurrent sends all carried counter 0 and none of them
   * decrypted.
   *
   * The lock is therefore the single thing standing between this codebase and a
   * catastrophic failure, and until now no test entered it concurrently. A
   * harness that awaits every call one at a time cannot tell a working lock from
   * a deleted one.
   */
  lockQueue: Promise<void>;
}

/** identical in shape to live.ts's withRatchetLock, deliberately. */
export async function withPeerLock<T>(peer: Peer, op: () => Promise<T>): Promise<T> {
  const prior = peer.lockQueue;
  let release!: () => void;
  peer.lockQueue = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try {
    return await op();
  } finally {
    release();
  }
}

/**
 * Both witnesses, mirroring live.ts. A test that drives only the counter can
 * never reach teardown, which is the point: a burst of rejections is not
 * evidence of desync, and the harness has to agree with production about that or
 * the invariant it checks is about a different machine.
 */
export const DESYNC_MIN_FAILURES = 8;
export const DESYNC_GRACE_MS = 30_000;

/**
 * Peers whose clock never moved off the default.
 *
 * The teardown rule needs elapsed time, so a peer left on `now: () => 0` can
 * never be declared dead and every "the session survived" assertion about it is
 * a tautology. That is not a hypothetical: `sim.ts` asserted exactly such an
 * invariant across 40 seeds while its peers had no clock. Rather than trust
 * every future harness to remember, record the omission so a test can assert it
 * did not happen.
 */
export const NO_CLOCK = new Set<Peer>();

/** throws if any peer reached a teardown decision without a working clock. */
export function assertClocksWereLive(): void {
  if (NO_CLOCK.size > 0) {
    throw new Error(
      `${NO_CLOCK.size} peer(s) evaluated the teardown rule with a frozen clock, ` +
      `so any "session survived" assertion about them proved nothing. Set peer.now.`,
    );
  }
}

export interface DuplexChannel {
  offerer: Peer;
  answerer: Peer;
}

/**
 * Establish a fully-connected duplex over the real protocol, mirroring the loop-
 * state setup live.ts performs during the handshake: the offerer and answerer
 * exchange DH ratchet keys and both derive their membrane (loop) states from the
 * resulting chain keys. offerer→answerer works immediately; answerer→offerer
 * triggers a natural DH ratchet on first receipt, which protocolDecrypt handles.
 */
export type KeyGen = () => Promise<{ publicKey: Uint8Array; privateKey: CryptoKey }>;

export async function establishChannel(sharedSecret: Uint8Array, keyGen: KeyGen = generateDHKeyPair): Promise<DuplexChannel> {
  // the offerer's initial keypair must come from the SAME source as the ratchet
  // internals (installed via setDHKeyPairSource), or a seeded run isn't fully
  // deterministic — that one direct keygen would still be random.
  const dhOfferer = await keyGen();
  const offRatchet = await initRatchetAsOfferer(sharedSecret.slice(), dhOfferer);
  const ansRatchet = await initRatchetAsReceiver(sharedSecret.slice(), dhOfferer.publicKey);

  // offerer adopts answerer's key → gains both chains. Pass a COPY: dhRatchetStep
  // stores the peer pubkey BY REFERENCE, and production peers live in separate
  // processes. Sharing the buffer here would let one peer's forward-secrecy wipe
  // corrupt the other peer's dhSelf — an artifact of running both peers in one
  // process, not a real behavior.
  await dhRatchetStep(offRatchet, ansRatchet.dhSelf.publicKey.slice());
  const offLoops = await loopStatesFromRatchetState(offRatchet);

  // answerer adopts offerer's post-step key → gains its receive chain
  await dhRatchetStep(ansRatchet, offRatchet.dhSelf.publicKey.slice());
  const ansLoops = await loopStatesFromRatchetState(ansRatchet);

  const offerer: ProtocolState = {
    ratchet: offRatchet,
    loopSend: offLoops.send,
    loopRecv: offLoops.recv,
    skippedLoopKeys: new Map(),
    lastSentPubKeyHex: "",
    lastRecvPubKeyHex: "",
    nSentTotal: 0,
    nRecvTotal: 0,
    isOfferer: true,
  };
  const answerer: ProtocolState = {
    ratchet: ansRatchet,
    loopSend: ansLoops.send,
    loopRecv: ansLoops.recv,
    skippedLoopKeys: new Map(),
    lastSentPubKeyHex: "",
    lastRecvPubKeyHex: "",
    nSentTotal: 0,
    nRecvTotal: 0,
    isOfferer: false,
  };

  return {
    offerer: { state: offerer, sendDirBit: 0, failures: 0, lastSuccessAt: 0, alive: true, now: () => 0, lockQueue: Promise.resolve() },
    answerer: { state: answerer, sendDirBit: 1, failures: 0, lastSuccessAt: 0, alive: true, now: () => 0, lockQueue: Promise.resolve() },
  };
}

/**
 * Like establishChannel but faithful to production's LAZY bootstrap: the answerer
 * is left with chainKeyRecv/loopRecv = null (it has NOT yet ratcheted to the
 * offerer's post-init key). The offerer's FIRST received message is what drives
 * the answerer's bootstrap DH ratchet through protocolDecrypt — exercising the
 * `chainKeyRecv === null` branch that establishChannel pre-runs and hides.
 */
export async function establishBootstrap(sharedSecret: Uint8Array, keyGen: KeyGen = generateDHKeyPair): Promise<DuplexChannel> {
  const dhOfferer = await keyGen();
  const offRatchet = await initRatchetAsOfferer(sharedSecret.slice(), dhOfferer);
  const ansRatchet = await initRatchetAsReceiver(sharedSecret.slice(), dhOfferer.publicKey);

  // offerer adopts answerer's key → gains both chains (as in production once it
  // receives the answerer's ratchet-init). Pass a COPY (see establishChannel).
  await dhRatchetStep(offRatchet, ansRatchet.dhSelf.publicKey.slice());
  const offLoops = await loopStatesFromRatchetState(offRatchet);

  // answerer keeps only its send chain (chainKeyRecv is null until its first
  // received message triggers the bootstrap ratchet inside protocolDecrypt).
  const ansSendLoop = await buildLoopStateFromChainKey(ansRatchet.chainKeySend!);

  const offerer: ProtocolState = {
    ratchet: offRatchet,
    loopSend: offLoops.send,
    loopRecv: offLoops.recv,
    skippedLoopKeys: new Map(),
    lastSentPubKeyHex: "",
    lastRecvPubKeyHex: "",
    nSentTotal: 0,
    nRecvTotal: 0,
    isOfferer: true,
  };
  const answerer: ProtocolState = {
    ratchet: ansRatchet, // chainKeyRecv === null
    loopSend: ansSendLoop,
    loopRecv: null,
    skippedLoopKeys: new Map(),
    lastSentPubKeyHex: "",
    lastRecvPubKeyHex: "",
    nSentTotal: 0,
    nRecvTotal: 0,
    isOfferer: false,
  };

  return {
    offerer: { state: offerer, sendDirBit: 0, failures: 0, lastSuccessAt: 0, alive: true, now: () => 0, lockQueue: Promise.resolve() },
    answerer: { state: answerer, sendDirBit: 1, failures: 0, lastSuccessAt: 0, alive: true, now: () => 0, lockQueue: Promise.resolve() },
  };
}

/** Encrypt a plaintext message (flags=0 = plain text) with the given nonce salt. */
export async function encrypt(peer: Peer, plaintext: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return withPeerLock(peer, async () => {
    const { wire } = await protocolEncrypt(peer.state, plaintext, 0, salt);
    return wire;
  });
}

/**
 * A MALICIOUS-BUT-KEYED peer: crafts a properly AEAD-authenticated frame carrying
 * an arbitrary pre-encryption payload (which protocolEncrypt would never produce),
 * so tests can reach protocolDecrypt's post-authentication branches (the decodedLen
 * bound and payload-too-short guard) that honest frames and tampering cannot. Runs
 * on a clone of the sender so the real state is untouched; the receiver, at the
 * same membrane position, derives the same key and authenticates it, then hits the
 * payload check. `payload` is the raw pre-encryption bytes: [decodedLen:4B LE][…].
 */
export async function craftAuthenticated(sender: Peer, payload: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const s = cloneProtocolState(sender.state);
  if (!s.loopSend) throw new Error("craftAuthenticated: sender not initialized");
  const { messageKey } = await loopStep(s.loopSend);
  const counter = s.ratchet.nSend;
  const dirBit = s.isOfferer ? 0 : 1;
  const nonce = buildNonce(counter, dirBit, salt);
  const pubKeyHex = toHex(s.ratchet.dhSelf.publicKey);
  const sameKey = pubKeyHex === s.lastSentPubKeyHex;
  const header = buildHeader(
    sameKey ? LIVE_FLAG_SAME_KEY : 0,
    s.ratchet.dhSelf.publicKey,
    counter,
    s.ratchet.prevChainLength,
    salt,
  );
  const ct = await aesGcmEncrypt(messageKey, payload, nonce, header);
  messageKey.fill(0);
  const wire = new Uint8Array(header.length + ct.length);
  wire.set(header, 0);
  wire.set(ct, header.length);
  return wire;
}

/** Encrypt, returning the wire AND the global msgId (parity encodes the sender). */
export async function encryptWithId(
  peer: Peer,
  plaintext: Uint8Array,
  salt: Uint8Array,
  flags = 0,
): Promise<{ wire: Uint8Array; msgId: number }> {
  return protocolEncrypt(peer.state, plaintext, flags, salt);
}

/**
 * Decrypt a wire frame. Runs the real protocolDecrypt on a clone and commits
 * only on success (state-neutral on any rejection), exactly as live.ts does.
 * The third argument is accepted for call-site compatibility and ignored — the
 * direction bit is derived from the peer's own isOfferer inside protocolDecrypt.
 */
export function decrypt(peer: Peer, wire: Uint8Array, _peerSendDirBit?: number): Promise<DecryptResult> {
  return withPeerLock(peer, () => decryptLocked(peer, wire));
}

async function decryptLocked(peer: Peer, wire: Uint8Array): Promise<DecryptResult> {
  const clone = cloneProtocolState(peer.state);
  let outcome: Awaited<ReturnType<typeof protocolDecrypt>>;
  let threw = false;
  try {
    outcome = await protocolDecrypt(clone, wire);
  } catch (e) {
    // protocolDecrypt is contracted to be TOTAL, so reaching here is itself the
    // finding. The throw is still contained the way live.ts contains it, but it
    // is recorded rather than laundered into an ordinary rejection.
    threw = true;
    outcome = { ok: false, reason: `threw: ${(e as Error)?.message ?? String(e)}` };
  }
  // the boundary wrapper converts an escaped exception into this reason, so it is
  // the same finding arriving through the supported channel.
  if (!outcome.ok && outcome.reason.startsWith("unexpected:")) threw = true;

  if (outcome.ok) {
    commitDecrypt(peer, clone); // mirror live.ts commitReceiveState: selective copy + wipe old secrets
    peer.failures = 0;          // live.ts:  consecutiveDecryptFailures = 0 on success
    peer.lastSuccessAt = peer.now();
    return { status: "accept", plaintext: outcome.plaintext, msgId: outcome.msgId };
  }

  // failure → discard clone, peer.state untouched (state-neutral). the CALLER's
  // accounting still moves, and that is the part an attacker can drive.
  peer.failures++;
  if (peer.failures >= DESYNC_MIN_FAILURES && peer.now() - peer.lastSuccessAt >= DESYNC_GRACE_MS) {
    peer.alive = false;
  }
  if (peer.now() === 0) NO_CLOCK.add(peer);

  if (outcome.reason.includes("skip") || outcome.reason.includes("skipped")) {
    return { status: "reject-gap", reason: outcome.reason, threw };
  }
  return { status: "reject-auth", reason: outcome.reason, threw };
}

/**
 * Commit a successful decrypt the way live.ts's commitReceiveState does:
 * install the new receive-side state + counters, then ZEROIZE the superseded
 * secrets (old ratchet keys, old membranes, old skipped keys) for forward
 * secrecy. The send-side msgId counters (nSentTotal, lastSentPubKeyHex) are
 * deliberately NOT copied from the clone — decrypt never changes them, and not
 * copying drops any spurious transform mutation, exactly as production does.
 * (cloneProtocolState deep-copies every buffer, so wiping the old objects can
 * never corrupt the newly installed state.)
 */
function commitDecrypt(peer: Peer, next: ProtocolState): void {
  const s = peer.state;
  const oldRatchet = s.ratchet;
  const oldLoopSend = s.loopSend;
  const oldLoopRecv = s.loopRecv;
  const oldSkipped = s.skippedLoopKeys;

  s.ratchet = next.ratchet;
  s.loopSend = next.loopSend;
  s.loopRecv = next.loopRecv;
  s.skippedLoopKeys = next.skippedLoopKeys;
  s.lastRecvPubKeyHex = next.lastRecvPubKeyHex;
  s.nRecvTotal = next.nRecvTotal;

  wipeRatchetSecrets(oldRatchet);
  if (oldLoopSend) loopWipe(oldLoopSend);
  if (oldLoopRecv) loopWipe(oldLoopRecv);
  for (const v of oldSkipped.values()) v.fill(0);
  oldSkipped.clear();
}

function wipeRatchetSecrets(r: ProtocolState["ratchet"]): void {
  r.rootKey.fill(0);
  r.chainKeySend?.fill(0);
  r.chainKeyRecv?.fill(0);
  r.dhPeer?.fill(0);
  r.dhSelf.publicKey.fill(0);
  for (const v of r.skippedKeys.values()) v.fill(0);
  r.skippedKeys.clear();
}

// re-export so tests can build fresh loop states if needed
export { buildLoopStateFromChainKey };
