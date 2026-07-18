/**
 * Campfire: gossip-propagated group chat engine.
 *
 * CampfireNode manages the campfire lifecycle over the braid crypto core
 * (../live-braid.ts): every seat folds a shared epoch root and derives its
 * own send chain from it, so there is no key distribution and no rotation
 * ceremony. The neighbor graph is a pure function of the roster
 * (./topology.ts) — "root" survives only as the genesis host and, while it
 * holds seat zero, the single fold-writer (the elder). The circle persists
 * as long as any seat remains; there is no root-authority kill switch.
 *
 * Every pairwise link is a WhisperLiveSession under the hood (or a fake
 * satisfying CampfireSessionLike, for tests), using the campfire flag
 * (0x02) in the message header to distinguish campfire payloads.
 */

import {
  WhisperLiveSession,
  WHISPER_LIVE_RTC_LOCAL_ONLY,
  WHISPER_LIVE_RTC_PUBLIC_STUN,
  type WhisperLiveCallbacks,
} from "../live";

import { TE, constantTimeEqual } from "../live-crypto";
import { randomBytes, sha256, concatBytes, toHex } from "../wasm";

import {
  braidFold,
  braidInit,
  braidSeal,
  braidOpen,
  braidWants,
  braidWipe,
  type BraidMessage,
} from "../live-braid";

import {
  sortRoster,
  computeTopology,
  neighborsOf,
  edgeOfferer,
} from "./topology";

import {
  type CampfireState,
  type CampfireRole,
  type CampfireCallbacks,
  type CampfirePeer,
  type BraidEpoch,
  type CampfireSessionLike,
  type CampfireSessionFactory,
  ContentType,
  CAMPFIRE_FLAG,
  PEER_ID_LEN,
  KEY_GRACE_PERIOD,
  DEDUP_RING_SIZE,
  MAX_HOP_COUNT,
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
} from "./types";

import {
  buildGroupMsg,
  rewrapGroupMsg,
  buildPeerList,
  buildJoinAnnounce,
  buildLeaveAnnounce,
  buildSdpRelay,
  buildDmSdpRelay,
  buildRingWant,
  buildCfReact,
  buildBraidFold,
  buildBraidWelcome,
  buildJoinReq,
  buildEdgeRelease,
  parseGroupMsgHeader,
  parseJoinAnnounce,
  parseLeaveAnnounce,
  parseSdpRelay,
  parsePeerList,
  parseDmSdpRelay,
  parseRingWant,
  parseCfReact,
  parseBraidFold,
  parseBraidWelcome,
  parseJoinReq,
  type ParsedBraidFold,
} from "./wire";

/* ═══════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════ */

/** SDP type codes used in relay messages. */
const SDP_OFFER = 0x01;
const SDP_ANSWER = 0x02;

const RING_REPAIR_INTERVAL = 12_000;

const BEACON_CHECK_INTERVAL = 5_000;
const BEACON_MSG_THRESHOLD = 24;
const BEACON_IDLE_MS = 10_000;

const PENDING_META_CAP = 512;

const FOLD_REASON_JOIN = 1;
const FOLD_REASON_LEAVE = 2;

/** default session factory: the real WebRTC-backed transport. */
const defaultSessionFactory: CampfireSessionFactory = (callbacks, opts) =>
  new WhisperLiveSession(callbacks, opts);

/* ═══════════════════════════════════════════════════════════════════
   Local helpers
   ═══════════════════════════════════════════════════════════════════ */

function le32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xFF;
  b[1] = (n >>> 8) & 0xFF;
  b[2] = (n >>> 16) & 0xFF;
  b[3] = (n >>> 24) & 0xFF;
  return b;
}

/** decode a lowercase hex seat id back into its raw bytes. seat ids are the
 *  hex strings themselves (see live-braid.ts normalizeRoster), so this is a
 *  pure, network-independent inverse of toHex — no allPeers lookup needed. */
function hexDecode(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ═══════════════════════════════════════════════════════════════════
   CampfireNode
   ═══════════════════════════════════════════════════════════════════ */

export class CampfireNode {
  private _state: CampfireState = "idle";
  private role: CampfireRole = "peer";
  private peerId: Uint8Array = new Uint8Array(0);
  private peerIdHex = "";
  private displayName = "";

  // Braid epoch state — replaces the old root-distributed symmetric group key.
  private currentEpoch: BraidEpoch | null = null;
  private previousEpoch: { epoch: BraidEpoch; expiresAt: number } | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  // Neighbor sessions (pairwise WebRTC links)
  private neighbors = new Map<string, CampfirePeer>();

  // Full peer list (all campfire members, not just neighbors)
  private allPeers = new Map<string, { peerId: Uint8Array; name: string }>();

  // Root-only bootstrap slot state (root remains the sole admission entry point)
  private rootSlotCounter = 0;

  // Peer-only bootstrap state
  private bootstrapSession: CampfireSessionLike | null = null;

  // Admissions: joinerHex -> the direct link that admitted them, awaiting a fold to welcome over.
  private pendingAdmissions = new Map<string, { label: string; session: CampfireSessionLike }>();

  // Epoch mutations (fold issue, fold apply, welcome adoption) run through one
  // promise chain: interleaved awaits must never mint two folds for the same
  // epoch id or apply folds against a half-rotated state.
  private epochQueue: Promise<unknown> = Promise.resolve();
  // Folds that arrived ahead of order (or before we were seated), keyed by
  // their target epoch id, waiting for the chain to catch up.
  private pendingFolds = new Map<number, ParsedBraidFold>();
  // Joiners we've already kicked off admission for (issued a fold, or relayed a JOIN_REQ),
  // guarding against redundant work while gossip settles — cleared once the fold lands.
  private pendingJoinReqs = new Set<string>();

  // Gossip dedup (shared ring: GROUP_MSG msgIds, BRAID_FOLD/RING_WANT/SDP content hashes)
  private seenMsgIds: string[] = [];
  private seenMsgSet = new Set<string>();
  // React dedup — key: "{senderHex}:{react|unreact}:{targetMsgIdHex}:{emoji}"
  private seenReacts = new Set<string>();

  // Ring/repair state
  private recentBySeq = new Map<string, Uint8Array>();
  private repairTimer: ReturnType<typeof setInterval> | null = null;

  // Auto-beacon state
  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  private receivedSinceOwnSend = 0;
  private lastOwnSendAt = 0;

  // Display metadata for delivered braid messages, keyed `${epochId}:${senderIdx}:${seq}`.
  private pendingMeta = new Map<string, { msgId: Uint8Array; timestamp: number; hopCount: number; contentType: number }>();

  // DM side-channels
  private dmSessions = new Map<string, CampfireSessionLike>();
  private pendingDmSdp = new Map<string, { session: CampfireSessionLike; isOfferer: boolean }>();

  // Mesh SDP handshakes
  private pendingMeshSdp = new Map<string, { session: CampfireSessionLike; isOfferer: boolean }>();

  // RTC config
  private useStun = false;

  // Callbacks + transport injection
  private cb: CampfireCallbacks;
  private sessionFactory: CampfireSessionFactory;

  constructor(callbacks: CampfireCallbacks, options?: { sessionFactory?: CampfireSessionFactory }) {
    this.cb = callbacks;
    this.sessionFactory = options?.sessionFactory ?? defaultSessionFactory;
  }

  get state(): CampfireState { return this._state; }

  private setState(state: CampfireState, detail?: string): void {
    this._state = state;
    if (state === "active") this.startActiveLoops();
    this.cb.onStateChange(state, detail);
  }

  private log(line: string): void {
    this.cb.onLog(line);
  }

  private get rtcConfig(): RTCConfiguration {
    return this.useStun ? WHISPER_LIVE_RTC_PUBLIC_STUN : WHISPER_LIVE_RTC_LOCAL_ONLY;
  }

  private startActiveLoops(): void {
    this.startRingRepair();
    this.startBeacon();
  }

  /** elder rule: the single fold-writer for the current epoch is roster[0].
   *  `excludingHex`, when given, evaluates elder-ness against the roster
   *  with that seat already removed (used when the leaver IS the elder). */
  private isElderFor(excludingHex?: string): boolean {
    if (!this.currentEpoch) return false;
    const roster = excludingHex
      ? this.currentEpoch.roster.filter((h) => h !== excludingHex)
      : this.currentEpoch.roster;
    return roster.length > 0 && roster[0] === this.peerIdHex;
  }

  private isElder(): boolean {
    return this.isElderFor();
  }

  /* ── Campfire Creation (Root) ──────────────────────────── */

  async createCampfire(name: string, useStun = false): Promise<string> {
    this.useStun = useStun;
    this.role = "root";
    this.peerId = randomBytes(PEER_ID_LEN);
    this.peerIdHex = toHex(this.peerId);
    this.displayName = name;
    this.setState("creating");
    this.log("creating room...");

    // genesis: fold seat zero into existence and seat ourselves in epoch 1.
    const entropy = randomBytes(32);
    const roster = [this.peerIdHex];
    const root = await braidFold(null, entropy, 1, roster);
    entropy.fill(0);
    const braid = await braidInit(root, 1, roster, this.peerIdHex);
    this.currentEpoch = { epochId: 1, roster, root, braid };
    this.lastOwnSendAt = Date.now();

    // Add self to peer list
    this.allPeers.set(this.peerIdHex, { peerId: this.peerId, name: this.displayName });

    // Create a session for the initial connection (host waits for first peer)
    const rootSession = this.createNeighborSession(this.nextRootSlotLabel());

    const offerCode = await rootSession.createOffer();
    this.setState("waiting");
    this.log("room ready, share the code");

    // Store pending session, will be assigned to joining peer
    this._pendingRootSession = rootSession;
    this._pendingRootOffer = offerCode;
    this.cb.onRoomCodeUpdate?.(offerCode);

    return offerCode;
  }

  private _pendingRootSession: CampfireSessionLike | null = null;
  private _pendingRootOffer: string | null = null;

  private nextRootSlotLabel(): string {
    const n = this.rootSlotCounter;
    this.rootSlotCounter += 1;
    return `root-slot-${n}`;
  }

  /** Root: apply answer from a joining peer. */
  async applyAnswer(answerCode: string): Promise<void> {
    if (!this._pendingRootSession) throw new Error("No pending session");
    await this._pendingRootSession.applyAnswer(answerCode);
  }

  /* ── Campfire Join (Peer) ──────────────────────────────── */

  async joinCampfire(offerCode: string, name: string, useStun = false): Promise<string> {
    this.useStun = useStun;
    this.role = "peer";
    this.peerId = randomBytes(PEER_ID_LEN);
    this.peerIdHex = toHex(this.peerId);
    this.displayName = name;
    this.allPeers.set(this.peerIdHex, { peerId: this.peerId, name: this.displayName });
    this.setState("connecting");
    this.log("joining room...");

    // Create session to Root — no epoch until a BRAID_WELCOME arrives.
    const session = this.createNeighborSession("join-root");
    const answerCode = await session.acceptOffer(offerCode);

    // Track bootstrap session for potential later release
    this.bootstrapSession = session;

    return answerCode;
  }

  /* ── Neighbor Session Factory ──────────────────────────── */

  private createNeighborSession(label: string): CampfireSessionLike {
    const callbacks: WhisperLiveCallbacks = {
      onStateChange: (state, detail) => {
        if (state === "error" && detail) this.log(detail);
        if (state === "live") {
          this.handleNeighborConnected(label, session);
        } else if (state === "disconnected" || state === "error") {
          this.handleNeighborDisconnected(label);
        }
      },
      onFingerprint: () => {},
      onMessage: () => {},
      onLog: () => {},
      onRawDecrypted: (plaintext) => this.handleCampfireMessage(plaintext, label),
    };

    const session = this.sessionFactory(callbacks, {
      rtcConfig: this.rtcConfig,
      autoConfirmFingerprint: true,
    });

    return session;
  }

  /* ── Neighbor Connected ────────────────────────────────── */

  private handleNeighborConnected(label: string, session: CampfireSessionLike): void {
    if (this.role === "root" && label.startsWith("root-slot-")) {
      // First (or Nth) peer joined the host's bootstrap slot. Their real
      // identity resolves once JOIN_ANNOUNCE arrives over this link.
      const tempId = new Uint8Array(PEER_ID_LEN);
      this.neighbors.set(label, {
        peerId: tempId,
        peerIdHex: "",
        name: "connecting...",
        session,
        connected: true,
        joinedAt: Date.now(),
      });

      this.sendPeerList(session);

      if (this._state !== "active") {
        this.setState("active");
      }

      // Prepare next incoming connection slot
      this.prepareNextRootSlot();
    } else if (this.role === "peer" && label === "join-root") {
      // Connected to the host — stay in "connecting" until BRAID_WELCOME arrives.
      // keyed by the session's own label so disconnect bookkeeping finds it.
      this.neighbors.set("join-root", {
        peerId: new Uint8Array(PEER_ID_LEN),
        peerIdHex: "",
        name: "host",
        session,
        connected: true,
        joinedAt: Date.now(),
      });

      void this.sendToNeighbor(session, buildJoinAnnounce(this.peerId, this.displayName));
    } else if (label.startsWith("mesh-")) {
      // Mesh neighbor connected — resolve full peer ID from label prefix.
      const prefix = label.slice(5); // strip "mesh-"
      let resolvedHex = "";
      let resolvedId = new Uint8Array(PEER_ID_LEN);
      let resolvedName = label;
      for (const [hex, info] of this.allPeers) {
        if (hex.startsWith(prefix)) {
          resolvedHex = hex;
          resolvedId = new Uint8Array(info.peerId);
          resolvedName = info.name;
          break;
        }
      }

      this.neighbors.set(label, {
        peerId: resolvedId,
        peerIdHex: resolvedHex,
        name: resolvedName,
        session,
        connected: true,
        joinedAt: Date.now(),
      });
      this.log(`mesh neighbor connected: ${resolvedName}`);

      // give the new edge a cross-check copy of our current epoch (step 7 of
      // the join flow) and let topology re-derive the bootstrap decision.
      void this.sendBraidWelcome(session);
      void this.applyTopology();
    } else {
      // Additional neighbor connected (unrecognized label, defensive fallback)
      this.neighbors.set(label, {
        peerId: new Uint8Array(PEER_ID_LEN),
        peerIdHex: label,
        name: label,
        session,
        connected: true,
        joinedAt: Date.now(),
      });
      this.log("new neighbor connected");
    }
  }

  private handleNeighborDisconnected(label: string): void {
    const neighbor = this.neighbors.get(label);
    if (!neighbor) return;
    neighbor.connected = false;
    this.neighbors.delete(label);
    this.log("neighbor disconnected");

    // an announced release closes the edge without anyone leaving. the two
    // ends of an edge can be an epoch apart when topology reconciliation
    // drops it, so the peer's word beats our possibly stale roster math.
    if (neighbor.released) return;

    // a joiner that loses its bootstrap before being seated has nothing left.
    if (!this.currentEpoch) {
      if (this.neighbors.size === 0 && this._state !== "ended" && this._state !== "idle") {
        void this.endCampfire("the host slipped away before you were seated. nothing remains.");
      }
      return;
    }

    // a dropped link only means departure when it was a real topology edge.
    // bootstrap links get released intentionally once the mesh forms, and
    // that release says nothing about the peer's presence in the circle.
    if (!neighbor.peerIdHex || !this.allPeers.has(neighbor.peerIdHex)) return;
    const topo = computeTopology(this.currentEpoch.roster);
    if (!neighborsOf(topo, this.peerIdHex).includes(neighbor.peerIdHex)) return;

    // a topology neighbor really vanished: gossip the leave on their behalf
    // and, if we are now the elder, fold them out of the epoch.
    const leavingId = neighbor.peerId;
    const leavingHex = neighbor.peerIdHex;
    this.removePeerIfPresent(leavingHex);
    void this.broadcastToNeighbors(buildLeaveAnnounce(leavingId));

    if (this.currentEpoch.roster.includes(leavingHex) && this.isElderFor(leavingHex)) {
      void this.issueFold(FOLD_REASON_LEAVE, leavingId);
    }

    // no root-death poetry: the fire persists as long as any seat remains.
  }

  /* ── Root: Prepare Next Connection Slot ─────────────── */

  private async prepareNextRootSlot(): Promise<void> {
    if (this.role !== "root") return;

    const session = this.createNeighborSession(this.nextRootSlotLabel());
    try {
      const offerCode = await session.createOffer();
      this._pendingRootSession = session;
      this._pendingRootOffer = offerCode;
      this.cb.onRoomCodeUpdate?.(offerCode);
    } catch (err) {
      this.log(`failed to prepare next connection: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  /** Root: get current offer code for new joiners. */
  getCurrentOfferCode(): string | null {
    return this._pendingRootOffer;
  }

  /* ── Send Helpers ──────────────────────────────────────── */

  private async sendToNeighbor(session: CampfireSessionLike, data: Uint8Array): Promise<void> {
    try {
      await session.sendEncryptedRaw(data, CAMPFIRE_FLAG);
    } catch (err) {
      this.log(`send failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  private async broadcastToNeighbors(data: Uint8Array, excludeLabel?: string): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [label, peer] of this.neighbors) {
      if (label === excludeLabel) continue;
      if (peer.session && peer.connected) {
        promises.push(this.sendToNeighbor(peer.session, data));
      }
    }
    await Promise.all(promises);
  }

  private async sendPeerList(session: CampfireSessionLike): Promise<void> {
    const peers = Array.from(this.allPeers.values());
    const data = buildPeerList(peers);
    await this.sendToNeighbor(session, data);
  }

  /** send our current epoch (root + roster) plus a fresh peer list over one
   *  link. used both by the admitter welcoming a fresh joiner and by every
   *  member sending a cross-check copy over a newly connected mesh edge. */
  private async sendBraidWelcome(session: CampfireSessionLike): Promise<void> {
    if (!this.currentEpoch) return;
    const rosterIds = this.currentEpoch.roster.map(hexDecode);
    const wire = buildBraidWelcome(this.currentEpoch.epochId, this.peerId, this.currentEpoch.root, rosterIds);
    await this.sendToNeighbor(session, wire);
    await this.sendToNeighbor(session, buildPeerList(Array.from(this.allPeers.values())));
  }

  private rememberRecent(senderHex: string, seq: number, rawGroupPayload: Uint8Array): void {
    const key = `${senderHex}:${seq}`;
    const full = concatBytes(new Uint8Array([CF_GROUP_MSG]), rawGroupPayload);
    this.recentBySeq.set(key, full);
    if (this.recentBySeq.size > DEDUP_RING_SIZE) {
      const oldest = this.recentBySeq.keys().next().value;
      if (oldest) this.recentBySeq.delete(oldest);
    }
  }

  private removePeerIfPresent(hex: string): void {
    const peer = this.allPeers.get(hex);
    if (!peer) return;
    this.allPeers.delete(hex);
    this.cb.onPeerLeave(peer.peerId);
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
  }

  /** content-addressed dedup for gossip types with no other natural
   *  termination condition (unlike JOIN/LEAVE_ANNOUNCE, which dedup via
   *  allPeers presence, or GROUP_MSG, which dedups via msgId). the mesh
   *  topology now has real cycles (ring + chords), so anything forwarded
   *  unconditionally would flood forever without this. shares the same
   *  ring as everything else — floods are rare relative to chat traffic. */
  private async seenBefore(payload: Uint8Array): Promise<boolean> {
    const id = await sha256(payload);
    if (this.hasSeen(id)) return true;
    this.markSeen(id);
    return false;
  }

  /* ── Broadcast Message (User Action) ──────────────────── */

  async broadcastText(text: string): Promise<void> {
    if (this._state !== "active" || !this.currentEpoch) return;

    const plaintext = TE.encode(text);
    const epochId = this.currentEpoch.epochId;
    const sealed = await braidSeal(this.currentEpoch.braid, plaintext);
    const msgId = await sha256(concatBytes(this.peerId, le32(epochId), le32(sealed.seq), sealed.ciphertext));
    const displayId = new DataView(msgId.buffer, msgId.byteOffset, 4).getUint32(0, true);

    const wire = buildGroupMsg(
      msgId, this.peerId, sealed.seq, epochId, Date.now(), 0, ContentType.Text,
      sealed.frontier, sealed.ciphertext,
    );

    this.markSeen(msgId);
    this.rememberRecent(this.peerIdHex, sealed.seq, wire.subarray(1));
    this.lastOwnSendAt = Date.now();
    this.receivedSinceOwnSend = 0;
    await this.broadcastToNeighbors(wire);

    // Show locally
    this.cb.onMessage({
      msgId,
      displayId,
      senderId: this.peerId,
      senderIdHex: this.peerIdHex,
      timestamp: Date.now(),
      hopCount: 0,
      epoch: epochId,
      contentType: ContentType.Text,
      plaintext,
    });
  }

  /**
   * Broadcast a reaction to a campfire message group-wide.
   * @param targetMsgIdFull  The full 32-byte SHA-256 msgId of the message being reacted to.
   * @param emoji            Free-form Unicode emoji string.
   * @param isUnreact        If true, sends CF_UNREACT instead of CF_REACT.
   */
  async broadcastReact(targetMsgIdFull: Uint8Array, emoji: string, isUnreact = false): Promise<void> {
    if (this._state !== "active" || !this.currentEpoch) return;
    const subType = isUnreact ? CF_UNREACT : CF_REACT;
    const wire = buildCfReact(subType, targetMsgIdFull, this.peerId, emoji, 0);
    // Mark as seen so we don't re-deliver our own reaction when gossip loops back
    const targetHex = toHex(targetMsgIdFull);
    const action = isUnreact ? "unreact" : "react";
    this.seenReacts.add(`${this.peerIdHex}:${action}:${targetHex}:${emoji}`);
    await this.broadcastToNeighbors(wire);
  }

  /* ── Gossip Dedup ──────────────────────────────────────── */

  private markSeen(msgId: Uint8Array): void {
    const hex = toHex(msgId);
    if (this.seenMsgSet.has(hex)) return;
    if (this.seenMsgIds.length >= DEDUP_RING_SIZE) {
      const oldest = this.seenMsgIds.shift()!;
      this.seenMsgSet.delete(oldest);
    }
    this.seenMsgIds.push(hex);
    this.seenMsgSet.add(hex);
  }

  private hasSeen(msgId: Uint8Array): boolean {
    return this.seenMsgSet.has(toHex(msgId));
  }

  /* ── Incoming Campfire Message Router ──────────────────── */

  private async handleCampfireMessage(plaintext: Uint8Array, fromLabel: string): Promise<void> {
    if (plaintext.length < 1) return;
    const subType = plaintext[0];
    const payload = plaintext.subarray(1);

    switch (subType) {
      case CF_GROUP_MSG:
        await this.handleGroupMsg(payload, fromLabel);
        break;
      case CF_JOIN_ANNOUNCE:
        await this.handleJoinAnnounce(payload, fromLabel);
        break;
      case CF_LEAVE_ANNOUNCE:
        await this.handleLeaveAnnounce(payload, fromLabel);
        break;
      case CF_SDP_RELAY:
        await this.handleSdpRelay(payload, fromLabel);
        break;
      case CF_PEER_LIST:
        this.handlePeerListMsg(payload);
        break;
      case CF_DM_SDP_RELAY:
        await this.handleDmSdpRelay(payload, fromLabel);
        break;
      case CF_RING_WANT:
        await this.handleRingWant(payload, fromLabel);
        break;
      case CF_REACT:
        await this.handleCfReact(plaintext, fromLabel, false);
        break;
      case CF_UNREACT:
        await this.handleCfReact(plaintext, fromLabel, true);
        break;
      case CF_BRAID_FOLD:
        await this.handleBraidFold(payload, fromLabel);
        break;
      case CF_BRAID_WELCOME:
        await this.handleBraidWelcome(payload, fromLabel);
        break;
      case CF_JOIN_REQ:
        await this.handleJoinReq(payload, fromLabel);
        break;
      case CF_EDGE_RELEASE:
        this.handleEdgeRelease(fromLabel);
        break;
      default:
        break; // unknown message type, silently ignore
    }
  }

  /** the peer on this edge is about to close it on purpose (topology
   *  reconciliation, bootstrap release). point-to-point, never forwarded:
   *  the mark only changes how we read this edge's coming disconnect. */
  private handleEdgeRelease(fromLabel: string): void {
    const neighbor = this.neighbors.get(fromLabel);
    if (neighbor) neighbor.released = true;
  }

  /* ── Braid Message Handler ──────────────────────────────── */

  private async handleGroupMsg(data: Uint8Array, fromLabel: string): Promise<void> {
    const parsed = parseGroupMsgHeader(data);

    if (this.hasSeen(parsed.msgId)) return;
    this.markSeen(parsed.msgId);

    if (parsed.hopCount >= MAX_HOP_COUNT) return; // max hops exceeded, silently drop

    let target: BraidEpoch | null = null;
    if (this.currentEpoch && parsed.epochId === this.currentEpoch.epochId) {
      target = this.currentEpoch;
    } else if (
      this.previousEpoch &&
      parsed.epochId === this.previousEpoch.epoch.epochId &&
      Date.now() < this.previousEpoch.expiresAt
    ) {
      target = this.previousEpoch.epoch;
    }

    const forward = async (): Promise<void> => {
      const rewrapped = rewrapGroupMsg(concatBytes(new Uint8Array([CF_GROUP_MSG]), data), parsed.hopCount + 1);
      await this.broadcastToNeighbors(rewrapped, fromLabel);
    };

    if (!target) {
      // wrong epoch entirely (too old, or we haven't caught up yet) — others
      // further out in the mesh may still be able to use it.
      await forward();
      return;
    }

    const senderHex = toHex(parsed.senderId);
    const senderIndex = target.roster.indexOf(senderHex);
    if (senderIndex < 0) {
      await forward();
      return;
    }

    const metaKey = `${target.epochId}:${senderIndex}:${parsed.seq}`;
    this.pendingMeta.set(metaKey, {
      msgId: parsed.msgId, timestamp: parsed.timestamp, hopCount: parsed.hopCount, contentType: parsed.contentType,
    });
    if (this.pendingMeta.size > PENDING_META_CAP) {
      const oldest = this.pendingMeta.keys().next().value;
      if (oldest !== undefined) this.pendingMeta.delete(oldest);
    }

    this.rememberRecent(senderHex, parsed.seq, data);

    const braidMsg: BraidMessage = {
      senderIndex, seq: parsed.seq, epochId: parsed.epochId,
      frontier: parsed.frontier, ciphertext: parsed.ciphertext,
    };
    const result = await braidOpen(target.braid, braidMsg);

    if (result.status === "delivered") {
      this.receivedSinceOwnSend++;
      for (const entry of result.delivered) {
        const key = `${target.epochId}:${entry.senderIndex}:${entry.seq}`;
        const meta = this.pendingMeta.get(key);
        this.pendingMeta.delete(key);
        const senderSeatHex = target.roster[entry.senderIndex];
        const senderId = hexDecode(senderSeatHex);
        const contentType = meta?.contentType ?? ContentType.Text;

        if (entry.plaintext.length === 0 && contentType === ContentType.System) {
          continue; // silent beacon — no UI event
        }

        const msgId = meta?.msgId
          ?? await sha256(concatBytes(senderId, le32(target.epochId), le32(entry.seq)));
        const displayId = new DataView(msgId.buffer, msgId.byteOffset, 4).getUint32(0, true);
        this.cb.onMessage({
          msgId,
          displayId,
          senderId,
          senderIdHex: senderSeatHex,
          timestamp: meta?.timestamp ?? Date.now(),
          hopCount: meta?.hopCount ?? 0,
          epoch: target.epochId,
          contentType,
          plaintext: entry.plaintext,
        });
      }
    } else if (result.status === "held") {
      for (const want of result.wants) {
        const seatHex = target.roster[want.seatIndex];
        if (!seatHex) continue;
        await this.broadcastToNeighbors(buildRingWant(this.peerId, hexDecode(seatHex), want.fromSeq, want.toSeq));
      }
    } else if (result.status === "diverged") {
      const seatHex = target.roster[result.seatIndex];
      const name = this.allPeers.get(seatHex)?.name ?? seatHex.slice(0, 8);
      this.log(`a thread frayed: ${name} fell out of sync`);
      this.cb.onSeatDiverged?.(hexDecode(seatHex), result.reason);
    }
    // "ignored" — nothing to do.

    await forward();
  }

  /* ── Ring Repair (braid-driven) ────────────────────────── */

  private async handleRingWant(data: Uint8Array, fromLabel: string): Promise<void> {
    if (await this.seenBefore(data)) return;

    const { originPeerId, targetPeerId, fromSeq, toSeq } = parseRingWant(data);
    const targetHex = toHex(targetPeerId);
    const originHex = toHex(originPeerId);

    // serve whatever we have cached, regardless of whether we are the
    // target — this is the mesh healing power: anyone can repair anyone.
    const responder = this.findNeighborByHex(originHex);
    if (responder?.session) {
      for (let seq = fromSeq; seq <= toSeq; seq++) {
        const raw = this.recentBySeq.get(`${targetHex}:${seq}`);
        if (raw) await this.sendToNeighbor(responder.session, raw);
      }
    }

    await this.broadcastToNeighbors(buildRingWant(originPeerId, targetPeerId, fromSeq, toSeq), fromLabel);
  }

  /**
   * Handle an incoming CF_REACT or CF_UNREACT message.
   * `plaintext` is the full campfire payload including the subtype byte.
   */
  private async handleCfReact(plaintext: Uint8Array, fromLabel: string, isUnreact: boolean): Promise<void> {
    const data = plaintext.subarray(1);
    const parsed = parseCfReact(data);
    if (!parsed) return;

    const senderHex = toHex(parsed.senderId);
    const targetHex = toHex(parsed.targetMsgIdFull);
    const action = isUnreact ? "unreact" : "react";
    const dedupKey = `${senderHex}:${action}:${targetHex}:${parsed.emoji}`;

    if (this.seenReacts.has(dedupKey)) return;
    this.seenReacts.add(dedupKey);

    if (parsed.hopCount >= MAX_HOP_COUNT) return;

    // Deliver to UI
    const displayId = new DataView(parsed.targetMsgIdFull.buffer, parsed.targetMsgIdFull.byteOffset, 4).getUint32(0, true);
    if (isUnreact) {
      this.cb.onUnreact?.(displayId, parsed.emoji, senderHex);
    } else {
      this.cb.onReact?.(displayId, parsed.emoji, senderHex);
    }

    // Gossip forward with incremented hop count
    const rewrapped = buildCfReact(
      isUnreact ? CF_UNREACT : CF_REACT,
      parsed.targetMsgIdFull, parsed.senderId, parsed.emoji, parsed.hopCount + 1,
    );
    await this.broadcastToNeighbors(rewrapped, fromLabel);
  }

  /* ── Join / Leave Announce ──────────────────────────────── */

  private async handleJoinAnnounce(data: Uint8Array, fromLabel: string): Promise<void> {
    const { peerId, name } = parseJoinAnnounce(data);
    const hex = toHex(peerId);

    if (hex === this.peerIdHex) return; // ignore our own join
    if (this.allPeers.has(hex)) return; // already known

    this.allPeers.set(hex, { peerId: new Uint8Array(peerId), name });
    this.cb.onPeerJoin(peerId, name);
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
    this.log(`${name} joined the room`);

    // Forward gossip regardless of admission role.
    await this.broadcastToNeighbors(buildJoinAnnounce(peerId, name), fromLabel);

    // Admission: only the direct, not-yet-resolved host slot the joiner
    // announced over makes us the admitter. announces that merely pass
    // through other links (mesh edges, our own bootstrap) never do.
    if (!fromLabel.startsWith("root-slot-")) return;
    const from = this.neighbors.get(fromLabel);
    if (from && !from.peerIdHex && from.session) {
      from.peerId = new Uint8Array(peerId);
      from.peerIdHex = hex;
      from.name = name;
      this.pendingAdmissions.set(hex, { label: fromLabel, session: from.session });

      if (this.isElder()) {
        if (!this.pendingJoinReqs.has(hex)) {
          this.pendingJoinReqs.add(hex);
          await this.issueFold(FOLD_REASON_JOIN, peerId);
        }
      } else if (!this.pendingJoinReqs.has(hex)) {
        this.pendingJoinReqs.add(hex);
        await this.broadcastToNeighbors(buildJoinReq(peerId, name));
      }
    }
  }

  private async handleLeaveAnnounce(data: Uint8Array, fromLabel: string): Promise<void> {
    const { peerId } = parseLeaveAnnounce(data);
    const hex = toHex(peerId);

    if (!this.allPeers.has(hex)) return; // already gone — also bounds the gossip flood

    const name = this.allPeers.get(hex)?.name ?? "someone";
    this.removePeerIfPresent(hex);
    this.log(`${name} left the room`);

    // Forward gossip
    await this.broadcastToNeighbors(buildLeaveAnnounce(peerId), fromLabel);

    // the post-leave elder folds the departure out of the epoch.
    if (this.currentEpoch?.roster.includes(hex) && this.isElderFor(hex)) {
      await this.issueFold(FOLD_REASON_LEAVE, peerId);
    }
  }

  /* ── Join Request Relay (elder routing) ─────────────────── */

  private async handleJoinReq(data: Uint8Array, fromLabel: string): Promise<void> {
    if (await this.seenBefore(data)) return;

    const { joinerId, name } = parseJoinReq(data);
    const hex = toHex(joinerId);

    if (!this.currentEpoch || this.currentEpoch.roster.includes(hex)) return;

    if (this.isElder()) {
      if (!this.pendingJoinReqs.has(hex)) {
        this.pendingJoinReqs.add(hex);
        await this.issueFold(FOLD_REASON_JOIN, joinerId);
      }
      return;
    }

    // not the elder: keep flooding until it reaches them.
    await this.broadcastToNeighbors(buildJoinReq(joinerId, name), fromLabel);
  }

  /* ── Epoch Folds ─────────────────────────────────────────── */

  private serializeEpoch<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.epochQueue.then(fn, fn);
    this.epochQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** elder-only: mint a new epoch fold for a join or leave, apply it
   *  locally through the same path every receiver uses, then broadcast it.
   *  serialized: the roster and epoch id are re-read inside the queue so
   *  two overlapping admissions mint sequential folds, never twins. */
  private issueFold(reason: typeof FOLD_REASON_JOIN | typeof FOLD_REASON_LEAVE, subjectPeerId: Uint8Array): Promise<void> {
    return this.serializeEpoch(async () => {
      if (!this.currentEpoch) return;
      const subjectHex = toHex(subjectPeerId);
      if (reason === FOLD_REASON_JOIN && this.currentEpoch.roster.includes(subjectHex)) return;
      if (reason === FOLD_REASON_LEAVE && !this.currentEpoch.roster.includes(subjectHex)) return;

      const newEpochId = this.currentEpoch.epochId + 1;
      const newRoster = reason === FOLD_REASON_JOIN
        ? sortRoster([...this.currentEpoch.roster, subjectHex])
        : this.currentEpoch.roster.filter((h) => h !== subjectHex);
      if (newRoster.length === 0) return; // never fold to an empty circle

      const entropy = randomBytes(32);
      const rosterDigest = await sha256(concatBytes(...newRoster.map(hexDecode)));
      const wire = buildBraidFold(newEpochId, reason, subjectPeerId, entropy, rosterDigest);
      entropy.fill(0);

      const payload = wire.subarray(1);
      this.markSeen(await sha256(payload));

      // broadcast only what actually took hold locally.
      try {
        if (await this.applyBraidFold(parseBraidFold(payload))) {
          await this.broadcastToNeighbors(wire);
        }
      } catch (err) {
        this.log(`fold failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    });
  }

  private async handleBraidFold(data: Uint8Array, fromLabel: string): Promise<void> {
    if (await this.seenBefore(data)) return;

    const fold = parseBraidFold(data);
    await this.serializeEpoch(async () => {
      this.rememberFold(fold);
      await this.drainFolds();
    });

    // forward regardless: peers elsewhere in the mesh may be behind or
    // ahead of us and still need this copy. dedup above bounds the flood.
    const rewrapped = concatBytes(new Uint8Array([CF_BRAID_FOLD]), data);
    await this.broadcastToNeighbors(rewrapped, fromLabel);
  }

  /** queue a fold for ordered application. the dedup ring already swallowed
   *  duplicate copies, so a fold that arrives ahead of order must be kept or
   *  the chain wedges: no second copy is coming. */
  private rememberFold(fold: ParsedBraidFold): void {
    if (this.currentEpoch && fold.newEpochId <= this.currentEpoch.epochId) return;
    if (this.pendingFolds.size >= 16 && !this.pendingFolds.has(fold.newEpochId)) {
      let maxKey = -1;
      for (const k of this.pendingFolds.keys()) if (k > maxKey) maxKey = k;
      if (fold.newEpochId >= maxKey) return; // farthest-future fold loses
      this.pendingFolds.delete(maxKey);
    }
    this.pendingFolds.set(fold.newEpochId, fold);
  }

  /** apply queued folds in strict epoch order until the chain has a gap.
   *  a seat with no epoch yet keeps its queue until a welcome seats it.
   *  a fold that throws (rather than merely not applying) is poisoned;
   *  it is dropped and the chain waits for whatever comes next. */
  private async drainFolds(): Promise<void> {
    while (this.currentEpoch) {
      const next = this.pendingFolds.get(this.currentEpoch.epochId + 1);
      if (!next) break;
      this.pendingFolds.delete(next.newEpochId);
      try {
        if (!await this.applyBraidFold(next)) break;
      } catch (err) {
        this.log(`fold failed: ${err instanceof Error ? err.message : "unknown"}`);
        break;
      }
    }
    if (this.currentEpoch) {
      for (const k of this.pendingFolds.keys()) {
        if (k <= this.currentEpoch.epochId) this.pendingFolds.delete(k);
      }
    }
  }

  /** apply a parsed braid fold to local state: verify the roster digest,
   *  fold the epoch root, rotate epoch state, then run post-fold topology
   *  and admission bookkeeping. shared by the elder's own admission and by
   *  every receiver — this IS "the same code path as receiving it".
   *  returns whether the fold took hold. always called inside the epoch
   *  queue; never call directly. */
  private async applyBraidFold(fold: ParsedBraidFold): Promise<boolean> {
    if (!this.currentEpoch) return false; // not seated yet; the fold stays queued
    if (fold.newEpochId !== this.currentEpoch.epochId + 1) return false; // stale or out of order

    const subjectHex = toHex(fold.subjectPeerId);
    let newRoster: string[];
    if (fold.reason === FOLD_REASON_JOIN) {
      if (this.currentEpoch.roster.includes(subjectHex)) return false; // already a member
      newRoster = sortRoster([...this.currentEpoch.roster, subjectHex]);
    } else {
      if (!this.currentEpoch.roster.includes(subjectHex)) return false; // already gone
      newRoster = this.currentEpoch.roster.filter((h) => h !== subjectHex);
    }
    if (newRoster.length === 0) return false; // never fold to an empty circle

    const expectedDigest = await sha256(concatBytes(...newRoster.map(hexDecode)));
    if (toHex(expectedDigest) !== toHex(fold.rosterDigest)) {
      this.log("a fold arrived that does not match the roster we computed. dropped.");
      return false;
    }

    const newRoot = await braidFold(this.currentEpoch.root, fold.entropy, fold.newEpochId, newRoster);
    const newBraid = await braidInit(newRoot, fold.newEpochId, newRoster, this.peerIdHex);

    // rotate: the outgoing epoch survives a grace window for stragglers.
    if (this.previousEpoch) braidWipe(this.previousEpoch.epoch.braid);
    this.previousEpoch = { epoch: this.currentEpoch, expiresAt: Date.now() + KEY_GRACE_PERIOD };
    this.currentEpoch = { epochId: fold.newEpochId, roster: newRoster, root: newRoot, braid: newBraid };
    this.scheduleGraceExpiry();

    if (fold.reason === FOLD_REASON_LEAVE) {
      this.removePeerIfPresent(subjectHex);
    }

    // topology reconciliation creates webrtc offers (slow); never stall the
    // epoch queue on it.
    void this.applyTopology();

    this.pendingJoinReqs.delete(subjectHex);
    if (fold.reason === FOLD_REASON_JOIN) {
      const pending = this.pendingAdmissions.get(subjectHex);
      if (pending) {
        this.pendingAdmissions.delete(subjectHex);
        await this.sendBraidWelcome(pending.session);
      }
    }
    return true;
  }

  private scheduleGraceExpiry(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.previousEpoch && Date.now() >= this.previousEpoch.expiresAt) {
        braidWipe(this.previousEpoch.epoch.braid);
        this.previousEpoch = null;
      }
    }, KEY_GRACE_PERIOD + 50);
  }

  /* ── Braid Welcome (join adoption + cross-check) ────────── */

  private async handleBraidWelcome(data: Uint8Array, _fromLabel: string): Promise<void> {
    const { epochId, senderPeerId, root, roster: rosterIds } = parseBraidWelcome(data);
    const rosterHex = sortRoster(rosterIds.map((id) => toHex(id)));

    await this.serializeEpoch(async () => {
      if (!this.currentEpoch) {
        // first epoch this seat has ever seen: adopt it, then replay any
        // folds that overtook the welcome on the way here. a welcome whose
        // roster cannot seat us is fatal to the join, not to the process.
        let braid;
        try {
          braid = await braidInit(root, epochId, rosterHex, this.peerIdHex);
        } catch {
          await this.endCampfire("the welcome had no seat for you. nothing remains.");
          return;
        }
        this.currentEpoch = { epochId, roster: rosterHex, root, braid };
        this.lastOwnSendAt = Date.now();

        const senderHex = toHex(senderPeerId);
        const link = this.neighbors.get("join-root") ?? this.neighbors.get("root");
        if (link && !link.peerIdHex) {
          link.peerIdHex = senderHex;
          const known = this.allPeers.get(senderHex);
          if (known) { link.peerId = new Uint8Array(known.peerId); link.name = known.name; }
        }

        if (this._state !== "active") {
          this.setState("active");
          this.log("connected to room");
        }

        await this.drainFolds();
        void this.applyTopology();
        return;
      }

      if (epochId === this.currentEpoch.epochId) {
        // cross-check: an honest circle agrees on its shape.
        const rootMatches = constantTimeEqual(root, this.currentEpoch.root);
        const rosterMatches = rosterHex.length === this.currentEpoch.roster.length
          && rosterHex.every((h, i) => h === this.currentEpoch!.roster[i]);
        if (!rootMatches || !rosterMatches) {
          await this.endCampfire("the circle would not agree on its shape. nothing remains.");
        }
      }

      // welcome for an epoch we've moved past or haven't reached yet — ignore.
    });
  }

  /* ── Topology (pure function of the roster) ─────────────── */

  /** after every epoch change: recompute the roster's neighbor graph, offer
   *  to peers we're now responsible for connecting to, drop mesh edges that
   *  fell out of the graph, and decide whether the bootstrap/admission link
   *  is still needed. */
  private async applyTopology(): Promise<void> {
    if (!this.currentEpoch) return;
    const topo = computeTopology(this.currentEpoch.roster);
    const mine = new Set(neighborsOf(topo, this.peerIdHex));

    for (const hex of mine) {
      if (this.findNeighborByHex(hex)) continue;
      if (this.pendingMeshSdp.has(hex)) continue;
      if (edgeOfferer(this.peerIdHex, hex) !== this.peerIdHex) continue; // wait for their offer instead

      const label = `mesh-${hex.slice(0, 8)}`;
      const session = this.createNeighborSession(label);
      try {
        const offerCode = await session.createOffer();
        this.pendingMeshSdp.set(hex, { session, isOfferer: true });
        const wire = buildSdpRelay(hexDecode(hex), this.peerId, SDP_OFFER, offerCode);
        await this.broadcastToNeighbors(wire);
      } catch (err) {
        this.log(`mesh offer failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    for (const [label, peer] of Array.from(this.neighbors)) {
      if (!label.startsWith("mesh-")) continue;
      if (!peer.peerIdHex || mine.has(peer.peerIdHex)) continue;
      // announce the release before closing: the peer may not have folded
      // yet and must not read this drop as our departure.
      if (peer.session) await this.sendToNeighbor(peer.session, buildEdgeRelease(this.peerId));
      peer.session?.disconnect();
      this.neighbors.delete(label);
    }

    await this.maybeReleaseBootstrap(mine);
  }

  /** Release the bootstrap/admission connection once it is no longer needed:
   *  keep it while its peer is a real topology neighbor, or while we have no
   *  other connected mesh neighbor to fall back on. */
  private async maybeReleaseBootstrap(mine: Set<string>): Promise<void> {
    if (this.role !== "peer" || !this.bootstrapSession) return;
    const link = this.neighbors.get("join-root") ?? this.neighbors.get("root");
    if (!link || !link.peerIdHex) return; // identity not resolved yet
    if (mine.has(link.peerIdHex)) return; // still a real topology neighbor

    const hasOtherMesh = Array.from(this.neighbors.keys()).some((l) => l.startsWith("mesh-"));
    if (!hasOtherMesh) return; // don't strand ourselves

    this.log("releasing bootstrap connection to host");
    await this.sendToNeighbor(this.bootstrapSession, buildEdgeRelease(this.peerId));
    this.bootstrapSession.disconnect();
    this.bootstrapSession = null;
    this.neighbors.delete("root");
    this.neighbors.delete("join-root");
  }

  /* ── SDP Relay Handler (mesh edge creation) ─────────────── */

  private async handleSdpRelay(data: Uint8Array, fromLabel: string): Promise<void> {
    if (await this.seenBefore(data)) return;

    const { targetPeerId, originPeerId, sdpType, sdpCode } = parseSdpRelay(data);
    const targetHex = toHex(targetPeerId);

    if (targetHex === this.peerIdHex) {
      // This SDP is for us
      await this.handleIncomingMeshSdp(sdpType, sdpCode, toHex(originPeerId), originPeerId);
      return;
    }

    if (this.role === "root") {
      // Root relays directly to the target when it happens to be a neighbor.
      const targetPeer = this.findNeighborByHex(targetHex);
      if (targetPeer?.session) {
        await this.sendToNeighbor(targetPeer.session, buildSdpRelay(targetPeerId, originPeerId, sdpType, sdpCode));
        return;
      }
    }

    await this.broadcastToNeighbors(buildSdpRelay(targetPeerId, originPeerId, sdpType, sdpCode), fromLabel);
  }

  /* ── Mesh SDP Handling ──────────────────────────────── */

  private async handleIncomingMeshSdp(
    sdpType: number, sdpCode: string, originHex: string, originPeerId: Uint8Array,
  ): Promise<void> {
    if (sdpType === SDP_OFFER) {
      // Someone is offering to connect to us — create mesh session and answer
      const prefix = originHex.slice(0, 8);
      const label = `mesh-${prefix}`;
      const session = this.createNeighborSession(label);
      try {
        const answerCode = await session.acceptOffer(sdpCode);
        // Send answer back through gossip
        const wire = buildSdpRelay(originPeerId, this.peerId, SDP_ANSWER, answerCode);
        await this.broadcastToNeighbors(wire);
      } catch (err) {
        this.log(`mesh answer failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    } else if (sdpType === SDP_ANSWER) {
      // Answer to our earlier offer
      const pending = this.pendingMeshSdp.get(originHex);
      if (pending?.isOfferer) {
        try {
          await pending.session.applyAnswer(sdpCode);
        } catch (err) {
          this.log(`mesh apply-answer failed: ${err instanceof Error ? err.message : "unknown"}`);
        }
        this.pendingMeshSdp.delete(originHex);
      }
    }
  }

  private handlePeerListMsg(data: Uint8Array): void {
    const { peers } = parsePeerList(data);
    for (const p of peers) {
      const hex = toHex(p.peerId);
      this.allPeers.set(hex, { peerId: new Uint8Array(p.peerId), name: p.name });
    }
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
  }

  private async handleDmSdpRelay(data: Uint8Array, fromLabel: string): Promise<void> {
    if (await this.seenBefore(data)) return;

    const { targetPeerId, originPeerId, sdpType, sdpCode } = parseDmSdpRelay(data);
    const targetHex = toHex(targetPeerId);

    if (targetHex === this.peerIdHex) {
      // DM SDP is for us
      await this.handleIncomingDmSdp(sdpType, sdpCode, toHex(originPeerId));
      return;
    }

    if (this.role === "root") {
      const targetPeer = this.findNeighborByHex(targetHex);
      if (targetPeer?.session) {
        await this.sendToNeighbor(targetPeer.session, buildDmSdpRelay(targetPeerId, originPeerId, sdpType, sdpCode));
        return;
      }
    }

    await this.broadcastToNeighbors(buildDmSdpRelay(targetPeerId, originPeerId, sdpType, sdpCode), fromLabel);
  }

  /* ── SDP Handling (DM) ──────────────────────────────── */

  private async handleIncomingDmSdp(sdpType: number, sdpCode: string, originHex: string): Promise<void> {
    if (sdpType === SDP_OFFER) {
      const session = this.createDmSession(originHex);
      const answerCode = await session.acceptOffer(sdpCode);
      const originPeer = this.allPeers.get(originHex);
      if (originPeer) {
        await this.broadcastToNeighbors(buildDmSdpRelay(originPeer.peerId, this.peerId, SDP_ANSWER, answerCode));
      }
    } else if (sdpType === SDP_ANSWER) {
      const pending = this.pendingDmSdp.get(originHex);
      if (pending?.isOfferer) {
        await pending.session.applyAnswer(sdpCode);
        this.pendingDmSdp.delete(originHex);
      }
    }
  }

  /* ── DM Side-Channels ──────────────────────────────────── */

  /** Initiate a DM with a specific peer by their hex ID. */
  async startDm(targetPeerIdHex: string): Promise<void> {
    if (this.dmSessions.has(targetPeerIdHex)) {
      this.log("direct message session already open");
      return;
    }

    const session = this.createDmSession(targetPeerIdHex);
    const offerCode = await session.createOffer();
    this.pendingDmSdp.set(targetPeerIdHex, { session, isOfferer: true });

    // Find target peerId bytes
    const target = this.allPeers.get(targetPeerIdHex);
    if (!target) {
      this.log("peer not found");
      return;
    }

    // Send DM SDP relay through the mesh
    await this.broadcastToNeighbors(buildDmSdpRelay(target.peerId, this.peerId, SDP_OFFER, offerCode));
    this.log(`starting direct message with ${target.name}`);
  }

  /** Send a DM text to a peer. */
  async sendDmText(targetPeerIdHex: string, text: string): Promise<void> {
    const session = this.dmSessions.get(targetPeerIdHex);
    if (!session) return;
    await session.sendText(text);
  }

  private createDmSession(peerIdHex: string): CampfireSessionLike {
    let sessionRef: CampfireSessionLike | null = null;
    const callbacks: WhisperLiveCallbacks = {
      onStateChange: (state) => {
        if (state === "live") {
          const pending = this.pendingDmSdp.get(peerIdHex);
          if (pending) {
            this.dmSessions.set(peerIdHex, pending.session);
            this.pendingDmSdp.delete(peerIdHex);
          } else if (sessionRef) {
            this.dmSessions.set(peerIdHex, sessionRef);
          }
          this.log("direct message connected");
        } else if (state === "disconnected" || state === "error") {
          this.dmSessions.delete(peerIdHex);
        }
      },
      onFingerprint: () => {},
      onMessage: (msg) => {
        if (msg.type === "text" && msg.text) {
          const peerId = this.allPeers.get(peerIdHex)?.peerId ?? hexDecode(peerIdHex);
          this.cb.onDmMessage(peerId, { type: "text", text: msg.text, timestamp: msg.timestamp });
        }
      },
      onLog: () => {},
    };

    const session = this.sessionFactory(callbacks, {
      rtcConfig: this.rtcConfig,
      autoConfirmFingerprint: true,
    });
    sessionRef = session;
    return session;
  }

  /* ── Ring Repair + Auto-Beacon Timers ───────────────────── */

  private startRingRepair(): void {
    this.stopRingRepair();
    this.repairTimer = setInterval(() => {
      if (this._state !== "active" || !this.currentEpoch) return;
      const wants = braidWants(this.currentEpoch.braid);
      for (const want of wants) {
        const seatHex = this.currentEpoch.roster[want.seatIndex];
        if (!seatHex) continue;
        void this.broadcastToNeighbors(buildRingWant(this.peerId, hexDecode(seatHex), want.fromSeq, want.toSeq));
      }
    }, RING_REPAIR_INTERVAL);
  }

  private stopRingRepair(): void {
    if (this.repairTimer) { clearInterval(this.repairTimer); this.repairTimer = null; }
  }

  private startBeacon(): void {
    this.stopBeacon();
    this.beaconTimer = setInterval(() => {
      void this.maybeSendBeacon();
    }, BEACON_CHECK_INTERVAL);
  }

  private stopBeacon(): void {
    if (this.beaconTimer) { clearInterval(this.beaconTimer); this.beaconTimer = null; }
  }

  /** send a silent, empty-payload group message so quiet seats still
   *  advance their frontier and stay reachable for view reconstruction. */
  private async maybeSendBeacon(): Promise<void> {
    if (this._state !== "active" || !this.currentEpoch) return;
    const idle = this.receivedSinceOwnSend > 0 && Date.now() - this.lastOwnSendAt > BEACON_IDLE_MS;
    if (this.receivedSinceOwnSend < BEACON_MSG_THRESHOLD && !idle) return;

    const epochId = this.currentEpoch.epochId;
    const sealed = await braidSeal(this.currentEpoch.braid, new Uint8Array(0));
    const msgId = await sha256(concatBytes(this.peerId, le32(epochId), le32(sealed.seq), sealed.ciphertext));
    const wire = buildGroupMsg(
      msgId, this.peerId, sealed.seq, epochId, Date.now(), 0, ContentType.System,
      sealed.frontier, sealed.ciphertext,
    );

    this.markSeen(msgId);
    this.rememberRecent(this.peerIdHex, sealed.seq, wire.subarray(1));
    this.lastOwnSendAt = Date.now();
    this.receivedSinceOwnSend = 0;
    await this.broadcastToNeighbors(wire);
  }

  /* ── Utility ───────────────────────────────────────────── */

  private findNeighborByHex(hex: string): CampfirePeer | undefined {
    for (const [, peer] of this.neighbors) {
      if (peer.peerIdHex === hex) return peer;
    }
    return undefined;
  }

  /** Get our peer ID hex. */
  getPeerIdHex(): string { return this.peerIdHex; }

  /** Get our display name. */
  getDisplayName(): string { return this.displayName; }

  /** Get our role. */
  getRole(): CampfireRole { return this.role; }

  /** Get all known peers. */
  getAllPeers(): Array<{ peerId: Uint8Array; name: string }> {
    return Array.from(this.allPeers.values());
  }

  /* ── Teardown ──────────────────────────────────────────── */

  /** End the campfire (voluntary leave, any role). */
  async endCampfire(reason?: string): Promise<void> {
    if (this._state === "ended" || this._state === "idle") return;

    await this.broadcastToNeighbors(buildLeaveAnnounce(this.peerId));

    this.stopRingRepair();
    this.stopBeacon();
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }

    // Disconnect all neighbors
    for (const [, peer] of this.neighbors) {
      peer.session?.disconnect();
    }
    this.neighbors.clear();

    // Disconnect bootstrap if still open
    if (this.bootstrapSession) {
      this.bootstrapSession.disconnect();
      this.bootstrapSession = null;
    }

    // Disconnect all DM sessions
    for (const [, session] of this.dmSessions) {
      session.disconnect();
    }
    this.dmSessions.clear();

    // Wipe braid secrets
    if (this.currentEpoch) {
      braidWipe(this.currentEpoch.braid);
      this.currentEpoch = null;
    }
    if (this.previousEpoch) {
      braidWipe(this.previousEpoch.epoch.braid);
      this.previousEpoch = null;
    }

    this.pendingMeshSdp.clear();
    this.pendingAdmissions.clear();
    this.pendingJoinReqs.clear();
    this.pendingFolds.clear();
    this.pendingMeta.clear();
    this.allPeers.clear();
    this.seenMsgIds = [];
    this.seenMsgSet.clear();
    this.seenReacts.clear();
    this.recentBySeq.clear();

    this.setState("ended", reason ?? "session ended");
    this.log(reason ?? "session ended");
  }

  /** Full cleanup, called when leaving the page. */
  destroy(): void {
    this.endCampfire();
    this._state = "idle";
  }
}
