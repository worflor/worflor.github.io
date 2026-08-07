/**
 * vnet.ts — a discrete-event network with an actual clock.
 *
 * WHAT WAS WRONG WITH THE OLD ONE. The previous simulation had no time in it.
 * It was a FIFO: enqueue a burst from one direction, drain it to quiescence,
 * then let the other direction go. Everything was serial, nothing was ever in
 * flight, and the two peers never spoke at once. That is not a network, it is a
 * turn-based board game, and a Double Ratchet is *specifically* the protocol
 * whose hard cases only exist when both sides act before hearing from the other.
 *
 * The condition that matters and that a FIFO can never produce:
 *
 *     A ---- m1 (new DH key kA₂) ---->  \  /  <---- m2 (still under kA₁) ---- B
 *                                        \/
 *                                        /\   the frames CROSS
 *
 * B sent m2 believing A's key was kA₁. A already moved to kA₂. Now A receives a
 * message from the chain it thinks is finished, and B receives a ratchet step
 * for a chain it has unsent messages on. That is what prevChainLen, skipped
 * message keys and MAX_SKIP are all FOR, and a strictly alternating harness
 * exercises none of it.
 *
 * WHAT IS MODELLED, AND WHY EACH ONE.
 *
 *  - VIRTUAL TIME. A priority queue keyed by timestamp. Nothing sleeps, so a
 *    twenty-minute session runs in milliseconds, and every run is reproducible
 *    because the ordering comes from the clock and a seeded tiebreak rather than
 *    from the host's scheduler.
 *
 *  - HEAVY-TAILED LATENCY. Real RTT distributions are lognormal-ish with a long
 *    right tail; uniform jitter would never produce the rare 800ms straggler
 *    that actually causes crossing. Sampled as exp(normal), which is the
 *    standard shape and costs one Box-Muller.
 *
 *  - GILBERT-ELLIOTT LOSS. Packet loss on real paths is BURSTY: a two-state
 *    Markov chain (GOOD/BAD) with a low loss rate in GOOD and a high one in BAD.
 *    Independent per-packet coin flips are the classic modelling mistake — they
 *    make a 2% loss rate look like isolated blips, when the thing that breaks
 *    protocols is losing six in a row.
 *
 *  - ORDERED-RELIABLE SEMANTICS ON TOP. Production opens the datachannel with
 *    `ordered: true`, so SCTP retransmits and re-sequences beneath the app. It
 *    would be INFIDELITY, not rigor, to hand out-of-order frames to a protocol
 *    that cannot receive them. So loss here becomes what loss actually is at the
 *    application layer: HEAD-OF-LINE BLOCKING. Lose packet 5 and 6,7,8 sit in
 *    the receiver's buffer until the retransmit lands, then all four surface in
 *    one burst. Bursty arrival under concurrent load is the realistic stressor.
 *
 *  - SERIALIZATION DELAY. Big frames take longer to put on the wire, so a file
 *    chunk genuinely delays the chat message behind it. This is where the
 *    interesting delay correlation comes from.
 *
 *  - RECONNECT. The one place gaps are real: a new datachannel means everything
 *    in flight is gone for good, and ordering restarts.
 *
 *  - CLOCK SKEW. The two peers do not agree on the time, because two machines
 *    never do, and anything that compares timestamps across the pair had better
 *    not assume they do.
 */

import type { Rng } from "./rng.js";

export interface LinkProfile {
  /** median one-way delay in ms before jitter. */
  baseLatencyMs: number;
  /** lognormal sigma: 0 is a fixed delay, 0.6 is a normal-looking wifi tail. */
  jitter: number;
  /** bytes per second, for serialization delay. */
  bandwidthBps: number;
  /** Gilbert-Elliott: loss probability while in the GOOD state. */
  lossGood: number;
  /** Gilbert-Elliott: loss probability while in the BAD state. */
  lossBad: number;
  /** per-packet probability of entering the BAD state. */
  pGoodToBad: number;
  /** per-packet probability of recovering. */
  pBadToGood: number;
  /** retransmission timeout in ms. */
  rtoMs: number;
}

/** a plausible domestic wifi path: fast, mostly clean, with real bad minutes. */
export const WIFI: LinkProfile = {
  baseLatencyMs: 28, jitter: 0.55, bandwidthBps: 2_000_000,
  lossGood: 0.001, lossBad: 0.35, pGoodToBad: 0.004, pBadToGood: 0.25, rtoMs: 220,
};

/** a phone on a bad train: slow, heavy tail, long bad periods. */
export const MOBILE_POOR: LinkProfile = {
  baseLatencyMs: 140, jitter: 1.1, bandwidthBps: 180_000,
  lossGood: 0.01, lossBad: 0.6, pGoodToBad: 0.02, pBadToGood: 0.08, rtoMs: 700,
};

/** same room, same router: the easy case, kept so profiles can be compared. */
export const LAN: LinkProfile = {
  baseLatencyMs: 2, jitter: 0.15, bandwidthBps: 50_000_000,
  lossGood: 0, lossBad: 0, pGoodToBad: 0, pBadToGood: 1, rtoMs: 50,
};

interface Event {
  at: number;
  order: number;
  run: () => void | Promise<void>;
}

/**
 * The scheduler. Events fire in timestamp order; ties break on insertion order,
 * so a run is a pure function of the seed.
 */
export class VirtualClock {
  private events: Event[] = [];
  private counter = 0;
  private t = 0;

  now(): number {
    return this.t;
  }

  at(time: number, run: () => void | Promise<void>): void {
    this.events.push({ at: Math.max(time, this.t), order: this.counter++, run });
  }

  after(delay: number, run: () => void | Promise<void>): void {
    this.at(this.t + Math.max(0, delay), run);
  }

  pending(): number {
    return this.events.length;
  }

  /**
   * Run until the queue empties or `untilMs` is reached.
   *
   * The queue is re-sorted each step rather than kept in a heap: these runs are
   * thousands of events, not millions, and a visibly correct ordering is worth
   * more here than the log factor.
   */
  async run(untilMs = Infinity, maxEvents = 500_000): Promise<number> {
    let fired = 0;
    while (this.events.length > 0) {
      if (++fired > maxEvents) throw new Error(`vnet: ${maxEvents} events without settling`);
      this.events.sort((a, b) => (a.at - b.at) || (a.order - b.order));
      const next = this.events[0];
      if (next.at > untilMs) break;
      this.events.shift();
      this.t = next.at;
      await next.run();
    }
    return fired;
  }
}

/** Box-Muller, so the latency tail is a real tail rather than a uniform band. */
function normal(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-9);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * One direction of one connection: lossy, jittery, bandwidth-limited underneath;
 * ordered and reliable at the surface, which is what `ordered: true` buys.
 */
export class Link {
  private geBad = false;
  private nextSeq = 0;
  private expected = 0;
  /** frames that arrived ahead of a gap, waiting for the retransmit. */
  private holdback = new Map<number, Uint8Array>();
  /** when the wire is next free, for serialization. */
  private wireFreeAt = 0;

  readonly stats = {
    sent: 0, delivered: 0, dropped: 0, retransmitted: 0,
    maxHoldback: 0, burstsDelivered: 0, lostToReconnect: 0,
  };
  /** frames handed to the transport but not yet surfaced at the far end. */
  private outstanding = 0;

  constructor(
    private clock: VirtualClock,
    private rng: Rng,
    private profile: LinkProfile,
    private deliver: (bytes: Uint8Array) => void | Promise<void>,
  ) {}

  /** true if this packet is lost, advancing the Gilbert-Elliott state machine. */
  private lost(): boolean {
    const p = this.geBad ? this.profile.lossBad : this.profile.lossGood;
    const isLost = this.rng.next() < p;
    // the state transition is per-packet, which is what makes loss come in runs
    if (this.geBad) {
      if (this.rng.next() < this.profile.pBadToGood) this.geBad = false;
    } else if (this.rng.next() < this.profile.pGoodToBad) {
      this.geBad = true;
    }
    return isLost;
  }

  private latency(bytes: number): number {
    const jittered = this.profile.baseLatencyMs * Math.exp(normal(this.rng) * this.profile.jitter);
    const serialize = (bytes / this.profile.bandwidthBps) * 1000;
    // the wire is busy until the previous frame has finished going out
    const startAt = Math.max(this.clock.now(), this.wireFreeAt);
    this.wireFreeAt = startAt + serialize;
    return (startAt - this.clock.now()) + serialize + jittered;
  }

  /** hand a frame to the transport. */
  send(bytes: Uint8Array): void {
    const seq = this.nextSeq++;
    this.stats.sent++;
    this.outstanding++;
    this.transmit(seq, bytes, 0);
  }

  private transmit(seq: number, bytes: Uint8Array, attempt: number): void {
    if (attempt > 24) throw new Error("vnet: a frame never got through; the profile is unsurvivable");
    if (this.lost()) {
      this.stats.dropped++;
      // SCTP notices and retransmits. The APPLICATION sees this as delay, and
      // as head-of-line blocking for everything queued behind it.
      this.clock.after(this.profile.rtoMs, () => {
        this.stats.retransmitted++;
        this.transmit(seq, bytes, attempt + 1);
      });
      return;
    }
    this.clock.after(this.latency(bytes.length), () => this.arrive(seq, bytes));
  }

  /** reassembly: deliver the contiguous prefix, hold anything past a gap. */
  private async arrive(seq: number, bytes: Uint8Array): Promise<void> {
    if (seq < this.expected) return; // a duplicate retransmit; SCTP would drop it
    this.holdback.set(seq, bytes);
    this.stats.maxHoldback = Math.max(this.stats.maxHoldback, this.holdback.size);

    let burst = 0;
    while (this.holdback.has(this.expected)) {
      const frame = this.holdback.get(this.expected)!;
      this.holdback.delete(this.expected);
      this.expected++;
      burst++;
      this.stats.delivered++;
      this.outstanding--;
      await this.deliver(frame);
    }
    if (burst > 1) this.stats.burstsDelivered++;
  }

  /**
   * The datachannel died. Everything in flight is gone for real — this is the
   * only place the application sees a genuine gap rather than a delay.
   */
  reconnect(): void {
    this.stats.lostToReconnect += this.outstanding;
    this.outstanding = 0;
    this.holdback.clear();
    this.expected = this.nextSeq;
    this.geBad = false;
    this.wireFreeAt = this.clock.now();
  }

  /** how many frames are on the wire right now — the crossing detector. */
  inFlight(): number {
    return this.outstanding;
  }
}

/**
 * Two peers that do not agree about what time it is.
 *
 * Skew is constant offset plus drift, because both are real: phones differ by
 * seconds at rest and their crystals run at slightly different rates. Anything
 * that compares a local timestamp to a peer's must survive this, and the only
 * way to find out is to make them disagree.
 */
export class SkewedClock {
  constructor(
    private clock: VirtualClock,
    private offsetMs: number,
    private driftPpm: number,
  ) {}

  now(): number {
    const t = this.clock.now();
    return t + this.offsetMs + (t * this.driftPpm) / 1e6;
  }
}
