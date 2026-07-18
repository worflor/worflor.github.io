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

/** Previous-epoch braid grace period (ms) — how long a stale epoch may still open messages. */
export const KEY_GRACE_PERIOD        = 30_000;

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
  braid: BraidState;
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
}
