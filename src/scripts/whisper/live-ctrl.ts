/**
 * Whisper Live — control protocol (CTRL frames).
 *
 * Opcode ranges:
 *   0x01–0x0F  history/storage    CLEAR_VOTE=0x01, CLEAR_CANCEL=0x02
 *   0x10–0x1F  presence/status    (future)
 *   0x20–0x2F  reactions          (future)
 *   0x30–0x3F  session policy     (future)
 *
 * Frame format (payload after LIVE_MSG.CTRL type byte):
 *   [0]       opcode      (1B)
 *   [1]       payload_len (1B, 0–255)
 *   [2..2+N]  payload     (N bytes)
 */

export const CTRL_OP = {
  CLEAR_VOTE:   0x01,
  CLEAR_CANCEL: 0x02,
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
 * Usage:
 *   const clear = new VoteTopic({ parties: 2, timeoutMs: 30_000, onExecute, onState });
 *   // user clicks button  → clear.castLocal()   → returns { send: voteOpcode } or { execute: true }
 *   // peer sends vote     → clear.receivePeer()  → may trigger execute
 *   // user cancels        → clear.cancelLocal()  → returns { send: cancelOpcode }
 *   // peer cancels        → clear.cancelPeer()
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
  private _peer = 0;
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

  /** Cast this client's vote. Returns true if threshold met (action executed). */
  castLocal(): boolean {
    if (this._local) return false;
    this._local = true;
    if (this._tally() >= this.threshold) {
      this._execute();
      return true;
    }
    this._transition("pending-out");
    this._arm();
    return false;
  }

  /** Retract this client's vote. */
  cancelLocal(): void {
    if (!this._local) return;
    this._local = false;
    this._clearTimer();
    this._transition(this._peer > 0 ? "pending-in" : "idle");
  }

  /** Register a peer's vote. Returns true if threshold met (action executed). */
  receivePeer(): boolean {
    this._peer = Math.min(this._peer + 1, this._maxPeer);
    if (this._tally() >= this.threshold) {
      this._execute();
      return true;
    }
    this._transition("pending-in");
    this._arm();
    return false;
  }

  /** Register a peer's cancellation. */
  cancelPeer(): void {
    this._peer = Math.max(this._peer - 1, 0);
    if (this._tally() < this.threshold) {
      this._clearTimer();
      this._transition(this._local ? "pending-out" : "idle");
    }
  }

  /** Reset all state — call on disconnect / session teardown. */
  reset(): void {
    this._local = false;
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
    this._peer = 0;
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

/* ── Message reference encoding ─────────────────────────── */

/**
 * Encode a message reference as a 5-byte payload.
 * [0]    direction: 0x00 = self (from sender's perspective), 0x01 = peer
 * [1..4] counter (4B LE)
 */
export function encodeMsgRef(direction: "self" | "peer", counter: number): Uint8Array {
  const buf = new Uint8Array(5);
  buf[0] = direction === "self" ? 0x00 : 0x01;
  new DataView(buf.buffer).setUint32(1, counter, true);
  return buf;
}

export function decodeMsgRef(payload: Uint8Array): { direction: "self" | "peer"; counter: number } | null {
  if (payload.length < 5) return null;
  return {
    direction: payload[0] === 0x00 ? "self" : "peer",
    counter: new DataView(payload.buffer, payload.byteOffset + 1, 4).getUint32(0, true),
  };
}
