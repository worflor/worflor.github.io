/**
 * Campfire — wire protocol message builders/parsers.
 *
 * All campfire messages are carried inside the existing 0x20 encrypted
 * message type. The flags byte has bit1 (0x02) set to indicate campfire
 * content. The decrypted plaintext starts with a campfire sub-type byte
 * (0x51–0x60), followed by sub-type-specific payload.
 *
 * This module is a pure framer: it has no crypto of its own. Group message
 * ciphertext and frontier bytes come opaque from the braid core
 * (../live-braid.ts); wire.ts only knows how to lay them out and read them
 * back.
 */

import { TE, TD } from "../live-crypto";
import { concatBytes } from "../wasm";
import {
  CF_GROUP_MSG,
  CF_JOIN_ANNOUNCE,
  CF_LEAVE_ANNOUNCE,
  CF_SDP_RELAY,
  CF_PEER_LIST,
  CF_DM_SDP_RELAY,
  CF_RING_WANT,
  CF_REACT,
  CF_UNREACT,
  CF_BRAID_FOLD,
  CF_BRAID_WELCOME,
  CF_JOIN_REQ,
  CF_EDGE_RELEASE,
  PEER_ID_LEN,
  MSG_ID_LEN,
} from "./types";

/* ═══════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════ */

function u32LE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function readU32LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function u16LE(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function readU16LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function f64LE(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n, true);
  return b;
}

function readF64LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(offset, true);
}

/* ═══════════════════════════════════════════════════════════════════
   Builders
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 0x51 GROUP_MSG: [msgId 32B][senderId 16B][seq 4B][epochId 4B][timestamp 8B]
 *                 [hopCount 1B][contentType 1B][frontier: count 1B + 5B per entry][ciphertext ...]
 *
 * msgId is computed by the caller as sha256(senderId || le32(epochId) ||
 * le32(seq) || ciphertext). frontier and ciphertext come opaque from
 * braidSeal — this builder does no encryption, so it is synchronous.
 */
export function buildGroupMsg(
  msgId: Uint8Array, senderId: Uint8Array, seq: number, epochId: number,
  timestamp: number, hopCount: number, contentType: number,
  frontier: Uint8Array, ciphertext: Uint8Array,
): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_GROUP_MSG]),
    msgId, senderId,
    u32LE(seq),
    u32LE(epochId),
    f64LE(timestamp),
    new Uint8Array([hopCount, contentType]),
    frontier,
    ciphertext,
  );
}

/** Re-wrap a GROUP_MSG for forwarding — increment hop count but keep the ciphertext intact. */
export function rewrapGroupMsg(raw: Uint8Array, newHopCount: number): Uint8Array {
  // raw starts at sub-type byte 0x51
  // [0] subtype | [1..32] msgId | [33..48] senderId | [49..52] seq
  // [53..56] epochId | [57..64] timestamp | [65] hopCount | ...
  const hopOffset = 65;
  const out = new Uint8Array(raw);
  out[hopOffset] = newHopCount;
  return out;
}

/** 0x52 JOIN_ANNOUNCE: [peerId 16B][nameUTF8...] */
export function buildJoinAnnounce(peerId: Uint8Array, name: string): Uint8Array {
  return concatBytes(new Uint8Array([CF_JOIN_ANNOUNCE]), peerId, TE.encode(name));
}

/** 0x53 LEAVE_ANNOUNCE: [peerId 16B] */
export function buildLeaveAnnounce(peerId: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([CF_LEAVE_ANNOUNCE]), peerId);
}

/** 0x55 SDP_RELAY: [targetPeerId 16B][originPeerId 16B][sdpType 1B][sdpCode...] */
export function buildSdpRelay(targetPeerId: Uint8Array, originPeerId: Uint8Array, sdpType: number, sdpCode: string): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_SDP_RELAY]),
    targetPeerId,
    originPeerId,
    new Uint8Array([sdpType]),
    TE.encode(sdpCode),
  );
}

/** 0x57 PEER_LIST: [count 2B][...peerId 16B + nameLen 1B + name] */
export function buildPeerList(peers: Array<{ peerId: Uint8Array; name: string }>): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([CF_PEER_LIST]), u16LE(peers.length)];
  for (const p of peers) {
    const nameBytes = TE.encode(p.name);
    parts.push(p.peerId, new Uint8Array([nameBytes.length]), nameBytes);
  }
  return concatBytes(...parts);
}

/** 0x58 DM_SDP_RELAY: [targetPeerId 16B][originPeerId 16B][sdpType 1B][sdpCode...] */
export function buildDmSdpRelay(
  targetPeerId: Uint8Array,
  originPeerId: Uint8Array,
  sdpType: number,
  sdpCode: string,
): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_DM_SDP_RELAY]),
    targetPeerId,
    originPeerId,
    new Uint8Array([sdpType]),
    TE.encode(sdpCode),
  );
}

/** 0x5B RING_WANT: [originPeerId 16B][targetPeerId 16B][fromSeq 4B][toSeq 4B] */
export function buildRingWant(originPeerId: Uint8Array, targetPeerId: Uint8Array, fromSeq: number, toSeq: number): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_RING_WANT]),
    originPeerId,
    targetPeerId,
    u32LE(fromSeq),
    u32LE(toSeq),
  );
}

/**
 * 0x5C CF_REACT / 0x5D CF_UNREACT:
 *   [subType:1B][targetMsgIdFull:32B][senderId:16B][hopCount:1B][emoji:utf8]
 *
 * subType must be CF_REACT or CF_UNREACT.
 * targetMsgIdFull is the 32-byte SHA-256 msgId of the message being reacted to.
 * emoji is any Unicode emoji string encoded as UTF-8 (no length prefix — fills to end of payload).
 */
export function buildCfReact(
  subType: typeof CF_REACT | typeof CF_UNREACT,
  targetMsgIdFull: Uint8Array,
  senderId: Uint8Array,
  emoji: string,
  hopCount = 0,
): Uint8Array {
  return concatBytes(
    new Uint8Array([subType]),
    targetMsgIdFull,
    senderId,
    new Uint8Array([hopCount]),
    TE.encode(emoji),
  );
}

/**
 * 0x5E BRAID_FOLD: [newEpochId 4B][reason 1B][subjectPeerId 16B][entropy 32B][rosterDigest 32B]
 *
 * reason: 1 = join, 2 = leave. subjectPeerId is the joiner or the leaver.
 * entropy folds into the new epoch root (see live-braid.ts braidFold);
 * rosterDigest lets every receiver verify its own recomputed roster before
 * adopting the fold — it is sha256 over the concatenated raw id bytes of
 * the new roster's sorted hex seat ids.
 */
export function buildBraidFold(
  newEpochId: number, reason: number, subjectPeerId: Uint8Array,
  entropy: Uint8Array, rosterDigest: Uint8Array,
): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_BRAID_FOLD]),
    u32LE(newEpochId),
    new Uint8Array([reason]),
    subjectPeerId,
    entropy,
    rosterDigest,
  );
}

/**
 * 0x5F BRAID_WELCOME: [epochId 4B][senderPeerId 16B][root 32B][rosterCount 1B][...peerId 16B each]
 *
 * senderPeerId identifies who sent this welcome. It is needed the first
 * time a joiner adopts an epoch: the bootstrap link it connects through has
 * no other way to learn the sender's real id now that heartbeats are gone.
 * Every later cross-check welcome (sent over an ordinary mesh edge) fills
 * the same field with its own sender's id; it is only consulted on first
 * adoption, never on the cross-check path.
 */
export function buildBraidWelcome(
  epochId: number, senderPeerId: Uint8Array, root: Uint8Array, roster: Uint8Array[],
): Uint8Array {
  const parts: Uint8Array[] = [
    new Uint8Array([CF_BRAID_WELCOME]),
    u32LE(epochId),
    senderPeerId,
    root,
    new Uint8Array([roster.length]),
  ];
  for (const id of roster) parts.push(id);
  return concatBytes(...parts);
}

/** 0x60 JOIN_REQ: [joinerId 16B][nameUTF8...] — relayed toward the elder when
 *  a non-elder member admits a joiner over its own direct link. */
export function buildJoinReq(joinerId: Uint8Array, name: string): Uint8Array {
  return concatBytes(new Uint8Array([CF_JOIN_REQ]), joinerId, TE.encode(name));
}

/**
 * 0x61 EDGE_RELEASE: [senderPeerId 16B] — point-to-point over the closing
 * edge, never gossiped. sent immediately before an intentional disconnect
 * (topology reconciliation after a fold, bootstrap release) so the peer
 * never mistakes the drop for a departure. epochs propagate asynchronously,
 * so the two ends of an edge can disagree about whether it is still
 * required; without this signal the lagging side would announce a spurious
 * leave and get an innocent seat folded out of the circle.
 */
export function buildEdgeRelease(senderPeerId: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([CF_EDGE_RELEASE]), senderPeerId);
}

export interface ParsedEdgeRelease { senderPeerId: Uint8Array }
export function parseEdgeRelease(data: Uint8Array): ParsedEdgeRelease {
  return { senderPeerId: data.subarray(0, PEER_ID_LEN) };
}

/* ═══════════════════════════════════════════════════════════════════
   Parsers
   ═══════════════════════════════════════════════════════════════════ */

export interface ParsedGroupMsg {
  msgId: Uint8Array; senderId: Uint8Array;
  seq: number; epochId: number; timestamp: number; hopCount: number; contentType: number;
  frontier: Uint8Array; ciphertext: Uint8Array;
}
export function parseGroupMsgHeader(data: Uint8Array): ParsedGroupMsg {
  let o = 0;
  const msgId = data.subarray(o, o + MSG_ID_LEN); o += MSG_ID_LEN;
  const senderId = data.subarray(o, o + PEER_ID_LEN); o += PEER_ID_LEN;
  const seq = readU32LE(data, o); o += 4;
  const epochId = readU32LE(data, o); o += 4;
  const timestamp = readF64LE(data, o); o += 8;
  const hopCount = data[o]; o += 1;
  const contentType = data[o]; o += 1;
  const frontierCount = data[o];
  const frontierLen = 1 + frontierCount * 5;
  const frontier = data.subarray(o, o + frontierLen); o += frontierLen;
  const ciphertext = data.subarray(o);
  return { msgId, senderId, seq, epochId, timestamp, hopCount, contentType, frontier, ciphertext };
}

export interface ParsedJoinAnnounce { peerId: Uint8Array; name: string }
export function parseJoinAnnounce(data: Uint8Array): ParsedJoinAnnounce {
  return {
    peerId: data.subarray(0, PEER_ID_LEN),
    name: TD.decode(data.subarray(PEER_ID_LEN)),
  };
}

export interface ParsedLeaveAnnounce { peerId: Uint8Array }
export function parseLeaveAnnounce(data: Uint8Array): ParsedLeaveAnnounce {
  return { peerId: data.subarray(0, PEER_ID_LEN) };
}

export interface ParsedSdpRelay { targetPeerId: Uint8Array; originPeerId: Uint8Array; sdpType: number; sdpCode: string }
export function parseSdpRelay(data: Uint8Array): ParsedSdpRelay {
  return {
    targetPeerId: data.subarray(0, PEER_ID_LEN),
    originPeerId: data.subarray(PEER_ID_LEN, PEER_ID_LEN * 2),
    sdpType: data[PEER_ID_LEN * 2],
    sdpCode: TD.decode(data.subarray(PEER_ID_LEN * 2 + 1)),
  };
}

export interface ParsedPeerList { peers: Array<{ peerId: Uint8Array; name: string }> }
export function parsePeerList(data: Uint8Array): ParsedPeerList {
  const count = readU16LE(data, 0);
  const peers: Array<{ peerId: Uint8Array; name: string }> = [];
  let o = 2;
  for (let i = 0; i < count; i++) {
    const peerId = data.subarray(o, o + PEER_ID_LEN); o += PEER_ID_LEN;
    const nameLen = data[o]; o += 1;
    const name = TD.decode(data.subarray(o, o + nameLen)); o += nameLen;
    peers.push({ peerId, name });
  }
  return { peers };
}

export interface ParsedDmSdpRelay {
  targetPeerId: Uint8Array;
  originPeerId: Uint8Array;
  sdpType: number;
  sdpCode: string;
}

export function parseDmSdpRelay(data: Uint8Array): ParsedDmSdpRelay {
  return {
    targetPeerId: data.subarray(0, PEER_ID_LEN),
    originPeerId: data.subarray(PEER_ID_LEN, PEER_ID_LEN * 2),
    sdpType: data[PEER_ID_LEN * 2],
    sdpCode: TD.decode(data.subarray(PEER_ID_LEN * 2 + 1)),
  };
}

export interface ParsedRingWant {
  originPeerId: Uint8Array;
  targetPeerId: Uint8Array;
  fromSeq: number;
  toSeq: number;
}

export function parseRingWant(data: Uint8Array): ParsedRingWant {
  return {
    originPeerId: data.subarray(0, PEER_ID_LEN),
    targetPeerId: data.subarray(PEER_ID_LEN, PEER_ID_LEN * 2),
    fromSeq: readU32LE(data, PEER_ID_LEN * 2),
    toSeq: readU32LE(data, PEER_ID_LEN * 2 + 4),
  };
}

export interface ParsedCfReact {
  /** Full 32-byte SHA-256 of the target message — used for gossip re-broadcast. */
  targetMsgIdFull: Uint8Array;
  senderId: Uint8Array;
  hopCount: number;
  /** Free-form Unicode emoji string. */
  emoji: string;
}

/** Parse a CF_REACT or CF_UNREACT payload (data is AFTER the subtype byte). */
export function parseCfReact(data: Uint8Array): ParsedCfReact | null {
  if (data.length < MSG_ID_LEN + PEER_ID_LEN + 2) return null; // min: 32 + 16 + 1 (hop) + 1 (emoji)
  let o = 0;
  const targetMsgIdFull = data.subarray(o, o + MSG_ID_LEN); o += MSG_ID_LEN;
  const senderId = data.subarray(o, o + PEER_ID_LEN); o += PEER_ID_LEN;
  const hopCount = data[o]; o += 1;
  const emojiBytes = data.subarray(o);
  // Guard: cap emoji bytes, then normalise to first grapheme cluster
  if (emojiBytes.length === 0 || emojiBytes.length > 32) return null;
  const raw = TD.decode(emojiBytes);
  const first = new Intl.Segmenter().segment(raw)[Symbol.iterator]().next().value;
  if (!first?.segment) return null;
  return { targetMsgIdFull, senderId, hopCount, emoji: first.segment };
}

export interface ParsedBraidFold {
  newEpochId: number; reason: number; subjectPeerId: Uint8Array;
  entropy: Uint8Array; rosterDigest: Uint8Array;
}
export function parseBraidFold(data: Uint8Array): ParsedBraidFold {
  let o = 0;
  const newEpochId = readU32LE(data, o); o += 4;
  const reason = data[o]; o += 1;
  const subjectPeerId = data.subarray(o, o + PEER_ID_LEN); o += PEER_ID_LEN;
  const entropy = data.subarray(o, o + 32); o += 32;
  const rosterDigest = data.subarray(o, o + 32); o += 32;
  return { newEpochId, reason, subjectPeerId, entropy, rosterDigest };
}

export interface ParsedBraidWelcome {
  epochId: number; senderPeerId: Uint8Array; root: Uint8Array; roster: Uint8Array[];
}
export function parseBraidWelcome(data: Uint8Array): ParsedBraidWelcome {
  let o = 0;
  const epochId = readU32LE(data, o); o += 4;
  const senderPeerId = data.subarray(o, o + PEER_ID_LEN); o += PEER_ID_LEN;
  const root = data.subarray(o, o + 32); o += 32;
  const count = data[o]; o += 1;
  const roster: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    roster.push(data.subarray(o, o + PEER_ID_LEN));
    o += PEER_ID_LEN;
  }
  return { epochId, senderPeerId, root, roster };
}

export interface ParsedJoinReq { joinerId: Uint8Array; name: string }
export function parseJoinReq(data: Uint8Array): ParsedJoinReq {
  return {
    joinerId: data.subarray(0, PEER_ID_LEN),
    name: TD.decode(data.subarray(PEER_ID_LEN)),
  };
}
