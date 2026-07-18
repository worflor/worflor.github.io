/**
 * live-braid.ts
 *
 * the braid: the kizuna membrane generalized to n seats.
 *
 * the 2-party loop (live-loop.ts) is one strand: an ordered chain of keys
 * whose salt is the digest of a count-model trained on the whole history.
 * the braid weaves n strands through one shared model. each seat keeps its
 * own ordered send chain (its time); the group shares a commutative count
 * accumulator (its space). commutativity is load-bearing: a message's
 * count-delta is a pure function of its plaintext (see loopTrain), so a SET
 * of messages yields identical counts in any integration order. no total
 * order, no sequencing authority, no server.
 *
 * every message carries its sender's frontier: the highest seq the sender
 * had integrated from each seat when it sealed. the receiver reconstructs
 * the sender's exact view (base counts plus the deltas the frontier names),
 * digests it, and derives the message key from the sender's chain plus that
 * digest. a sender whose history diverged derives a key nobody else can
 * derive, gcm rejects, and after bounded retries the seat's bond is dead
 * for this epoch. the 2-party death-on-desync property, per seat.
 *
 * key derivation:
 *   seat chain     = HKDF(epochRoot, seatIdBytes, 'kizuna-braid-seat-v1', 32)
 *   messageKey     = HKDF(chain, viewDigest, 'kizuna-braid-msg-v1'   || le32(seq), 32)
 *   chain'         = HKDF(chain, viewDigest, 'kizuna-braid-chain-v1' || le32(seq), 32)
 *   epoch fold     = HKDF(prevRoot | 0*32, entropy, 'kizuna-braid-epoch-v1' || le32(epochId) || rosterDigest, 32)
 *   model base     = loopInit(loopExpand(epochRoot)) counts, identical for every seat
 *
 * trust model: matches campfire. the epoch root is shared by the circle, so
 * any member can derive any seat's chain; sender authenticity inside the
 * group is social, not cryptographic. outsiders and divergent histories are
 * what the math excludes.
 *
 * this module is pure: no network, no timers, no dom. the campfire node
 * owns gossip, dedup, repair, and epoch lifecycle.
 */

import { hkdf, TE, aesGcmEncrypt, aesGcmDecrypt } from "./live-crypto";
import { toArrayBuffer } from "./buf";
import {
    loopInit,
    loopExpand,
    loopEncode,
    loopDecode,
    loopTrain,
    modelDigest,
    type ModelCounts,
    type LoopState,
} from "./live-loop";

// --- constants ---

const INFO_SEAT  = TE.encode("kizuna-braid-seat-v1");
const INFO_MSG   = TE.encode("kizuna-braid-msg-v1");
const INFO_CHAIN = TE.encode("kizuna-braid-chain-v1");
const INFO_EPOCH = TE.encode("kizuna-braid-epoch-v1");

const ZERO_SALT_32 = new Uint8Array(32);

/** roster ceiling. frontier entries index seats with one byte and the
 *  topology diameter must stay inside the gossip hop limit. */
export const BRAID_MAX_SEATS = 64;

/** distinct delivery failures tolerated per (seat, seq) before the bond dies.
 *  the chain never advances on failure, so retries are idempotent: a clean
 *  copy of the bytes (via ring repair) can still succeed on a later try. */
export const BRAID_MAX_STRIKES = 3;

/** total plaintexts retained for view reconstruction. when the cap forces
 *  eviction of history a silent seat still needs, that seat diverges on its
 *  next message. epochs reset the store, so this bounds a single epoch. */
export const BRAID_STORE_CAP = 4096;

/** byte ceiling for the same store, so a run of large payloads cannot pin
 *  megabytes per seat. eviction order and consequences match the entry cap. */
export const BRAID_STORE_MAX_BYTES = 16 * 1024 * 1024;

/** held (out-of-order or frontier-starved) messages retained per seat. */
export const BRAID_HOLDBACK_CAP = 256;

// --- helpers ---

function le32(n: number): Uint8Array {
    const b = new Uint8Array(4);
    b[0] =  n         & 0xFF;
    b[1] = (n >>>  8) & 0xFF;
    b[2] = (n >>> 16) & 0xFF;
    b[3] = (n >>> 24) & 0xFF;
    return b;
}

function readLe32(b: Uint8Array, o: number): number {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function concatU8(...arrs: Uint8Array[]): Uint8Array {
    let total = 0; for (const a of arrs) total += a.length;
    const out = new Uint8Array(total); let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
}

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length >>> 1);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

function cloneCounts(c: ModelCounts): ModelCounts {
    return {
        countsBitM: c.countsBitM.slice(),
        countsBit1: c.countsBit1.slice(),
        countsBitX: c.countsBitX.slice(),
    };
}

// loopEncode/loopDecode operate on a LoopState but only read the counts and
// clone the chain. this adapter lets bare accumulators ride the coder.
function asLoopState(c: ModelCounts): LoopState {
    return { chain: new Uint8Array(32), ...c, step: 0 };
}

function storeKey(seatIndex: number, seq: number): string {
    return seatIndex + ":" + seq;
}

// --- wire fragments owned by the braid ---

/** nonce is structural, never random: the message key is unique per
 *  (epoch, seat, seq, history), so uniqueness comes from the key itself. */
function makeNonce(senderIndex: number, seq: number, epochId: number): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce[0] = senderIndex;
    nonce.set(le32(seq), 1);
    nonce.set(le32(epochId), 5);
    return nonce;
}

function makeAad(senderIndex: number, seq: number, epochId: number, frontier: Uint8Array): Uint8Array {
    return concatU8(new Uint8Array([senderIndex]), le32(seq), le32(epochId), frontier);
}

/** frontier wire form: [count u8] then per named seat [seatIndex u8][seq u32le],
 *  seat indices strictly ascending, zero entries omitted. */
export function encodeFrontier(frontier: Uint32Array): Uint8Array {
    let count = 0;
    for (let i = 0; i < frontier.length; i++) if (frontier[i] > 0) count++;
    const out = new Uint8Array(1 + count * 5);
    out[0] = count;
    let o = 1;
    for (let i = 0; i < frontier.length; i++) {
        if (frontier[i] === 0) continue;
        out[o] = i;
        out.set(le32(frontier[i]), o + 1);
        o += 5;
    }
    return out;
}

/** parse and validate a frontier against a roster size. returns null on any
 *  malformation; the caller treats that as a strike, not an exception. */
export function parseFrontier(bytes: Uint8Array, nSeats: number): Uint32Array | null {
    if (bytes.length < 1) return null;
    const count = bytes[0];
    if (bytes.length !== 1 + count * 5) return null;
    const out = new Uint32Array(nSeats);
    let prevIdx = -1;
    for (let k = 0; k < count; k++) {
        const o = 1 + k * 5;
        const idx = bytes[o];
        const seq = readLe32(bytes, o + 1);
        if (idx <= prevIdx || idx >= nSeats || seq === 0) return null;
        out[idx] = seq;
        prevIdx = idx;
    }
    return out;
}

// --- state ---

/** one seat's strand as observed locally: their chain replayed message by
 *  message, their last authenticated frontier, and the reconstruction of
 *  their model view at that frontier. */
interface SeatLane {
    chain: Uint8Array;
    nextSeq: number;
    frontier: Uint32Array;
    view: ModelCounts;
    diverged: boolean;
    divergedReason: string;
    strikes: Map<number, number>;
}

export interface BraidMessage {
    senderIndex: number;
    seq: number;
    epochId: number;
    frontier: Uint8Array;
    ciphertext: Uint8Array;
}

export interface BraidWant {
    seatIndex: number;
    fromSeq: number;
    toSeq: number;
}

export type BraidOpenResult =
    | { status: "delivered"; delivered: Array<{ senderIndex: number; seq: number; plaintext: Uint8Array }> }
    | { status: "held"; wants: BraidWant[] }
    | { status: "ignored"; reason: string }
    | { status: "diverged"; seatIndex: number; reason: string };

export interface BraidState {
    epochId: number;
    /** sorted lowercase hex seat ids. index into this array is the seat index. */
    seats: string[];
    seatIndex: number;

    mySeq: number;
    mySendChain: Uint8Array;
    /** highest seq integrated per seat, my own included. */
    myFrontier: Uint32Array;
    /** counts of exactly the set myFrontier names. */
    myView: ModelCounts;

    lanes: SeatLane[];

    /** plaintexts retained for view reconstruction, keyed "seat:seq",
     *  insertion-ordered for cap eviction. */
    store: Map<string, Uint8Array>;
    /** running byte total of the store, maintained by storePut and storeGc. */
    storeBytes: number;
    /** held messages per seat, keyed by seq. */
    held: Map<number, Map<number, BraidMessage>>;

    /** internal promise chain serializing seal/open against the async kdf calls. */
    queue: Promise<unknown>;
}

function serialize<T>(state: BraidState, fn: () => Promise<T>): Promise<T> {
    const run = state.queue.then(fn, fn);
    state.queue = run.then(() => undefined, () => undefined);
    return run;
}

// --- lifecycle ---

function normalizeRoster(rosterHex: Iterable<string>): string[] {
    return Array.from(new Set(Array.from(rosterHex, (h) => h.toLowerCase()))).sort();
}

/** derive a fresh epoch root. genesis passes prevRoot = null with random
 *  entropy; joins and leaves pass the outgoing root plus fold entropy that
 *  the departing seat can never observe (it rides hop-encrypted edges the
 *  departed seat no longer holds). the roster digest binds membership. */
export async function braidFold(
    prevRoot: Uint8Array | null,
    entropy: Uint8Array,
    epochId: number,
    rosterHex: string[],
): Promise<Uint8Array> {
    const roster = normalizeRoster(rosterHex);
    const rosterBytes = concatU8(...roster.map(hexToBytes));
    const rosterDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(rosterBytes)));
    return hkdf(
        prevRoot ?? ZERO_SALT_32,
        entropy,
        concatU8(INFO_EPOCH, le32(epochId), rosterDigest),
        32,
    );
}

/** initialize braid state for one epoch. every seat calls this with the same
 *  root and roster and derives the identical starting object. */
export async function braidInit(
    epochRoot: Uint8Array,
    epochId: number,
    rosterHex: string[],
    selfHex: string,
): Promise<BraidState> {
    const seats = normalizeRoster(rosterHex);
    if (seats.length === 0 || seats.length > BRAID_MAX_SEATS) {
        throw new Error(`braidInit: roster size ${seats.length} outside 1..${BRAID_MAX_SEATS}`);
    }
    const seatIndex = seats.indexOf(selfHex.toLowerCase());
    if (seatIndex < 0) throw new Error("braidInit: self not in roster");

    // shared model base: identical for every seat, secret to the circle.
    const block = await loopExpand(epochRoot);
    const base = loopInit(block);
    base.chain.fill(0);
    block.fill(0);
    const baseCounts: ModelCounts = {
        countsBitM: base.countsBitM,
        countsBit1: base.countsBit1,
        countsBitX: base.countsBitX,
    };

    const lanes: SeatLane[] = [];
    for (const seatHex of seats) {
        lanes.push({
            chain: await hkdf(epochRoot, hexToBytes(seatHex), INFO_SEAT, 32),
            nextSeq: 1,
            frontier: new Uint32Array(seats.length),
            view: cloneCounts(baseCounts),
            diverged: false,
            divergedReason: "",
            strikes: new Map(),
        });
    }

    return {
        epochId,
        seats,
        seatIndex,
        mySeq: 0,
        mySendChain: lanes[seatIndex].chain.slice(),
        myFrontier: new Uint32Array(seats.length),
        myView: cloneCounts(baseCounts),
        lanes,
        store: new Map(),
        storeBytes: 0,
        held: new Map(),
        queue: Promise.resolve(),
    };
}

// --- store ---

function storePut(state: BraidState, seatIndex: number, seq: number, plaintext: Uint8Array): void {
    state.store.set(storeKey(seatIndex, seq), plaintext.slice());
    state.storeBytes += plaintext.length;
    while (state.store.size > BRAID_STORE_CAP || state.storeBytes > BRAID_STORE_MAX_BYTES) {
        const oldest = state.store.keys().next().value;
        if (oldest === undefined) break;
        state.storeBytes -= state.store.get(oldest)!.length;
        state.store.delete(oldest);
    }
}

/** drop plaintexts every alive lane has already folded into its view. with
 *  no other alive lanes nothing needs replay, so everything up to my own
 *  frontier goes. */
function storeGc(state: BraidState): void {
    const n = state.seats.length;
    const minF = new Uint32Array(n);
    minF.set(state.myFrontier);
    for (let k = 0; k < n; k++) {
        if (k === state.seatIndex) continue;
        const lane = state.lanes[k];
        if (lane.diverged) continue;
        for (let j = 0; j < n; j++) {
            if (lane.frontier[j] < minF[j]) minF[j] = lane.frontier[j];
        }
    }
    for (const [key, plaintext] of state.store) {
        const sep = key.indexOf(":");
        const j = Number(key.slice(0, sep));
        const q = Number(key.slice(sep + 1));
        if (q <= minF[j]) {
            state.storeBytes -= plaintext.length;
            state.store.delete(key);
        }
    }
}

// --- seal (send) ---

/** seal a plaintext as the next message on my strand. the frontier snapshot
 *  excludes this message; my own entry in it is always mySeq before the send.
 *  an empty plaintext is a valid beacon: it advances seq and frontier with a
 *  zero count-delta, giving silent seats an authenticated heartbeat. */
export function braidSeal(
    state: BraidState,
    plaintext: Uint8Array,
): Promise<{ seq: number; frontier: Uint8Array; ciphertext: Uint8Array }> {
    return serialize(state, async () => {
        const frontier = encodeFrontier(state.myFrontier);
        const digest = await modelDigest(state.myView);
        const seq = state.mySeq + 1;

        const [messageKey, newChain] = await Promise.all([
            hkdf(state.mySendChain, digest, concatU8(INFO_MSG, le32(seq)), 32),
            hkdf(state.mySendChain, digest, concatU8(INFO_CHAIN, le32(seq)), 32),
        ]);

        const { encoded, raw, next } = loopEncode(asLoopState(state.myView), plaintext);
        const framed = raw ? concatU8(new Uint8Array([0xFF]), encoded) : encoded;
        const inner = concatU8(le32(plaintext.length), framed);

        const nonce = makeNonce(state.seatIndex, seq, state.epochId);
        const aad = makeAad(state.seatIndex, seq, state.epochId, frontier);
        const ciphertext = await aesGcmEncrypt(messageKey, inner, nonce, aad);
        messageKey.fill(0);

        // commit only after every fallible step succeeded.
        state.mySendChain.fill(0);
        state.mySendChain = newChain;
        state.mySeq = seq;
        state.myView = { countsBitM: next.countsBitM, countsBit1: next.countsBit1, countsBitX: next.countsBitX };
        state.myFrontier[state.seatIndex] = seq;
        storePut(state, state.seatIndex, seq, plaintext);

        return { seq, frontier, ciphertext };
    });
}

// --- open (receive) ---

function diverge(lane: SeatLane, reason: string): void {
    lane.diverged = true;
    lane.divergedReason = reason;
    lane.chain.fill(0);
    lane.view.countsBitM.fill(0);
    lane.view.countsBit1.fill(0);
    lane.view.countsBitX.fill(0);
    lane.strikes.clear();
}

function strike(lane: SeatLane, seq: number): boolean {
    const count = (lane.strikes.get(seq) ?? 0) + 1;
    lane.strikes.set(seq, count);
    return count >= BRAID_MAX_STRIKES;
}

function holdMessage(state: BraidState, msg: BraidMessage): void {
    let perSeat = state.held.get(msg.senderIndex);
    if (!perSeat) { perSeat = new Map(); state.held.set(msg.senderIndex, perSeat); }
    if (perSeat.size >= BRAID_HOLDBACK_CAP && !perSeat.has(msg.seq)) {
        // evict the farthest-future seq; nearest messages unblock first.
        let maxSeq = -1;
        for (const s of perSeat.keys()) if (s > maxSeq) maxSeq = s;
        if (msg.seq >= maxSeq) return;
        perSeat.delete(maxSeq);
    }
    perSeat.set(msg.seq, msg);
}

/** attempt one message against the current state. never recurses; the
 *  cascade in braidOpen drains newly unblocked holds iteratively.
 *
 *  result kinds:
 *    delivered - decrypted, decoded, integrated.
 *    held      - waiting on missing history; keep the bytes, repair will feed us.
 *    spent     - this copy failed a deterministic check; drop it and want a
 *                fresh copy. state never changes a spent verdict, only new
 *                bytes can. strikes cap how many copies may fail before the
 *                bond dies.
 *    ignored   - stale or irrelevant.
 *    diverged  - the strand is dead for this epoch. */
async function openOne(
    state: BraidState,
    msg: BraidMessage,
): Promise<
    | { kind: "delivered"; plaintext: Uint8Array }
    | { kind: "held"; wants: BraidWant[] }
    | { kind: "spent"; reason: string; wants: BraidWant[] }
    | { kind: "ignored"; reason: string }
    | { kind: "diverged"; reason: string }
> {
    const i = msg.senderIndex;
    const lane = state.lanes[i];
    const spent = (
        reason: string,
    ): { kind: "diverged"; reason: string } | { kind: "spent"; reason: string; wants: BraidWant[] } => {
        if (strike(lane, msg.seq)) {
            diverge(lane, reason);
            return { kind: "diverged", reason };
        }
        return { kind: "spent", reason, wants: [{ seatIndex: i, fromSeq: msg.seq, toSeq: msg.seq }] };
    };

    if (msg.seq < lane.nextSeq) return { kind: "ignored", reason: "stale seq" };
    if (msg.seq > lane.nextSeq) {
        holdMessage(state, msg);
        return { kind: "held", wants: [{ seatIndex: i, fromSeq: lane.nextSeq, toSeq: msg.seq - 1 }] };
    }

    const F = parseFrontier(msg.frontier, state.seats.length);
    if (!F) return spent("malformed frontier");

    // a sender always names its own full prior strand.
    if (F[i] !== msg.seq - 1) return spent("frontier omits own strand");

    // frontiers only move forward.
    for (let j = 0; j < F.length; j++) {
        if (F[j] < lane.frontier[j]) return spent("frontier regression");
    }

    // starved: the sender has integrated messages i have not seen yet.
    const wants: BraidWant[] = [];
    for (let j = 0; j < F.length; j++) {
        if (F[j] > state.myFrontier[j]) {
            wants.push({ seatIndex: j, fromSeq: state.myFrontier[j] + 1, toSeq: F[j] });
        }
    }
    if (wants.length > 0) {
        holdMessage(state, msg);
        return { kind: "held", wants };
    }

    // reconstruct the sender's view at F on a working clone; the lane commits
    // only after gcm verifies, so a failed attempt leaves the strand intact.
    const work = cloneCounts(lane.view);
    for (let j = 0; j < F.length; j++) {
        for (let q = lane.frontier[j] + 1; q <= F[j]; q++) {
            const p = state.store.get(storeKey(j, q));
            if (!p) {
                // the history this seat still needs was evicted; the view can
                // never be rebuilt locally. the bond dies immediately.
                diverge(lane, "history evicted");
                return { kind: "diverged", reason: "history evicted" };
            }
            loopTrain(work, p);
        }
    }

    const digest = await modelDigest(work);
    const messageKey = await hkdf(lane.chain, digest, concatU8(INFO_MSG, le32(msg.seq)), 32);
    const aad = makeAad(i, msg.seq, msg.epochId, msg.frontier);
    const nonce = makeNonce(i, msg.seq, msg.epochId);

    let inner: Uint8Array;
    try {
        inner = await aesGcmDecrypt(messageKey, msg.ciphertext, nonce, aad);
    } catch {
        messageKey.fill(0);
        return spent("key mismatch: history diverged");
    }
    messageKey.fill(0);

    if (inner.length < 5) return spent("truncated payload");
    const decodedLen = readLe32(inner, 0);
    let decoded: Uint8Array;
    let next: ModelCounts;
    try {
        const res = loopDecode(asLoopState(work), inner.subarray(4), decodedLen);
        decoded = res.decoded;
        next = res.next;
    } catch {
        return spent("undecodable payload");
    }

    // commit the strand: chain forward, frontier to F with their own entry
    // bumped past this message, view to counts(new frontier set).
    lane.chain = await hkdf(lane.chain, digest, concatU8(INFO_CHAIN, le32(msg.seq)), 32);
    lane.nextSeq = msg.seq + 1;
    F[i] = msg.seq;
    lane.frontier = F;
    lane.view = next;
    lane.strikes.delete(msg.seq);

    // integrate into my own view. loopTrain's delta equals the decode delta,
    // so my counts and the sender's stay on the same trajectory.
    loopTrain(state.myView, decoded);
    state.myFrontier[i] = msg.seq;
    storePut(state, i, msg.seq, decoded);

    return { kind: "delivered", plaintext: decoded };
}

/** open an incoming braid message. delivery may unblock held messages from
 *  any seat; all deliveries this call produced come back in order. */
export function braidOpen(state: BraidState, msg: BraidMessage): Promise<BraidOpenResult> {
    return serialize(state, async () => {
        if (msg.epochId !== state.epochId) return { status: "ignored", reason: "wrong epoch" };
        if (!Number.isInteger(msg.senderIndex) || msg.senderIndex < 0 || msg.senderIndex >= state.seats.length) {
            return { status: "ignored", reason: "unknown seat" };
        }
        if (msg.senderIndex === state.seatIndex) return { status: "ignored", reason: "own message" };
        if (msg.seq < 1 || !Number.isInteger(msg.seq)) return { status: "ignored", reason: "bad seq" };
        if (state.lanes[msg.senderIndex].diverged) return { status: "ignored", reason: "diverged seat" };

        const first = await openOne(state, msg);
        if (first.kind === "ignored") return { status: "ignored", reason: first.reason };
        if (first.kind === "held" || first.kind === "spent") return { status: "held", wants: first.wants };
        if (first.kind === "diverged") {
            return { status: "diverged", seatIndex: msg.senderIndex, reason: first.reason };
        }

        const delivered = [{ senderIndex: msg.senderIndex, seq: msg.seq, plaintext: first.plaintext }];
        state.held.get(msg.senderIndex)?.delete(msg.seq);

        // cascade: keep sweeping the holds until a full pass delivers nothing.
        // spent copies leave the hold; only fresh bytes can change their verdict.
        let progressed = true;
        while (progressed) {
            progressed = false;
            for (const [seatIdx, perSeat] of state.held) {
                const lane = state.lanes[seatIdx];
                if (lane.diverged) { state.held.delete(seatIdx); continue; }
                const heldMsg = perSeat.get(lane.nextSeq);
                if (!heldMsg) continue;
                const res = await openOne(state, heldMsg);
                if (res.kind === "delivered") {
                    perSeat.delete(heldMsg.seq);
                    delivered.push({ senderIndex: seatIdx, seq: heldMsg.seq, plaintext: res.plaintext });
                    progressed = true;
                } else if (res.kind === "spent") {
                    perSeat.delete(heldMsg.seq);
                } else if (res.kind === "diverged") {
                    state.held.delete(seatIdx);
                }
                // held results stay held; ignored cannot happen for a queued next-seq.
            }
            if (delivered.length > 4096) break; // defensive bound, unreachable in honest runs
        }

        storeGc(state);
        return { status: "delivered", delivered };
    });
}

// --- repair + introspection ---

/** everything currently missing: per-seat seq gaps below held messages and
 *  frontier references beyond my view. feed this to the ring repair loop. */
export function braidWants(state: BraidState): BraidWant[] {
    const n = state.seats.length;
    const needMax = new Uint32Array(n);
    const wants: BraidWant[] = [];

    for (const [seatIdx, perSeat] of state.held) {
        const lane = state.lanes[seatIdx];
        if (lane.diverged || perSeat.size === 0) continue;
        let minHeld = Infinity;
        for (const [seq, heldMsg] of perSeat) {
            if (seq < minHeld) minHeld = seq;
            const F = parseFrontier(heldMsg.frontier, n);
            if (!F) continue;
            for (let j = 0; j < n; j++) {
                if (F[j] > needMax[j]) needMax[j] = F[j];
            }
        }
        if (minHeld > lane.nextSeq) {
            wants.push({ seatIndex: seatIdx, fromSeq: lane.nextSeq, toSeq: minHeld - 1 });
        }
    }

    for (let j = 0; j < n; j++) {
        if (needMax[j] > state.myFrontier[j]) {
            const covered = wants.find((w) => w.seatIndex === j);
            const from = state.myFrontier[j] + 1;
            const to = needMax[j];
            if (covered) {
                if (from < covered.fromSeq) covered.fromSeq = from;
                if (to > covered.toSeq) covered.toSeq = to;
            } else {
                wants.push({ seatIndex: j, fromSeq: from, toSeq: to });
            }
        }
    }
    return wants;
}

export interface BraidSeatStatus {
    seatHex: string;
    seatIndex: number;
    isSelf: boolean;
    delivered: number;
    diverged: boolean;
    divergedReason: string;
}

export function braidStatus(state: BraidState): BraidSeatStatus[] {
    return state.seats.map((seatHex, idx) => ({
        seatHex,
        seatIndex: idx,
        isSelf: idx === state.seatIndex,
        delivered: idx === state.seatIndex ? state.mySeq : state.lanes[idx].nextSeq - 1,
        diverged: state.lanes[idx].diverged,
        divergedReason: state.lanes[idx].divergedReason,
    }));
}

/** wipe every secret in the state. the object is dead afterwards. */
export function braidWipe(state: BraidState): void {
    state.mySendChain.fill(0);
    state.myView.countsBitM.fill(0);
    state.myView.countsBit1.fill(0);
    state.myView.countsBitX.fill(0);
    state.myFrontier.fill(0);
    for (const lane of state.lanes) {
        lane.chain.fill(0);
        lane.view.countsBitM.fill(0);
        lane.view.countsBit1.fill(0);
        lane.view.countsBitX.fill(0);
        lane.frontier.fill(0);
        lane.strikes.clear();
    }
    for (const p of state.store.values()) p.fill(0);
    state.store.clear();
    state.storeBytes = 0;
    state.held.clear();
}
