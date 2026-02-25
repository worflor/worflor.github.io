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
} from "./whisper-live";

import { TE, TD, hkdf, aesGcmEncrypt, aesGcmDecrypt } from "./whisper-live-crypto";
import { randomBytes, sha256, concatBytes, toHex } from "./whisper-wasm";
import { sdpToCode, codeToSdp } from "./whisper-live-sdp";

import {
  type CampfireState,
  type CampfireRole,
  type CampfireCallbacks,
  type CampfirePeer,
  type GroupKeyEpoch,
  type SubCampfire,
  ContentType,
  CAMPFIRE_FLAG,
  PEER_ID_LEN,
  GROUP_KEY_LEN,
  MSG_ID_LEN,
  ROOT_HEARTBEAT_INTERVAL,
  ROOT_HEARTBEAT_TIMEOUT,
  KEY_GRACE_PERIOD,
  DEDUP_RING_SIZE,
  MAX_HOP_COUNT,
} from "./campfire-types";

import { CampfireTopology } from "./campfire-topology";

import {
  buildRootHeartbeat,
  buildGroupMsg,
  rewrapGroupMsg,
  buildGroupKey,
  buildPeerList,
  buildJoinAnnounce,
  buildLeaveAnnounce,
  buildSdpRelay,
  buildDmSdpRelay,
  buildSubInvite,
  buildSubSdp,
  parseRootHeartbeat,
  parseGroupMsgHeader,
  decryptGroupMsg,
  parseJoinAnnounce,
  parseLeaveAnnounce,
  parseSdpRelay,
  parseGroupKey,
  parsePeerList,
  parseDmSdpRelay,
  parseSubInvite,
  parseSubSdp,
} from "./campfire-wire";

import {
  CF_ROOT_HEARTBEAT,
  CF_GROUP_MSG,
  CF_JOIN_ANNOUNCE,
  CF_LEAVE_ANNOUNCE,
  CF_SDP_RELAY,
  CF_GROUP_KEY,
  CF_PEER_LIST,
  CF_DM_SDP_RELAY,
  CF_SUB_INVITE,
  CF_SUB_SDP,
} from "./campfire-types";

/* ═══════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════ */

const ZERO_SALT_32 = new Uint8Array(32);
const GROUP_KEY_INFO = TE.encode("campfire-group-v1");
const ROTATE_KEY_INFO = TE.encode("campfire-rotate");
const SUB_KEY_INFO = TE.encode("campfire-sub-v1");

/** SDP type codes used in relay messages. */
const SDP_OFFER = 0x01;
const SDP_ANSWER = 0x02;

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
  private topology: CampfireTopology | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Peer-only state
  private lastRootHeartbeat = 0;
  private heartbeatWatchTimer: ReturnType<typeof setInterval> | null = null;

  // Gossip dedup
  private seenMsgIds: string[] = [];
  private seenMsgSet = new Set<string>();

  // DM side-channels
  private dmSessions = new Map<string, WhisperLiveSession>();
  private pendingDmSdp = new Map<string, { session: WhisperLiveSession; isOfferer: boolean }>();

  // Sub-campfires
  private subCampfires = new Map<string, SubCampfire>();

  // RTC config
  private useStun = false;

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

    // Initialize topology
    this.topology = new CampfireTopology(this.peerId);

    // Generate group key
    const seed = randomBytes(32);
    const groupKey = await hkdf(seed, ZERO_SALT_32, GROUP_KEY_INFO, GROUP_KEY_LEN);
    seed.fill(0);
    this.currentEpoch = { epoch: 1, key: groupKey, expiresAt: Infinity };

    // Add self to peer list
    this.allPeers.set(this.peerIdHex, { peerId: this.peerId, name: this.displayName });

    // Create a WhisperLiveSession for the initial connection (Root waits for first peer)
    const rootSession = this.createNeighborSession("root-initial");

    const offerCode = await rootSession.createOffer();
    this.setState("waiting");
    this.log("room ready, share the code");

    // Store pending session, will be assigned to joining peer
    this._pendingRootSession = rootSession;
    this._pendingRootOffer = offerCode;

    // Start heartbeat
    this.startRootHeartbeat();

    return offerCode;
  }

  private _pendingRootSession: WhisperLiveSession | null = null;
  private _pendingRootOffer: string | null = null;

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
    this.setState("connecting");
    this.log("joining room...");

    // Create session to Root
    const session = this.createNeighborSession("join-root");
    const answerCode = await session.acceptOffer(offerCode);

    // Session will auto-confirm fingerprint and go live
    // Root will send PEER_LIST + GROUP_KEY once connected

    return answerCode;
  }

  /* ── Neighbor Session Factory ──────────────────────────── */

  private createNeighborSession(label: string): WhisperLiveSession {
    const callbacks: WhisperLiveCallbacks = {
      onStateChange: (state, detail) => {
        this.log(`[${label}] ${state}${detail ? `: ${detail}` : ""}`);
        if (state === "live") {
          this.handleNeighborConnected(label, session);
        } else if (state === "disconnected" || state === "error") {
          this.handleNeighborDisconnected(label);
        }
      },
      onFingerprint: () => {},
      onMessage: () => {},
      onLog: (line) => this.log(`[${label}] ${line}`),
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
    if (this.role === "root" && label === "root-initial") {
      // First peer joined, store as neighbor
      // We'll get their peerId from the first message they send
      // For now, generate a temporary ID. Root will assign real ID via PEER_LIST exchange
      const tempId = randomBytes(PEER_ID_LEN);
      const tempHex = toHex(tempId);
      this.neighbors.set(tempHex, {
        peerId: tempId,
        peerIdHex: tempHex,
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

      if (this._state !== "active") {
        this.setState("active");
        this.log("connected to room");
      }
    } else {
      // Additional neighbor connected (topology expansion)
      this.neighbors.set(label, {
        peerId: new Uint8Array(PEER_ID_LEN),
        peerIdHex: label,
        name: label,
        session,
        connected: true,
        joinedAt: Date.now(),
      });
      this.log(`neighbor ${label} connected`);
    }
  }

  private handleNeighborDisconnected(label: string): void {
    const neighbor = this.neighbors.get(label);
    if (neighbor) {
      neighbor.connected = false;
      this.neighbors.delete(label);
      this.log(`neighbor ${label} disconnected`);
    }

    // If root peer loses connection, check if there are any neighbors left
    if (this.role === "root") {
      if (this.neighbors.size === 0 && this._state === "active") {
        // All peers gone, but Root stays active (waiting for new joiners)
      }
    } else {
      // If peer lost root connection
      if (label === "join-root" || label === "root") {
        // Root is gone, campfire ends
        this.log("lost connection to root");
        this.endCampfire("root disconnected. the fire is out. nothing remains.");
      }
    }
  }

  /* ── Root: Prepare Next Connection Slot ─────────────── */

  private async prepareNextRootSlot(): Promise<void> {
    if (this.role !== "root") return;

    const session = this.createNeighborSession("root-initial");
    try {
      const offerCode = await session.createOffer();
      this._pendingRootSession = session;
      this._pendingRootOffer = offerCode;
      // In a real deployment, Root would update the room code.
      // Here we re-use the same pattern. The UI will show "new peers can join"
    } catch (err) {
      this.log(`failed to prepare next slot: ${err instanceof Error ? err.message : "unknown"}`);
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

  /* ── Broadcast Message (User Action) ──────────────────── */

  async broadcastText(text: string): Promise<void> {
    if (this._state !== "active" || !this.currentEpoch) return;

    const plaintext = TE.encode(text);
    const msgId = await sha256(concatBytes(this.peerId, randomBytes(16), plaintext));

    const wire = await buildGroupMsg(
      msgId, this.peerId, this.displayName,
      Date.now(), 0, this.currentEpoch.epoch,
      ContentType.Text, plaintext, this.currentEpoch.key,
    );

    this.markSeen(msgId);
    await this.broadcastToNeighbors(wire);

    // Show locally
    this.cb.onMessage({
      msgId,
      senderId: this.peerId,
      senderIdHex: this.peerIdHex,
      senderName: this.displayName,
      timestamp: Date.now(),
      hopCount: 0,
      epoch: this.currentEpoch.epoch,
      contentType: ContentType.Text,
      plaintext,
    });
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
        this.handleRootHeartbeat(payload);
        break;
      case CF_GROUP_MSG:
        await this.handleGroupMsg(payload, fromLabel);
        break;
      case CF_JOIN_ANNOUNCE:
        this.handleJoinAnnounce(payload, fromLabel);
        break;
      case CF_LEAVE_ANNOUNCE:
        this.handleLeaveAnnounce(payload, fromLabel);
        break;
      case CF_SDP_RELAY:
        await this.handleSdpRelay(payload);
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
      case CF_SUB_INVITE:
        this.handleSubInvite(payload);
        break;
      case CF_SUB_SDP:
        await this.handleSubSdp(payload);
        break;
      default:
        this.log(`unknown sub-type: 0x${subType.toString(16)}`);
    }
  }

  /* ── Message Handlers ──────────────────────────────────── */

  private handleRootHeartbeat(data: Uint8Array): void {
    const hb = parseRootHeartbeat(data);
    this.lastRootHeartbeat = Date.now();

    // Forward to other neighbors (gossip)
    const wire = concatBytes(new Uint8Array([CF_ROOT_HEARTBEAT]), data);
    // We need to re-broadcast but the buildRootHeartbeat already built the full payload
    // Just broadcast the raw message including sub-type byte
    const fullMsg = concatBytes(new Uint8Array([CF_ROOT_HEARTBEAT]), data);
    // Mark as seen using rootPeerId + epoch as dedup key
    const dedupKey = concatBytes(hb.rootPeerId, new Uint8Array(new Uint32Array([hb.epoch]).buffer));
    if (this.hasSeen(dedupKey)) return;
    this.markSeen(dedupKey);

    this.broadcastToNeighbors(fullMsg);
  }

  private async handleGroupMsg(data: Uint8Array, fromLabel: string): Promise<void> {
    const parsed = parseGroupMsgHeader(data);

    // Dedup
    if (this.hasSeen(parsed.msgId)) return;
    this.markSeen(parsed.msgId);

    // Hop limit
    if (parsed.hopCount >= MAX_HOP_COUNT) {
      this.log("message dropped, max hops exceeded");
      return;
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
        this.log("group message decryption failed");
        return;
      }
    } else {
      this.log(`no key for epoch ${parsed.epoch}`);
      return;
    }

    // Deliver to UI
    this.cb.onMessage({
      msgId: parsed.msgId,
      senderId: parsed.senderId,
      senderIdHex: toHex(parsed.senderId),
      senderName: parsed.senderName,
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

  private handleJoinAnnounce(data: Uint8Array, fromLabel: string): void {
    const { peerId, name } = parseJoinAnnounce(data);
    const hex = toHex(peerId);

    if (hex === this.peerIdHex) return; // ignore our own join
    if (this.allPeers.has(hex)) return; // already known

    this.allPeers.set(hex, { peerId: new Uint8Array(peerId), name });
    this.cb.onPeerJoin(peerId, name);
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
    this.log(`${name} joined the room`);

    // Forward gossip
    const wire = buildJoinAnnounce(peerId, name);
    this.broadcastToNeighbors(wire, fromLabel);
  }

  private handleLeaveAnnounce(data: Uint8Array, fromLabel: string): void {
    const { peerId } = parseLeaveAnnounce(data);
    const hex = toHex(peerId);

    if (!this.allPeers.has(hex)) return;

    const peer = this.allPeers.get(hex);
    this.allPeers.delete(hex);
    this.cb.onPeerLeave(peerId);
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
    this.log(`${peer?.name ?? hex.slice(0, 8)} left the room`);

    // Forward gossip
    const wire = buildLeaveAnnounce(peerId);
    this.broadcastToNeighbors(wire, fromLabel);
  }

  private async handleSdpRelay(data: Uint8Array): Promise<void> {
    const { targetPeerId, sdpType, sdpCode } = parseSdpRelay(data);
    const targetHex = toHex(targetPeerId);

    if (targetHex === this.peerIdHex) {
      // This SDP is for us, handle it
      await this.handleIncomingSdp(sdpType, sdpCode, "relay");
    } else if (this.role === "root") {
      // Root relays to the target peer
      const targetPeer = this.findNeighborByHex(targetHex);
      if (targetPeer?.session) {
        const wire = buildSdpRelay(targetPeerId, sdpType, sdpCode);
        await this.sendToNeighbor(targetPeer.session, wire);
      }
    }
  }

  private handleGroupKeyMsg(data: Uint8Array): void {
    const { epoch, groupKey } = parseGroupKey(data);
    this.log(`received group key epoch ${epoch}`);

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
      if (!this.allPeers.has(hex)) {
        this.allPeers.set(hex, { peerId: new Uint8Array(p.peerId), name: p.name });
      }
    }
    this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
    this.log(`peer list updated: ${this.allPeers.size} peers`);
  }

  private async handleDmSdpRelay(data: Uint8Array, fromLabel: string): Promise<void> {
    const { targetPeerId, sdpType, sdpCode } = parseDmSdpRelay(data);
    const targetHex = toHex(targetPeerId);

    if (targetHex === this.peerIdHex) {
      // DM SDP is for us
      await this.handleIncomingDmSdp(sdpType, sdpCode, fromLabel);
    } else if (this.role === "root") {
      // Root relays DM SDP
      const targetPeer = this.findNeighborByHex(targetHex);
      if (targetPeer?.session) {
        const wire = buildDmSdpRelay(targetPeerId, sdpType, sdpCode);
        await this.sendToNeighbor(targetPeer.session, wire);
      }
    } else {
      // Forward through mesh
      await this.broadcastToNeighbors(buildDmSdpRelay(targetPeerId, sdpType, sdpCode), fromLabel);
    }
  }

  private handleSubInvite(data: Uint8Array): void {
    const { subId, inviterPeerId, invitees } = parseSubInvite(data);
    this.cb.onSubCampfireInvite(subId, inviterPeerId, invitees);
  }

  private async handleSubSdp(data: Uint8Array): Promise<void> {
    const { subId, targetPeerId, sdpType, sdpCode } = parseSubSdp(data);
    const targetHex = toHex(targetPeerId);

    if (targetHex === this.peerIdHex) {
      // Sub SDP is for us
      await this.handleIncomingSubSdp(subId, sdpType, sdpCode);
    } else if (this.role === "root") {
      // Relay
      const targetPeer = this.findNeighborByHex(targetHex);
      if (targetPeer?.session) {
        await this.sendToNeighbor(targetPeer.session, buildSubSdp(subId, targetPeerId, sdpType, sdpCode));
      }
    }
  }

  /* ── SDP Handling ──────────────────────────────────────── */

  private async handleIncomingSdp(sdpType: number, sdpCode: string, label: string): Promise<void> {
    if (sdpType === SDP_OFFER) {
      // Someone is offering to connect to us
      const session = this.createNeighborSession(`neighbor-${label}`);
      const answerCode = await session.acceptOffer(sdpCode);
      // Send answer back through the mesh
      await this.broadcastToNeighbors(buildSdpRelay(this.peerId, SDP_ANSWER, answerCode));
    } else if (sdpType === SDP_ANSWER) {
      // We get an answer for our pending offer
      // Find pending session and apply
      for (const [, pending] of this.pendingDmSdp) {
        if (pending.isOfferer) {
          await pending.session.applyAnswer(sdpCode);
          break;
        }
      }
    }
  }

  private async handleIncomingDmSdp(sdpType: number, sdpCode: string, fromLabel: string): Promise<void> {
    if (sdpType === SDP_OFFER) {
      const session = this.createDmSession(fromLabel);
      const answerCode = await session.acceptOffer(sdpCode);
      // Send DM answer back
      // Determine sender peerId from fromLabel
      const fromPeer = this.neighbors.get(fromLabel);
      if (fromPeer?.session) {
        await this.sendToNeighbor(fromPeer.session, buildDmSdpRelay(this.peerId, SDP_ANSWER, answerCode));
      }
    } else if (sdpType === SDP_ANSWER) {
      const pending = this.pendingDmSdp.get(fromLabel);
      if (pending?.isOfferer) {
        await pending.session.applyAnswer(sdpCode);
        this.pendingDmSdp.delete(fromLabel);
      }
    }
  }

  private async handleIncomingSubSdp(_subId: Uint8Array, _sdpType: number, _sdpCode: string): Promise<void> {
    // Sub-campfire SDP handling, similar pattern to DM SDP
    // Implementation deferred to sub-campfire creation flow
    this.log("sub-room sdp received");
  }

  /* ── DM Side-Channels ──────────────────────────────────── */

  /** Initiate a DM with a specific peer by their hex ID. */
  async startDm(targetPeerIdHex: string): Promise<void> {
    if (this.dmSessions.has(targetPeerIdHex)) {
      this.log("dm session already open");
      return;
    }

    const session = this.createDmSession(targetPeerIdHex);
    const offerCode = await session.createOffer();
    this.pendingDmSdp.set(targetPeerIdHex, { session, isOfferer: true });

    // Find target peerId bytes
    const target = this.allPeers.get(targetPeerIdHex);
    if (!target) {
      this.log("target peer not found");
      return;
    }

    // Send DM SDP relay through the mesh
    await this.broadcastToNeighbors(buildDmSdpRelay(target.peerId, SDP_OFFER, offerCode));
    this.log(`dm started with ${target.name}`);
  }

  /** Send a DM text to a peer. */
  async sendDmText(targetPeerIdHex: string, text: string): Promise<void> {
    const session = this.dmSessions.get(targetPeerIdHex);
    if (!session) {
      this.log("no dm session");
      return;
    }
    await session.sendText(text);
  }

  private createDmSession(peerIdHex: string): WhisperLiveSession {
    const callbacks: WhisperLiveCallbacks = {
      onStateChange: (state) => {
        if (state === "live") {
          const pending = this.pendingDmSdp.get(peerIdHex);
          if (pending) {
            this.dmSessions.set(peerIdHex, pending.session);
            this.pendingDmSdp.delete(peerIdHex);
          }
          this.log(`dm live with ${peerIdHex.slice(0, 8)}`);
        }
      },
      onFingerprint: () => {},
      onMessage: (msg) => {
        if (msg.type === "text" && msg.text) {
          const peerId = this.allPeers.get(peerIdHex)?.peerId ?? new Uint8Array(PEER_ID_LEN);
          this.cb.onDmMessage(peerId, { type: "text", text: msg.text, timestamp: msg.timestamp });
        }
      },
      onLog: (line) => this.log(`[dm ${peerIdHex.slice(0, 8)}] ${line}`),
    };

    return new WhisperLiveSession(callbacks, {
      rtcConfig: this.rtcConfig,
      autoConfirmFingerprint: true,
    });
  }

  /* ── Sub-Campfires ─────────────────────────────────────── */

  /** Root: create a sub-campfire with selected peers. */
  async createSubCampfire(inviteePeerIds: Uint8Array[]): Promise<Uint8Array | null> {
    if (this.role !== "root") {
      this.log("only root can split rooms");
      return null;
    }

    const subId = randomBytes(PEER_ID_LEN);
    const subHex = toHex(subId);

    // Derive sub-group key from parent key + subId
    if (!this.currentEpoch) return null;
    const subKey = await hkdf(
      concatBytes(this.currentEpoch.key, subId),
      ZERO_SALT_32, SUB_KEY_INFO, GROUP_KEY_LEN,
    );

    const sub: SubCampfire = {
      subId,
      subIdHex: subHex,
      members: new Map(),
      groupKey: subKey,
      epoch: 1,
    };
    this.subCampfires.set(subHex, sub);

    // Send invites through the mesh
    const wire = buildSubInvite(subId, this.peerId, inviteePeerIds);
    await this.broadcastToNeighbors(wire);

    this.log(`sub-room ${subHex.slice(0, 8)} created, ${inviteePeerIds.length} invited`);
    return subId;
  }

  /* ── Root Heartbeat ────────────────────────────────────── */

  private startRootHeartbeat(): void {
    this.stopRootHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (this._state !== "active" && this._state !== "waiting") return;
      const epoch = this.currentEpoch?.epoch ?? 0;
      const wire = buildRootHeartbeat(epoch, this.allPeers.size, this.peerId);
      await this.broadcastToNeighbors(wire);
    }, ROOT_HEARTBEAT_INTERVAL);
  }

  private stopRootHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /* ── Peer Heartbeat Watch ──────────────────────────────── */

  private startHeartbeatWatch(): void {
    this.stopHeartbeatWatch();
    this.lastRootHeartbeat = Date.now();
    this.heartbeatWatchTimer = setInterval(() => {
      if (this._state !== "active") return;
      if (Date.now() - this.lastRootHeartbeat > ROOT_HEARTBEAT_TIMEOUT) {
        this.log("root heartbeat lost, session ending");
        this.endCampfire("root went silent. the fire is out. nothing remains.");
      }
    }, ROOT_HEARTBEAT_INTERVAL);
  }

  private stopHeartbeatWatch(): void {
    if (this.heartbeatWatchTimer) { clearInterval(this.heartbeatWatchTimer); this.heartbeatWatchTimer = null; }
  }

  /* ── Group Key Rotation ────────────────────────────────── */

  /** Root: rotate the group key (on join/leave). */
  private async rotateGroupKey(event: string): Promise<void> {
    if (this.role !== "root" || !this.currentEpoch) return;

    const eventHash = await sha256(TE.encode(event));
    const newKey = await hkdf(
      concatBytes(this.currentEpoch.key, eventHash),
      ZERO_SALT_32, ROTATE_KEY_INFO, GROUP_KEY_LEN,
    );

    this.previousEpoch = {
      ...this.currentEpoch,
      expiresAt: Date.now() + KEY_GRACE_PERIOD,
    };

    this.currentEpoch = {
      epoch: this.currentEpoch.epoch + 1,
      key: newKey,
      expiresAt: Infinity,
    };

    // Distribute new key to all neighbors
    for (const [, peer] of this.neighbors) {
      if (peer.session && peer.connected) {
        await this.sendGroupKey(peer.session, this.currentEpoch.epoch, this.currentEpoch.key);
      }
    }

    this.log(`group key rotated to epoch ${this.currentEpoch.epoch}`);
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
  endCampfire(reason?: string): void {
    if (this._state === "ended" || this._state === "idle") return;

    if (this.role === "root") {
      // Broadcast leave announce for root
      const wire = buildLeaveAnnounce(this.peerId);
      this.broadcastToNeighbors(wire);
    }

    this.stopRootHeartbeat();
    this.stopHeartbeatWatch();

    // Disconnect all neighbors
    for (const [, peer] of this.neighbors) {
      peer.session?.disconnect();
    }
    this.neighbors.clear();

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

    // Wipe sub-campfire keys
    for (const [, sub] of this.subCampfires) {
      sub.groupKey.fill(0);
    }
    this.subCampfires.clear();

    this.allPeers.clear();
    this.seenMsgIds = [];
    this.seenMsgSet.clear();

    this.setState("ended", reason ?? "session ended");
    this.log(reason ?? "session ended");
  }

  /** Full cleanup, called when leaving the page. */
  destroy(): void {
    this.endCampfire();
    this._state = "idle";
  }
}
