/**
 * Whisper Live — control protocol (CTRL frames).
 *
 * Opcode ranges:
 *   0x01–0x7F  signals  (bit 7 = 0)
 *     0x01  VOTE     [topic:1B][round:1B]  : cast vote for topic's round
 *     0x02  CANCEL   [topic:1B][round:1B]  : retract vote for topic's round
 *       topic 0x01 = clear history, 0x02 = campfire
 *       round is a per-topic mod-256 counter, bumped each time a vote executes,
 *       letting both sides converge correctly even when a local cancel crosses an
 *       already-committed peer vote for the same round (see VoteTopic below).
 *     0x20  STREAM_STATE  [flags:1B]  — bit0=audio, bit1=video, bit2=screen
 *     0x30–0x3F  session policy     (future)
 *   0x80–0xFF  payload-bearing ops (bit 7 = 1)
 *     0x81  SEEN        [msgId:4B LE]
 *     0x82  REACT       [msgId:4B LE][emoji:utf8]
 *     0x83  UNREACT     [msgId:4B LE][emoji:utf8]
 *     0x84  FILE_CANCEL [transferId:4B LE][role:1B]
 *       role 0 = sender aborting its own outbound transfer
 *       role 1 = receiver rejecting an inbound transfer
 *
 * Frame format (payload after LIVE_MSG.CTRL type byte):
 *   [0]       opcode      (1B)
 *   [1]       payload_len (1B, 0–255)
 *   [2..2+N]  payload     (N bytes)
 *
 * Message references use the global session msgId (uint32 LE):
 *   offerer's messages → even IDs (0, 2, 4…)
 *   answerer's messages → odd IDs (1, 3, 5…)
 * No direction byte needed — the parity encodes it.
 */

export const CTRL_OP = {
  VOTE: 0x01,    // payload: [topic:1B][round:1B]
  CANCEL: 0x02,  // payload: [topic:1B][round:1B]
  STREAM_STATE: 0x20, // payload: [flags:1B] bit0=audio, bit1=video, bit2=screen, 0x00=off
  SEEN: 0x81,  // payload: [msgId:4B LE]
  REACT: 0x82,  // payload: [msgId:4B LE][emoji:utf8]
  UNREACT: 0x83,  // payload: [msgId:4B LE][emoji:utf8]
  FILE_CANCEL: 0x84,  // payload: [transferId:4B LE][role:1B]
  DRAW_STREAM: 0x90, // payload: draw-stream binary frame (live-draw-stream.ts)
} as const;

/** FILE_CANCEL role byte — whose transfer the cancel frame originated from. */
export const FILE_CANCEL_ROLE = {
  /** the sender is aborting its own outbound transfer. */
  SENDER: 0,
  /** the receiver is rejecting an inbound transfer. */
  RECEIVER: 1,
} as const;

export const VOTE_TOPIC = {
  CLEAR: 0x01,
  CAMPFIRE: 0x02,
} as const;

/* ── Wire format ─────────────────────────────────────────── */

export function encodeCtrl(opcode: number, payload?: Uint8Array): Uint8Array {
  const n = payload?.length ?? 0;
  if (n > 255) throw new RangeError("ctrl payload > 255 bytes");
  const buf = new Uint8Array(2 + n);
  buf[0] = opcode; buf[1] = n;
  if (payload && n > 0) buf.set(payload, 2);
  return buf;
}

export function decodeCtrl(bytes: Uint8Array): { opcode: number; payload: Uint8Array } | null {
  if (bytes.length < 2) return null;
  const payloadLen = bytes[1];
  if (bytes.length < 2 + payloadLen) return null;
  return { opcode: bytes[0], payload: bytes.subarray(2, 2 + payloadLen) };
}

/* ── Vote topic ──────────────────────────────────────────── */

/**
 * Generic voted operation. Encapsulates the symmetric voting state machine:
 * both parties must agree before an action executes.
 *
 * Rounds: each topic tracks a currentRound (mod 256), bumped only on execute.
 * castLocal/cancelLocal always act on the current round, so read `.round` when
 * building the wire payload so the peer knows which round a vote belongs to.
 *
 * Convergence: if the peer's VOTE for round R arrives after the local side
 * cancelled its own vote for round R, the local side still executes, because the
 * peer necessarily saw our vote before committing (that's why they crossed
 * threshold), so their execution already happened and the cancel arrived too
 * late to prevent it. A local sticky "voted this round" flag (independent of
 * the live cancel/vote toggle) drives this: it's set by castLocal and only
 * cleared by execute or reset, never by cancelLocal.
 *
 * Usage:
 *   const clear = new VoteTopic({ parties: 2, timeoutMs: 30_000, onExecute, onState });
 *   // user clicks button  → session.sendCtrl(VOTE, encodeVotePayload(topic, clear.round)); clear.castLocal();
 *   // peer sends vote     → clear.receivePeer(round)        → may trigger execute
 *   // user cancels        → session.sendCtrl(CANCEL, encodeVotePayload(topic, clear.round)); clear.cancelLocal();
 *   // peer cancels        → clear.receivePeerCancel(round)
 *   // session ends        → clear.reset()
 */
export type VoteState = "idle" | "pending-out" | "pending-in";

export interface VoteTopicOptions {
  /** Total participants (default 2 for 1:1). */
  parties?: number;
  /** Timeout in ms before votes expire (default 30s). */
  timeoutMs?: number;
  /**
   * Weight of this client's vote (default 1).
   * Always 1 in 1:1 (symmetric). In campfire, founders get weight 2.
   * Assigned locally, never declared over the wire → unspoofable.
   */
  localWeight?: number;
  /**
   * Weight of each peer's vote (default 1).
   * In 1:1, always 1 (symmetric). In campfire, non-founder peers get weight 1.
   */
  peerWeight?: number;
  /** Called when the vote threshold is met — execute the action. */
  onExecute: () => void;
  /** Called on every state transition. Wire this to your UI. */
  onState: (state: VoteState) => void;
}

export class VoteTopic {
  readonly threshold: number;

  private _state: VoteState = "idle";
  private _local = false;
  /** sticky: true once castLocal fires this round, cleared only by execute/reset,
   *  NOT by cancelLocal. drives the crossing-cancel convergence rule (see class doc). */
  private _localVotedThisRound = false;
  private _peer = 0;
  /** per-topic round counter (wire byte, wraps mod 256). bumped only on execute. */
  private _round = 0;
  private _maxPeer: number;
  private _localWeight: number;
  private _peerWeight: number;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _timeoutMs: number;
  private _onExecute: () => void;
  private _onState: (state: VoteState) => void;

  constructor(opts: VoteTopicOptions) {
    const parties = opts.parties ?? 2;
    this._localWeight = opts.localWeight ?? 1;
    this._peerWeight = opts.peerWeight ?? 1;
    const totalWeight = this._localWeight + this._peerWeight * (parties - 1);
    this.threshold = Math.floor(totalWeight / 2) + 1;
    this._maxPeer = parties - 1;
    this._timeoutMs = opts.timeoutMs ?? 30_000;
    this._onExecute = opts.onExecute;
    this._onState = opts.onState;
  }

  get state(): VoteState { return this._state; }
  get localVoted(): boolean { return this._local; }
  /** The round a local castLocal()/cancelLocal() right now would apply to.
   *  Read this when building the wire payload for VOTE/CANCEL. */
  get round(): number { return this._round; }

  /**
   * Reconfigure weights and recalculate threshold.
   * Call when the session role becomes known (e.g. on "live" state).
   * Safe to call multiple times — resets vote state.
   */
  setWeights(localWeight: number, peerWeight: number, parties?: number): void {
    this._localWeight = localWeight;
    this._peerWeight = peerWeight;
    if (parties !== undefined) this._maxPeer = parties - 1;
    const totalWeight = this._localWeight + this._peerWeight * this._maxPeer;
    (this as { threshold: number }).threshold = Math.floor(totalWeight / 2) + 1;
    this.reset();
  }

  /** Cast this client's vote for the current round. Returns true if threshold met (action executed). */
  castLocal(): boolean {
    if (this._local) return false;
    this._local = true;
    this._localVotedThisRound = true;
    if (this._tally() >= this.threshold) {
      this._execute();
      return true;
    }
    this._transition("pending-out");
    this._arm();
    return false;
  }

  /** Retract this client's vote for the current round. Does not clear the sticky
   *  "voted this round" flag: a peer vote that already crossed threshold before
   *  seeing this cancel must still converge (see receivePeer). */
  cancelLocal(): void {
    if (!this._local) return;
    this._local = false;
    this._clearTimer();
    this._transition(this._peer > 0 ? "pending-in" : "idle");
  }

  /**
   * Register a peer's vote for `round`. Returns true if the action executed.
   * Stale rounds (already resolved here) are no-ops. A round matching ours where
   * we ever voted (even if since locally cancelled) converges immediately, since the
   * peer only sent this because they'd already seen our vote and crossed
   * threshold on their side before our cancel could reach them.
   */
  receivePeer(round: number): boolean {
    if (round !== this._round) return false; // stale or ahead, SCTP ordering means this shouldn't happen
    if (this._localVotedThisRound) {
      this._execute();
      return true;
    }
    this._peer = Math.min(this._peer + 1, this._maxPeer);
    if (this._tally() >= this.threshold) {
      this._execute();
      return true;
    }
    this._transition("pending-in");
    this._arm();
    return false;
  }

  /** Register a peer's cancellation of `round`. A cancel for a round that already
   *  executed here is a no-op: the action already happened, retracting is moot. */
  receivePeerCancel(round: number): void {
    if (round !== this._round) return; // already executed here, or not reached yet: no-op
    this._peer = Math.max(this._peer - 1, 0);
    if (this._tally() < this.threshold) {
      this._clearTimer();
      this._transition(this._local ? "pending-out" : "idle");
    }
  }

  /** Reset all state: call on disconnect / session teardown. Does not bump the
   *  round: an abandoned/timed-out attempt never executed, so retrying the same
   *  round number is safe. */
  reset(): void {
    this._local = false;
    this._localVotedThisRound = false;
    this._peer = 0;
    this._clearTimer();
    this._transition("idle");
  }

  /** Clean up timer without state change. */
  destroy(): void {
    this._clearTimer();
  }

  private _tally(): number { return (this._local ? this._localWeight : 0) + this._peer * this._peerWeight; }

  private _transition(next: VoteState): void {
    if (this._state === next) return;
    this._state = next;
    this._onState(next);
  }

  private _execute(): void {
    this._local = false;
    this._localVotedThisRound = false;
    this._peer = 0;
    this._round = (this._round + 1) & 0xFF;
    this._clearTimer();
    this._state = "idle";
    this._onExecute();
    this._onState("idle");
  }

  private _arm(): void {
    this._clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      this.reset();
    }, this._timeoutMs);
  }

  private _clearTimer(): void {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}

/* ── VOTE / CANCEL payload encoding ──────────────────────── */

/** VOTE / CANCEL payload: 1-byte topic + 1-byte round (mod-256, see VoteTopic). */
export function encodeVotePayload(topic: number, round: number): Uint8Array {
  return new Uint8Array([topic & 0xFF, round & 0xFF]);
}

export function decodeVotePayload(payload: Uint8Array): { topic: number; round: number } | null {
  if (payload.length < 2) return null;
  return { topic: payload[0], round: payload[1] };
}

/* ── Stream state ───────────────────────────────────────── */

export const STREAM_FLAG = {
  AUDIO: 0x01,
  VIDEO: 0x02,
  SCREEN: 0x04,
} as const;

export function encodeStreamState(flags: number): Uint8Array {
  return new Uint8Array([flags & 0xFF]);
}

export function decodeStreamState(payload: Uint8Array): { audio: boolean; video: boolean; screen: boolean } | null {
  if (payload.length < 1) return null;
  return {
    audio: (payload[0] & STREAM_FLAG.AUDIO) !== 0,
    video: (payload[0] & STREAM_FLAG.VIDEO) !== 0,
    screen: (payload[0] & STREAM_FLAG.SCREEN) !== 0,
  };
}

/* ── SEEN / REACT payload encoding ───────────────────────── */

/** SEEN payload: 4-byte global msgId (LE). */
export function encodeSeenPayload(msgId: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, msgId, true);
  return buf;
}

export function decodeSeenPayload(payload: Uint8Array): number | null {
  if (payload.length < 4) return null;
  return new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
}

/** REACT / UNREACT payload: 4-byte global msgId (LE) + emoji as UTF-8 bytes. */
export function encodeReactPayload(msgId: number, emoji: string): Uint8Array {
  const emojiBytes = new TextEncoder().encode(emoji);
  const buf = new Uint8Array(4 + emojiBytes.length);
  new DataView(buf.buffer).setUint32(0, msgId, true);
  buf.set(emojiBytes, 4);
  return buf;
}

export function decodeReactPayload(payload: Uint8Array): { msgId: number; emoji: string } | null {
  if (payload.length < 5) return null;
  // Guard: emoji field must not exceed 32 bytes (largest real emoji sequence is ~28 bytes)
  const emojiByteLen = payload.length - 4;
  if (emojiByteLen > 32) return null;
  const raw = new TextDecoder().decode(payload.subarray(4));
  // Normalise to exactly one grapheme cluster — protects against multi-emoji attacks
  const seg = new Intl.Segmenter();
  const first = seg.segment(raw)[Symbol.iterator]().next().value;
  if (!first?.segment) return null;
  return {
    msgId: new DataView(payload.buffer, payload.byteOffset).getUint32(0, true),
    emoji: first.segment,
  };
}

/* ── FILE_CANCEL payload encoding ────────────────────────── */

/** FILE_CANCEL payload: 4-byte transferId (LE) + 1-byte role (see FILE_CANCEL_ROLE). */
export function encodeFileCancelPayload(transferId: number, role: number): Uint8Array {
  const buf = new Uint8Array(5);
  new DataView(buf.buffer).setUint32(0, transferId, true);
  buf[4] = role & 0xFF;
  return buf;
}

export function decodeFileCancelPayload(payload: Uint8Array): { transferId: number; role: number } | null {
  if (payload.length < 5) return null;
  return {
    transferId: new DataView(payload.buffer, payload.byteOffset).getUint32(0, true),
    role: payload[4],
  };
}
