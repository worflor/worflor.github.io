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
  generateIdentity, generateAgreementKey, signBytes, verifyAuthored,
  sealToAgreement, openFromAgreement, PUBKEY_LEN,
  type CampfireIdentity,
} from "./identity";

/** binds a seal to its purpose, so a fold copy cannot be replayed as anything else. */
const INFO_FOLD_ENTROPY = TE.encode("kizuna-fold-entropy-v1");

import {
  braidFold,
  braidInit,
  braidSeal,
  braidOpen,
  braidWants,
  braidWipe,
  type BraidMessage,
  parseFrontier,
} from "../live-braid";
import { evictBelowFloor, purgeDead, meetOf } from "../retention";

import {
  sortRoster,
  computeTopology,
  neighborsOf,
  edgeOfferer,
} from "./topology";

import {
  type GroupMsgFacts,
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
  MAX_DRAINING_EPOCHS,
  MAX_RETAINED_FOLDS,
  MAX_KNOWN_PEERS,
  REACT_DEDUP_RING,
  FOLD_PUSH_INTERVAL,
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
  groupMsgSigningBody,
  rewrapGroupMsg,
  buildPeerList,
  buildJoinAnnounce,
  buildLeaveAnnounce,
  buildSdpRelay,
  buildDmSdpRelay,
  buildRingWant,
  buildCfReact,
  buildBraidFold,
  braidFoldSigningBody,
  foldRecipientFor,
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


const FOLD_REASON_JOIN = 1;
const FOLD_REASON_LEAVE = 2;
/**
 * A self-issued, membership-preserving fold: the HEALING operation.
 *
 * Everything else in this file protects secrets that an attacker does not yet
 * have. This one assumes it already lost: a seat's whole state is in hostile
 * hands, including every lane chain (they all derive from the shared root) and
 * therefore the entire circle's traffic. Nothing about the roster is wrong, so
 * no join or leave will fire, and the epoch root only ever moved on membership
 * change — which is why compromise used to be permanent.
 *
 * The seat rotates its own agreement key and folds fresh entropy sealed to the
 * NEW key. An attacker holding the old key cannot open its copy, cannot learn
 * the entropy, and therefore cannot follow the root forward. The seat keeps its
 * identity throughout, because peerId commits to the SIGNING key and only the
 * agreement half moves.
 *
 * HONEST LIMIT, same as MLS: this heals the seat that updates. If seat B is
 * compromised and seat A updates, the new entropy is still sealed to B's old
 * (compromised) key, so the attacker follows along. B must update, or be removed.
 */
const FOLD_REASON_UPDATE = 3;

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

  // this seat's signing identity. peerId is the hash of identity.publicKey, so
  // the roster doubles as a set of public-key commitments and a fold's author
  // can be checked against the seat the epoch says is elder.
  private identity: CampfireIdentity | null = null;
  private peerIdHex = "";
  private displayName = "";

  // Braid epoch state — replaces the old root-distributed symmetric group key.
  private currentEpoch: BraidEpoch | null = null;
  // outgoing epochs kept alive so messages already in flight when the roster
  // turned still open. a single slot stranded them whenever two folds landed
  // inside one grace window, which is exactly what a pair of quick departures
  // looks like, so keep a bounded ring keyed by epoch id.
  private draining = new Map<number, { epoch: BraidEpoch; expiresAt: number }>();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  // Neighbor sessions (pairwise WebRTC links)
  private neighbors = new Map<string, CampfirePeer>();

  // Full peer list (all campfire members, not just neighbors)
  // agreementKey is what fold entropy is sealed to, per recipient. a seat whose
  // key we do not know cannot be sealed to, so it cannot be folded with.
  private allPeers = new Map<string, { peerId: Uint8Array; agreementKey: Uint8Array; name: string }>();

  // Root-only bootstrap slot state (root remains the sole admission entry point)
  private rootSlotCounter = 0;
  /** resolvers awaiting the next freshly minted root offer; see nextOfferCode. */
  private offerWaiters: Array<(code: string) => void> = [];

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

  // folds this seat has already APPLIED, kept so a neighbor that fell behind
  // can be caught up. losing a topology hub can partition the mesh before
  // reconnection heals it, and the fold that turned the roster is gone from the
  // network by then; without a retained copy the stranded seat never recovers.
  // memory only, bounded, zeroized on teardown.
  private appliedFolds = new Map<number, ParsedBraidFold>();

  /**
   * Highest epoch we have EVIDENCE each seat has reached.
   *
   * This is an epoch vector clock over the roster, and its minimum is the floor
   * below which a retained fold can never be asked for again. `appliedFolds`
   * exists solely to serve `pushFoldsTo`, whose consumer is a lagging seat that
   * needs a CONTIGUOUS run of folds from its own epoch forward, because
   * applyBraidFold advances by exactly one and refuses anything else. Evicting
   * by count instead of by that floor strands the seat permanently: one missing
   * link and every later fold it receives sits inert forever, with no path back
   * short of leaving and rejoining.
   *
   * Same shape as the store watermark. The consumer is ordered by epoch, so the
   * eviction has to be ordered by epoch too, and the safe cut is the meet.
   */
  private peerEpoch = new Map<string, number>();

  /**
   * Each peer's last DECLARED frontier, indexed by seat.
   *
   * Every group message carries its sender's frontier, so this is free evidence
   * of how far each peer has got through every strand. It is exactly the demand
   * vector the repair cache is searched by, and its meet is the floor below
   * which no RING_WANT can ever arrive.
   */
  private peerFrontier = new Map<string, Uint32Array>();

  /**
   * Repair requests already in flight, keyed (epoch, seat, fromSeq) -> asked at.
   *
   * A want is a QUESTION, and re-asking one that is still outstanding is pure
   * amplification: every held message re-broadcast a want for the same gaps, a
   * neighbour answered each by RESENDING the missing frames, and those resends
   * re-flooded the mesh. A seat with a deep backlog therefore generated load
   * proportional to its backlog times its neighbours times the hop limit.
   *
   * The suppression follows the same rule as every other bounded structure here:
   * a want is dead once the gap it names is filled, which is exactly when our
   * own frontier passes it. So entries are dropped along the frontier order, and
   * re-asked only after the repair interval, never on every arriving frame.
   */
  private outstandingWants = new Map<string, number>();

  // last time we walked each neighbor forward, so a chatty lagging seat cannot
  // make us re-send the same folds on every frame it emits.
  private lastFoldPush = new Map<string, number>();

  // Joiners we've already kicked off admission for (issued a fold, or relayed a JOIN_REQ),
  // guarding against redundant work while gossip settles — cleared once the fold lands.
  private pendingJoinReqs = new Set<string>();

  // how many times we have asked an elder to admit each joiner. gossip dedups by
  // payload hash, so a retry has to differ in at least one byte to travel at all.
  private joinReqAttempts = new Map<string, number>();

  // join requests we saw but could not act on because we were not the elder at
  // that instant. an elder change is not atomic: a request can arrive at the
  // seat that is ABOUT to inherit, before that seat has applied the fold making
  // it elder, and there is no second event to re-drive it. holding the subject
  // turns a one-shot signal into something we can act on once we do inherit.
  private relayedJoinReqs = new Map<string, Uint8Array>();

  // the epoch at which each seat most recently ENTERED the roster. a fold's
  // entropy is the secret that advances the root, so serving one to a peer for
  // an epoch it was not part of hands it the arithmetic to reconstruct exactly
  // the traffic it was excluded from.
  private seatedSince = new Map<string, number>();

  // Gossip dedup (shared ring: GROUP_MSG msgIds, BRAID_FOLD/RING_WANT/SDP content hashes)
  private seenMsgIds: string[] = [];
  private seenMsgSet = new Set<string>();
  // React dedup — key: "{senderHex}:{react|unreact}:{targetMsgIdHex}:{emoji}"
  private seenReacts = new Set<string>();
  private seenReactRing: string[] = [];

  // Ring/repair state
  private recentBySeq = new Map<string, Uint8Array>();
  private repairTimer: ReturnType<typeof setInterval> | null = null;

  // Auto-beacon state
  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  private receivedSinceOwnSend = 0;
  private lastOwnSendAt = 0;

  // Display metadata for delivered braid messages, keyed `${epochId}:${senderIdx}:${seq}`.

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
  // recovery cadences (ring repair + auto-beacon), injectable so tests drive
  // them fast and deterministically instead of racing the real wall clock,
  // which starves and flakes under full-suite load. production keeps the real
  // values; nothing but a test ever passes these.
  private ringRepairIntervalMs: number;
  private beaconCheckMs: number;
  private beaconIdleMs: number;

  constructor(callbacks: CampfireCallbacks, options?: {
    sessionFactory?: CampfireSessionFactory;
    ringRepairIntervalMs?: number;
    beaconCheckMs?: number;
    beaconIdleMs?: number;
  }) {
    this.cb = callbacks;
    this.sessionFactory = options?.sessionFactory ?? defaultSessionFactory;
    this.ringRepairIntervalMs = options?.ringRepairIntervalMs ?? RING_REPAIR_INTERVAL;
    this.beaconCheckMs = options?.beaconCheckMs ?? BEACON_CHECK_INTERVAL;
    this.beaconIdleMs = options?.beaconIdleMs ?? BEACON_IDLE_MS;
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
    this.identity = await generateIdentity();
    this.peerId = this.identity.peerId;
    this.peerIdHex = this.identity.peerIdHex;
    this.displayName = name;
    this.setState("creating");
    this.log("creating room...");

    // genesis: fold seat zero into existence and seat ourselves in epoch 1.
    const entropy = randomBytes(32);
    const roster = [this.peerIdHex];
    const root = await braidFold(null, entropy, 1, roster);
    entropy.fill(0);
    const braid = await braidInit<GroupMsgFacts>(root, 1, roster, this.peerIdHex);
    this.currentEpoch = { epochId: 1, roster, root, braid };
    this.lastOwnSendAt = Date.now();

    // Add self to peer list
    this.allPeers.set(this.peerIdHex, { peerId: this.peerId, agreementKey: this.identity.agreement.publicKey, name: this.displayName });

    // Create a session for the initial connection (host waits for first peer)
    const rootSession = this.createNeighborSession(this.nextRootSlotLabel());

    const offerCode = await rootSession.createOffer();
    this.setState("waiting");
    this.log("room ready, share the code");

    // Store pending session, will be assigned to joining peer
    this._pendingRootSession = rootSession;
    this.publishOfferCode(offerCode);

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
    this.identity = await generateIdentity();
    this.peerId = this.identity.peerId;
    this.peerIdHex = this.identity.peerIdHex;
    this.displayName = name;
    this.allPeers.set(this.peerIdHex, { peerId: this.peerId, agreementKey: this.identity.agreement.publicKey, name: this.displayName });
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

      void this.sendToNeighbor(session, buildJoinAnnounce(this.peerId, this.identity!.agreement.publicKey, this.displayName));
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
      this.publishOfferCode(offerCode);
    } catch (err) {
      this.log(`failed to prepare next connection: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  /** Root: get current offer code for new joiners. */
  getCurrentOfferCode(): string | null {
    return this._pendingRootOffer;
  }

  /**
   * Resolves the next time a fresh root offer is minted.
   *
   * The node already knows the exact instant this happens, so anyone waiting for
   * it should be told rather than left to ask. The flare transport used to poll
   * `getCurrentOfferCode()` every 120ms for up to twelve seconds, which is the
   * same question asked eighty times against a clock that has nothing to do with
   * the answer, and which added up to a poll interval of dead time to every
   * offer rotation.
   */
  nextOfferCode(): Promise<string> {
    return new Promise((resolve) => { this.offerWaiters.push(resolve); });
  }

  /** Single place a fresh root offer becomes visible: store, announce, wake waiters. */
  private publishOfferCode(offerCode: string): void {
    this._pendingRootOffer = offerCode;
    this.cb.onRoomCodeUpdate?.(offerCode);
    const waiting = this.offerWaiters;
    this.offerWaiters = [];
    for (const resolve of waiting) resolve(offerCode);
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

  /** a position in the mesh's shared record is (epoch, seat, seq). every fold
   *  restarts each strand at 1, so the epoch is part of the identity of a slot,
   *  not decoration: without it a repair can answer with a previous epoch's
   *  frame, and two honest frames look like an equivocation. */
  private rememberRecent(epochId: number, senderHex: string, seq: number, rawGroupPayload: Uint8Array): void {
    const key = `${epochId}:${senderHex}:${seq}`;
    const full = concatBytes(new Uint8Array([CF_GROUP_MSG]), rawGroupPayload);
    this.recentBySeq.set(key, full);
    // Dead means: this epoch is closed, or every peer has already passed this
    // slot in that seat's strand. Insertion order only breaks ties among those.
    const currentEpochId = this.currentEpoch?.epochId ?? 0;
    evictBelowFloor(this.recentBySeq, DEDUP_RING_SIZE, (k) => {
      const [epochPart, seatHex, seqPart] = k.split(":");
      const epoch = Number(epochPart);
      if (epoch < currentEpochId) return true; // a closed epoch is never repaired
      if (epoch > currentEpochId) return false;
      return Number(seqPart) <= this.repairFloor(seatHex);
    });
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

    const timestamp = Date.now();
    const authored = await this.signGroupMsg(
      sealed.seq, epochId, timestamp, ContentType.Text, sealed.confirm, sealed.frontier, sealed.ciphertext,
    );
    const wire = buildGroupMsg(
      msgId, this.peerId, sealed.seq, epochId, timestamp, 0, ContentType.Text,
      sealed.confirm, sealed.frontier, sealed.ciphertext, authored.authorPublicKey, authored.signature,
    );

    this.markSeen(msgId);
    this.rememberRecent(epochId, this.peerIdHex, sealed.seq, wire.subarray(1));
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
    this.markReactSeen(`${this.peerIdHex}:${action}:${targetHex}:${emoji}`);
    await this.broadcastToNeighbors(wire);
  }

  /* ── Gossip Dedup ──────────────────────────────────────── */

  /** remember a reaction id under a bound. the id embeds an attacker-chosen
   *  emoji string, so an unbounded set grows without limit in both cardinality
   *  and per-entry size; it was only ever cleared on destroy. */
  private markReactSeen(key: string): void {
    if (this.seenReacts.has(key)) return;
    if (this.seenReactRing.length >= REACT_DEDUP_RING) {
      const oldest = this.seenReactRing.shift()!;
      this.seenReacts.delete(oldest);
    }
    this.seenReactRing.push(key);
    this.seenReacts.add(key);
  }

  /** admit a peer into the directory under a bound. JOIN_ANNOUNCE and PEER_LIST
   *  are neither authenticated nor roster-checked, and every new entry is
   *  re-gossiped, so this is remote-controlled growth. seats in the current
   *  roster are never evicted: they are the ones we actually need. */
  private rememberPeer(hex: string, peerId: Uint8Array, agreementKey: Uint8Array, name: string): boolean {
    if (!this.allPeers.has(hex) && this.allPeers.size >= MAX_KNOWN_PEERS) {
      const roster = this.currentEpoch?.roster;
      let evicted: string | null = null;
      for (const known of this.allPeers.keys()) {
        if (known === this.peerIdHex) continue;
        if (roster?.includes(known)) continue;
        evicted = known;
        break;
      }
      if (!evicted) return false; // every slot is a seated peer; refuse the newcomer
      this.allPeers.delete(evicted);
    }
    this.allPeers.set(hex, { peerId, agreementKey, name });
    return true;
  }

  /** seal-time authorship. The epoch root is shared, so every member can derive
   *  every seat's chain and could otherwise forge a frame that is byte-for-byte
   *  indistinguishable from another seat's. Confidentiality is symmetric by
   *  necessity (a receiver has to DERIVE the sender's key), so authenticity has
   *  to come from somewhere the root cannot reach: the sender's own key.
   *
   *  TRADEOFF, deliberate: a signature is transferable, so this weakens
   *  deniability. The alternative that keeps it is a per-recipient MAC under a
   *  pairwise secret, which costs O(roster) bytes on every message. This follows
   *  MLS in choosing signatures. */
  private async signGroupMsg(
    seq: number, epochId: number, timestamp: number, contentType: number,
    confirm: Uint8Array, frontier: Uint8Array, ciphertext: Uint8Array,
  ): Promise<{ authorPublicKey: Uint8Array; signature: Uint8Array }> {
    if (!this.identity) throw new Error("cannot sign without an identity");
    const body = groupMsgSigningBody(
      this.peerId, seq, epochId, timestamp, contentType, confirm, frontier, ciphertext,
      this.identity.publicKey,
    );
    return { authorPublicKey: this.identity.publicKey, signature: await signBytes(this.identity, body) };
  }

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
    // relay-supplied bytes: a frame that does not contain what it claims is
    // dropped here rather than trusted field by field.
    const parsed = parseGroupMsgHeader(data);
    if (!parsed) return;

    // The msgId is a pure function of (senderId, epochId, seq, ciphertext), so
    // recompute it rather than trusting the frame's own claim. Trusting it let a
    // relay pick any id it liked: emit a garbage frame carrying the msgId of a
    // message it had just seen, and the victim marks that id seen, fails to open
    // the forgery, and then discards the GENUINE copy as a duplicate. The same
    // frame also lands in the repair cache below, so ring repair would go on to
    // serve the forged bytes to anyone asking for that (seat, seq).
    const expectedMsgId = await sha256(concatBytes(
      parsed.senderId, le32(parsed.epochId), le32(parsed.seq), parsed.ciphertext,
    ));
    if (!constantTimeEqual(expectedMsgId, parsed.msgId)) return; // forged or corrupt id

    // check-and-mark stays in one synchronous stretch on purpose. every neighbor
    // edge is its own session, and live.ts hands us onRawDecrypted WITHOUT
    // awaiting it, so two copies of one frame really are part-way through this
    // handler at the same time. the await above sits before the check, which is
    // harmless: both copies may resume past it, but whichever reaches the check
    // first also reaches the mark before it can yield again.
    //
    // measured, by inserting a yield between these two lines: both copies then
    // get past this point. the observable behaviour stayed correct anyway,
    // because the braid layer is the authoritative dedup (a seq already
    // integrated into the lane is ignored) and the relay path is gated on that.
    // so this is the cheap first line, not the thing correctness rests on. keep
    // them adjacent regardless, since the work it saves is a signature
    // verification and a braid open per redundant mesh path.
    if (this.hasSeen(parsed.msgId)) return;
    this.markSeen(parsed.msgId);

    if (parsed.hopCount >= MAX_HOP_COUNT) return; // max hops exceeded, silently drop

    let target: BraidEpoch | null = null;
    if (this.currentEpoch && parsed.epochId === this.currentEpoch.epochId) {
      target = this.currentEpoch;
    } else {
      const draining = this.draining.get(parsed.epochId);
      if (draining && Date.now() < draining.expiresAt) target = draining.epoch;
    }

    const forward = async (): Promise<void> => {
      const rewrapped = rewrapGroupMsg(concatBytes(new Uint8Array([CF_GROUP_MSG]), data), parsed.hopCount + 1);
      await this.broadcastToNeighbors(rewrapped, fromLabel);
    };

    // a frame stamped with an epoch we have already left means the neighbor that
    // relayed it is behind. this is the signal that actually catches a seat
    // stranded by a partition: a new mesh edge (and its welcome exchange) is not
    // guaranteed when the partition heals over links that never dropped, but a
    // lagging seat keeps stamping its stale epoch on every message and beacon.
    if (this.currentEpoch && parsed.epochId < this.currentEpoch.epochId) {
      const link = this.neighbors.get(fromLabel);
      if (link?.peerIdHex) {
        this.notePeerEpoch(link.peerIdHex, parsed.epochId);
        void this.pushFoldsTo(fromLabel, link.peerIdHex, parsed.epochId);
      }
    }

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

    // WHO really sent this. The epoch root is shared by the circle, so the AEAD
    // tag only proves "some member"; any seat can derive any other seat's chain
    // and mint a frame that opens correctly under the victim's name. Worse, such
    // a frame ADVANCES that seat's lane, so the impersonated member's genuine
    // next message can never open again — a silent, permanent eviction.
    // The seat id is the hash of its public key, so the frame carries its own
    // proof and stays verifiable after relaying or repair.
    const authored = await verifyAuthored(
      parsed.authorPublicKey, senderHex,
      groupMsgSigningBody(
        parsed.senderId, parsed.seq, parsed.epochId, parsed.timestamp,
        parsed.contentType, parsed.confirm, parsed.frontier, parsed.ciphertext,
        parsed.authorPublicKey,
      ),
      parsed.signature,
    );
    if (!authored) return; // not from the seat it names: drop, do not relay


    // WITNESS CHECK. A seat's strand is monotone, so one position holds exactly
    // one frame. Two distinct frames at the same (seat, seq) is a loop that does
    // not close: injected curvature in the mesh's shared picture of who said
    // what. It needs no key to spot, and unlike the signature check it still
    // fires when a seat's key has been STOLEN, because the thief cannot stop the
    // honest seat from testifying. Both frames are signed by that seat, so the
    // pair is evidence anyone can re-verify.
    const priorFrame = this.recentBySeq.get(`${parsed.epochId}:${senderHex}:${parsed.seq}`);
    if (priorFrame) {
      const prior = parseGroupMsgHeader(priorFrame.subarray(1));
      if (!prior) { this.recentBySeq.delete(`${parsed.epochId}:${senderHex}:${parsed.seq}`); }
      else
      // the position is (seat, EPOCH, seq): every fold restarts each seat's
      // strand at seq 1, so the same seq in a later epoch is a different place
      // entirely. recentBySeq is keyed without the epoch, so qualify it here.
      if (prior.epochId === parsed.epochId && !constantTimeEqual(prior.msgId, parsed.msgId)) {
        const name = this.allPeers.get(senderHex)?.name ?? senderHex.slice(0, 8);
        this.log(`two different messages claim the same place in ${name}'s thread`);
        this.cb.onSeatEquivocated?.(parsed.senderId, parsed.seq, priorFrame, concatBytes(new Uint8Array([CF_GROUP_MSG]), data));
        return; // never accept the second: the position is already spoken for
      }
    }

    // Free evidence, taken at the one point every seat's progress is stated:
    // a group message carries its sender's epoch and its full frontier.
    this.notePeerEpoch(senderHex, parsed.epochId);
    const declared = parseFrontier(parsed.frontier, target.roster.length);
    if (declared) this.peerFrontier.set(senderHex, declared);

    this.rememberRecent(parsed.epochId, senderHex, parsed.seq, data);

    // The facts the UI needs travel WITH the message, because delivery can happen
    // long after arrival: a frame that lands behind a gap waits in the braid's
    // holdback until the gap fills. These used to live in a parallel map keyed by
    // (epoch, seat, seq) with its own 512-entry FIFO cap, and the two structures
    // disagreed about how long a message lives. They were anti-correlated, even:
    // that map evicted in ARRIVAL order while the holdback exists precisely to
    // decouple arrival from delivery, so the message held longest lost its facts
    // first. The miss was then papered over with defaults that are in-band rather
    // than distinguishable, so a File silently became Text and, worse, a
    // recomputed msgId omitting the ciphertext made a well-formed identifier that
    // NO OTHER MEMBER computes. Measured on a 600-message backlog: 89 messages
    // delivered with an identity the rest of the circle did not share, which
    // silently detaches every reaction and read receipt keyed on it.
    const braidMsg: BraidMessage<GroupMsgFacts> = {
      senderIndex, seq: parsed.seq, epochId: parsed.epochId,
      confirm: parsed.confirm, frontier: parsed.frontier, ciphertext: parsed.ciphertext,
      attachment: {
        msgId: parsed.msgId, timestamp: parsed.timestamp,
        hopCount: parsed.hopCount, contentType: parsed.contentType,
      } satisfies GroupMsgFacts,
    };
    const result = await braidOpen(target.braid, braidMsg);

    if (result.status === "delivered") {
      this.receivedSinceOwnSend++;
      for (const entry of result.delivered) {
        // No cast and no presence check, because neither is expressible any more:
        // the braid is parametric in the attachment, so what comes back here is
        // the GroupMsgFacts that went in, and the type says so. The earlier
        // version asserted that with `as` and guarded it with a runtime branch,
        // which is the same fact stated twice and checked never.
        const meta = entry.attachment;
        const senderSeatHex = target.roster[entry.senderIndex];
        const senderId = hexDecode(senderSeatHex);
        const contentType = meta.contentType;

        if (entry.plaintext.length === 0 && contentType === ContentType.System) {
          continue; // silent beacon — no UI event
        }

        const msgId = meta.msgId;
        const displayId = new DataView(msgId.buffer, msgId.byteOffset, 4).getUint32(0, true);
        this.cb.onMessage({
          msgId,
          displayId,
          senderId,
          senderIdHex: senderSeatHex,
          timestamp: meta.timestamp,
          hopCount: meta.hopCount,
          epoch: target.epochId,
          contentType,
          plaintext: entry.plaintext,
        });
      }
    } else if (result.status === "held") {
      // drop questions our own progress has already answered
      const mine = target.braid.myFrontier;
      purgeDead(this.outstandingWants, (k) => {
        const [ep, seatIdx, from] = k.split(":").map(Number);
        return ep !== target.epochId || Number(from) <= (mine[seatIdx] ?? 0);
      });

      const askedAt = Date.now();
      for (const want of result.wants) {
        const seatHex = target.roster[want.seatIndex];
        if (!seatHex) continue;
        const key = `${target.epochId}:${want.seatIndex}:${want.fromSeq}`;
        const last = this.outstandingWants.get(key) ?? 0;
        if (askedAt - last < this.ringRepairIntervalMs) continue; // already asked, still waiting
        this.outstandingWants.set(key, askedAt);
        await this.broadcastToNeighbors(buildRingWant(this.peerId, hexDecode(seatHex), target.epochId, want.fromSeq, want.toSeq));
      }
      if (result.stalled) this.reportStall(senderHex);
    } else if (result.status === "diverged") {
      const seatHex = target.roster[result.seatIndex];
      const name = this.allPeers.get(seatHex)?.name ?? seatHex.slice(0, 8);
      this.log(`a thread frayed: ${name} fell out of sync`);
      this.cb.onSeatDiverged?.(hexDecode(seatHex), result.reason);
    } else if (result.status === "forked") {
      // a NAMED disagreement: this seat's stated history commitment does not
      // match ours at the same frontier. the message is signed, so the pair of
      // contradicting claims is evidence, not a guess about the network.
      this.log(`a thread split: ${senderHex.slice(0, 8)} tells a different history`);
      this.cb.onSeatStalled?.(parsed.senderId, "history disagreement");
    } else if (result.status === "ignored" && result.stalled) {
      this.reportStall(senderHex);
    }

    await forward();
  }

  /** a seat whose next frame will not open, with traffic piling up behind it.
   *  the only signal a history fork produces, now that a failed tag is
   *  unattributable and must not sever anything. it is a report, not a verdict:
   *  no state changed, and a clean copy still lands. a burst of forged frames
   *  can produce it too, so it says "cannot read", never "they left". */
  private reportStall(seatHex: string): void {
    const name = this.allPeers.get(seatHex)?.name ?? seatHex.slice(0, 8);
    this.log(`a thread pulled taut: cannot read ${name}`);
    this.cb.onSeatStalled?.(hexDecode(seatHex), "cannot open this seat's messages");
  }

  /* ── Ring Repair (braid-driven) ────────────────────────── */

  private async handleRingWant(data: Uint8Array, fromLabel: string): Promise<void> {
    if (await this.seenBefore(data)) return;

    const want = parseRingWant(data);
    if (!want) return; // malformed relay frame
    const { originPeerId, targetPeerId, epochId, fromSeq, toSeq } = want;
    const targetHex = toHex(targetPeerId);
    const originHex = toHex(originPeerId);

    // serve whatever we have cached, regardless of whether we are the
    // target — this is the mesh healing power: anyone can repair anyone.
    const responder = this.findNeighborByHex(originHex);
    if (responder?.session) {
      for (let seq = fromSeq; seq <= toSeq; seq++) {
        const raw = this.recentBySeq.get(`${epochId}:${targetHex}:${seq}`);
        if (raw) await this.sendToNeighbor(responder.session, raw);
      }
    }

    await this.broadcastToNeighbors(buildRingWant(originPeerId, targetPeerId, epochId, fromSeq, toSeq), fromLabel);
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
    this.markReactSeen(dedupKey);

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
    const announce = parseJoinAnnounce(data);
    if (!announce) return; // malformed relay frame
    const { peerId, agreementKey, name } = announce;
    const hex = toHex(peerId);

    if (hex === this.peerIdHex) return; // ignore our own join

    if (!this.allPeers.has(hex)) {
      if (!this.rememberPeer(hex, new Uint8Array(peerId), new Uint8Array(agreementKey), name)) return;
      this.cb.onPeerJoin(peerId, name);
      this.cb.onPeerListUpdate(Array.from(this.allPeers.values()));
      this.log(`${name} joined the room`);

      // Forward gossip regardless of admission role.
      await this.broadcastToNeighbors(buildJoinAnnounce(peerId, agreementKey, name), fromLabel);
    }

    // Admission: only the direct host slot the joiner announced over makes us
    // the admitter. announces that merely pass through other links (mesh edges,
    // our own bootstrap) never do.
    //
    // A RE-announce runs this again on purpose. A joiner that is still not
    // seated resends, and by then the elder may have changed: the seat that was
    // asked the first time may have departed carrying the request with it. Only
    // the elder may issue the fold, so the question "who is elder" has to be
    // re-asked at the moment of each attempt rather than answered once.
    if (!fromLabel.startsWith("root-slot-")) return;
    const from = this.neighbors.get(fromLabel);
    if (!from?.session) return;
    if (!from.peerIdHex) {
      from.peerId = new Uint8Array(peerId);
      from.peerIdHex = hex;
      from.name = name;
    }
    if (this.currentEpoch?.roster.includes(hex)) return; // already seated

    this.pendingAdmissions.set(hex, { label: fromLabel, session: from.session });
    if (this.isElder()) {
      // issueFold is serialized and early-returns if the subject is already in
      // the roster, so a repeat cannot fold the same joiner twice.
      this.pendingJoinReqs.add(hex);
      await this.issueFold(FOLD_REASON_JOIN, peerId);
    } else {
      this.pendingJoinReqs.add(hex);
      const attempt = (this.joinReqAttempts.get(hex) ?? 0) + 1;
      this.joinReqAttempts.set(hex, attempt);
      await this.broadcastToNeighbors(buildJoinReq(peerId, name, attempt));
    }
  }

  private async handleLeaveAnnounce(data: Uint8Array, fromLabel: string): Promise<void> {
    const leave = parseLeaveAnnounce(data);
    if (!leave) return; // malformed relay frame
    const { peerId } = leave;
    const hex = toHex(peerId);

    // an unseated joiner re-asks on ANY departure it hears about. the seat that
    // left may be the elder holding its admission, and the request died with it.
    // this runs before the known-peer guard on purpose: a joiner that was never
    // welcomed has no peer list, so it would otherwise ignore the one event that
    // tells it to try again.
    if (!this.currentEpoch && this._state === "connecting") {
      const link = this.neighbors.get("join-root");
      if (link?.connected && link.session) {
        await this.sendToNeighbor(link.session, buildJoinAnnounce(this.peerId, this.identity!.agreement.publicKey, this.displayName));
      }
    }

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

    const req = parseJoinReq(data);
    if (!req) return; // malformed relay frame
    const { joinerId, name, attempt } = req;
    const hex = toHex(joinerId);

    if (!this.currentEpoch || this.currentEpoch.roster.includes(hex)) return;

    if (this.isElder()) {
      // issueFold is serialized and applies locally before returning, so a
      // second request for the same joiner queues behind the first and hits its
      // already-in-roster early return. no extra dedup is needed here, and the
      // set that used to guard this was never cleared on that early return,
      // which silently blocked a later rejoin by the same peer.
      this.pendingJoinReqs.add(hex);
      await this.issueFold(FOLD_REASON_JOIN, joinerId);
      return;
    }

    // not the elder yet. remember the subject: we may be the seat inheriting the
    // role right now, in which case this request would otherwise be dropped.
    if (this.relayedJoinReqs.size < 16) this.relayedJoinReqs.set(hex, new Uint8Array(joinerId));

    // keep flooding until it reaches whoever the elder turns out to be.
    await this.broadcastToNeighbors(buildJoinReq(joinerId, name, attempt), fromLabel);
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
  private issueFold(
    reason: typeof FOLD_REASON_JOIN | typeof FOLD_REASON_LEAVE | typeof FOLD_REASON_UPDATE,
    subjectPeerId: Uint8Array,
  ): Promise<void> {
    return this.serializeEpoch(async () => {
      if (!this.currentEpoch) return;
      const subjectHex = toHex(subjectPeerId);
      if (reason === FOLD_REASON_JOIN && this.currentEpoch.roster.includes(subjectHex)) return;
      if (reason === FOLD_REASON_LEAVE && !this.currentEpoch.roster.includes(subjectHex)) return;
      if (reason === FOLD_REASON_UPDATE && !this.currentEpoch.roster.includes(subjectHex)) return;

      const newEpochId = this.currentEpoch.epochId + 1;
      const newRoster = reason === FOLD_REASON_JOIN
        ? sortRoster([...this.currentEpoch.roster, subjectHex])
        : reason === FOLD_REASON_UPDATE
          ? this.currentEpoch.roster                       // membership preserved
          : this.currentEpoch.roster.filter((h) => h !== subjectHex);
      if (newRoster.length === 0) return; // never fold to an empty circle

      // an UPDATE rotates the author's agreement key. the replacement is used
      // for the author's OWN sealed copy below, so an attacker holding the old
      // key cannot open it and cannot follow the root forward.
      const rotated = reason === FOLD_REASON_UPDATE ? await generateAgreementKey() : null;
      const newAgreementKey = rotated ? rotated.publicKey : new Uint8Array(PUBKEY_LEN);

      if (!this.identity) return; // cannot author a fold without a signing key
      const entropy = randomBytes(32);
      const rosterDigest = await sha256(concatBytes(...newRoster.map(hexDecode)));

      // Seal the entropy to each member of the NEW roster, one copy each. A
      // removed subject is not in that roster, so it gets no copy — and since it
      // holds the previous root, a cleartext entropy field would simply BE the
      // new root for it. This is the whole mechanism: removal stops depending on
      // who we relayed the frame to.
      const parts: Uint8Array[] = [];
      for (const memberHex of newRoster) {
        const known = this.allPeers.get(memberHex);
        const agreementKey = memberHex === this.peerIdHex
          ? (rotated ? rotated.publicKey : this.identity.agreement.publicKey)
          : known?.agreementKey;
        if (!agreementKey) {
          this.log("a member's key is unknown; the fold would leave them behind. dropped.");
          entropy.fill(0);
          return;
        }
        const sealed = await sealToAgreement(agreementKey, entropy, INFO_FOLD_ENTROPY);
        if (!sealed) { entropy.fill(0); return; }
        parts.push(hexDecode(memberHex), sealed);
      }
      const recipients = concatBytes(...parts);

      const body = braidFoldSigningBody(
        newEpochId, reason, subjectPeerId, recipients, rosterDigest,
        this.identity.publicKey, newAgreementKey,
      );
      const signature = await signBytes(this.identity, body);
      const wire = buildBraidFold(
        newEpochId, reason, subjectPeerId, recipients, rosterDigest,
        this.identity.publicKey, newAgreementKey, signature,
      );
      entropy.fill(0);

      const payload = wire.subarray(1);
      this.markSeen(await sha256(payload));

      // broadcast only what actually took hold locally.
      const selfParsed = parseBraidFold(payload);
      if (!selfParsed) return; // we just built it; unparseable means a bug, not an attack
      // We sealed OUR copy to the rotated key, so we must be holding it to open
      // that copy while applying. Adopt first and put the old half back if the
      // fold does not take hold, rather than sealing to the old key and rotating
      // afterwards — that ordering would hand the attacker one more epoch.
      const previousAgreement = this.identity.agreement;
      if (rotated) this.identity.agreement = rotated;
      try {
        if (await this.applyBraidFold(selfParsed)) {
          await this.broadcastToNeighbors(wire);
        } else if (rotated) {
          this.identity.agreement = previousAgreement;
        }
      } catch (err) {
        if (rotated) this.identity.agreement = previousAgreement;
        this.log(`fold failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    });
  }

  private async handleBraidFold(data: Uint8Array, fromLabel: string): Promise<void> {
    if (await this.seenBefore(data)) return;

    const fold = parseBraidFold(data);
    if (!fold) return; // malformed relay frame

    // a seat may not author its own removal. the fold carries the entropy that
    // advances the root, so whoever mints it knows the epoch it produces. a
    // departing member that mints its own leave fold lands every seat applying
    // it on a root the departed member knows in full, which destroys exactly the
    // forward secrecy the fold exists to provide. the immediate sender is
    // authenticated by the pairwise link, so refusing here also stops the
    // forgery from being laundered onward through an honest hop: we return
    // before the forward below.
    if (fold.reason === FOLD_REASON_LEAVE) {
      const senderHex = this.neighbors.get(fromLabel)?.peerIdHex;
      if (senderHex && senderHex === toHex(fold.subjectPeerId)) {
        this.log("a fold arrived from the very seat it removes. dropped.");
        return;
      }
    }

    await this.serializeEpoch(async () => {
      this.rememberFold(fold);
      await this.drainFolds();
    });

    // a fold we cannot apply yet means we are behind: it sits in pendingFolds
    // waiting for an epoch we never received, and nothing would ever deliver it.
    // announce where we are to whoever sent it, which is exactly the signal that
    // makes them push us the folds we are missing. without this a seat that
    // missed one fold stays behind forever while still relaying traffic, and any
    // joiner whose admission it holds is stranded with it.
    if (this.currentEpoch && fold.newEpochId > this.currentEpoch.epochId + 1) {
      const link = this.neighbors.get(fromLabel);
      if (link?.connected && link.session) void this.sendBraidWelcome(link.session);
    }

    // forward regardless: peers elsewhere in the mesh may be behind or
    // ahead of us and still need this copy. dedup above bounds the flood.
    const rewrapped = concatBytes(new Uint8Array([CF_BRAID_FOLD]), data);
    await this.broadcastToNeighbors(rewrapped, fromLabel);

  }

  /** queue a fold for ordered application. the dedup ring already swallowed
   *  duplicate copies, so a fold that arrives ahead of order must be kept or
   *  the chain wedges: no second copy is coming. */
  /** send a lagging neighbor the folds between its epoch and ours. only a peer
   *  seated in our CURRENT roster is served: a peer we no longer seat was
   *  removed, and the fold that removed it is precisely the secret it must
   *  never receive, or the leave would stop being forward secret. */
  /** record evidence of how far a seat has got, for the retention floor. */
  private notePeerEpoch(peerHex: string, epochId: number): void {
    const prior = this.peerEpoch.get(peerHex) ?? 0;
    if (epochId > prior) this.peerEpoch.set(peerHex, epochId);
  }

  /**
   * The epoch floor: the lowest epoch any currently seated peer might still ask
   * for. A seat we have never heard from counts as 0, which pins the floor and
   * keeps everything, deliberately: retaining a few hundred bytes per fold is
   * recoverable, stranding a member is not. If that retention ever becomes the
   * problem, the answer is to fold the silent seat out, which raises the floor.
   */
  private foldFloor(): number {
    if (!this.currentEpoch) return 0;
    return meetOf(
      this.currentEpoch.roster
        .filter((hex) => hex !== this.peerIdHex)
        .map((hex) => this.peerEpoch.get(hex)),
    );
  }

  /**
   * The per-seat repair floor: the lowest seq of seat `s` that any peer could
   * still request through ring repair.
   *
   * `recentBySeq` is the repair server's cache, and a RING_WANT names an exact
   * (epoch, seat, seq) driven by the ASKER's gap. So its demand order is the
   * strand order of each seat, and the floor is the meet of what every peer has
   * been seen to hold. Evicting on a single global arrival counter instead let
   * one busy seat flush every quiet seat's repairable history, which is the
   * cross-principal shape: the volume came from one party, the loss landed on
   * another.
   */
  private repairFloor(senderHex: string): number {
    if (!this.currentEpoch) return 0;
    const seatIndex = this.currentEpoch.roster.indexOf(senderHex);
    if (seatIndex < 0) return Infinity; // not seated: nobody will ask for it
    return meetOf(
      this.currentEpoch.roster
        .filter((hex) => hex !== this.peerIdHex)
        .map((hex) => this.peerFrontier.get(hex)?.[seatIndex]),
    );
  }

  private async pushFoldsTo(fromLabel: string, peerHex: string, theirEpochId: number): Promise<void> {
    if (!this.currentEpoch) return;
    if (!this.currentEpoch.roster.includes(peerHex)) return;
    const link = this.neighbors.get(fromLabel);
    if (!link?.connected || !link.session) return;

    const now = Date.now();
    const last = this.lastFoldPush.get(peerHex) ?? 0;
    if (now - last < FOLD_PUSH_INTERVAL) return;
    this.lastFoldPush.set(peerHex, now);

    // `theirEpochId` is supplied by the peer, so it cannot decide how far back
    // we reach. A seat re-admitted at epoch 20 that announces epoch 10 must not
    // receive folds 11..19: it retains the root from before its removal, and
    // those entropies are precisely what turn that root into every epoch it was
    // excluded from. Serve only from the epoch it actually joined.
    // strictly ABOVE the epoch that seated them: the root for that epoch reaches
    // a joiner through its welcome, so the fold is redundant there, and serving
    // it would hand a re-admitted seat one more step of the arithmetic.
    this.notePeerEpoch(peerHex, theirEpochId);
    const seated = this.seatedSince.get(peerHex) ?? 0;
    const floor = Math.max(theirEpochId + 1, seated + 1);
    for (let id = floor; id <= this.currentEpoch.epochId; id++) {
      const fold = this.appliedFolds.get(id);
      if (!fold) continue; // rotated out of the ring; nothing we can do for that gap
      const wire = buildBraidFold(
        fold.newEpochId, fold.reason, fold.subjectPeerId, fold.recipients, fold.rosterDigest,
        fold.authorPublicKey, fold.newAgreementKey, fold.signature,
      );
      await this.sendToNeighbor(link.session, wire);
    }
  }

  /** re-issue admissions this seat is still holding, for joiners the roster does
   *  not yet seat. only the elder may issue an admission fold, so this fires on
   *  the seat that just inherited the role and is still holding the joiner's
   *  bootstrap link. */
  /**
   * Rotate this seat's key material without changing the roster.
   *
   * Call this when a device may have been exposed. It is the only operation that
   * recovers from compromise: the epoch root otherwise moves only on membership
   * change, so a stolen state would keep decrypting the whole circle forever.
   */
  async updateOwnKeys(): Promise<void> {
    if (!this.currentEpoch || !this.identity) return;
    if (!this.currentEpoch.roster.includes(this.peerIdHex)) return;
    await this.issueFold(FOLD_REASON_UPDATE, this.peerId);
  }

  private async readmitPendingJoiners(): Promise<void> {
    if (!this.currentEpoch || !this.isElder()) return;

    // requests that reached us before we were elder. draining them here is what
    // makes the retry level-triggered rather than edge-triggered.
    for (const [hex, joinerId] of Array.from(this.relayedJoinReqs)) {
      this.relayedJoinReqs.delete(hex);
      if (this.currentEpoch.roster.includes(hex)) continue;
      this.pendingJoinReqs.add(hex);
      await this.issueFold(FOLD_REASON_JOIN, joinerId);
    }

    for (const [hex, pending] of Array.from(this.pendingAdmissions)) {
      if (this.currentEpoch.roster.includes(hex)) continue;
      const peer = this.neighbors.get(pending.label);
      if (!peer?.connected || !peer.peerIdHex) continue;
      this.pendingJoinReqs.add(hex);
      await this.issueFold(FOLD_REASON_JOIN, peer.peerId);
    }
  }

  /**
   * CONCURRENT FOLDS RESOLVE BY A DETERMINISTIC JOIN, NOT BY WHO ARRIVED FIRST.
   *
   * Epoch ids form a total order, but the EVENTS that mint them do not: under a
   * partition two seats can each believe they are elder and each author a fold
   * for the same id. Keeping only the first-seen copy makes the outcome depend
   * on arrival order, which is exactly the order the mesh does not agree on, so
   * the two halves settle on different roots and the only later signal is a
   * welcome cross-check that tears the whole circle down.
   *
   * The fix is to make the choice a function of the folds themselves rather than
   * of the network: among candidates for one epoch id, keep the one whose
   * roster digest is smallest. Any comparison that is total and content-derived
   * would do; smallest-digest is chosen because every seat can evaluate it from
   * the frame alone, with no extra round trip and no notion of time. Two seats
   * that see the same pair of folds therefore reach the SAME epoch, in either
   * arrival order, and the split never forms.
   */
  private foldPrecedes(a: ParsedBraidFold, b: ParsedBraidFold): boolean {
    // The comparison has to be TOTAL over distinct folds, or the tiebreak just
    // relocates the arrival-order dependence instead of removing it. Roster
    // digest alone is not: an UPDATE preserves membership, so two seats rotating
    // keys at the same instant produce equal digests and the choice falls back
    // to whoever arrived first, which is the whole problem. Subject and reason
    // separate those, and the author's key is the final discriminator since two
    // distinct folds cannot share one.
    const fields = (f: ParsedBraidFold): Uint8Array[] => [
      f.rosterDigest, f.subjectPeerId, Uint8Array.from([f.reason]), f.authorPublicKey,
    ];
    const left = fields(a), right = fields(b);
    for (let k = 0; k < left.length; k++) {
      const x = left[k], y = right[k];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) return x[i] < y[i];
      }
      if (x.length !== y.length) return x.length < y.length;
    }
    return true; // identical in every field: the same fold, either copy will do
  }

  private rememberFold(fold: ParsedBraidFold): void {
    if (this.currentEpoch && fold.newEpochId <= this.currentEpoch.epochId) return;
    const rival = this.pendingFolds.get(fold.newEpochId);
    if (rival) {
      // a second candidate for the same id: keep the canonical one, whichever
      // of the two happened to arrive first.
      if (this.foldPrecedes(rival, fold)) return;
      this.pendingFolds.delete(fold.newEpochId);
    }
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
    } else if (fold.reason === FOLD_REASON_UPDATE) {
      // membership-preserving: an update only rotates the author's key material
      if (!this.currentEpoch.roster.includes(subjectHex)) return false;
      newRoster = this.currentEpoch.roster;
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

    // Authorship. The fold carries the entropy that advances the root, so
    // whoever mints one knows the epoch it produces; nothing derived from the
    // shared root can establish who that was. The elder of the epoch we are
    // folding FROM is the only seat entitled to issue, and a seat id is the hash
    // of its public key, so the roster we already hold is the whole check.
    // WHO may sign. The elder of the epoch we fold FROM is the obvious answer and
    // it is wrong for the commonest case: when the elder itself departs, it is
    // gone and the seat that issues is the next one. The authority is therefore
    // the elder among the seats present in BOTH epochs — for a leave that is
    // newRoster[0], for a join the current roster[0] (a joiner must never be able
    // to author its own admission, even if its id happens to sort first).
    // An UPDATE is SELF-issued by definition: only the seat whose key is being
    // rotated may rotate it. Letting the elder mint updates for other seats would
    // hand it the power to replace anyone's key material.
    const authorHex = fold.reason === FOLD_REASON_UPDATE
      ? subjectHex
      : fold.reason === FOLD_REASON_JOIN
        ? this.currentEpoch.roster[0]
        : newRoster[0];
    const authored = await verifyAuthored(
      fold.authorPublicKey, authorHex, fold.signingBody, fold.signature,
    );
    if (!authored) {
      this.log("a fold arrived that the elder did not sign. dropped.");
      return false;
    }

    const wasElder = this.isElder();
    // open the copy addressed to us. no copy means this fold was not sealed for
    // this seat, which is exactly what a removed member sees.
    if (!this.identity) return false;
    const mine = foldRecipientFor(fold.recipients, this.peerIdHex);
    if (!mine) {
      this.log("a fold arrived that was not sealed for this seat. dropped.");
      return false;
    }
    const entropy = await openFromAgreement(this.identity.agreement, mine, INFO_FOLD_ENTROPY);
    if (!entropy) {
      this.log("a fold's sealed entropy would not open. dropped.");
      return false;
    }

    const newRoot = await braidFold(this.currentEpoch.root, entropy, fold.newEpochId, newRoster);
    entropy.fill(0);
    const newBraid = await braidInit<GroupMsgFacts>(newRoot, fold.newEpochId, newRoster, this.peerIdHex);

    // rotate: the outgoing epoch survives a grace window for stragglers. each
    // gets its own window, so a burst of folds cannot cut an earlier one short.
    this.draining.set(this.currentEpoch.epochId, {
      epoch: this.currentEpoch,
      expiresAt: Date.now() + KEY_GRACE_PERIOD,
    });
    // The comment above promises each window its own full grace period, and the
    // cap must not quietly break that promise. A draining epoch is dead when its
    // own window has closed, never merely because a newer one arrived: a burst
    // of folds inside one grace period is exactly the case the promise exists
    // for, and cutting the earliest short drops in-flight messages that other
    // seats sent believing they were delivered.
    const nowMs = Date.now();
    const drainSweep = evictBelowFloor(
      this.draining, MAX_DRAINING_EPOCHS,
      (id) => (this.draining.get(id)?.expiresAt ?? 0) <= nowMs,
      (_id, entry) => braidWipe(entry.epoch.braid),
    );
    if (drainSweep.overCap > 0) {
      this.log(`${drainSweep.overCap} draining epoch(s) held past the cap: their grace windows are still open`);
    }
    this.currentEpoch = { epochId: fold.newEpochId, roster: newRoster, root: newRoot, braid: newBraid };
    this.scheduleGraceExpiry();

    if (fold.reason === FOLD_REASON_JOIN) this.seatedSince.set(subjectHex, fold.newEpochId);
    else if (fold.reason === FOLD_REASON_LEAVE) this.seatedSince.delete(subjectHex);

    // record the author's rotated agreement key so OUR next fold seals to the
    // new one. without this the circle would keep sealing to a key the author
    // has abandoned, and the heal would not stick past one epoch.
    if (fold.reason === FOLD_REASON_UPDATE) {
      const known = this.allPeers.get(subjectHex);
      if (known) known.agreementKey = new Uint8Array(fold.newAgreementKey);
    }

    // keep the fold so a neighbor still on an earlier epoch can be caught up.
    this.appliedFolds.set(fold.newEpochId, fold);
    this.notePeerEpoch(this.peerIdHex, fold.newEpochId);
    // Evict only what every seated peer has already passed. The count cap is a
    // pressure signal, not a licence: when it is exceeded and nothing is below
    // the floor, some seat is far enough behind that dropping a fold would
    // strand it, and keeping the bytes is the cheaper mistake.
    const evictBelow = this.foldFloor();
    const foldSweep = evictBelowFloor(this.appliedFolds, MAX_RETAINED_FOLDS, (id) => id <= evictBelow);
    if (foldSweep.overCap > 0) {
      // Not a leak: a measurement. Some seat is far enough behind that serving
      // it and staying small are no longer both possible, and that is the epoch
      // layer's decision to make, not a sweep's.
      this.log(`retaining ${foldSweep.overCap} fold(s) over cap for a seat behind epoch ${evictBelow}`);
    }


    if (fold.reason === FOLD_REASON_LEAVE) {
      this.removePeerIfPresent(subjectHex);
    }

    // topology reconciliation creates webrtc offers (slow); never stall the
    // epoch queue on it.
    void this.applyTopology();

    // a joiner's admission lives with whichever elder was asked. if that elder
    // departs mid-admission the request dies with it and the joiner sits at
    // "joining room" forever with nothing to tell it otherwise. only the seat
    // that just INHERITED the elder role re-issues: doing it on every fold would
    // duplicate an admission already in flight and inflate the epoch.
    // queued, never awaited: we are inside the epoch queue and issueFold takes it.
    if (!wasElder && this.isElder()) void this.readmitPendingJoiners();

    this.pendingJoinReqs.delete(subjectHex);
    this.relayedJoinReqs.delete(subjectHex);
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
      const now = Date.now();
      for (const [epochId, entry] of this.draining) {
        if (now < entry.expiresAt) continue;
        braidWipe(entry.epoch.braid);
        this.draining.delete(epochId);
      }
      if (this.draining.size > 0) this.scheduleGraceExpiry();
    }, KEY_GRACE_PERIOD + 50);
  }

  /* ── Braid Welcome (join adoption + cross-check) ────────── */

  private async handleBraidWelcome(data: Uint8Array, _fromLabel: string): Promise<void> {
    const welcome = parseBraidWelcome(data);
    if (!welcome) return; // malformed relay frame
    const { epochId, senderPeerId, root, roster: rosterIds } = welcome;
    const rosterHex = sortRoster(rosterIds.map((id) => toHex(id)));

    await this.serializeEpoch(async () => {
      if (!this.currentEpoch) {
        // first epoch this seat has ever seen: adopt it, then replay any
        // folds that overtook the welcome on the way here. a welcome whose
        // roster cannot seat us is fatal to the join, not to the process.
        let braid;
        try {
          braid = await braidInit<GroupMsgFacts>(root, epochId, rosterHex, this.peerIdHex);
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
      } else if (epochId < this.currentEpoch.epochId) {
        // the sender is behind. it cannot adopt our root directly (a bare root
        // is unverifiable against its own chain), but the folds between its
        // epoch and ours are self-verifying, so hand those over and let it walk
        // itself forward through the ordinary verified path. this is the only
        // way a seat stranded by a partition ever recovers: by then the fold is
        // long gone from the network and nobody else re-sends it.
        void this.pushFoldsTo(_fromLabel, toHex(senderPeerId), epochId);
      } else {
        // the sender is ahead of us. we cannot adopt its root (unverifiable
        // against our own chain), but we can say where we are: it will then
        // push the folds we are missing. this is what heals a seat that missed
        // a fold entirely, without waiting for it to speak first.
        const link = this.neighbors.get(_fromLabel);
        if (link?.connected && link.session) void this.sendBraidWelcome(link.session);
      }
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
   *  keep it while its peer is a real topology neighbor, or while any edge the
   *  roster asks us to hold is still being negotiated. */
  private async maybeReleaseBootstrap(mine: Set<string>): Promise<void> {
    if (this.role !== "peer" || !this.bootstrapSession) return;
    const link = this.neighbors.get("join-root") ?? this.neighbors.get("root");
    if (!link || !link.peerIdHex) return; // identity not resolved yet
    if (mine.has(link.peerIdHex)) return; // still a real topology neighbor

    // Every edge the roster gives us has to be live before we let go of the one
    // link we know works. "Some mesh edge exists" was too weak: a seat the
    // roster gives two neighbors, holding only the first, would drop the
    // bootstrap while the second was still mid-negotiation, and until that edge
    // landed it had exactly one route into the circle. Losing that one neighbor
    // then cut it off with nothing left to heal through. If an edge lands after
    // this check the bootstrap simply survives to the next epoch change, which
    // costs a link and strands nobody.
    for (const hex of mine) {
      const peer = this.findNeighborByHex(hex);
      if (!peer?.connected) return;
    }

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

    // No direct-to-target shortcut, deliberately. The root used to hand an SDP
    // straight to the neighbor it was addressed to and stop there, which turned
    // one link into the frame's only route: if that link was closing at the same
    // instant (a peer releasing its bootstrap the moment topology stopped
    // needing it), the SDP died and the mesh edge it was negotiating never
    // formed. A seat then sat at degree one and any departure of its single
    // neighbor cut it out of the circle entirely. The flood already includes
    // that neighbor and every other path to it, and receivers dedup by content,
    // so routing an edge negotiation through a single link only ever removes
    // redundancy from the one exchange that builds redundancy.
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
    const list = parsePeerList(data);
    if (!list) return; // malformed relay frame
    const { peers } = list;
    for (const p of peers) {
      const hex = toHex(p.peerId);
      this.rememberPeer(hex, new Uint8Array(p.peerId), new Uint8Array(p.agreementKey), p.name);
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
        void this.broadcastToNeighbors(buildRingWant(this.peerId, hexDecode(seatHex), this.currentEpoch.epochId, want.fromSeq, want.toSeq));
      }
    }, this.ringRepairIntervalMs);
  }

  private stopRingRepair(): void {
    if (this.repairTimer) { clearInterval(this.repairTimer); this.repairTimer = null; }
  }

  private startBeacon(): void {
    this.stopBeacon();
    this.beaconTimer = setInterval(() => {
      void this.maybeSendBeacon();
    }, this.beaconCheckMs);
  }

  private stopBeacon(): void {
    if (this.beaconTimer) { clearInterval(this.beaconTimer); this.beaconTimer = null; }
  }

  /** send a silent, empty-payload group message so quiet seats still
   *  advance their frontier and stay reachable for view reconstruction. */
  private async maybeSendBeacon(): Promise<void> {
    if (this._state !== "active" || !this.currentEpoch) return;
    const idle = this.receivedSinceOwnSend > 0 && Date.now() - this.lastOwnSendAt > this.beaconIdleMs;
    if (this.receivedSinceOwnSend < BEACON_MSG_THRESHOLD && !idle) return;

    const epochId = this.currentEpoch.epochId;
    const sealed = await braidSeal(this.currentEpoch.braid, new Uint8Array(0));
    const msgId = await sha256(concatBytes(this.peerId, le32(epochId), le32(sealed.seq), sealed.ciphertext));
    const timestamp = Date.now();
    const authored = await this.signGroupMsg(
      sealed.seq, epochId, timestamp, ContentType.System, sealed.confirm, sealed.frontier, sealed.ciphertext,
    );
    const wire = buildGroupMsg(
      msgId, this.peerId, sealed.seq, epochId, timestamp, 0, ContentType.System,
      sealed.confirm, sealed.frontier, sealed.ciphertext, authored.authorPublicKey, authored.signature,
    );

    this.markSeen(msgId);
    this.rememberRecent(epochId, this.peerIdHex, sealed.seq, wire.subarray(1));
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

    // a joiner whose handshake is still in flight is not in `neighbors` yet: it
    // lives in the pending root slot. leaving without closing it leaves that
    // joiner holding a link to nobody, still saying "joining room", with no
    // event that would ever tell it otherwise.
    if (this._pendingRootSession) {
      this._pendingRootSession.disconnect();
      this._pendingRootSession = null;
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
    for (const [, entry] of this.draining) braidWipe(entry.epoch.braid);
    this.draining.clear();

    this.pendingMeshSdp.clear();
    this.pendingAdmissions.clear();
    this.pendingJoinReqs.clear();
    this.joinReqAttempts.clear();
    this.relayedJoinReqs.clear();
    this.seatedSince.clear();
    this.pendingFolds.clear();
    this.appliedFolds.clear();
    this.peerEpoch.clear();
    this.peerFrontier.clear();
    this.outstandingWants.clear();
    this.lastFoldPush.clear();
    this.allPeers.clear();
    this.seenMsgIds = [];
    this.seenMsgSet.clear();
    this.seenReacts.clear();
    this.seenReactRing.length = 0;
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
