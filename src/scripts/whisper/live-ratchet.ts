/**
 * Whisper Live — Double Ratchet protocol implementation.
 *
 * Signal Protocol Double Ratchet algorithm.
 *
 * Root chain: initialized from ECDH shared secret.
 * DH ratchet: new P-256 keypair per sending turn.
 * Symmetric ratchet: HMAC-SHA256 chain per direction.
 * Message keys: derived from chain, used once then discarded.
 */

import { toHex, toArrayBuffer } from "./wasm";
import { hkdf, kdfChainDirect } from "./live-crypto";

/** Pre-encoded constant — avoids per-call TextEncoder allocations */
const KDF_INFO_RATCHET = new TextEncoder().encode("whisper-ratchet");

const MAX_SKIP = 256;  // max skipped message keys to store

function skippedKeyId(pubHex: string, nr: number): string {
  return `${pubHex}:${nr}`;
}

interface RatchetKeyPair {
  publicKey: Uint8Array;    // raw 65-byte uncompressed P-256 point
  privateKey: CryptoKey;    // non-extractable ECDH private key
}

export interface RatchetState {
  /** Root key — 32 bytes, ratcheted with each DH exchange */
  rootKey: Uint8Array;

  /** Our current DH ratchet keypair */
  dhSelf: RatchetKeyPair;

  /** Peer's current DH ratchet public key (raw bytes) */
  dhPeer: Uint8Array | null;

  /** Cached hex of dhPeer — avoids recomputing toHex(dhPeer) per message */
  dhPeerHex: string;

  /** Sending chain key */
  chainKeySend: Uint8Array | null;

  /** Receiving chain key */
  chainKeyRecv: Uint8Array | null;

  /** Number of messages sent in current sending chain */
  nSend: number;

  /** Number of messages received in current receiving chain */
  nRecv: number;

  /** Previous sending chain length (for header) */
  prevChainLength: number;

  /** Skipped message keys for out-of-order delivery — Map<"pubHex:nr", messageKey> */
  skippedKeys: Map<string, Uint8Array>;
}

export async function generateDHKeyPair(): Promise<RatchetKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: pubRaw, privateKey: pair.privateKey };
}

async function dhExchange(privateKey: CryptoKey, peerPublicRaw: Uint8Array): Promise<Uint8Array> {
  const peerKey = await crypto.subtle.importKey(
    "raw", toArrayBuffer(peerPublicRaw), { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerKey }, privateKey, 256,
  );
  return new Uint8Array(bits);
}

/** KDF for root chain ratchet: HKDF(rootKey, dhOutput) → [newRootKey, newChainKey] */
async function kdfRootChain(
  rootKey: Uint8Array, dhOutput: Uint8Array,
): Promise<[Uint8Array, Uint8Array]> {
  const derived = await hkdf(dhOutput, rootKey, KDF_INFO_RATCHET, 64);
  return [derived.subarray(0, 32), derived.subarray(32, 64)];
}


/** Initialize ratchet state — called by the person who received the first message (answerer). */
export async function initRatchetAsReceiver(
  sharedSecret: Uint8Array,
  peerPublicKey: Uint8Array,
): Promise<RatchetState> {
  const dhSelf = await generateDHKeyPair();
  const dhOutput = await dhExchange(dhSelf.privateKey, peerPublicKey);
  const [rootKey, chainKeySend] = await kdfRootChain(sharedSecret, dhOutput);
  dhOutput.fill(0);

  return {
    rootKey,
    dhSelf,
    dhPeer: peerPublicKey,
    dhPeerHex: toHex(peerPublicKey),
    chainKeySend,
    chainKeyRecv: null,
    nSend: 0,
    nRecv: 0,
    prevChainLength: 0,
    skippedKeys: new Map(),
  };
}

/** Initialize ratchet state — called by the person who sent the first message (offerer). */
export async function initRatchetAsOfferer(
  sharedSecret: Uint8Array, dhSelf: RatchetKeyPair,
): Promise<RatchetState> {
  return {
    // Keep the ratchet root independent from the session root used by handshake confirmation.
    rootKey: sharedSecret.slice(),
    dhSelf,
    dhPeer: null,
    dhPeerHex: "",
    chainKeySend: null,
    chainKeyRecv: null,
    nSend: 0,
    nRecv: 0,
    prevChainLength: 0,
    skippedKeys: new Map(),
  };
}

/** Perform a DH ratchet step when receiving a new public key from peer. */
export async function dhRatchetStep(state: RatchetState, peerPublicKey: Uint8Array): Promise<void> {
  state.prevChainLength = state.nSend;
  state.nSend = 0;
  state.nRecv = 0;

  if (state.dhPeer) state.dhPeer.fill(0);
  state.dhPeer = peerPublicKey;
  state.dhPeerHex = toHex(peerPublicKey);

  if (state.chainKeyRecv) state.chainKeyRecv.fill(0);
  if (state.chainKeySend) state.chainKeySend.fill(0);

  const dhRecv = await dhExchange(state.dhSelf.privateKey, peerPublicKey);
  const oldRootKey1 = state.rootKey;
  const [rootKey1, chainKeyRecv] = await kdfRootChain(state.rootKey, dhRecv);
  dhRecv.fill(0);
  oldRootKey1.fill(0);
  state.rootKey = rootKey1;
  state.chainKeyRecv = chainKeyRecv;

  const oldDhSelf = state.dhSelf;
  state.dhSelf = await generateDHKeyPair();
  oldDhSelf.publicKey.fill(0);
  const dhSend = await dhExchange(state.dhSelf.privateKey, peerPublicKey);
  const intermediateRootKey = state.rootKey;
  const [rootKey2, chainKeySend] = await kdfRootChain(state.rootKey, dhSend);
  dhSend.fill(0);
  intermediateRootKey.fill(0);
  state.rootKey = rootKey2;
  state.chainKeySend = chainKeySend;
}

/** Skip message keys for out-of-order delivery. */
export async function skipMessageKeys(state: RatchetState, until: number): Promise<void> {
  if (!state.chainKeyRecv) return;
  if (until - state.nRecv > MAX_SKIP) throw new Error("Too many skipped messages");
  const pubHex = state.dhPeerHex;

  while (state.nRecv < until) {
    const oldChainKey = state.chainKeyRecv!;
    const [newChainKey, mk] = await kdfChainDirect(oldChainKey);
    oldChainKey.fill(0);
    state.chainKeyRecv = newChainKey;
    state.skippedKeys.set(skippedKeyId(pubHex, state.nRecv), mk);
    state.nRecv++;

    if (state.skippedKeys.size > MAX_SKIP * 2) {
      const excess = state.skippedKeys.size - MAX_SKIP;
      const iter = state.skippedKeys.keys();
      for (let i = 0; i < excess; i++) {
        const k = iter.next().value;
        if (k !== undefined) {
          const evicted = state.skippedKeys.get(k);
          if (evicted) evicted.fill(0);
          state.skippedKeys.delete(k);
        }
      }
    }
  }
}

/** Try to find a skipped message key. Returns and removes it if found. O(1) Map lookup. */
export function trySkippedKey(
  state: RatchetState, pubKeyHex: string, nr: number,
): Uint8Array | null {
  const key = skippedKeyId(pubKeyHex, nr);
  const mk = state.skippedKeys.get(key);
  if (!mk) return null;
  state.skippedKeys.delete(key);
  return mk;
}
