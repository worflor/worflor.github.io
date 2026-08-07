/**
 * campfire-harness.ts
 *
 * fake transport + node orchestration for multi-node campfire integration
 * tests. CampfireNode (../../../src/scripts/whisper/campfire/gossip.ts)
 * takes its transport through a sessionFactory injection point
 * (CampfireSessionFactory in campfire/types.ts) so a whole circle of nodes
 * can run in-process, wired together by a single deterministic message
 * queue instead of real webrtc.
 *
 * two pieces:
 *   - VirtualNet: an offer/answer broker plus a FIFO (or bounded-reorder)
 *     delivery queue. every session send becomes a queued delivery; drain()
 *     processes the queue to quiescence, awaiting each handler and settling
 *     microtask chains between rounds so fire-and-forget internal awaits
 *     (epoch folds, topology reconciliation) finish before the next round.
 *   - FakeSession: a CampfireSessionLike backed by the net. two sessions
 *     become "peers" when an answer is applied; sends become queued
 *     deliveries to the peer's callbacks.
 *
 * makeNode()/connect()/teardown() mirror the real create/join/apply-answer
 * UI flow so test scenarios read like a transcript of what a user did.
 */

import type {
  CampfireCallbacks,
  CampfireSessionFactory,
  CampfireSessionLike,
  CampfireState,
  CampfireMessage,
} from "../../../src/scripts/whisper/campfire/types.js";
import { CampfireNode } from "../../../src/scripts/whisper/campfire/gossip.js";
import { toHex, sha256, concatBytes } from "../../../src/scripts/whisper/wasm.js";
import { parseGroupMsgHeader, groupMsgSigningBody } from "../../../src/scripts/whisper/campfire/wire.js";
import { signBytes, type CampfireIdentity } from "../../../src/scripts/whisper/campfire/identity.js";
import { makeDeterministicRng } from "./generators.js";
import type { WhisperLiveCallbacks } from "../../../src/scripts/whisper/live.js";

/* ═══════════════════════════════════════════════════════════════════
   VirtualNet: offer/answer broker + deterministic delivery queue
   ═══════════════════════════════════════════════════════════════════ */

export type DeliveryFilter = (fromNodeIdx: number, toNodeIdx: number, bytes: Uint8Array) => boolean;

interface QueuedDelivery {
  seq: number;
  run: () => unknown;
}

/**
 * Runaway-gossip backstop. Configurable per net because it does double duty: it
 * is the only infinite-loop detector, AND it caps legitimate work, so a test
 * that deliberately builds a large backlog trips it for the honest reason. A
 * fixed global forces such a test to either shrink below the thing it is trying
 * to measure or to be deleted, and both hide the scenario.
 */
const DELIVERY_CEILING = 100_000;
const REORDER_WINDOW = 4;

export class VirtualNet {
  /** when true, drain() picks the next delivery from the first REORDER_WINDOW
   *  queued items (via a seeded rng) instead of strict FIFO. */
  reorder = false;
  /** optional per-edge drop hook, consulted for every sendEncryptedRaw delivery. */
  dropFilter?: DeliveryFilter;
  /** raise for tests that legitimately generate a lot of traffic; see DELIVERY_CEILING. */
  deliveryCeiling = DELIVERY_CEILING;

  private queue: QueuedDelivery[] = [];
  private seqCounter = 0;
  private msgIdCounter = 0;
  private nodeCounter = 0;
  private rng: () => number;

  // offer/answer broker state
  private offers = new Map<string, FakeSession>();
  private pendingAnswers = new Map<string, { offerSession: FakeSession; answerSession: FakeSession }>();
  private tokenCounter = 0;

  constructor(seed = 0xC0FFEE) {
    this.rng = makeDeterministicRng(seed);
  }

  nextNodeIdx(): number {
    return this.nodeCounter++;
  }

  nextMsgId(): number {
    return this.msgIdCounter++;
  }

  shouldDrop(fromIdx: number, toIdx: number, bytes: Uint8Array): boolean {
    return this.dropFilter ? this.dropFilter(fromIdx, toIdx, bytes) : false;
  }

  enqueue(_fromIdx: number, _toIdx: number, run: () => unknown): void {
    this.queue.push({ seq: this.seqCounter++, run });
    if (this.autoPump) this.schedulePump();
  }

  /** process deliveries as they are enqueued instead of only inside drain().
   *  the real transport is concurrent: a node can receive and relay while it is
   *  part-way through its own teardown. without this the harness batches every
   *  delivery until the caller reaches drain(), so anything a node does DURING
   *  an await looks like a no-op no matter how correct it is. */
  autoPump = false;
  private pumping = false;

  private schedulePump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(async () => {
      try {
        let processed = 0;
        while (this.queue.length > 0) {
          if (++processed > this.deliveryCeiling) {
            throw new Error(`virtual net: exceeded ${this.deliveryCeiling} deliveries while pumping`);
          }
          await this.takeNext().run();
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  /* ── offer/answer broker ─────────────────────────────────── */

  registerOffer(session: FakeSession): string {
    const token = `offer-${this.tokenCounter++}`;
    this.offers.set(token, session);
    return token;
  }

  acceptOfferToken(answerSession: FakeSession, offerToken: string): string {
    const offerSession = this.offers.get(offerToken);
    if (!offerSession) throw new Error(`fake net: unknown offer token ${offerToken}`);
    this.offers.delete(offerToken);
    const answerToken = `answer-${this.tokenCounter++}`;
    this.pendingAnswers.set(answerToken, { offerSession, answerSession });
    return answerToken;
  }

  resolveAnswer(answerToken: string): void {
    const pair = this.pendingAnswers.get(answerToken);
    if (!pair) throw new Error(`fake net: unknown answer token ${answerToken}`);
    this.pendingAnswers.delete(answerToken);
    pair.offerSession.peer = pair.answerSession;
    pair.answerSession.peer = pair.offerSession;
    // the real transport goes live once the datachannel opens on both ends;
    // schedule both notifications through the queue rather than firing them
    // synchronously here, so callers never re-enter mid-handshake.
    this.enqueue(pair.offerSession.nodeIdx, pair.offerSession.nodeIdx, () => pair.offerSession.fireLive());
    this.enqueue(pair.answerSession.nodeIdx, pair.answerSession.nodeIdx, () => pair.answerSession.fireLive());
  }

  /* ── delivery queue ───────────────────────────────────────── */

  private takeNext(): QueuedDelivery {
    if (!this.reorder || this.queue.length <= 1) return this.queue.shift()!;
    const window = Math.min(REORDER_WINDOW, this.queue.length);
    const pick = Math.floor(this.rng() * window);
    return this.queue.splice(pick, 1)[0];
  }

  /** process the queue to quiescence: drain FIFO (or bounded-reorder),
   *  awaiting each delivery in turn, then yield one macrotask tick to let
   *  fire-and-forget internal awaits (epoch queue, topology reconciliation)
   *  land before checking whether new work appeared. returns once a settle
   *  round finds nothing queued. */
  async drain(): Promise<void> {
    let processed = 0;
    for (;;) {
      while (this.queue.length > 0) {
        const next = this.takeNext();
        processed++;
        if (processed > this.deliveryCeiling) {
          throw new Error(`virtual net: exceeded ${this.deliveryCeiling} deliveries — probable infinite gossip loop`);
        }
        await next.run();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.queue.length === 0) return;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   FakeSession: CampfireSessionLike backed by a VirtualNet
   ═══════════════════════════════════════════════════════════════════ */

export class FakeSession implements CampfireSessionLike {
  readonly nodeIdx: number;
  peer: FakeSession | null = null;
  disconnected = false;

  private net: VirtualNet;
  private callbacks: WhisperLiveCallbacks;

  constructor(net: VirtualNet, nodeIdx: number, callbacks: WhisperLiveCallbacks) {
    this.net = net;
    this.nodeIdx = nodeIdx;
    this.callbacks = callbacks;
  }

  /* invoked by VirtualNet/other sessions — never call these on yourself
   * from outside the queue, or you re-enter the node mid-handshake. */
  fireLive(): void {
    this.callbacks.onStateChange("live");
  }

  fireDisconnected(): void {
    this.callbacks.onStateChange("disconnected");
  }

  async deliverRaw(plaintext: Uint8Array): Promise<void> {
    // no disconnected guard here: a send enqueued before disconnect() must
    // still land (see sendEncryptedRaw) — only the pre-enqueue check there
    // decides whether a send happens at all.
    const fn = this.callbacks.onRawDecrypted;
    if (!fn) return;
    // onRawDecrypted is typed void but CampfireNode's real implementation is
    // async (handleCampfireMessage); capture and await whatever it returns.
    const ret = (fn as unknown as (p: Uint8Array) => unknown)(plaintext);
    if (ret && typeof (ret as Promise<unknown>).then === "function") {
      await (ret as Promise<unknown>);
    }
  }

  deliverText(msg: { type: "text"; text: string; timestamp: number; msgId: number }): void {
    this.callbacks.onMessage(msg as unknown as Parameters<WhisperLiveCallbacks["onMessage"]>[0]);
  }

  /* ── CampfireSessionLike ──────────────────────────────────── */

  async createOffer(): Promise<string> {
    return this.net.registerOffer(this);
  }

  async acceptOffer(offerToken: string): Promise<string> {
    return this.net.acceptOfferToken(this, offerToken);
  }

  async applyAnswer(answerToken: string): Promise<void> {
    this.net.resolveAnswer(answerToken);
  }

  async sendEncryptedRaw(plaintext: Uint8Array, _flags: number): Promise<void> {
    // guard against NEW sends issued after this session's own disconnect;
    // once enqueued below, delivery proceeds regardless of what disconnect()
    // does afterward — a message sent before disconnect must still land,
    // matching endCampfire's own "announce, then disconnect" ordering.
    if (this.disconnected || !this.peer) return;
    const copy = plaintext.slice();
    const target = this.peer;
    const fromIdx = this.nodeIdx;
    const toIdx = target.nodeIdx;
    this.net.enqueue(fromIdx, toIdx, async () => {
      if (this.net.shouldDrop(fromIdx, toIdx, copy)) return;
      await target.deliverRaw(copy);
    });
  }

  async sendText(text: string): Promise<number | void> {
    if (this.disconnected || !this.peer) return;
    const msgId = this.net.nextMsgId();
    const target = this.peer;
    const fromIdx = this.nodeIdx;
    const toIdx = target.nodeIdx;
    this.net.enqueue(fromIdx, toIdx, () => {
      target.deliverText({ type: "text", text, timestamp: Date.now(), msgId });
    });
    return msgId;
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    const peer = this.peer;
    this.net.enqueue(this.nodeIdx, this.nodeIdx, () => this.fireDisconnected());
    if (peer && !peer.disconnected) {
      peer.disconnected = true;
      this.net.enqueue(peer.nodeIdx, peer.nodeIdx, () => peer.fireDisconnected());
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Node orchestration
   ═══════════════════════════════════════════════════════════════════ */

export interface NodeRecord {
  readonly net: VirtualNet;
  readonly idx: number;
  readonly name: string;
  readonly node: CampfireNode;
  readonly states: CampfireState[];
  readonly stateDetails: Array<{ state: CampfireState; detail?: string }>;
  readonly messages: CampfireMessage[];
  readonly logs: string[];
  readonly peersSeen: Array<{ peerId: Uint8Array; name: string }>;
  readonly diverged: Array<{ hex: string; reason: string }>;
  readonly stalled: Array<{ hex: string; reason: string }>;
  readonly equivocations: Array<{ hex: string; seq: number }>;
}

/** construct a CampfireNode wired to a fake transport bound to `net`,
 *  recording every callback into arrays on the returned record. */
export function makeNode(net: VirtualNet, name: string, opts: { ringRepairIntervalMs?: number; beaconCheckMs?: number; beaconIdleMs?: number } = {}): NodeRecord {
  const idx = net.nextNodeIdx();
  const states: CampfireState[] = [];
  const stateDetails: Array<{ state: CampfireState; detail?: string }> = [];
  const messages: CampfireMessage[] = [];
  const logs: string[] = [];
  const peersSeen: Array<{ peerId: Uint8Array; name: string }> = [];
  const diverged: Array<{ hex: string; reason: string }> = [];
  const stalled: Array<{ hex: string; reason: string }> = [];
  const equivocations: Array<{ hex: string; seq: number }> = [];

  const sessionFactory: CampfireSessionFactory = (callbacks) => new FakeSession(net, idx, callbacks);

  const callbacks: CampfireCallbacks = {
    onStateChange: (state, detail) => {
      states.push(state);
      stateDetails.push({ state, detail });
    },
    onMessage: (msg) => { messages.push(msg); },
    onPeerJoin: (peerId, peerName) => { peersSeen.push({ peerId, name: peerName }); },
    onPeerLeave: () => {},
    onPeerListUpdate: () => {},
    onLog: (line) => { logs.push(line); },
    onRoomCodeUpdate: () => {},
    onDmMessage: () => {},
    onReact: () => {},
    onUnreact: () => {},
    onSeatDiverged: (peerId, reason) => { diverged.push({ hex: toHex(peerId), reason }); },
    onSeatStalled: (peerId, reason) => { stalled.push({ hex: toHex(peerId), reason }); },
    onSeatEquivocated: (peerId, seq) => { equivocations.push({ hex: toHex(peerId), seq }); },
  };

  const node = new CampfireNode(callbacks, {
    sessionFactory,
    ringRepairIntervalMs: opts.ringRepairIntervalMs,
    beaconCheckMs: opts.beaconCheckMs,
    beaconIdleMs: opts.beaconIdleMs,
  });

  return { net, idx, name, node, states, stateDetails, messages, logs, peersSeen, diverged, stalled, equivocations };
}

/** mimic the UI join flow: host must already have created (or be holding a
 *  fresh root slot from a prior join); joiner accepts the current offer;
 *  host applies the answer; then drain until the handshake, admission fold,
 *  welcome, and mesh reconciliation all settle. */
export async function connect(host: NodeRecord, joiner: NodeRecord): Promise<void> {
  const offer = host.node.getCurrentOfferCode() ?? await host.node.createCampfire(host.name, false);
  const answer = await joiner.node.joinCampfire(offer, joiner.name, false);
  await host.node.applyAnswer(answer);
  await host.net.drain();
}

/** reach into the private epoch field — acceptable for integration
 *  assertions (root bytes, roster, epochId) that have no public getter. */
export function epochOf(rec: NodeRecord): { epochId: number; roster: string[]; root: Uint8Array } | null {
  return (rec.node as unknown as { currentEpoch: { epochId: number; roster: string[]; root: Uint8Array } | null }).currentEpoch;
}

/** the current elder's hex id (roster[0] of the current epoch), or null if
 *  the node isn't seated yet. */
export function elderHex(rec: NodeRecord): string | null {
  const epoch = epochOf(rec);
  return epoch && epoch.roster.length > 0 ? epoch.roster[0] : null;
}

/** number of currently-connected neighbor links (mesh edges plus any
 *  surviving bootstrap link) — reaches into the private neighbors map. */
export function connectedNeighborCount(rec: NodeRecord): number {
  const neighbors: Map<string, { connected: boolean }> =
    (rec.node as unknown as { neighbors: Map<string, { connected: boolean }> }).neighbors;
  let n = 0;
  for (const peer of neighbors.values()) if (peer.connected) n++;
  return n;
}

export function findByHex(recs: NodeRecord[], hex: string): NodeRecord | undefined {
  return recs.find((r) => r.node.getPeerIdHex() === hex);
}

/** forge a delivery straight into `target`'s incoming handler by borrowing
 *  one of its live neighbor links and sending from the far end — the same
 *  path a malicious or corrupted peer would use, without needing target's
 *  own session (which only sends outward). */
export async function injectForgedMessage(target: NodeRecord, plaintext: Uint8Array): Promise<void> {
  const neighbors: Map<string, { connected: boolean; session: CampfireSessionLike | null }> =
    (target.node as unknown as { neighbors: Map<string, { connected: boolean; session: CampfireSessionLike | null }> }).neighbors;
  for (const peer of neighbors.values()) {
    if (peer.connected && peer.session) {
      const mirror = (peer.session as FakeSession).peer;
      if (mirror) {
        await mirror.sendEncryptedRaw(plaintext, 0x02);
        return;
      }
    }
  }
  throw new Error("injectForgedMessage: target has no connected neighbor session");
}

/** deliver `bytes` to `target` over the link whose far end is the peer `fromHex`,
 *  so the receiver attributes the frame to that specific neighbor. use this when
 *  an attack depends on WHO the immediate sender is; injectForgedMessage borrows
 *  an arbitrary neighbor and would silently model a different attacker. returns
 *  false if target has no connected link to that peer. */
export async function injectForgedMessageFrom(
  target: NodeRecord, fromHex: string, bytes: Uint8Array,
): Promise<boolean> {
  const neighbors: Map<string, { connected: boolean; peerIdHex: string; session: CampfireSessionLike | null }> =
    (target.node as unknown as {
      neighbors: Map<string, { connected: boolean; peerIdHex: string; session: CampfireSessionLike | null }>;
    }).neighbors;
  for (const peer of neighbors.values()) {
    if (!peer.connected || !peer.session || peer.peerIdHex !== fromHex) continue;
    const mirror = (peer.session as FakeSession).peer;
    if (!mirror) continue;
    await mirror.sendEncryptedRaw(bytes, 0x02);
    return true;
  }
  return false;
}

/** Corrupt a CF_GROUP_MSG's ciphertext and repair its msgId so the frame stays
 *  internally consistent. The receiver recomputes msgId from
 *  (senderId, epochId, seq, ciphertext) and drops mismatches, which is what stops
 *  a relay from censoring by id-collision — so a test that wants the frame to
 *  reach the CRYPTO layer has to keep the id honest. Returns the new frame.
 *  Layout: [type 1][msgId 32][senderId 16][seq 4][epochId 4][ts 8][hop 1][ct 1][frontier..][ciphertext..] */
export async function corruptGroupCiphertext(
  frame: Uint8Array, sender: NodeRecord, byteFromEnd = 1,
): Promise<Uint8Array> {
  const out = frame.slice();
  out[out.length - byteFromEnd] ^= 0xff;
  const body = out.subarray(1);
  const senderId = body.subarray(32, 32 + 16);
  const parsed = parseGroupMsgHeader(body);
  if (!parsed) throw new Error("corruptGroupCiphertext: frame did not parse");
  // production order is (peerId, epochId, seq, ciphertext) — see broadcastText
  const msgId = await sha256(concatBytes(senderId, le32(parsed.epochId), le32(parsed.seq), parsed.ciphertext));
  out.set(msgId, 1);

  // Re-sign as the sender. Group messages are authored, so a corrupted frame is
  // dropped before it ever reaches the crypto layer unless its signature is
  // valid — which is the point of the defence. A test that wants to exercise a
  // frame that AUTHENTICATES but will not OPEN is modelling an honest-but-buggy
  // sender, and only that sender's own key can produce one.
  const identity = (sender.node as unknown as { identity: CampfireIdentity }).identity;
  const sigBody = groupMsgSigningBody(
    senderId, parsed.seq, parsed.epochId, parsed.timestamp, parsed.contentType,
    parsed.confirm, parsed.frontier, parsed.ciphertext, identity.publicKey,
  );
  const signature = await signBytes(identity, sigBody);
  // [type 1][msgId 32][senderId 16][seq 4][epochId 4][ts 8][hop 1][ct 1][pubkey 33][sig 64]
  out.set(identity.publicKey, 1 + 32 + 16 + 4 + 4 + 8 + 1 + 1);
  out.set(signature, 1 + 32 + 16 + 4 + 4 + 8 + 1 + 1 + 33);
  return out;
}

function le32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

/** destroy every node (stops their real timers) then drain to flush leave
 *  announces and let async teardown (endCampfire's promise chain) settle
 *  before the test process tries to exit. */
export async function teardown(recs: NodeRecord[]): Promise<void> {
  for (const rec of recs) rec.node.destroy();
  const net = recs[0]?.net;
  if (net) await net.drain();
}
