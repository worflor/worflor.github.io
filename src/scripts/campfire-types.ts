/**
 * Campfire — shared types, interfaces, and constants.
 *
 * Campfire is a gossip-propagated group chat over WebRTC.
 * Root controls the topology, heartbeat, and kill switch.
 */

import type { WhisperLiveSession } from "./whisper-live";

/* ═══════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════ */

/** Campfire wire sub-types (carried inside 0x20 encrypted messages with flags & 0x02). */
export const CF_ROOT_HEARTBEAT     = 0x50;
export const CF_GROUP_MSG          = 0x51;
export const CF_JOIN_ANNOUNCE      = 0x52;
export const CF_LEAVE_ANNOUNCE     = 0x53;
export const CF_TOPOLOGY_ASSIGN    = 0x54;
export const CF_SDP_RELAY          = 0x55;
export const CF_GROUP_KEY          = 0x56;
export const CF_PEER_LIST          = 0x57;
export const CF_DM_SDP_RELAY       = 0x58;
export const CF_SUB_INVITE         = 0x59;
export const CF_SUB_SDP            = 0x5a;

/** Flags bit for campfire messages in the whisper-live header. */
export const CAMPFIRE_FLAG         = 0x02;

/** Peer ID length in bytes. */
export const PEER_ID_LEN           = 16;

/** Group key length in bytes. */
export const GROUP_KEY_LEN         = 32;

/** Message ID length (SHA-256 hash). */
export const MSG_ID_LEN            = 32;

/** Root heartbeat interval (ms). */
export const ROOT_HEARTBEAT_INTERVAL = 10_000;

/** Heartbeat miss tolerance (ms). */
export const ROOT_HEARTBEAT_TIMEOUT  = 30_000;

/** Previous-epoch key grace period (ms). */
export const KEY_GRACE_PERIOD        = 30_000;

/** Max target neighbors per peer. */
export const MAX_NEIGHBORS           = 4;
export const MIN_NEIGHBORS           = 2;

/** Dedup ring buffer size. */
export const DEDUP_RING_SIZE         = 512;

/** Max gossip hop count before dropping. */
export const MAX_HOP_COUNT          = 16;

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
  session: WhisperLiveSession | null;
  connected: boolean;
  joinedAt: number;
}

export interface GroupKeyEpoch {
  epoch: number;
  key: Uint8Array;          // 32 bytes AES-256
  expiresAt: number;        // when this epoch can no longer decrypt (grace)
}

export interface CampfireMessage {
  msgId: Uint8Array;        // 32 bytes
  senderId: Uint8Array;     // 16 bytes
  senderIdHex: string;
  senderName: string;
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
  onDmMessage: (fromPeerId: Uint8Array, msg: { type: "text"; text: string; timestamp: number }) => void;
  onSubCampfireInvite: (subId: Uint8Array, inviterPeerId: Uint8Array, invitees: Uint8Array[]) => void;
}

export interface SubCampfire {
  subId: Uint8Array;
  subIdHex: string;
  members: Map<string, CampfirePeer>;
  groupKey: Uint8Array;
  epoch: number;
}
