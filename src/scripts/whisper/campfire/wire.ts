/**
 * Campfire — wire protocol message builders/parsers.
 *
 * All campfire messages are carried inside the existing 0x20 encrypted
 * message type. The flags byte has bit1 (0x02) set to indicate campfire
 * content. The decrypted plaintext starts with a campfire sub-type byte
 * (0x50–0x5A), followed by sub-type-specific payload.
 */

import { TE, TD, aesGcmEncrypt, aesGcmDecrypt } from "../live-crypto";
import { concatBytes, randomBytes } from "../wasm";
import {
  CF_ROOT_HEARTBEAT,
  CF_GROUP_MSG,
  CF_JOIN_ANNOUNCE,
  CF_LEAVE_ANNOUNCE,
  CF_TOPOLOGY_ASSIGN,
  CF_SDP_RELAY,
  CF_GROUP_KEY,
  CF_PEER_LIST,
  CF_DM_SDP_RELAY,
  CF_SUB_INVITE,
  CF_SUB_SDP,
  PEER_ID_LEN,
  GROUP_KEY_LEN,
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

/** 0x50 ROOT_HEARTBEAT: [epoch 4B][peerCount 2B][rootPeerId 16B] */
export function buildRootHeartbeat(epoch: number, peerCount: number, rootPeerId: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([CF_ROOT_HEARTBEAT]), u32LE(epoch), u16LE(peerCount), rootPeerId);
}

/**
 * 0x51 GROUP_MSG: [msgId 32B][senderId 16B][senderNameLen 1B][name][timestamp 8B]
 *                 [hopCount 1B][epoch 4B][nonce 12B][contentType 1B][ciphertext...]
 *
 * Content is encrypted with the group key (AES-256-GCM).
 */
export async function buildGroupMsg(
  msgId: Uint8Array, senderId: Uint8Array, senderName: string,
  timestamp: number, hopCount: number, epoch: number,
  contentType: number, plaintext: Uint8Array, groupKey: Uint8Array,
): Promise<Uint8Array> {
  const nameBytes = TE.encode(senderName);
  const nonce = randomBytes(12);
  const ciphertext = await aesGcmEncrypt(groupKey, plaintext, nonce);
  return concatBytes(
    new Uint8Array([CF_GROUP_MSG]),
    msgId, senderId,
    new Uint8Array([nameBytes.length]), nameBytes,
    f64LE(timestamp),
    new Uint8Array([hopCount]),
    u32LE(epoch),
    nonce,
    new Uint8Array([contentType]),
    ciphertext,
  );
}

/** Re-wrap a GROUP_MSG for forwarding — increment hop count but keep the encrypted payload intact. */
export function rewrapGroupMsg(raw: Uint8Array, newHopCount: number): Uint8Array {
  // raw starts at sub-type byte 0x51
  // [0] subtype | [1..32] msgId | [33..48] senderId | [49] nameLen | [50..50+nameLen-1] name
  // [50+nameLen..57+nameLen] timestamp | [58+nameLen] hopCount | ...
  const nameLen = raw[49];
  const hopOffset = 50 + nameLen + 8; // after timestamp
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

/** 0x54 TOPOLOGY_ASSIGN: [neighborCount 1B][...peerId 16B each] */
export function buildTopologyAssign(neighborPeerIds: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([CF_TOPOLOGY_ASSIGN]), new Uint8Array([neighborPeerIds.length])];
  for (const id of neighborPeerIds) parts.push(id);
  return concatBytes(...parts);
}

/** 0x55 SDP_RELAY: [targetPeerId 16B][sdpType 1B][sdpCode...] */
export function buildSdpRelay(targetPeerId: Uint8Array, sdpType: number, sdpCode: string): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_SDP_RELAY]),
    targetPeerId,
    new Uint8Array([sdpType]),
    TE.encode(sdpCode),
  );
}

/** 0x56 GROUP_KEY: [epoch 4B][groupKey 32B] (content is pairwise-encrypted by the outer channel). */
export function buildGroupKey(epoch: number, groupKey: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([CF_GROUP_KEY]), u32LE(epoch), groupKey);
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

/** 0x58 DM_SDP_RELAY: [targetPeerId 16B][sdpType 1B][sdpCode...] */
export function buildDmSdpRelay(targetPeerId: Uint8Array, sdpType: number, sdpCode: string): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_DM_SDP_RELAY]),
    targetPeerId,
    new Uint8Array([sdpType]),
    TE.encode(sdpCode),
  );
}

/** 0x59 SUB_CAMPFIRE_INVITE: [subId 16B][inviterPeerId 16B][...inviteePeerIds 16B each] */
export function buildSubInvite(subId: Uint8Array, inviterPeerId: Uint8Array, invitees: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([CF_SUB_INVITE]), subId, inviterPeerId];
  for (const id of invitees) parts.push(id);
  return concatBytes(...parts);
}

/** 0x5A SUB_CAMPFIRE_SDP: [subId 16B][targetPeerId 16B][sdpType 1B][sdpCode...] */
export function buildSubSdp(subId: Uint8Array, targetPeerId: Uint8Array, sdpType: number, sdpCode: string): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_SUB_SDP]),
    subId, targetPeerId,
    new Uint8Array([sdpType]),
    TE.encode(sdpCode),
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Parsers
   ═══════════════════════════════════════════════════════════════════ */

export interface ParsedRootHeartbeat { epoch: number; peerCount: number; rootPeerId: Uint8Array }
export function parseRootHeartbeat(data: Uint8Array): ParsedRootHeartbeat {
  // data starts AFTER the sub-type byte
  return {
    epoch: readU32LE(data, 0),
    peerCount: readU16LE(data, 4),
    rootPeerId: data.subarray(6, 6 + PEER_ID_LEN),
  };
}

export interface ParsedGroupMsg {
  msgId: Uint8Array; senderId: Uint8Array; senderName: string;
  timestamp: number; hopCount: number; epoch: number;
  nonce: Uint8Array; contentType: number; ciphertext: Uint8Array;
}
export function parseGroupMsgHeader(data: Uint8Array): ParsedGroupMsg {
  let o = 0;
  const msgId = data.subarray(o, o + MSG_ID_LEN); o += MSG_ID_LEN;
  const senderId = data.subarray(o, o + PEER_ID_LEN); o += PEER_ID_LEN;
  const nameLen = data[o]; o += 1;
  const senderName = TD.decode(data.subarray(o, o + nameLen)); o += nameLen;
  const timestamp = readF64LE(data, o); o += 8;
  const hopCount = data[o]; o += 1;
  const epoch = readU32LE(data, o); o += 4;
  const nonce = data.subarray(o, o + 12); o += 12;
  const contentType = data[o]; o += 1;
  const ciphertext = data.subarray(o);
  return { msgId, senderId, senderName, timestamp, hopCount, epoch, nonce, contentType, ciphertext };
}

/** Decrypt a GROUP_MSG ciphertext with a group key. */
export async function decryptGroupMsg(
  ciphertext: Uint8Array, nonce: Uint8Array, groupKey: Uint8Array,
): Promise<Uint8Array> {
  return aesGcmDecrypt(groupKey, ciphertext, nonce);
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

export interface ParsedTopologyAssign { neighborPeerIds: Uint8Array[] }
export function parseTopologyAssign(data: Uint8Array): ParsedTopologyAssign {
  const count = data[0];
  const ids: Uint8Array[] = [];
  let o = 1;
  for (let i = 0; i < count; i++) {
    ids.push(data.subarray(o, o + PEER_ID_LEN));
    o += PEER_ID_LEN;
  }
  return { neighborPeerIds: ids };
}

export interface ParsedSdpRelay { targetPeerId: Uint8Array; sdpType: number; sdpCode: string }
export function parseSdpRelay(data: Uint8Array): ParsedSdpRelay {
  return {
    targetPeerId: data.subarray(0, PEER_ID_LEN),
    sdpType: data[PEER_ID_LEN],
    sdpCode: TD.decode(data.subarray(PEER_ID_LEN + 1)),
  };
}

export interface ParsedGroupKey { epoch: number; groupKey: Uint8Array }
export function parseGroupKey(data: Uint8Array): ParsedGroupKey {
  return {
    epoch: readU32LE(data, 0),
    groupKey: data.subarray(4, 4 + GROUP_KEY_LEN),
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

export function parseDmSdpRelay(data: Uint8Array): ParsedSdpRelay {
  return parseSdpRelay(data); // same format
}

export interface ParsedSubInvite { subId: Uint8Array; inviterPeerId: Uint8Array; invitees: Uint8Array[] }
export function parseSubInvite(data: Uint8Array): ParsedSubInvite {
  const subId = data.subarray(0, PEER_ID_LEN);
  const inviterPeerId = data.subarray(PEER_ID_LEN, PEER_ID_LEN * 2);
  const invitees: Uint8Array[] = [];
  let o = PEER_ID_LEN * 2;
  while (o + PEER_ID_LEN <= data.length) {
    invitees.push(data.subarray(o, o + PEER_ID_LEN));
    o += PEER_ID_LEN;
  }
  return { subId, inviterPeerId, invitees };
}

export interface ParsedSubSdp { subId: Uint8Array; targetPeerId: Uint8Array; sdpType: number; sdpCode: string }
export function parseSubSdp(data: Uint8Array): ParsedSubSdp {
  return {
    subId: data.subarray(0, PEER_ID_LEN),
    targetPeerId: data.subarray(PEER_ID_LEN, PEER_ID_LEN * 2),
    sdpType: data[PEER_ID_LEN * 2],
    sdpCode: TD.decode(data.subarray(PEER_ID_LEN * 2 + 1)),
  };
}
