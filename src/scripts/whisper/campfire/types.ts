/**
 * Campfire — shared types, interfaces, and constants.
 *
 * Campfire is a gossip-propagated group chat over WebRTC. The braid crypto
 * core (../live-braid.ts) replaces root-authority group keys: every seat
 * folds a shared epoch root and derives its own send chain, so there is no
 * key distribution and no key rotation ceremony. The topology (./topology.ts)
 * is a pure function of the roster; "root" survives only as the genesis
 * host and, while it holds seat zero, the single fold-writer (the elder).
 */

import type { WhisperLiveCallbacks } from "../live";
import type { BraidState } from "../live-braid";

/* ═══════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════ */

/** Campfire wire sub-types (carried inside 0x20 encrypted messages with flags & 0x02). */
export const CF_GROUP_MSG          = 0x51;
export const CF_JOIN_ANNOUNCE      = 0x52;
export const CF_LEAVE_ANNOUNCE     = 0x53;
export const CF_SDP_RELAY          = 0x55;
export const CF_PEER_LIST          = 0x57;
export const CF_DM_SDP_RELAY       = 0x58;
export const CF_RING_WANT          = 0x5b;
export const CF_REACT              = 0x5c;  // [targetMsgIdFull:32B][senderId:16B][hopCount:1B][emoji:utf8]
export const CF_UNREACT            = 0x5d;  // [targetMsgIdFull:32B][senderId:16B][hopCount:1B][emoji:utf8]
export const CF_BRAID_FOLD         = 0x5e;  // epoch fold: new roster, fold entropy, roster digest
export const CF_BRAID_WELCOME      = 0x5f;  // sender -> joiner (or cross-check): epoch root + roster
export const CF_JOIN_REQ           = 0x60;  // non-elder member -> elder: relay a pending admission
export const CF_EDGE_RELEASE       = 0x61;  // point-to-point: "this edge closes intentionally, i have not left"

/** Flags bit for campfire messages in the whisper-live header. */
export const CAMPFIRE_FLAG         = 0x02;

/** Peer ID length in bytes. */
export const PEER_ID_LEN           = 16;

/** Message ID length (SHA-256 hash). */
export const MSG_ID_LEN            = 32;

/** Outgoing-epoch braid grace period (ms) — how long a stale epoch may still open messages. */
export const KEY_GRACE_PERIOD        = 30_000;

/** Outgoing epochs kept openable at once. Bounds the cost of a fold burst: a
 *  run of quick departures rotates several epochs inside one grace window, and
 *  each still holds messages that were in flight when it turned. */
export const MAX_DRAINING_EPOCHS     = 4;

/** Applied folds retained so a neighbor stranded by a partition can be walked
 *  forward. Memory only, zeroized on teardown; never served to a peer missing
 *  from the current roster, since a fold is exactly the secret that removed it. */
export const MAX_RETAINED_FOLDS      = 16;

/** Ceiling on the peer directory. `allPeers` is fed by JOIN_ANNOUNCE and
 *  PEER_LIST, neither of which is authenticated or roster-checked, so without a
 *  cap any peer can grow it without bound and each new entry is re-gossiped. */
export const MAX_KNOWN_PEERS         = 256;

/** Ceiling on remembered reaction ids. The key includes an attacker-chosen
 *  emoji string, so this set is unbounded in BOTH length and cardinality. */
export const REACT_DEDUP_RING        = 4096;

/** Minimum gap (ms) between walking the same neighbor forward. A lagging seat
 *  stamps its stale epoch on every frame it sends, so without this one silent
 *  partition would turn into a fold re-send per message. */
export const FOLD_PUSH_INTERVAL      = 1_000;


/** Max target neighbors per peer. */
export const MAX_NEIGHBORS           = 4;
export const MIN_NEIGHBORS           = 2;

/** Dedup ring buffer size. */
export const DEDUP_RING_SIZE         = 512;

/** Max gossip hop count before dropping. */
export const MAX_HOP_COUNT          = 16;

/* ═══════════════════════════════════════════════════════════════════
   Session abstraction (testability)
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Structural subset of WhisperLiveSession that CampfireNode depends on.
 * Lets tests inject a fake transport without touching the real WebRTC stack;
 * WhisperLiveSession satisfies this interface as-is (structural typing).
 */
export interface CampfireSessionLike {
  createOffer(): Promise<string>;
  acceptOffer(code: string): Promise<string>;
  applyAnswer(code: string): Promise<void>;
  sendEncryptedRaw(plaintext: Uint8Array, flags: number): Promise<void>;
  sendText(text: string): Promise<number | void>;
  disconnect(): void;
}

export type CampfireSessionFactory = (
  callbacks: WhisperLiveCallbacks,
  opts: { rtcConfig: RTCConfiguration; autoConfirmFingerprint: boolean },
) => CampfireSessionLike;

/* ═══════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════ */

export type CampfireState =
  | "idle"
  | "creating"
  | "waiting"
  | "connecting"
  | "active"
  | "ended";

export type CampfireRole = "root" | "peer";

/** Content type byte inside a GROUP_MSG. */
/**
 * The per-message facts the UI needs, carried ON the message through the braid.
 *
 * This is the attachment type the braid is parametric in. Naming it here rather
 * than inline is the whole point: it is the contract between the two places that
 * must agree (attached at ingress, read at delivery), and because the braid is
 * polymorphic in it, those are the ONLY two places that can possibly see it.
 * There is no third party to fall out of step with.
 */
export interface GroupMsgFacts {
  msgId: Uint8Array;
  timestamp: number;
  hopCount: number;
  contentType: ContentType;
}

export const enum ContentType {
  Text = 0x00,
  File = 0x01,
  System = 0x02,
}

export interface CampfirePeer {
  peerId: Uint8Array;       // 16 bytes
  peerIdHex: string;
  name: string;
  session: CampfireSessionLike | null;
  connected: boolean;
  joinedAt: number;
  /** the peer announced this edge closes intentionally (topology
   *  reconciliation, bootstrap release) — its disconnect must never be
   *  read as the peer leaving the circle. */
  released?: boolean;
}

/** One folded epoch: the roster it binds, the shared root it was folded to, and
 *  the live braid state derived from that root for this seat. */
export interface BraidEpoch {
  epochId: number;
  /** sorted lowercase hex seat ids — same ordering as BraidState.seats. */
  roster: string[];
  root: Uint8Array;
  braid: BraidState<GroupMsgFacts>;
}

export interface CampfireMessage {
  msgId: Uint8Array;        // 32 bytes — full SHA-256, used for gossip dedup
  /**
   * Compact uint32 display ID derived from the first 4 bytes of msgId (LE).
   * Used for DOM lookups (msgById), SEEN, and REACT — same numeric domain as 1:1 LiveMessage.msgId.
   */
  displayId: number;
  senderId: Uint8Array;     // 16 bytes
  senderIdHex: string;
  timestamp: number;
  hopCount: number;
  epoch: number;
  contentType: ContentType;
  plaintext: Uint8Array;    // decrypted content
}

export interface CampfireCallbacks {
  onStateChange: (state: CampfireState, detail?: string) => void;
  onMessage: (msg: CampfireMessage) => void;
  onPeerJoin: (peerId: Uint8Array, name: string) => void;
  onPeerLeave: (peerId: Uint8Array) => void;
  onPeerListUpdate: (peers: ReadonlyArray<{ peerId: Uint8Array; name: string }>) => void;
  onLog: (line: string) => void;
  onRoomCodeUpdate?: (code: string) => void;
  onDmMessage: (fromPeerId: Uint8Array, msg: { type: "text"; text: string; timestamp: number }) => void;
  /** A peer reacted to a message. displayId matches CampfireMessage.displayId. */
  onReact?: (displayId: number, emoji: string, senderIdHex: string) => void;
  /** A peer un-reacted to a message. */
  onUnreact?: (displayId: number, emoji: string, senderIdHex: string) => void;
  /** A seat's strand desynced beyond recovery for the current epoch — its bond is dead until the next fold. */
  onSeatDiverged?: (peerId: Uint8Array, reason: string) => void;
  /** Two differently-signed frames claim the SAME position in one seat's strand.
   *  A seat's sequence is monotone, so this cannot happen honestly. Both frames
   *  carry that seat's signature, so the PAIR is self-contained evidence: anyone
   *  can verify it without trusting whoever reports it. This is the one signal
   *  that survives a stolen key, because it does not ask "is this signed?" but
   *  "do the witnesses agree?" — and a thief cannot make the honest seat stop
   *  testifying. Carry both frames so the accusation stays checkable. */
  onSeatEquivocated?: (peerId: Uint8Array, seq: number, first: Uint8Array, second: Uint8Array) => void;
  /** A seat's frames keep failing to open. Unlike onSeatDiverged this is a
   *  report, not a verdict: no state changed, the bond is intact, and a clean
   *  copy still lands. It fires for a genuine history fork and can also fire
   *  for a burst of forged frames, so present it as "cannot read", never as
   *  "they left" or "they are compromised". */
  onSeatStalled?: (peerId: Uint8Array, reason: string) => void;
}
