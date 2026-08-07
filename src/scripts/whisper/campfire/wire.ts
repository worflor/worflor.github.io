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
import { PUBKEY_LEN, SIGNATURE_LEN } from "./identity";
import { Cursor } from "./cursor";
import { BRAID_CONFIRM_LEN } from "../live-braid";
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
/** The bytes a group message commits to. Deliberately excludes hopCount, which
 *  every relay rewrites (see rewrapGroupMsg), and msgId, which is a pure
 *  function of fields already covered. Includes the author's public key so a
 *  frame cannot keep a valid signature while presenting a different key. */
export function groupMsgSigningBody(
  senderId: Uint8Array, seq: number, epochId: number, timestamp: number,
  contentType: number, confirm: Uint8Array, frontier: Uint8Array, ciphertext: Uint8Array,
  authorPublicKey: Uint8Array,
): Uint8Array {
  return concatBytes(
    senderId, u32LE(seq), u32LE(epochId), f64LE(timestamp),
    new Uint8Array([contentType]), confirm, frontier, ciphertext, authorPublicKey,
  );
}

export function buildGroupMsg(
  msgId: Uint8Array, senderId: Uint8Array, seq: number, epochId: number,
  timestamp: number, hopCount: number, contentType: number,
  confirm: Uint8Array, frontier: Uint8Array, ciphertext: Uint8Array,
  authorPublicKey: Uint8Array, signature: Uint8Array,
): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_GROUP_MSG]),
    msgId, senderId,
    u32LE(seq),
    u32LE(epochId),
    f64LE(timestamp),
    new Uint8Array([hopCount, contentType]),
    authorPublicKey, signature,
    confirm,
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
/** A seat announces its AGREEMENT key alongside its id. Fold entropy is sealed
 *  to that key per recipient, so a seat whose key nobody knows cannot be folded
 *  with. It is safe to carry unauthenticated here: the seal binds to the key,
 *  and a wrong key simply means the recipient cannot open its copy — it cannot
 *  make someone else's copy readable. */
export function buildJoinAnnounce(
  peerId: Uint8Array, agreementKey: Uint8Array, name: string,
): Uint8Array {
  return concatBytes(new Uint8Array([CF_JOIN_ANNOUNCE]), peerId, agreementKey, TE.encode(name));
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
export function buildPeerList(
  peers: Array<{ peerId: Uint8Array; agreementKey: Uint8Array; name: string }>,
): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([CF_PEER_LIST]), u16LE(peers.length)];
  for (const p of peers) {
    const nameBytes = TE.encode(p.name);
    parts.push(p.peerId, p.agreementKey, new Uint8Array([nameBytes.length]), nameBytes);
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
/** A sequence number only means something INSIDE an epoch: every fold restarts
 *  each seat's strand at 1. A repair request without an epoch therefore names an
 *  ambiguous position, and can be answered with a frame from a previous epoch. */
export function buildRingWant(
  originPeerId: Uint8Array, targetPeerId: Uint8Array, epochId: number, fromSeq: number, toSeq: number,
): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_RING_WANT]),
    originPeerId,
    targetPeerId,
    u32LE(epochId),
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
  recipients: Uint8Array, rosterDigest: Uint8Array,
  authorPublicKey: Uint8Array, newAgreementKey: Uint8Array, signature: Uint8Array,
): Uint8Array {
  return concatBytes(
    new Uint8Array([CF_BRAID_FOLD]),
    braidFoldSigningBody(
      newEpochId, reason, subjectPeerId, recipients, rosterDigest, authorPublicKey, newAgreementKey,
    ),
    signature,
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
/** `attempt` distinguishes retries. Gossip dedups by payload hash, so without it
 *  a re-sent request is byte-identical to the first and is dropped everywhere as
 *  already-seen — which makes retrying structurally impossible, not merely
 *  ineffective. A joiner whose elder departed mid-admission depends on this. */
/** one recipient's copy of the fold entropy: who it is for, then the seal
 *  ([ephemeral pubkey 33][ciphertext+tag 48]). */
export const SEALED_ENTROPY_LEN = PUBKEY_LEN + 48;
export const FOLD_RECIPIENT_LEN = PEER_ID_LEN + SEALED_ENTROPY_LEN;

/** the bytes an epoch fold commits to: everything except the signature itself.
 *  the author's public key is inside the signed region, so a frame cannot keep a
 *  valid signature while swapping in a different key. */
export function braidFoldSigningBody(
  newEpochId: number, reason: number, subjectPeerId: Uint8Array,
  recipients: Uint8Array, rosterDigest: Uint8Array, authorPublicKey: Uint8Array,
  newAgreementKey: Uint8Array,
): Uint8Array {
  // the recipient COUNT is inside the signed region: a relay must not be able to
  // drop a member's sealed copy and leave the signature intact, which would
  // silently exclude that seat from the epoch.
  return concatBytes(
    u32LE(newEpochId), new Uint8Array([reason]), subjectPeerId,
    new Uint8Array([recipients.length / FOLD_RECIPIENT_LEN]), recipients,
    rosterDigest, authorPublicKey, newAgreementKey,
  );
}

export function buildJoinReq(joinerId: Uint8Array, name: string, attempt = 0): Uint8Array {
  return concatBytes(new Uint8Array([CF_JOIN_REQ]), joinerId, u32LE(attempt), TE.encode(name));
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
  authorPublicKey: Uint8Array; signature: Uint8Array;
  /** keyed tag over the sender's transcript commitment at `frontier`. */
  confirm: Uint8Array;
  frontier: Uint8Array; ciphertext: Uint8Array;
}
/** fixed prefix before the variable-length frontier:
 *  msgId 32 + senderId 16 + seq 4 + epochId 4 + timestamp 8 + hop 1 + type 1
 *  + authorPublicKey 33 + signature 64 */
export const GROUP_MSG_PREFIX =
  MSG_ID_LEN + PEER_ID_LEN + 4 + 4 + 8 + 1 + 1 + PUBKEY_LEN + SIGNATURE_LEN + BRAID_CONFIRM_LEN;

/**
 * Returns null on any frame that does not actually contain what it claims.
 *
 * These bytes arrive from a RELAY, before any signature or tag is checked, so
 * every length here is attacker-chosen. Reading a field without first proving
 * it is present threw a RangeError out of the parser on a short frame — and
 * nothing upstream catches it, so a truncated frame from any relay became an
 * unhandled rejection in the receiving node. Believing the frontier count
 * without checking the bytes exist was the same mistake one field along: it
 * silently produced a short signature and handed the whole frame back as
 * ciphertext.
 */
export function parseGroupMsgHeader(data: Uint8Array): ParsedGroupMsg | null {
  const c = new Cursor(data);
  const msgId = c.bytes(MSG_ID_LEN);
  const senderId = c.bytes(PEER_ID_LEN);
  const seq = c.u32();
  const epochId = c.u32();
  const timestamp = c.f64();
  const hopCount = c.u8();
  const contentType = c.u8();
  const authorPublicKey = c.bytes(PUBKEY_LEN);
  const signature = c.bytes(SIGNATURE_LEN);
  const confirm = c.bytes(BRAID_CONFIRM_LEN);
  // the frontier has a DEPENDENT length: its width is a function of a value
  // read from the frame itself. the count is consumed first and only then
  // honoured, so a lie about it fails the cursor instead of reading past the end.
  const frontierCount = c.u8();
  const frontier = concatBytes(new Uint8Array([frontierCount]), c.bytes(frontierCount * 5));
  // AES-GCM output is plaintext plus a 16-byte tag, so a shorter remainder
  // cannot be a ciphertext whatever the rest of the frame claims.
  c.expect(16);
  const ciphertext = c.rest();
  return c.finish({
    msgId, senderId, seq, epochId, timestamp, hopCount, contentType,
    authorPublicKey, signature, confirm, frontier, ciphertext,
  });
}

export interface ParsedJoinAnnounce { peerId: Uint8Array; agreementKey: Uint8Array; name: string }
export function parseJoinAnnounce(data: Uint8Array): ParsedJoinAnnounce | null {
  const c = new Cursor(data);
  const peerId = c.bytes(PEER_ID_LEN);
  const agreementKey = c.bytes(PUBKEY_LEN);
  return c.finish({ peerId, agreementKey, name: TD.decode(c.rest()) });
}

export interface ParsedLeaveAnnounce { peerId: Uint8Array }
export function parseLeaveAnnounce(data: Uint8Array): ParsedLeaveAnnounce | null {
  const c = new Cursor(data);
  return c.finish({ peerId: c.bytes(PEER_ID_LEN) });
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

export interface ParsedPeerList { peers: Array<{ peerId: Uint8Array; agreementKey: Uint8Array; name: string }> }
export function parsePeerList(data: Uint8Array): ParsedPeerList | null {
  const c = new Cursor(data);
  const count = c.u16();
  const peers: Array<{ peerId: Uint8Array; agreementKey: Uint8Array; name: string }> = [];
  // the count is a 16-bit attacker-chosen field, and it is not trusted: it only
  // says how many times to ask. each ask fails the cursor when the bytes are not
  // there, so a 3-byte frame claiming 65535 entries just yields null.
  for (let i = 0; i < count && c.ok; i++) {
    const peerId = c.bytes(PEER_ID_LEN);
    const agreementKey = c.bytes(PUBKEY_LEN);
    const name = TD.decode(c.bytes(c.u8()));
    peers.push({ peerId, agreementKey, name });
  }
  return c.finish({ peers });
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
  epochId: number;
  fromSeq: number;
  toSeq: number;
}

export function parseRingWant(data: Uint8Array): ParsedRingWant | null {
  const c = new Cursor(data);
  const originPeerId = c.bytes(PEER_ID_LEN);
  const targetPeerId = c.bytes(PEER_ID_LEN);
  const epochId = c.u32();
  const fromSeq = c.u32();
  const toSeq = c.u32();
  return c.finish({ originPeerId, targetPeerId, epochId, fromSeq, toSeq });
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
  /** concatenated [peerId 16][sealed 81], one entry per member of the new roster. */
  recipients: Uint8Array; rosterDigest: Uint8Array;
  authorPublicKey: Uint8Array;
  /** on an UPDATE fold, the author's replacement agreement key. */
  newAgreementKey: Uint8Array;
  signature: Uint8Array;
  /** exact bytes the signature covers, so verification never re-serializes. */
  signingBody: Uint8Array;
}
/** the fold is now variable-length: a recipient list sits between the fixed
 *  prefix and the fixed suffix. */
export const BRAID_FOLD_PREFIX = 4 + 1 + PEER_ID_LEN + 1;
export const BRAID_FOLD_SUFFIX = 32 + PUBKEY_LEN + PUBKEY_LEN + SIGNATURE_LEN;

export function parseBraidFold(data: Uint8Array): ParsedBraidFold | null {
  const c = new Cursor(data);
  const newEpochId = c.u32();
  const reason = c.u8();
  const subjectPeerId = c.bytes(PEER_ID_LEN);
  const count = c.u8();
  const recipients = c.bytes(count * FOLD_RECIPIENT_LEN);
  const rosterDigest = c.bytes(32);
  const authorPublicKey = c.bytes(PUBKEY_LEN);
  // an UPDATE fold rotates the author's agreement key; other reasons carry zeros
  const newAgreementKey = c.bytes(PUBKEY_LEN);
  // the signed region is everything before the signature
  const signingBody = data.subarray(0, Math.max(0, data.length - SIGNATURE_LEN));
  const signature = c.bytes(SIGNATURE_LEN);
  c.expectEnd(); // trailing bytes mean a malformed frame, not a longer one
  return c.finish({
    newEpochId, reason, subjectPeerId, recipients, rosterDigest,
    authorPublicKey, newAgreementKey, signature, signingBody,
  });
}

/** the sealed copy addressed to `peerIdHex`, or null when this fold is not ours. */
export function foldRecipientFor(recipients: Uint8Array, peerIdHex: string): Uint8Array | null {
  for (let o = 0; o + FOLD_RECIPIENT_LEN <= recipients.length; o += FOLD_RECIPIENT_LEN) {
    let match = true;
    for (let i = 0; i < PEER_ID_LEN; i++) {
      if (recipients[o + i] !== parseInt(peerIdHex.slice(i * 2, i * 2 + 2), 16)) { match = false; break; }
    }
    if (match) return recipients.subarray(o + PEER_ID_LEN, o + FOLD_RECIPIENT_LEN);
  }
  return null;
}

export interface ParsedBraidWelcome {
  epochId: number; senderPeerId: Uint8Array; root: Uint8Array; roster: Uint8Array[];
}
export function parseBraidWelcome(data: Uint8Array): ParsedBraidWelcome | null {
  const c = new Cursor(data);
  const epochId = c.u32();
  const senderPeerId = c.bytes(PEER_ID_LEN);
  const root = c.bytes(32);
  const count = c.u8();
  const roster: Uint8Array[] = [];
  for (let i = 0; i < count; i++) roster.push(c.bytes(PEER_ID_LEN));
  return c.finish({ epochId, senderPeerId, root, roster });
}

export interface ParsedJoinReq { joinerId: Uint8Array; attempt: number; name: string }
export function parseJoinReq(data: Uint8Array): ParsedJoinReq | null {
  const c = new Cursor(data);
  const joinerId = c.bytes(PEER_ID_LEN);
  const attempt = c.u32();
  return c.finish({ joinerId, attempt, name: TD.decode(c.rest()) });
}
