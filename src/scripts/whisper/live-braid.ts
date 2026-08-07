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
 * digest. a sender whose history diverged usually derives a different key,
 * gcm rejects, and after bounded retries the seat's bond is dead for this
 * epoch. the 2-party death-on-desync property, per seat.
 *
 * WHAT THAT DIGEST IS AND IS NOT. modelDigest hashes three count arrays, and
 * loopTrain ADDS a per-message delta into them, so the digest is
 * H(base + sum of deltas): a homomorphic image with a large kernel, not a
 * transcript hash. countsBit1 records the multiset of (prev>>>4, byte) pairs,
 * so two plaintexts that are Eulerian-trail transpositions of the same bigram
 * graph produce IDENTICAL counts. Measured: [00 01 00 02 00] and
 * [00 02 00 01 00] collide, and 4000 random 6-byte alphabet-4 samples yield
 * only 1147 distinct digests.
 * So this detects ACCIDENTAL divergence well and is not a commitment against
 * an adversary who chooses plaintexts. Two seats holding materially different
 * histories can derive the SAME key and nonce. Do not rest key uniqueness on
 * it; that argument needs an explicit transcript hash over the ordered set.
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

import { hkdf, TE, aesGcmEncrypt, aesGcmDecrypt, constantTimeEqual } from "./live-crypto";
import { sha256 } from "./wasm";
import { evictBelowFloor, purgeDead } from "./retention";
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
const INFO_CONFIRM = TE.encode("kizuna-braid-confirm-v1");
const INFO_EPOCH = TE.encode("kizuna-braid-epoch-v1");

const ZERO_SALT_32 = new Uint8Array(32);

/** roster ceiling. frontier entries index seats with one byte and the
 *  topology diameter must stay inside the gossip hop limit. */
export const BRAID_MAX_SEATS = 64;

/** distinct delivery failures tolerated per (seat, seq) before the bond dies.
 *  the chain never advances on failure, so retries are idempotent: a clean
 *  copy of the bytes (via ring repair) can still succeed on a later try. */
export const BRAID_MAX_STRIKES = 3;

/** messages piled up behind an unopenable one before we say we cannot read a
 *  seat. a fork stalls the lane at one seq forever, so everything after it
 *  queues; that pile, not a repeat count, is the observable signature. only the
 *  frame AT nextSeq ever reaches the tag check, so counting tag failures alone
 *  can never exceed one. forged frames can also produce it, which is why this
 *  is a report and never a state change. */
export const BRAID_STALL_THRESHOLD = 5;

/**
 * Ceiling on a frame's claimed decoded length, matching the 1:1 path.
 *
 * loopDecode allocates this many bytes and runs that many coder iterations, so
 * an authenticated frame naming an absurd length is a memory bomb aimed at every
 * seat in the circle at once. Sized to the largest legitimate payload (a 4MB
 * file chunk) with a factor of two of headroom, rather than to a round number:
 * the cost of a frame is linear in this number and it is paid synchronously.
 */
export const BRAID_MAX_DECODED_LEN = 8 * 1024 * 1024;

/** total plaintexts retained for view reconstruction. when the cap forces
 *  eviction of history a silent seat still needs, that seat diverges on its
 *  next message. epochs reset the store, so this bounds a single epoch. */
export const BRAID_STORE_CAP = 4096;

/** byte ceiling for the same store, so a run of large payloads cannot pin
 *  megabytes per seat. eviction order and consequences match the entry cap. */
export const BRAID_STORE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * How long a delivered plaintext may stay retained for replay.
 *
 * THE TENSION, stated honestly: this store exists so a lagging or out-of-order
 * seat can have the sender's model view rebuilt for it, which means REPLAY
 * REQUIRES HISTORY. You cannot both serve arbitrary replay and forget what was
 * said. So intra-epoch forward secrecy is bounded by this window rather than by
 * key zeroization — wiping message keys accomplishes nothing while the
 * plaintexts they protected sit in memory.
 *
 * Bounding it by COUNT alone (4096 entries / 16 MB) means a quiet circle keeps
 * everything for as long as it stays quiet. A time bound makes the exposure a
 * property of the clock instead: past this, a straggler must be repaired from a
 * peer that still holds the bytes, and if none does its lane reports the gap
 * rather than silently rebuilding from ancient history.
 *
 * Shorter is safer and costs more repair traffic. Sixty seconds covers ordinary
 * reordering and brief disconnects while keeping the window small.
 */
export const BRAID_STORE_TTL_MS = 60_000;

/** held (out-of-order or frontier-starved) messages retained per seat. */
export const BRAID_HOLDBACK_CAP = 256;

/**
 * Byte ceiling for the holdback, across all seats.
 *
 * The entry cap alone bounds COUNT, not SIZE, and the store already learned this
 * lesson: 256 frames per seat across 64 seats is 16384 frames of whatever length
 * the sender chose. Worse than the store's case, these are held BEFORE the tag
 * is checked, so the memory is spent on input nobody has authenticated yet.
 * Bounding entries without bounding bytes is bounding the wrong quantity when
 * the adversary picks the size.
 */
export const BRAID_HELD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Largest frontier gap a single frame may ask a receiver to replay.
 *
 * The frontier is attacker-chosen and unauthenticated at replay time, and the
 * replay walks one store lookup per named position. Without a ceiling a frame
 * can name 2^32 and buy an unbounded scan for the price of one frame. The store
 * holds at most BRAID_STORE_CAP entries, so no honest frontier can ever require
 * more than that many steps; anything beyond it is a claim about history this
 * seat could not possibly serve.
 */
export const BRAID_MAX_REPLAY_GAP = BRAID_STORE_CAP;

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

/**
 * THE HISTORY COMMITMENT — a product of free monoids, one per seat.
 *
 * WHY NOT THE COUNT MODEL. loopTrain makes the count map a monoid homomorphism
 * from the free monoid of messages into an abelian group (the count vectors add).
 * Any such homomorphism must kill the commutator subgroup: it CANNOT distinguish
 * ab from ba. That is a theorem, not an implementation slip, and it is why
 * exhaustively enumerating 243 five-byte strings yields only 116 distinct count
 * digests — the collision classes are exactly the permutations preserving the
 * bigram multiset, i.e. the fibres of the homomorphism.
 *
 * You cannot ask ONE object to be both order-independent (which the shared model
 * must be, or the group needs a sequencing authority) and order-committing
 * (which key derivation needs). So there are two objects:
 *   COUNTS      abelian, commutative, order-blind — kept, for compression.
 *   TRANSCRIPT  a hash chain PER SEAT, combined in seat order — this.
 *
 * Each seat's own strand is totally ordered by seq, so a chain over it is
 * well-defined; combining the per-strand heads in roster order makes the result
 * independent of the ORDER MESSAGES ARRIVED ACROSS seats, which is precisely the
 * CRDT property the braid needs. Order within a strand is committed; interleaving
 * across strands is not. Both, at once, without contradiction.
 */
export async function transcriptCommit(heads: Uint8Array[]): Promise<Uint8Array> {
    return sha256(concatU8(...heads));
}

/**
 * Advance one strand's chain by the plaintext just integrated.
 *
 * The SEAT INDEX is mixed in, so a strand is bound to its author from its first
 * message rather than only by where it sits in the combine. Positional binding
 * alone would mean two seats' heads could in principle be transposed without the
 * commitment noticing; binding here makes that unrepresentable instead of merely
 * unlikely. The length prefix keeps the chain injective over concatenation, so
 * (m1‖m2) as one message cannot equal m1 then m2 as two.
 */
export async function extendStrand(
    head: Uint8Array, seatIndex: number, plaintext: Uint8Array,
): Promise<Uint8Array> {
    return sha256(concatU8(head, le32(seatIndex), le32(plaintext.length), plaintext));
}

function cloneHeads(heads: Uint8Array[]): Uint8Array[] {
    return heads.map((h) => h.slice());
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

function makeAad(
    senderIndex: number, seq: number, epochId: number, frontier: Uint8Array, confirm: Uint8Array,
): Uint8Array {
    return concatU8(new Uint8Array([senderIndex]), le32(seq), le32(epochId), frontier, confirm);
}

/** bytes of the confirmation tag carried on every message. */
export const BRAID_CONFIRM_LEN = 8;

/**
 * LENGTH BUCKETING — blunting the compression side channel.
 *
 * The count model is shared, adaptive, and trained by every member, so a hostile
 * seat can seed it with a guess and watch whether the victim's next message
 * compresses better. Ciphertext length is visible to every relay, so that is a
 * classic adaptive-compression oracle (CRIME), made sharper here because the
 * model is attacker-trainable BY DESIGN. Measured before this: a matching guess
 * produced 37 bytes and a wrong one 38 — a byte-at-a-time distinguisher.
 *
 * Padding the inner payload up to a bucket removes the fine-grained signal: the
 * attacker now only learns which bucket a message fell into, so a guess is
 * informative just when it happens to straddle a boundary. That raises the cost
 * of the attack by roughly the bucket size rather than eliminating it — true
 * elimination needs constant-size records, which a chat transport cannot afford.
 * Stated plainly so nobody reads this as "length no longer leaks".
 *
 * Trailing padding is safe to ignore on receipt: the frame carries the real
 * plaintext length, and the coder consumes only what it needs (verified for RAW
 * and coded modes, empty through 200-byte payloads).
 */
export const BRAID_PAD_BUCKET = 64;

function padToBucket(inner: Uint8Array): Uint8Array {
    const target = Math.ceil((inner.length + 1) / BRAID_PAD_BUCKET) * BRAID_PAD_BUCKET;
    if (target === inner.length) return inner;
    const out = new Uint8Array(target);
    out.set(inner, 0);
    return out;
}

/**
 * THE CONFIRMATION TAG — the twist made explicit.
 *
 * The transcript commitment already reaches key derivation, so a seat that
 * disagrees about history simply fails to decrypt. That is detection without
 * ATTRIBUTION: a fork and a forged frame and plain network trouble all look
 * identical from the receiving end, which is exactly how a malicious elder can
 * split a circle in half and have each half blame the network.
 *
 * Carrying the commitment openly closes the loop. Every message already names
 * the sender's frontier — a claim about EVERY seat's strand — so pairing that
 * claim with a tag over the sender's own reconstruction makes each message a
 * witness statement that must agree with what the receiver independently
 * computes for the same frontier. Two seats in different halves of a fork then
 * emit contradictory statements about the same (epoch, frontier), and since the
 * campfire layer signs messages, that pair is transferable evidence naming a
 * seat rather than a shrug about connectivity.
 *
 * The tag is KEYED on the sender's chain rather than being the raw commitment.
 * A relay must not be able to correlate conversations by watching a public hash
 * of history go past; members can verify it because they can derive the chain,
 * outsiders see 8 bytes that look like noise.
 *
 * SOUNDNESS CONDITION, and it matters. A mismatch means EITHER a genuine fork OR
 * a frame that was relabelled to a different seat, because the tag is checked
 * before the AEAD and is therefore unauthenticated at this layer. Read alone,
 * "forked" is a fact about disagreement, NOT an accusation — treating it as one
 * would let anyone who can inject frames make an honest seat look guilty, which
 * is the same mistake as counting a failed tag as a strike.
 * It becomes an accusation only for a caller that has already authenticated the
 * sender. The campfire layer verifies the per-message signature before it ever
 * calls braidOpen, which is exactly why it may name a seat; a caller without
 * that step must not.
 */
async function confirmTag(chain: Uint8Array, commitment: Uint8Array): Promise<Uint8Array> {
    return hkdf(chain, commitment, INFO_CONFIRM, BRAID_CONFIRM_LEN);
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
    /** per-seat transcript heads AT `frontier`; the order-committing half. */
    heads: Uint8Array[];
    diverged: boolean;
    divergedReason: string;
    strikes: Map<number, number>;
    /** frames from this seat whose tag would not verify. only the frame at
     *  nextSeq is ever tried, so a stalled lane sits at 1 while its holdback
     *  grows. a failed tag is unattributable, so this drives a recoverable
     *  report only: it never touches key state and clears on the next delivery. */
    unopened: number;
    /** the stall was already reported; do not repeat it until something lands. */
    stallReported: boolean;
}

export interface BraidMessage<A = void> {
    /**
     * Payload the transport layer attaches at ingress and gets back at delivery.
     *
     * PARAMETRIC ON PURPOSE. `A` is a type variable this module never constrains,
     * so by parametricity no function here CAN inspect it: there is no operation
     * available on a value of an unknown type. That is a free theorem, not a
     * convention, and it is the difference between "the braid does not read this"
     * and "the braid cannot read this". An earlier version typed it `unknown`,
     * which bought the discipline without the proof and still needed a cast at
     * the far end, reintroducing in miniature the exact defect it was fixing: a
     * fact (the attachment's real type) known in two places and agreeing only by
     * agreement.
     *
     * REQUIRED, not optional, so presence is a static guarantee rather than a
     * runtime branch the reader has to remember.
     *
     * HONEST LIMIT. In System F parametricity is a theorem; in TypeScript it is a
     * theorem the compiler enforces UNLESS someone writes `as`. Verified both
     * ways: reading `msg.attachment.contentType` in this module is a type error,
     * and the same read behind a cast compiles. So this buys "you cannot do it by
     * accident, and doing it on purpose leaves an `as` in the diff" rather than
     * genuine impossibility. That is the strongest guarantee available here, and
     * it is strictly more than a comment saying please do not.
     *
     * It exists because the layer above needs per-message facts (identity,
     * timestamp, content type) at DELIVERY time, and delivery can happen long
     * after arrival for a message that sat in the holdback behind a gap. Keeping
     * those facts in a second map, with its own capacity and its own eviction
     * order, meant two structures owned one message's lifetime and disagreed
     * about it. They were in fact ANTI-correlated: that map evicted in arrival
     * order, and the holdback exists precisely to decouple arrival order from
     * delivery order, so the message held longest was the first to lose its
     * facts. Measured, 89 of a 600-message backlog were delivered carrying an
     * identity no other member of the circle computed.
     *
     * Riding along with the message makes the lifetimes identical by
     * construction rather than by agreement, and there is nothing left to keep
     * in step. Typed unknown so this layer cannot develop an opinion about it.
     */
    attachment: A;
    senderIndex: number;
    seq: number;
    epochId: number;
    frontier: Uint8Array;
    /** keyed tag over the sender's transcript commitment at `frontier`. */
    confirm: Uint8Array;
    ciphertext: Uint8Array;
}

export interface BraidWant {
    seatIndex: number;
    fromSeq: number;
    toSeq: number;
}

export type BraidOpenResult<A = void> =
    | {
        status: "delivered";
        delivered: Array<{
            senderIndex: number;
            seq: number;
            plaintext: Uint8Array;
            /** exactly what the caller attached to this message at ingress. */
            attachment: A;
        }>;
      }
    | { status: "held"; wants: BraidWant[]; stalled?: boolean }
    | { status: "ignored"; reason: string; stalled?: boolean }
    /** the sender's stated history commitment disagrees with ours at the same
     *  frontier. unlike a bare rejection this NAMES the seat and the position,
     *  and the campfire layer signs messages, so the pair of contradicting
     *  claims is evidence rather than a shrug about connectivity. */
    | { status: "forked"; seatIndex: number; seq: number; reason: string }
    | { status: "diverged"; seatIndex: number; reason: string };

export interface BraidState<A = void> {
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
    /** my own per-seat transcript heads at `myFrontier`. */
    myHeads: Uint8Array[];
    /** when each retained plaintext was stored, for the time bound. */
    storeAt: Map<string, number>;
    /** clock seam so tests can drive expiry deterministically. */
    now: () => number;
    /** running byte total of the holdback, maintained by holdMessage. */
    heldBytes: number;
    /** running byte total of the store, maintained by storePut and storeGc. */
    storeBytes: number;
    /** held messages per seat, keyed by seq. */
    held: Map<number, Map<number, BraidMessage<A>>>;

    /** internal promise chain serializing seal/open against the async kdf calls. */
    queue: Promise<unknown>;
}

function serialize<A, T>(state: BraidState<A>, fn: () => Promise<T>): Promise<T> {
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
export async function braidInit<A = void>(
    epochRoot: Uint8Array,
    epochId: number,
    rosterHex: string[],
    selfHex: string,
): Promise<BraidState<A>> {
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
            heads: seats.map(() => new Uint8Array(32)),
            unopened: 0,
            stallReported: false,
        });
    }

    return {
        epochId,
        seats,
        seatIndex,
        mySeq: 0,
        mySendChain: lanes[seatIndex].chain.slice(),
        myFrontier: new Uint32Array(seats.length),
        myHeads: seats.map(() => new Uint8Array(32)),
        storeAt: new Map(),
        now: () => Date.now(),
        myView: cloneCounts(baseCounts),
        lanes,
        store: new Map(),
        heldBytes: 0,
        storeBytes: 0,
        held: new Map(),
        queue: Promise.resolve(),
    };
}

// --- store ---

/**
 * THE STABILITY FRONTIER: the componentwise meet of every lane's frontier and my
 * own, in the vector-clock lattice ℕ^seats.
 *
 * `openOne` rebuilds a sender's view by replaying plaintexts from
 * `lane.frontier` up to the frontier the incoming message declares. So a
 * plaintext (j, q) is still reachable exactly when q > W[j] for the meet W: some
 * lane is still behind it and will ask. Below W every lane has passed it and
 * nobody can ever ask again.
 *
 * W is therefore not a heuristic watermark, it is the greatest lower bound in
 * the lattice, which makes it the LARGEST safe thing to forget. Anything evicted
 * above it is history a seat still needs, and losing it is unrecoverable within
 * the epoch: the store is written on DELIVERY, and re-supplying an
 * already-integrated seq is ignored, so repair puts nothing back.
 *
 * That last point was learned the hard way. A time-based sweep was added here
 * for intra-epoch forward secrecy, and wall-clock age is INCOMPARABLE to this
 * order: nothing relates "older than 60s" to "below the meet". The effect was
 * that a member who read without replying for a minute became permanently
 * unreadable to everyone else for the rest of the epoch, which is simply what a
 * lurker does. Every eviction path now consults W first.
 */
function stableFrontier<A>(state: BraidState<A>): Uint32Array {
    const n = state.seats.length;
    const meet = new Uint32Array(n);
    meet.set(state.myFrontier);
    for (let k = 0; k < n; k++) {
        if (k === state.seatIndex) continue;
        const lane = state.lanes[k];
        if (lane.diverged) continue; // a dead lane will never ask for anything
        for (let j = 0; j < n; j++) {
            if (lane.frontier[j] < meet[j]) meet[j] = lane.frontier[j];
        }
    }
    return meet;
}

/** true when no lane can still ask for this entry, so it is safe to drop. */
function belowWatermark(meet: Uint32Array, key: string): boolean {
    const sep = key.indexOf(":");
    const j = Number(key.slice(0, sep));
    const q = Number(key.slice(sep + 1));
    return j < meet.length && q <= meet[j];
}

/**
 * Release the resources of an entry the sweep has already removed from the map.
 *
 * Zeroizing is not hygiene here, it is the whole of what forward secrecy buys:
 * a retained plaintext is legible to anyone who reaches the heap, so wiping the
 * message key that protected it accomplishes nothing on its own.
 */
function releaseEntry<A>(state: BraidState<A>, key: string, bytes?: Uint8Array): void {
    const held = bytes ?? state.store.get(key);
    if (held) {
        held.fill(0);
        state.storeBytes -= held.length;
        state.store.delete(key); // no-op when the sweep already removed it
    }
    state.storeAt.delete(key); // the timestamp index must not outlive its entry
}

function storePut<A>(state: BraidState<A>, seatIndex: number, seq: number, plaintext: Uint8Array): void {
    state.store.set(storeKey(seatIndex, seq), plaintext.slice());
    state.storeAt.set(storeKey(seatIndex, seq), state.now());
    state.storeBytes += plaintext.length;
    // The caps are enforced ONLY below the watermark. If the store is over its
    // limit and everything in it is still reachable, the right answer is to keep
    // it: memory is recoverable, an unreadable seat is not. That state means a
    // lane has stalled far behind, and the remedy belongs to the epoch layer
    // (fold, or remove the seat) rather than to a sweep that would silently
    // break replay to hit a number.
    const meet = stableFrontier(state);
    const dead = (key: string) => belowWatermark(meet, key);
    // Two bounds, one floor. The byte budget is folded in by tightening the cap
    // until either the size fits or nothing dead is left to give.
    while (state.storeBytes > BRAID_STORE_MAX_BYTES) {
        const before = state.store.size;
        evictBelowFloor(state.store, Math.max(0, state.store.size - 1), dead,
            (k, v) => releaseEntry(state, k, v));
        if (state.store.size === before) break; // everything left is reachable
    }
    evictBelowFloor(state.store, BRAID_STORE_CAP, dead, (k, v) => releaseEntry(state, k, v));
    expireStore(state);
}

/** drop retained plaintexts past their time bound, zeroizing as they go. */
function expireStore<A>(state: BraidState<A>): void {
    const cutoff = state.now() - BRAID_STORE_TTL_MS;
    const meet = stableFrontier(state);
    // Age alone is not a licence. Forward secrecy wants these gone; replay may
    // still need them; the two are ordered by incomparable things, so the
    // lattice decides what is dead and the clock only chooses among the dead.
    purgeDead(
        state.store,
        (key) => belowWatermark(meet, key) && (state.storeAt.get(key) ?? Infinity) <= cutoff,
        (k, v) => releaseEntry(state, k, v),
    );
}

/** drop plaintexts every alive lane has already folded into its view. with
 *  no other alive lanes nothing needs replay, so everything up to my own
 *  frontier goes. */
/**
 * The unconditional sweep: everything strictly below the meet is unreachable by
 * every lane, so nothing is owed and all of it may go. The age-bounded sweep in
 * expireStore is the same rule with a second, stricter condition on top.
 */
function storeGc<A>(state: BraidState<A>): void {
    expireStore(state);
    const meet = stableFrontier(state);
    purgeDead(state.store, (key) => belowWatermark(meet, key), (k, v) => releaseEntry(state, k, v));
}

// --- seal (send) ---

/** seal a plaintext as the next message on my strand. the frontier snapshot
 *  excludes this message; my own entry in it is always mySeq before the send.
 *  an empty plaintext is a valid beacon: it advances seq and frontier with a
 *  zero count-delta, giving silent seats an authenticated heartbeat. */
// Seal an ARBITRARY inner payload under this seat's real message key, WITHOUT
// committing any state. Test-only seam. Production always goes through
// braidSeal, which builds the inner payload itself and can therefore never
// produce a malformed one. It exists so tests can reach the post-authentication
// fault paths (truncated / undecodable payload), which are the only faults a
// verified tag attributes to the sender and so the only ones that may strike a
// lane. Without it that entire mechanism is unreachable from a test.
export function braidSealInnerForTest<A>(
    state: BraidState<A>,
    inner: Uint8Array,
): Promise<{ seq: number; frontier: Uint8Array; confirm: Uint8Array; ciphertext: Uint8Array }> {
    return serialize(state, async () => {
        const frontier = encodeFrontier(state.myFrontier);
        const digest = await transcriptCommit(state.myHeads);
        const seq = state.mySeq + 1;
        const confirm = await confirmTag(state.mySendChain, digest);
        const messageKey = await hkdf(state.mySendChain, digest, concatU8(INFO_MSG, le32(seq)), 32);
        const nonce = makeNonce(state.seatIndex, seq, state.epochId);
        const aad = makeAad(state.seatIndex, seq, state.epochId, frontier, confirm);
        const ciphertext = await aesGcmEncrypt(messageKey, inner, nonce, aad);
        messageKey.fill(0);
        return { seq, frontier, confirm, ciphertext };
    });
}

export function braidSeal<A>(
    state: BraidState<A>,
    plaintext: Uint8Array,
): Promise<{ seq: number; frontier: Uint8Array; confirm: Uint8Array; ciphertext: Uint8Array }> {
    return serialize(state, async () => {
        const frontier = encodeFrontier(state.myFrontier);
        // the ORDER-COMMITTING digest. the count model still drives compression
        // below; it just no longer pretends to bind history.
        const digest = await transcriptCommit(state.myHeads);
        const seq = state.mySeq + 1;

        const [messageKey, newChain] = await Promise.all([
            hkdf(state.mySendChain, digest, concatU8(INFO_MSG, le32(seq)), 32),
            hkdf(state.mySendChain, digest, concatU8(INFO_CHAIN, le32(seq)), 32),
        ]);

        const { encoded, raw, next } = loopEncode(asLoopState(state.myView), plaintext);
        const framed = raw ? concatU8(new Uint8Array([0xFF]), encoded) : encoded;
        const inner = padToBucket(concatU8(le32(plaintext.length), framed));

        const confirm = await confirmTag(state.mySendChain, digest);
        const nonce = makeNonce(state.seatIndex, seq, state.epochId);
        const aad = makeAad(state.seatIndex, seq, state.epochId, frontier, confirm);
        const ciphertext = await aesGcmEncrypt(messageKey, inner, nonce, aad);
        messageKey.fill(0);

        // commit only after every fallible step succeeded.
        state.mySendChain.fill(0);
        state.mySendChain = newChain;
        state.mySeq = seq;
        state.myView = { countsBitM: next.countsBitM, countsBit1: next.countsBit1, countsBitX: next.countsBitX };
        state.myFrontier[state.seatIndex] = seq;
        state.myHeads[state.seatIndex] = await extendStrand(state.myHeads[state.seatIndex], state.seatIndex, plaintext);
        storePut(state, state.seatIndex, seq, plaintext);

        return { seq, frontier, confirm, ciphertext };
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

function heldSize(msg: BraidMessage<unknown>): number {
    return msg.ciphertext.length + msg.frontier.length + msg.confirm.length;
}

function dropHeld<A>(state: BraidState<A>, perSeat: Map<number, BraidMessage<A>>, seq: number): void {
    const gone = perSeat.get(seq);
    if (!gone) return;
    state.heldBytes -= heldSize(gone);
    perSeat.delete(seq);
}

/** drop an entire seat's holds, keeping the byte accounting in step. */
function dropSeatHolds<A>(state: BraidState<A>, seatIndex: number): void {
    const perSeat = state.held.get(seatIndex);
    if (!perSeat) return;
    for (const m of perSeat.values()) state.heldBytes -= heldSize(m);
    state.held.delete(seatIndex);
}

function holdMessage<A>(state: BraidState<A>, msg: BraidMessage<A>): void {
    let perSeat = state.held.get(msg.senderIndex);
    if (!perSeat) { perSeat = new Map(); state.held.set(msg.senderIndex, perSeat); }
    if (perSeat.has(msg.seq)) return; // already holding this position

    if (perSeat.size >= BRAID_HOLDBACK_CAP) {
        // evict the farthest-future seq; nearest messages unblock first.
        let maxSeq = -1;
        for (const s of perSeat.keys()) if (s > maxSeq) maxSeq = s;
        if (msg.seq >= maxSeq) return;
        dropHeld(state, perSeat, maxSeq);
    }

    // The byte ceiling is global, so a run of large frames on ONE seat cannot
    // pin memory that every other seat's holdback also needs. Evict farthest-
    // future first, across every seat, for the same reason as the entry cap:
    // the nearest holds are the ones that will unblock soonest.
    const incoming = heldSize(msg);
    while (state.heldBytes + incoming > BRAID_HELD_MAX_BYTES) {
        let worstSeat = -1, worstSeq = -1;
        for (const [seat, m] of state.held) {
            for (const s of m.keys()) if (s > worstSeq) { worstSeq = s; worstSeat = seat; }
        }
        if (worstSeat < 0) break; // nothing left to give
        if (worstSeat === msg.senderIndex && msg.seq >= worstSeq) return; // we are the worst
        dropHeld(state, state.held.get(worstSeat)!, worstSeq);
    }

    perSeat.set(msg.seq, msg);
    state.heldBytes += incoming;
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
async function openOne<A>(
    state: BraidState<A>,
    msg: BraidMessage<A>,
): Promise<
    | { kind: "delivered"; plaintext: Uint8Array }
    | { kind: "held"; wants: BraidWant[] }
    | { kind: "spent"; reason: string; wants: BraidWant[] }
    | { kind: "ignored"; reason: string }
    | { kind: "forked"; reason: string }
    | { kind: "diverged"; reason: string }
> {
    const i = msg.senderIndex;
    const lane = state.lanes[i];

    // strikes are destructive: enough of them sever the lane forever. only a
    // frame whose gcm tag verified proves the sender holds this lane's chain
    // key, so only a post-auth inconsistency may earn one. anything rejected
    // before the tag verifies is unattributable, and counting it would let any
    // party who can inject frames sever two honest seats with three forgeries.
    const spent = (
        reason: string,
    ): { kind: "diverged"; reason: string } | { kind: "spent"; reason: string; wants: BraidWant[] } => {
        if (strike(lane, msg.seq)) {
            diverge(lane, reason);
            return { kind: "diverged", reason };
        }
        return { kind: "spent", reason, wants: [{ seatIndex: i, fromSeq: msg.seq, toSeq: msg.seq }] };
    };

    // unauthenticated rejection: no strike, no repair want, no state change. an
    // honest retransmit of the same seq still lands, so nothing is lost.
    const unattributable = (reason: string): { kind: "ignored"; reason: string } =>
        ({ kind: "ignored", reason });

    if (msg.seq < lane.nextSeq) return { kind: "ignored", reason: "stale seq" };
    if (msg.seq > lane.nextSeq) {
        holdMessage(state, msg);
        return { kind: "held", wants: [{ seatIndex: i, fromSeq: lane.nextSeq, toSeq: msg.seq - 1 }] };
    }

    const F = parseFrontier(msg.frontier, state.seats.length);
    if (!F) return unattributable("malformed frontier");

    // a sender always names its own full prior strand.
    if (F[i] !== msg.seq - 1) return unattributable("frontier omits own strand");

    // frontiers only move forward.
    for (let j = 0; j < F.length; j++) {
        if (F[j] < lane.frontier[j]) return unattributable("frontier regression");
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
    // Bound the work a single unauthenticated frame can buy before spending any.
    // The frontier is attacker-chosen and the replay below does one store lookup
    // per named position, so an unbounded claim is an unbounded scan for the
    // price of one frame. No honest frontier can require more steps than the
    // store can hold, which makes this a ceiling on nonsense rather than a limit
    // on anything real.
    for (let j = 0; j < F.length; j++) {
        if (F[j] - lane.frontier[j] > BRAID_MAX_REPLAY_GAP) {
            return unattributable("frontier gap beyond anything replayable");
        }
    }

    const work = cloneCounts(lane.view);
    const workHeads = cloneHeads(lane.heads);
    for (let j = 0; j < F.length; j++) {
        for (let q = lane.frontier[j] + 1; q <= F[j]; q++) {
            const p = state.store.get(storeKey(j, q));
            if (!p) {
                // the history this seat still needs is not in my store. the
                // frontier naming it is unauthenticated, so this cannot sever
                // the lane; repair can refill the store and a retransmit lands.
                return unattributable("history evicted");
            }
            loopTrain(work, p);
            workHeads[j] = await extendStrand(workHeads[j], j, p);
        }
    }

    // reconstruct the SENDER's commitment at its frontier. both sides walk the
    // same per-strand chains over the same prefixes, so they agree regardless of
    // the order these messages happened to arrive at either of them.
    const digest = await transcriptCommit(workHeads);

    // THE LOOP CLOSES HERE. The sender stated a tag over ITS reconstruction at
    // this frontier; we independently computed ours. Agreement means we hold the
    // same history; disagreement names a fork at a specific (seat, epoch,
    // frontier) instead of surfacing as an anonymous decrypt failure. Checked
    // before the tag verifies, so it costs nothing on the honest path and cannot
    // move state: it only decides WHICH rejection to report.
    const expectConfirm = await confirmTag(lane.chain, digest);
    if (msg.confirm && msg.confirm.length === BRAID_CONFIRM_LEN
        && !constantTimeEqual(expectConfirm, msg.confirm)) {
        return { kind: "forked", reason: "history disagreement" };
    }

    const messageKey = await hkdf(lane.chain, digest, concatU8(INFO_MSG, le32(msg.seq)), 32);
    const aad = makeAad(i, msg.seq, msg.epochId, msg.frontier, msg.confirm);
    const nonce = makeNonce(i, msg.seq, msg.epochId);

    let inner: Uint8Array;
    try {
        inner = await aesGcmDecrypt(messageKey, msg.ciphertext, nonce, aad);
    } catch {
        messageKey.fill(0);
        lane.unopened++;
        return unattributable("key mismatch: history diverged");
    }
    messageKey.fill(0);

    if (inner.length < 5) return spent("truncated payload");
    const decodedLen = readLe32(inner, 0);
    // checked BEFORE loopDecode allocates. the tag already verified, so this is
    // attributable and may strike: only the named seat could have sent it.
    if (decodedLen > BRAID_MAX_DECODED_LEN) return spent("decodedLen exceeds safety limit");
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
    // zeroize the superseded chain before dropping the reference, exactly as the
    // send side does. reassigning alone leaves the old 32 bytes sitting in the
    // heap until a GC that may never come, which is the whole of what forward
    // secrecy is buying here: the ratchet is one-way, so the only way an old
    // receive key comes back is if we left a copy lying around.
    const nextChain = await hkdf(lane.chain, digest, concatU8(INFO_CHAIN, le32(msg.seq)), 32);
    lane.chain.fill(0);
    lane.chain = nextChain;
    lane.nextSeq = msg.seq + 1;
    F[i] = msg.seq;
    lane.frontier = F;
    lane.view = next;
    lane.heads = workHeads;
    lane.heads[i] = await extendStrand(lane.heads[i], i, decoded);
    lane.strikes.delete(msg.seq);
    lane.unopened = 0;
    lane.stallReported = false;

    // integrate into my own view. loopTrain's delta equals the decode delta,
    // so my counts and the sender's stay on the same trajectory.
    loopTrain(state.myView, decoded);
    state.myHeads[i] = await extendStrand(state.myHeads[i], i, decoded);
    state.myFrontier[i] = msg.seq;
    storePut(state, i, msg.seq, decoded);

    return { kind: "delivered", plaintext: decoded };
}

/** open an incoming braid message. delivery may unblock held messages from
 *  any seat; all deliveries this call produced come back in order. */
export function braidOpen<A>(state: BraidState<A>, msg: BraidMessage<A>): Promise<BraidOpenResult<A>> {
    return serialize(state, async (): Promise<BraidOpenResult<A>> => {
        if (msg.epochId !== state.epochId) return { status: "ignored", reason: "wrong epoch" };
        if (!Number.isInteger(msg.senderIndex) || msg.senderIndex < 0 || msg.senderIndex >= state.seats.length) {
            return { status: "ignored", reason: "unknown seat" };
        }
        if (msg.senderIndex === state.seatIndex) return { status: "ignored", reason: "own message" };
        if (msg.seq < 1 || !Number.isInteger(msg.seq)) return { status: "ignored", reason: "bad seq" };
        if (state.lanes[msg.senderIndex].diverged) return { status: "ignored", reason: "diverged seat" };

        // a lane whose next frame will not open, with a pile of later frames
        // waiting on it, is the shape of a history fork. report it once. nothing
        // here changes state, so a clean copy still delivers and clears it.
        const lane = state.lanes[msg.senderIndex];
        const stalledNow = (): boolean => {
            if (lane.stallReported || lane.unopened === 0) return false;
            if ((state.held.get(msg.senderIndex)?.size ?? 0) < BRAID_STALL_THRESHOLD) return false;
            lane.stallReported = true;
            return true;
        };

        const first = await openOne(state, msg);
        if (first.kind === "forked") {
            return { status: "forked", seatIndex: msg.senderIndex, seq: msg.seq, reason: first.reason };
        }
        if (first.kind === "ignored") {
            if (stalledNow()) return { status: "ignored", reason: first.reason, stalled: true };
            return { status: "ignored", reason: first.reason };
        }
        if (first.kind === "held" || first.kind === "spent") {
            if (stalledNow()) return { status: "held", wants: first.wants, stalled: true };
        }
        if (first.kind === "held" || first.kind === "spent") return { status: "held", wants: first.wants };
        if (first.kind === "diverged") {
            return { status: "diverged", seatIndex: msg.senderIndex, reason: first.reason };
        }

        const delivered: Array<{
            senderIndex: number; seq: number; plaintext: Uint8Array; attachment: A;
        }> = [{
            senderIndex: msg.senderIndex, seq: msg.seq,
            plaintext: first.plaintext, attachment: msg.attachment,
        }];
        const mine = state.held.get(msg.senderIndex);
        if (mine) dropHeld(state, mine, msg.seq);

        // cascade: keep sweeping the holds until a full pass delivers nothing.
        // spent copies leave the hold; only fresh bytes can change their verdict.
        let progressed = true;
        while (progressed) {
            progressed = false;
            for (const [seatIdx, perSeat] of state.held) {
                const lane = state.lanes[seatIdx];
                if (lane.diverged) { dropSeatHolds(state, seatIdx); continue; }
                const heldMsg = perSeat.get(lane.nextSeq);
                if (!heldMsg) continue;
                const res = await openOne(state, heldMsg);
                if (res.kind === "delivered") {
                    dropHeld(state, perSeat, heldMsg.seq);
                    delivered.push({
                        senderIndex: seatIdx, seq: heldMsg.seq,
                        plaintext: res.plaintext, attachment: heldMsg.attachment,
                    });
                    progressed = true;
                } else if (res.kind === "spent") {
                    dropHeld(state, perSeat, heldMsg.seq);
                } else if (res.kind === "diverged") {
                    dropSeatHolds(state, seatIdx);
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
export function braidWants<A>(state: BraidState<A>): BraidWant[] {
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
    /** consecutive unverifiable frames from this seat; 0 once anything lands. */
    unopened: number;
}

export function braidStatus<A>(state: BraidState<A>): BraidSeatStatus[] {
    return state.seats.map((seatHex, idx) => ({
        seatHex,
        seatIndex: idx,
        isSelf: idx === state.seatIndex,
        delivered: idx === state.seatIndex ? state.mySeq : state.lanes[idx].nextSeq - 1,
        diverged: state.lanes[idx].diverged,
        divergedReason: state.lanes[idx].divergedReason,
        unopened: state.lanes[idx].unopened,
    }));
}

/** wipe every secret in the state. the object is dead afterwards. */
export function braidWipe<A>(state: BraidState<A>): void {
    state.mySendChain.fill(0);
    state.myView.countsBitM.fill(0);
    state.myView.countsBit1.fill(0);
    state.myView.countsBitX.fill(0);
    state.myFrontier.fill(0);
    state.heldBytes = 0;
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
