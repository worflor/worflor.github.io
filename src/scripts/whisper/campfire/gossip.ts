/**
 * Campfire: gossip-propagated group chat engine.
 *
 * CampfireNode manages the campfire lifecycle:
 *   - Root: create campfire, assign topology, distribute group keys, heartbeat
 *   - Peer: join campfire, gossip messages, handle group key rotations
 *
 * Every pairwise link is a WhisperLiveSession under the hood, using the
 * campfire flag (0x02) in the message header to distinguish campfire payloads.
 */

import {
  WhisperLiveSession,
  WHISPER_LIVE_RTC_LOCAL_ONLY,
  WHISPER_LIVE_RTC_PUBLIC_STUN,
  type WhisperLiveCallbacks,
} from "../live";

import { TE, hkdf } from "../live-crypto";
import { randomBytes, sha256, concatBytes, toHex } from "../wasm";

import {
  type CampfireState,
  type CampfireRole,
  type CampfireCallbacks,
  type CampfirePeer,
  type GroupKeyEpoch,
  ContentType,
  CAMPFIRE_FLAG,
  PEER_ID_LEN,
  GROUP_KEY_LEN,
  ROOT_HEARTBEAT_INTERVAL,
  ROOT_HEARTBEAT_TIMEOUT,
  KEY_GRACE_PERIOD,
  DEDUP_RING_SIZE,
  MAX_HOP_COUNT,
} from "./types";

import {
  buildRootHeartbeat,
  buildGroupMsg,
  rewrapGroupMsg,
  buildGroupKey,
  buildPeerList,
  buildJoinAnnounce,
  buildLeaveAnnounce,
  buildSdpRelay,
  buildTopologyAssign,
  buildDmSdpRelay,
  buildRingWant,
  buildCfReact,
  parseRootHeartbeat,
  parseGroupMsgHeader,
  decryptGroupMsg,
  parseJoinAnnounce,
  parseLeaveAnnounce,
  parseSdpRelay,
  parseGroupKey,
  parsePeerList,
  parseTopologyAssign,
  parseDmSdpRelay,
  parseRingWant,
  parseCfReact,
} from "./wire";

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
  CF_RING_WANT,
  CF_REACT,
  CF_UNREACT,
} from "./types";

import { CampfireTopology } from "./topology";

/* ═══════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════ */

const ZERO_SALT_32 = new Uint8Array(32);
const GROUP_KEY_INFO = TE.encode("campfire-group-v1");

/** SDP type codes used in relay messages. */
const SDP_OFFER = 0x01;
const SDP_ANSWER = 0x02;
const RING_REPAIR_INTERVAL = 12_000;
const RING_REPAIR_WINDOW = 32;

/* ═══════════════════════════════════════════════════════════════════
   CampfireNode
   ═══════════════════════════════════════════════════════════════════ */

export class CampfireNode {
  private _state: CampfireState = "idle";
  private role: CampfireRole = "peer";
  private peerId: Uint8Array = new Uint8Array(0);
  private peerIdHex = "";
  private displayName = "";

  // Group crypto
  private currentEpoch: GroupKeyEpoch | null = null;
  private previousEpoch: GroupKeyEpoch | null = null;

  // Neighbor sessions (pairwise WebRTC links)
  private neighbors = new Map<string, CampfirePeer>();

  // Full peer list (all campfire members, not just neighbors)
  private allPeers = new Map<string, { peerId: Uint8Array; name: string }>();

  // Root-only state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private topology: CampfireTopology | null = null;
  private heartbeatSeq = 0;

  // Peer-only state
  private lastRootHeartbeat = 0;
  private heartbeatWatchTimer: ReturnType<typeof setInterval> | null = null;
  private bootstrapSession: WhisperLiveSession | null = null;
  private assignedNeighborHexes = new Set<string>();
  private meshNeighborsConnected = 0;

  // Gossip dedup
  private seenMsgIds: string[] = [];
  private seenMsgSet = new Set<string>();
  // React dedup — key: "{senderHex}:{react|unreact}:{targetMsgIdHex}:{emoji}"
  private seenReacts = new Set<string>();

  // Ring/repair state
  private seqBySender = new Map<string, number>();
  private localSeq = 0;
  private recentBySeq = new Map<string, Uint8Array>();
  private repairTimer: ReturnType<typeof setInterval> | null = null;

  // DM side-channels
  private dmSessions = new Map<string, WhisperLiveSession>();
  private pendingDmSdp = new Map<string, { session: WhisperLiveSession; isOfferer: boolean }>();

  // Mesh SDP handshakes
  private pendingMeshSdp = new Map<string, { session: WhisperLiveSession; isOfferer: boolean }>();

  // RTC config
  private useStun = false;
  private rootSlotCounter = 0;
  private rootPeerIdHex: string | null = null;

  // Callbacks
  private cb: CampfireCallbacks;

  constructor(callbacks: CampfireCallbacks) {
    this.cb = callbacks;
  }

  get state(): CampfireState { return this._state; }

  private setState(state: CampfireState, detail?: string): void {
    this._state = state;
    this.cb.onStateChange(state, detail);
  }

  private log(line: string): void {
    this.cb.onLog(line);
  }

  private get rtcConfig(): RTCConfiguration {
    return this.useStun ? WHISPER_LIVE_RTC_PUBLIC_STUN : WHISPER_LIVE_RTC_LOCAL_ONLY;
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

    // Initialize topology (Root-only)
    this.topology = new CampfireTopology(this.peerId);

    // Generate group key
    const seed = randomBytes(32);
    const groupKey = await hkdf(seed, ZERO_SALT_32, GROUP_KEY_INFO, GROUP_KEY_LEN);
    seed.fill(0);
    this.currentEpoch = { epoch: 1, key: groupKey, expiresAt: Infinity };

    // Add self to peer list
    this.allPeers.set(this.peerIdHex, { peerId: this.peerId, name: this.displayName });

    // Create a WhisperLiveSession for the initial connection (Root waits for first peer)
    const rootSession = this.createNeighborSession(this.nextRootSlotLabel());

    const offerCode = await rootSession.createOffer();
    this.setState("waiting");
    this.log("room ready, share the code");

    // Store pending session, will be assigned to joining peer
    this._pendingRootSession = rootSession;
    this._pendingRootOffer = offerCode;
    this.cb.onRoomCodeUpdate?.(offerCode);

    // Start heartbeat
    this.startRootHeartbeat();

    return offerCode;
  }

  private _pendingRootSession: WhisperLiveSession | null = null;
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

    // Create session to Root
    const session = this.createNeighborSession("join-root");
    const answerCode = await session.acceptOffer(offerCode);

    // Track bootstrap session for potential later release
    this.bootstrapSession = session;

    return answerCode;
  }

  /* ── Neighbor Session Factory ──────────────────────────── */

  private createNeighborSession(label: string): WhisperLiveSession {
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

    const session = new WhisperLiveSession(callbacks, {
      rtcConfig: this.rtcConfig,
      autoConfirmFingerprint: true,
    });

    return session;
  }

  /* ── Neighbor Connected ────────────────────────────────── */

  private handleNeighborConnected(label: string, session: WhisperLiveSession): void {
    if (this.role === "root" && label.startsWith("root-slot-")) {
      // First peer joined, store as neighbor
      // We'll get their peerId from the first message they send
      // For now, generate a temporary ID. Root will assign real ID via PEER_LIST exchange
      const tempId = new Uint8Array(PEER_ID_LEN);
      this.neighbors.set(label, {
        peerId: tempId,
        peerIdHex: "",
        name: "connecting...",
        session,
        connected: true,
        joinedAt: Date.now(),
      });

      // Send PEER_LIST to the new peer
      this.sendPeerList(session);

      // Send GROUP_KEY
      if (this.currentEpoch) {
        this.sendGroupKey(session, this.currentEpoch.epoch, this.currentEpoch.key);
      }

      if (this._state !== "active") {
        this.setState("active");
      }

      // Prepare next incoming connection slot
      this.prepareNextRootSlot();
    } else if (this.role === "peer" && label === "join-root") {
      // Connected to Root
      this.neighbors.set("root", {
        peerId: new Uint8Array(PEER_ID_LEN), // Will be filled from PEER_LIST
        peerIdHex: "root",
        name: "Root",
        session,
        connected: true,
        joinedAt: Date.now(),
      });

      this.lastRootHeartbeat = Date.now();
      this.startHeartbeatWatch();
      this.startRingRepair();

      if (this._state !== "active") {
        this.setState("active");
        this.log("connected to room");
      }

      void this.sendToNeighbor(session, buildJoinAnnounce(this.peerId, this.displayName));
    } else if (label.startsWith("mesh-")) {
      // Mesh neighbor connected — resolve full peer ID from label prefix
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

      // Track mesh neighbor connections for bootstrap release
      if (resolvedHex) {
        this.meshNeighborsConnected++;
        this.maybeReleaseBootstrap();
      }

      if (this._state === "active") this.startRingRepair();
    } else {
      // Additional neighbor connected (topology expansion, other)
      this.neighbors.set(label, {
        peerId: new Uint8Array(PEER_ID_LEN),
        peerIdHex: label,
        name: label,
        session,
        connected: true,
        joinedAt: Date.now(),
      });
      this.log("new neighbor connected");
      if (this._state === "active") this.startRingRepair();
    }
  }

  private handleNeighborDisconnected(label: string): void {
    const neighbor = this.neighbors.get(label);
    if (neighbor) {
      neighbor.connected = false;
      this.neighbors.delete(label);
      this.log("neighbor disconnected");

      if (this.role === "root" && neighbor.peerIdHex && this.allPeers.has(neighbor.peerIdHex)) {
        const leavingId = neighbor.peerId;
        const leavingHex = neighbor.peerIdHex;
        this.allPeers.delete(leavingHex);
        this.cb.onPeerLeave(leavingId);
        this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
        const leaveWire = buildLeaveAnnounce(leavingId);
        void this.broadcastToNeighbors(leaveWire);

        // Topology maintenance: remove node and rebalance
        if (this.topology) {
          const affected = this.topology.removeNode(leavingId);
          const newEdges = this.topology.rebalanceAfterRemoval(affected);
          for (const [peerA, peerB] of newEdges) {
            const hexA = toHex(peerA);
            const hexB = toHex(peerB);
            // Send topology assign to both peers
            const neighborA = this.findNeighborByHex(hexA);
            const neighborB = this.findNeighborByHex(hexB);
            if (neighborA?.session) {
              void this.sendToNeighbor(neighborA.session, buildTopologyAssign([peerB]));
            }
            if (neighborB?.session) {
              void this.sendToNeighbor(neighborB.session, buildTopologyAssign([peerA]));
            }
          }
        }
      }
    }

    // If root peer loses connection, check if there are any neighbors left
    if (this.role === "root") {
      if (this.neighbors.size === 0 && this._state === "active") {
        // All peers gone, but Root stays active (waiting for new joiners)
      }
    } else {
      // If peer lost root connection and has no other neighbors, campfire ends
      if (label === "join-root" || label === "root") {
        this.bootstrapSession = null;
        // Only end if we have no mesh neighbors
        const meshNeighbors = Array.from(this.neighbors.keys()).filter(l => l.startsWith("mesh-"));
        if (meshNeighbors.length === 0) {
          this.log("lost connection to the room host");
          this.endCampfire("root disconnected. the fire is out. nothing remains.");
        } else {
          this.log("bootstrap link to host released, mesh neighbors active");
        }
      }
    }
  }

  /** Release bootstrap connection to Root if Root isn't among assigned neighbors. */
  private maybeReleaseBootstrap(): void {
    if (this.role !== "peer" || !this.bootstrapSession) return;
    if (this.meshNeighborsConnected < 1) return;
    // If Root is among our assigned neighbors, keep the bootstrap
    if (this.rootPeerIdHex && this.assignedNeighborHexes.has(this.rootPeerIdHex)) return;
    // Root is NOT an assigned neighbor; release bootstrap
    this.log("releasing bootstrap connection to host");
    this.bootstrapSession.disconnect();
    this.bootstrapSession = null;
    this.neighbors.delete("root");
    this.neighbors.delete("join-root");
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

  private async sendToNeighbor(session: WhisperLiveSession, data: Uint8Array): Promise<void> {
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

  private async sendPeerList(session: WhisperLiveSession): Promise<void> {
    const peers = Array.from(this.allPeers.values());
    const data = buildPeerList(peers);
    await this.sendToNeighbor(session, data);
  }

  private async sendGroupKey(session: WhisperLiveSession, epoch: number, key: Uint8Array): Promise<void> {
    const data = buildGroupKey(epoch, key);
    await this.sendToNeighbor(session, data);
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

  private hexToPeerId(hex: string): Uint8Array {
    const peer = this.allPeers.get(hex);
    return peer ? new Uint8Array(peer.peerId) : new Uint8Array(PEER_ID_LEN);
  }

  /* ── Broadcast Message (User Action) ──────────────────── */

  async broadcastText(text: string): Promise<void> {
    if (this._state !== "active" || !this.currentEpoch) return;

    const plaintext = TE.encode(text);
    const seq = ++this.localSeq;
    const seqLe = new Uint8Array(4);
    new DataView(seqLe.buffer).setUint32(0, seq, true);
    const msgId = await sha256(concatBytes(this.peerId, seqLe, plaintext));
    const displayId = new DataView(msgId.buffer, msgId.byteOffset, 4).getUint32(0, true);

    const wire = await buildGroupMsg(
      msgId, this.peerId,
      Date.now(), 0, this.currentEpoch.epoch,
      ContentType.Text, plaintext, this.currentEpoch.key,
    );

    this.markSeen(msgId);
    this.seqBySender.set(this.peerIdHex, seq);
    this.rememberRecent(this.peerIdHex, seq, wire.subarray(1));
    await this.broadcastToNeighbors(wire);

    // Show locally
    this.cb.onMessage({
      msgId,
      displayId,
      senderId: this.peerId,
      senderIdHex: this.peerIdHex,
      timestamp: Date.now(),
      hopCount: 0,
      epoch: this.currentEpoch.epoch,
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
      case CF_ROOT_HEARTBEAT:
        await this.handleRootHeartbeat(payload);
        break;
      case CF_GROUP_MSG:
        await this.handleGroupMsg(payload, fromLabel);
        break;
      case CF_JOIN_ANNOUNCE:
        await this.handleJoinAnnounce(payload, fromLabel);
        break;
      case CF_LEAVE_ANNOUNCE:
        await this.handleLeaveAnnounce(payload, fromLabel);
        break;
      case CF_TOPOLOGY_ASSIGN:
        await this.handleTopologyAssign(payload);
        break;
      case CF_SDP_RELAY:
        await this.handleSdpRelay(payload, fromLabel);
        break;
      case CF_GROUP_KEY:
        this.handleGroupKeyMsg(payload);
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
      default:
        break; // unknown message type, silently ignore
    }
  }

  /* ── Message Handlers ──────────────────────────────────── */

  private async handleRootHeartbeat(data: Uint8Array): Promise<void> {
    const hb = parseRootHeartbeat(data);

    // Dedup using rootPeerId + epoch + seq
    const seqBytes = new Uint8Array(4);
    new DataView(seqBytes.buffer).setUint32(0, hb.seq, true);
    const dedupKey = concatBytes(hb.rootPeerId, new Uint8Array(new Uint32Array([hb.epoch]).buffer), seqBytes);
    if (this.hasSeen(dedupKey)) return;
    this.markSeen(dedupKey);

    this.lastRootHeartbeat = Date.now();
    this.rootPeerIdHex = toHex(hb.rootPeerId);

    if (!this.allPeers.has(this.rootPeerIdHex)) {
      this.allPeers.set(this.rootPeerIdHex, {
        peerId: new Uint8Array(hb.rootPeerId),
        name: "host",
      });
      this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
    }

    const rootLink = this.neighbors.get("join-root") ?? this.neighbors.get("root");
    if (rootLink) {
      rootLink.peerId = new Uint8Array(hb.rootPeerId);
      rootLink.peerIdHex = this.rootPeerIdHex;
      const known = this.allPeers.get(this.rootPeerIdHex);
      if (known) rootLink.name = known.name;
    }

    // Forward to other neighbors (gossip)
    const fullMsg = concatBytes(new Uint8Array([CF_ROOT_HEARTBEAT]), data);
    await this.broadcastToNeighbors(fullMsg);
  }

  private async handleGroupMsg(data: Uint8Array, fromLabel: string): Promise<void> {
    const parsed = parseGroupMsgHeader(data);
    const senderHex = toHex(parsed.senderId);

    // Dedup
    if (this.hasSeen(parsed.msgId)) return;
    this.markSeen(parsed.msgId);

    const seq = (this.seqBySender.get(senderHex) ?? 0) + 1;
    this.seqBySender.set(senderHex, seq);
    this.rememberRecent(senderHex, seq, data);

    // Hop limit
    if (parsed.hopCount >= MAX_HOP_COUNT) {
      return; // max hops exceeded, silently drop
    }

    // Try to decrypt with current or previous epoch key
    let plaintext: Uint8Array | null = null;
    let key: Uint8Array | null = null;

    if (this.currentEpoch && parsed.epoch === this.currentEpoch.epoch) {
      key = this.currentEpoch.key;
    } else if (this.previousEpoch && parsed.epoch === this.previousEpoch.epoch && Date.now() < this.previousEpoch.expiresAt) {
      key = this.previousEpoch.key;
    }

    if (key) {
      try {
        plaintext = await decryptGroupMsg(parsed.ciphertext, parsed.nonce, key);
      } catch {
        this.log("message could not be decrypted");
        return;
      }
    } else {
      this.log("no key for this message, may have been sent before you joined");
      return;
    }

    // Deliver to UI
    const displayId = new DataView(parsed.msgId.buffer, parsed.msgId.byteOffset, 4).getUint32(0, true);
    this.cb.onMessage({
      msgId: parsed.msgId,
      displayId,
      senderId: parsed.senderId,
      senderIdHex: toHex(parsed.senderId),
      timestamp: parsed.timestamp,
      hopCount: parsed.hopCount,
      epoch: parsed.epoch,
      contentType: parsed.contentType,
      plaintext,
    });

    // Forward to other neighbors (gossip), re-wrap with incremented hop count
    const rewrapped = rewrapGroupMsg(concatBytes(new Uint8Array([CF_GROUP_MSG]), data), parsed.hopCount + 1);
    await this.broadcastToNeighbors(rewrapped, fromLabel);
  }

  private async handleRingWant(data: Uint8Array, fromLabel: string): Promise<void> {
    const { originPeerId, targetPeerId, fromSeq, toSeq } = parseRingWant(data);
    const targetHex = toHex(targetPeerId);

    if (targetHex === this.peerIdHex) {
      const originHex = toHex(originPeerId);
      const responder = this.findNeighborByHex(originHex);
      if (!responder?.session) return;

      for (let seq = fromSeq; seq <= toSeq; seq++) {
        const key = `${this.peerIdHex}:${seq}`;
        const raw = this.recentBySeq.get(key);
        if (!raw) continue;
        await this.sendToNeighbor(responder.session, raw);
      }
      return;
    }

    if (this.role === "root") {
      const peer = this.findNeighborByHex(targetHex);
      if (peer?.session) {
        await this.sendToNeighbor(peer.session, buildRingWant(originPeerId, targetPeerId, fromSeq, toSeq));
      }
      return;
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

  private async handleJoinAnnounce(data: Uint8Array, fromLabel: string): Promise<void> {
    const { peerId, name } = parseJoinAnnounce(data);
    const hex = toHex(peerId);

    if (hex === this.peerIdHex) return; // ignore our own join
    if (this.allPeers.has(hex)) return; // already known

    this.allPeers.set(hex, { peerId: new Uint8Array(peerId), name });

    if (this.role === "root") {
      const from = this.neighbors.get(fromLabel);
      if (from) {
        from.peerId = new Uint8Array(peerId);
        from.peerIdHex = hex;
        from.name = name;
      }

      // Root: add to topology and assign neighbors
      if (this.topology) {
        const neighborIds = this.topology.selectNeighborsForNewPeer(peerId);
        // Send TOPOLOGY_ASSIGN to the new peer
        if (from?.session) {
          void this.sendToNeighbor(from.session, buildTopologyAssign(neighborIds));
        }
      }
    }
    this.cb.onPeerJoin(peerId, name);
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
    this.log(`${name} joined the room`);

    // Forward gossip
    const wire = buildJoinAnnounce(peerId, name);
    await this.broadcastToNeighbors(wire, fromLabel);
  }

  private async handleLeaveAnnounce(data: Uint8Array, fromLabel: string): Promise<void> {
    const { peerId } = parseLeaveAnnounce(data);
    const hex = toHex(peerId);

    if (!this.allPeers.has(hex)) return;

    const peer = this.allPeers.get(hex);
    this.allPeers.delete(hex);
    this.cb.onPeerLeave(peerId);
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
    this.log(`${peer?.name ?? "someone"} left the room`);

    // Forward gossip
    const wire = buildLeaveAnnounce(peerId);
    await this.broadcastToNeighbors(wire, fromLabel);
  }

  /* ── Topology Assign Handler ─────────────────────────── */

  private async handleTopologyAssign(data: Uint8Array): Promise<void> {
    const { neighborPeerIds } = parseTopologyAssign(data);
    this.log(`topology assigned: ${neighborPeerIds.length} neighbor(s)`);

    this.assignedNeighborHexes.clear();
    for (const nId of neighborPeerIds) {
      this.assignedNeighborHexes.add(toHex(nId));
    }

    for (const neighborId of neighborPeerIds) {
      const neighborHex = toHex(neighborId);
      // Skip if already connected to this peer
      if (this.findNeighborByHex(neighborHex)) continue;
      // Skip if this is our root bootstrap (already connected)
      if (this.rootPeerIdHex && neighborHex === this.rootPeerIdHex) continue;

      // Create mesh session and offer
      const prefix = neighborHex.slice(0, 8);
      const label = `mesh-${prefix}`;
      const session = this.createNeighborSession(label);
      try {
        const offerCode = await session.createOffer();
        this.pendingMeshSdp.set(neighborHex, { session, isOfferer: true });

        // Send SDP relay through gossip
        const wire = buildSdpRelay(neighborId, this.peerId, SDP_OFFER, offerCode);
        await this.broadcastToNeighbors(wire);
      } catch (err) {
        this.log(`mesh offer failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  }

  /* ── SDP Relay Handler ───────────────────────────────── */

  private async handleSdpRelay(data: Uint8Array, fromLabel: string): Promise<void> {
    const { targetPeerId, originPeerId, sdpType, sdpCode } = parseSdpRelay(data);
    const targetHex = toHex(targetPeerId);
    const originHex = toHex(originPeerId);

    if (targetHex === this.peerIdHex) {
      // This SDP is for us
      await this.handleIncomingMeshSdp(sdpType, sdpCode, originHex, originPeerId);
    } else if (this.role === "root") {
      // Root relays to the target peer directly if they're a neighbor
      const targetPeer = this.findNeighborByHex(targetHex);
      if (targetPeer?.session) {
        const wire = buildSdpRelay(targetPeerId, originPeerId, sdpType, sdpCode);
        await this.sendToNeighbor(targetPeer.session, wire);
      }
    } else {
      // Non-root: gossip-forward SDP relay
      await this.broadcastToNeighbors(
        buildSdpRelay(targetPeerId, originPeerId, sdpType, sdpCode),
        fromLabel,
      );
    }
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

  private handleGroupKeyMsg(data: Uint8Array): void {
    const { epoch, groupKey } = parseGroupKey(data);
    this.log("encryption key updated");

    // Rotate keys
    if (this.currentEpoch) {
      this.previousEpoch = {
        ...this.currentEpoch,
        expiresAt: Date.now() + KEY_GRACE_PERIOD,
      };
    }
    this.currentEpoch = { epoch, key: new Uint8Array(groupKey), expiresAt: Infinity };
  }

  private handlePeerListMsg(data: Uint8Array): void {
    const { peers } = parsePeerList(data);
    for (const p of peers) {
      const hex = toHex(p.peerId);
      this.allPeers.set(hex, { peerId: new Uint8Array(p.peerId), name: p.name });
    }

    if (this.role === "peer" && this.rootPeerIdHex) {
      const rootLink = this.neighbors.get("join-root") ?? this.neighbors.get("root");
      const rootPeer = this.allPeers.get(this.rootPeerIdHex);
      if (rootLink && rootPeer) {
        rootLink.peerId = new Uint8Array(rootPeer.peerId);
        rootLink.peerIdHex = this.rootPeerIdHex;
        rootLink.name = rootPeer.name;
      }
    }
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
  }

  private async handleDmSdpRelay(data: Uint8Array, fromLabel: string): Promise<void> {
    const { targetPeerId, originPeerId, sdpType, sdpCode } = parseDmSdpRelay(data);
    const targetHex = toHex(targetPeerId);
    const originHex = toHex(originPeerId);

    if (targetHex === this.peerIdHex) {
      // DM SDP is for us
      await this.handleIncomingDmSdp(sdpType, sdpCode, originHex);
    } else if (this.role === "root") {
      // Root relays DM SDP
      const targetPeer = this.findNeighborByHex(targetHex);
      if (targetPeer?.session) {
        const wire = buildDmSdpRelay(targetPeerId, originPeerId, sdpType, sdpCode);
        await this.sendToNeighbor(targetPeer.session, wire);
      }
    } else {
      // Forward through mesh
      await this.broadcastToNeighbors(buildDmSdpRelay(targetPeerId, originPeerId, sdpType, sdpCode), fromLabel);
    }
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

  private createDmSession(peerIdHex: string): WhisperLiveSession {
    let sessionRef: WhisperLiveSession | null = null;
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
          const peerId = this.allPeers.get(peerIdHex)?.peerId ?? new Uint8Array(PEER_ID_LEN);
          this.cb.onDmMessage(peerId, { type: "text", text: msg.text, timestamp: msg.timestamp });
        }
      },
      onLog: () => {},
    };

    const session = new WhisperLiveSession(callbacks, {
      rtcConfig: this.rtcConfig,
      autoConfirmFingerprint: true,
    });
    sessionRef = session;
    return session;
  }

  /* ── Root Heartbeat ────────────────────────────────────── */

  private startRootHeartbeat(): void {
    this.stopRootHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (this._state !== "active" && this._state !== "waiting") return;
      const epoch = this.currentEpoch?.epoch ?? 0;
      const seq = ++this.heartbeatSeq;
      const wire = buildRootHeartbeat(epoch, this.allPeers.size, this.peerId, seq);
      await this.broadcastToNeighbors(wire);
    }, ROOT_HEARTBEAT_INTERVAL);
  }

  private stopRootHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private startRingRepair(): void {
    this.stopRingRepair();
    this.repairTimer = setInterval(() => {
      if (this._state !== "active") return;
      const ids = Array.from(this.allPeers.keys()).sort();
      for (const hex of ids) {
        if (hex === this.peerIdHex) continue;
        const wantFrom = (this.seqBySender.get(hex) ?? 0) + 1;
        const wantTo = wantFrom + RING_REPAIR_WINDOW - 1;
        void this.broadcastToNeighbors(buildRingWant(this.peerId, this.hexToPeerId(hex), wantFrom, wantTo));
      }
    }, RING_REPAIR_INTERVAL);
  }

  private stopRingRepair(): void {
    if (this.repairTimer) { clearInterval(this.repairTimer); this.repairTimer = null; }
  }

  /* ── Peer Heartbeat Watch ──────────────────────────────── */

  private startHeartbeatWatch(): void {
    this.stopHeartbeatWatch();
    this.lastRootHeartbeat = Date.now();
    this.heartbeatWatchTimer = setInterval(() => {
      if (this._state !== "active") return;
      if (Date.now() - this.lastRootHeartbeat > ROOT_HEARTBEAT_TIMEOUT) {
        this.log("room host went silent, session ending");
        this.endCampfire("root went silent. the fire is out. nothing remains.");
      }
    }, ROOT_HEARTBEAT_INTERVAL);
  }

  private stopHeartbeatWatch(): void {
    if (this.heartbeatWatchTimer) { clearInterval(this.heartbeatWatchTimer); this.heartbeatWatchTimer = null; }
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

  /** End the campfire (Root: kill switch, Peer: leave). */
  async endCampfire(reason?: string): Promise<void> {
    if (this._state === "ended" || this._state === "idle") return;

    if (this.role === "root") {
      // Broadcast leave announce for root
      const wire = buildLeaveAnnounce(this.peerId);
      await this.broadcastToNeighbors(wire);
    }

    this.stopRootHeartbeat();
    this.stopHeartbeatWatch();
    this.stopRingRepair();

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

    // Wipe keys
    if (this.currentEpoch) {
      this.currentEpoch.key.fill(0);
      this.currentEpoch = null;
    }
    if (this.previousEpoch) {
      this.previousEpoch.key.fill(0);
      this.previousEpoch = null;
    }

    this.pendingMeshSdp.clear();
    this.topology = null;
    this.allPeers.clear();
    this.seenMsgIds = [];
    this.seenMsgSet.clear();
    this.seenReacts.clear();
    this.seqBySender.clear();
    this.recentBySeq.clear();
    this.assignedNeighborHexes.clear();
    this.meshNeighborsConnected = 0;

    this.setState("ended", reason ?? "session ended");
    this.log(reason ?? "session ended");
  }

  /** Full cleanup, called when leaving the page. */
  destroy(): void {
    this.endCampfire();
    this._state = "idle";
  }
}
