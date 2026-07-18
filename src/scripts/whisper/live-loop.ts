/**
 * live-loop.ts
 *
 * Whisper Loop — production runtime.
 *
 * production implementation. see test-loop.ts for algorithm documentation and test spec.
 *
 * key derivation:
 *   expandChain(chain, step)         → HKDF(chain, le32(step), 'kizuna-expand-v1', 32)
 *                                      → AES-CTR(key, 65536 zero bytes)
 *   deriveMessageKey(chain, r, step) → HKDF(chain, le32(r), 'kizuna-msg-v1'   || le32(step), 32)
 *   advanceChain(chain, r, step)     → HKDF(chain, le32(r), 'kizuna-chain-v1' || le32(step), 32)
 *   loopExpand(key)                  → HKDF(key, 0x00..., 'kizuna-init-v1', 32)
 *                                      → AES-CTR(key, 65536 zero bytes)
 *
 * adaptive compression:
 *   three parallel bit-level coders compete per message.
 *   BitM (Möbius per-bit, 512 ctx) — general purpose temporal.
 *   Bit1 (order-1 4-bit prefix, 4080 ctx) — inter-byte structure (UTF-8, structured data).
 *   BitX (XOR derivative, 4080 ctx) — byte-stream velocity (transition patterns).
 *     slot = (prev ^ prev2) >>> 4. inspired by Logos Z-axis (spectral derivative).
 *   Bit0 (order-0, 255 ctx) is NOT maintained separately — it's the mathematical
 *   marginal of BitM over prevBit, dominated in the membrane's priming regime.
 *   mode byte: 0x00=BitM, 0x02=Bit1, 0x03=BitX, 0xFF=RAW.
 */

import { hkdf, TE } from "./live-crypto";
import { toArrayBuffer } from "./buf";

// --- constants ---

const B16 = 65536;

// pre-encoded info strings (avoids per-call TextEncoder allocations)
// msg/chain bumped to v2: the key salt is now the model-trajectory digest (see loopStep),
// not the entropy-free 16D residual it used to be.
const INFO_EXPAND  = TE.encode("kizuna-expand-v1");
const INFO_MSG     = TE.encode("kizuna-msg-v2");
const INFO_CHAIN   = TE.encode("kizuna-chain-v2");
const INFO_INIT    = TE.encode("kizuna-init-v1");

// 32 zero bytes — used as HKDF salt for loopExpand
const ZERO_SALT_32 = new Uint8Array(32);

// --- helpers ---

function le32(n: number): Uint8Array {
    const b = new Uint8Array(4);
    b[0] =  n        & 0xFF;
    b[1] = (n >>>  8) & 0xFF;
    b[2] = (n >>> 16) & 0xFF;
    b[3] = (n >>> 24) & 0xFF;
    return b;
}

function concatU8(...arrs: Uint8Array[]): Uint8Array {
    let total = 0; for (const a of arrs) total += a.length;
    const out = new Uint8Array(total); let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
}

// --- count priming ---

// prime a BitContextModelM counts array with bytes from data (Möbius per-bit, 512 contexts).
export function primeCountsM(counts: Uint32Array, data: Uint8Array): void {
    let prev = 0;
    for (const byte of data) {
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit     = (byte >> k) & 1;
            const prevBit = (prev >> k) & 1;
            counts[(prevBit * 256 + ctx) * 2 + bit]++;
            ctx = (ctx << 1) | bit;
        }
        prev = byte;
    }
}

// prime a Bit1 counts array (order-1, 4-bit prefix of previous byte, 4080 contexts).
export function primeCounts1(counts: Uint32Array, data: Uint8Array): void {
    let prev = 0;
    for (const byte of data) {
        const slot = prev >>> 4;
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit = (byte >> k) & 1;
            counts[(slot * 256 + ctx) * 2 + bit]++;
            ctx = (ctx << 1) | bit;
        }
        prev = byte;
    }
}

// prime a BitX counts array (XOR derivative, 4080 contexts).
// slot = (prev ^ prev2) >>> 4: top nibble of XOR between last two bytes.
// captures byte-stream velocity — inspired by Logos Z-axis (spectral derivative).
// same footprint as Bit1 (16 slots × 256 tree × 2 = 8192 uint32).
export function primeCountsX(counts: Uint32Array, data: Uint8Array): void {
    let prev = 0, prev2 = 0;
    for (const byte of data) {
        const slot = (prev ^ prev2) >>> 4;
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit = (byte >> k) & 1;
            counts[(slot * 256 + ctx) * 2 + bit]++;
            ctx = (ctx << 1) | bit;
        }
        prev2 = prev;
        prev = byte;
    }
}

// --- arithmetic coder (LZMA-style range coder, RC_TOP=16M) ---

const RC_TOP = 0x1000000;

class ArithEncoder {
    private lo    = 0;
    private range = 0xFFFFFFFF;
    private cache = -1;
    private nPend = 0;
    // Uint8Array instead of number[] — avoids 8× memory amplification.
    // number[] stores each byte as an 8-byte JS heap number; for a 1MB payload
    // the buf would consume ~8MB. With Uint8Array it stays at 1MB.
    private buf = new Uint8Array(256);
    private len = 0;

    private _push(b: number): void {
        if (this.len >= this.buf.length) {
            const next = new Uint8Array(this.buf.length * 2);
            next.set(this.buf.subarray(0, this.len));
            this.buf = next;
        }
        this.buf[this.len++] = b;
    }

    encode(cumLo: number, cumHi: number, total: number): void {
        const step  = Math.floor(this.range / total);
        const newLo = (this.lo + step * cumLo) >>> 0;
        this.range  = cumHi === total
            ? (this.range - step * cumLo) >>> 0
            : (step * (cumHi - cumLo)) >>> 0;
        if (newLo < this.lo) this._carry();
        this.lo = newLo;
        while (this.range < RC_TOP) {
            const b = (this.lo >>> 24) & 0xFF;
            if (b !== 0xFF) { this._emit(b); } else { this.nPend++; }
            this.lo    = ((this.lo    & 0xFFFFFF) << 8) >>> 0;
            this.range = ( this.range << 8) >>> 0;
        }
    }
    private _carry(): void {
        if (this.cache >= 0) { this._push((this.cache + 1) & 0xFF); for (let i = 0; i < this.nPend; i++) this._push(0x00); }
        else { for (let i = 0; i < this.nPend; i++) this._push(0x00); }
        this.cache = -1; this.nPend = 0;
    }
    private _emit(b: number): void {
        if (this.cache >= 0) { this._push(this.cache); for (let i = 0; i < this.nPend; i++) this._push(0xFF); }
        else { for (let i = 0; i < this.nPend; i++) this._push(0xFF); }
        this.cache = b; this.nPend = 0;
    }
    flush(): Uint8Array {
        if (this.cache >= 0) { this._push(this.cache); for (let i = 0; i < this.nPend; i++) this._push(0xFF); }
        else { for (let i = 0; i < this.nPend; i++) this._push(0xFF); }
        for (let i = 0; i < 4; i++) { this._push((this.lo >>> 24) & 0xFF); this.lo = ((this.lo & 0xFFFFFF) << 8) >>> 0; }
        return this.buf.subarray(0, this.len);
    }
}

class ArithDecoder {
    private lo    = 0;
    private range = 0xFFFFFFFF;
    private code  = 0;
    private pos   = 0;
    constructor(private data: Uint8Array) {
        for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | (data[this.pos++] ?? 0)) >>> 0;
    }
    getCDF(total: number): number {
        const step = Math.floor(this.range / total);
        return Math.min(((this.code - this.lo) >>> 0) / step | 0, total - 1);
    }
    advance(cumLo: number, cumHi: number, total: number): void {
        const step = Math.floor(this.range / total);
        this.lo    = (this.lo + step * cumLo) >>> 0;
        this.range = cumHi === total ? (this.range - step * cumLo) >>> 0 : (step * (cumHi - cumLo)) >>> 0;
        while (this.range < RC_TOP) {
            this.lo    = ((this.lo    & 0xFFFFFF) << 8) >>> 0;
            this.range = ( this.range << 8) >>> 0;
            this.code  = ((this.code  & 0xFFFFFF) << 8 | (this.data[this.pos++] ?? 0)) >>> 0;
        }
    }
}

// --- encode/decode helpers for each bit-level model ---
// each pair mutates the counts array in-place (caller passes a clone).

// BitM: Möbius per-bit (prevBit context), 512 contexts
function encodeM(counts: Uint32Array, data: Uint8Array): Uint8Array {
    const enc = new ArithEncoder();
    let prev = 0;
    for (const byte of data) {
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit     = (byte >> k) & 1;
            const prevBit = (prev >> k) & 1;
            const idx     = (prevBit * 256 + ctx) * 2;
            const c0 = counts[idx], c1 = counts[idx + 1], total = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            counts[idx + bit]++;
            ctx = (ctx << 1) | bit;
        }
        prev = byte;
    }
    return enc.flush();
}
function decodeM(counts: Uint32Array, data: Uint8Array, len: number): Uint8Array {
    const dec = new ArithDecoder(data);
    const out = new Uint8Array(len);
    let prev = 0;
    for (let i = 0; i < len; i++) {
        let ctx = 1, byte = 0;
        for (let k = 7; k >= 0; k--) {
            const prevBit = (prev >> k) & 1;
            const idx     = (prevBit * 256 + ctx) * 2;
            const c0 = counts[idx], c1 = counts[idx + 1], total = c0 + c1;
            const offset = dec.getCDF(total);
            const bit    = offset >= c0 ? 1 : 0;
            if (bit === 0) dec.advance(0, c0, total);
            else           dec.advance(c0, total, total);
            counts[idx + bit]++;
            out[i] = byte = (byte << 1) | bit;
            ctx = (ctx << 1) | bit;
        }
        prev = byte;
    }
    return out;
}

// Bit1: order-1 (4-bit prefix of previous byte), 4080 contexts
function encode1(counts: Uint32Array, data: Uint8Array): Uint8Array {
    const enc = new ArithEncoder();
    let prev = 0;
    for (const byte of data) {
        const slot = prev >>> 4;
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit = (byte >> k) & 1;
            const idx = (slot * 256 + ctx) * 2;
            const c0 = counts[idx], c1 = counts[idx + 1], total = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            counts[idx + bit]++;
            ctx = (ctx << 1) | bit;
        }
        prev = byte;
    }
    return enc.flush();
}
function decode1(counts: Uint32Array, data: Uint8Array, len: number): Uint8Array {
    const dec = new ArithDecoder(data);
    const out = new Uint8Array(len);
    let prev = 0;
    for (let i = 0; i < len; i++) {
        const slot = prev >>> 4;
        let ctx = 1, byte = 0;
        for (let k = 7; k >= 0; k--) {
            const idx = (slot * 256 + ctx) * 2;
            const c0 = counts[idx], c1 = counts[idx + 1], total = c0 + c1;
            const offset = dec.getCDF(total);
            const bit    = offset >= c0 ? 1 : 0;
            if (bit === 0) dec.advance(0, c0, total);
            else           dec.advance(c0, total, total);
            counts[idx + bit]++;
            byte = (byte << 1) | bit;
            ctx  = (ctx << 1) | bit;
        }
        out[i] = byte;
        prev = byte;
    }
    return out;
}

// BitX: XOR derivative (prev^prev2 upper nibble), 4080 contexts.
// captures byte-stream velocity — the Z-axis of Logos lifted to the loop ratchet.
// for ASCII text: similar consecutive letters have small XOR (slot 0-1),
// space↔letter transitions have consistent XOR (slot 5), UTF-8 continuation
// bytes cluster tightly. BitX sees the rhythm of transitions, not the bytes themselves.
function encodeX(counts: Uint32Array, data: Uint8Array): Uint8Array {
    const enc = new ArithEncoder();
    let prev = 0, prev2 = 0;
    for (const byte of data) {
        const slot = (prev ^ prev2) >>> 4;
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit = (byte >> k) & 1;
            const idx = (slot * 256 + ctx) * 2;
            const c0 = counts[idx], c1 = counts[idx + 1], total = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            counts[idx + bit]++;
            ctx = (ctx << 1) | bit;
        }
        prev2 = prev;
        prev = byte;
    }
    return enc.flush();
}
function decodeX(counts: Uint32Array, data: Uint8Array, len: number): Uint8Array {
    const dec = new ArithDecoder(data);
    const out = new Uint8Array(len);
    let prev = 0, prev2 = 0;
    for (let i = 0; i < len; i++) {
        const slot = (prev ^ prev2) >>> 4;
        let ctx = 1, byte = 0;
        for (let k = 7; k >= 0; k--) {
            const idx = (slot * 256 + ctx) * 2;
            const c0 = counts[idx], c1 = counts[idx + 1], total = c0 + c1;
            const offset = dec.getCDF(total);
            const bit    = offset >= c0 ? 1 : 0;
            if (bit === 0) dec.advance(0, c0, total);
            else           dec.advance(c0, total, total);
            counts[idx + bit]++;
            byte = (byte << 1) | bit;
            ctx  = (ctx << 1) | bit;
        }
        out[i] = byte;
        prev2 = prev;
        prev = byte;
    }
    return out;
}

// --- production key derivation ---

// expands a 32-byte chain key to 65536 bytes.
// HKDF(chain, le32(step), 'kizuna-expand-v1', 32) → AES-CTR keystream over 65536 zero bytes.
async function expandChain(chain: Uint8Array, step: number): Promise<Uint8Array> {
    const aesKeyBytes = await hkdf(chain, le32(step), INFO_EXPAND, 32);
    const cryptoKey   = await crypto.subtle.importKey(
        "raw", toArrayBuffer(aesKeyBytes), { name: "AES-CTR" }, false, ["encrypt"],
    );
    aesKeyBytes.fill(0);
    const result = await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: new Uint8Array(16), length: 64 },
        cryptoKey,
        new Uint8Array(B16),  // 65536 zero bytes
    );
    return new Uint8Array(result);
}

// derives a 32-byte message key.
// HKDF(chain, salt=digest, 'kizuna-msg-v2' || le32(step), 32), where digest is the
// SHA-256 of the model trajectory (see modelDigest / loopStep).
async function deriveMessageKey(chain: Uint8Array, digest: Uint8Array, step: number): Promise<Uint8Array> {
    return hkdf(chain, digest, concatU8(INFO_MSG, le32(step)), 32);
}

// advances the 32-byte chain key.
// HKDF(chain, salt=digest, 'kizuna-chain-v2' || le32(step), 32).
async function advanceChain(chain: Uint8Array, digest: Uint8Array, step: number): Promise<Uint8Array> {
    return hkdf(chain, digest, concatU8(INFO_CHAIN, le32(step)), 32);
}

// the three adaptive count arrays, independent of any chain or step position.
// LoopState carries these for the 2-party membrane; the braid carries bare
// accumulators of this shape per seat view.
export interface ModelCounts {
    countsBitM:  Uint32Array;  // 1024 uint32
    countsBit1:  Uint32Array;  // 8192 uint32
    countsBitX:  Uint32Array;  // 8192 uint32
}

// SHA-256 digest of the full adaptive model state (all three count arrays).
// the counts are a lossy digest of the entire decoded plaintext history ("plaintext
// residue"): every prior message trained them. the arithmetic coder is robust to small
// perturbations of this state, but SHA-256 is maximally sensitive to them, so binding
// the key to this digest turns any history divergence into a ~50%-bit-different key.
// both honest parties hold identical counts before a given loopStep, so they derive the
// same digest and the same key; a party with a divergent history derives a wrong key.
export async function modelDigest(state: ModelCounts): Promise<Uint8Array> {
    const m = new Uint8Array(state.countsBitM.buffer, state.countsBitM.byteOffset, state.countsBitM.byteLength);
    const a = new Uint8Array(state.countsBit1.buffer, state.countsBit1.byteOffset, state.countsBit1.byteLength);
    const x = new Uint8Array(state.countsBitX.buffer, state.countsBitX.byteOffset, state.countsBitX.byteLength);
    const buf = new Uint8Array(m.length + a.length + x.length);
    buf.set(m, 0); buf.set(a, m.length); buf.set(x, m.length + a.length);
    const h = await crypto.subtle.digest("SHA-256", toArrayBuffer(buf));
    return new Uint8Array(h);
}

// --- loop state ---

export interface LoopState extends ModelCounts {
    // cryptographic root. all other fields derive from this + message history.
    chain:   Uint8Array;      // 32 bytes

    // the three ModelCounts arrays are the adaptive 0D attention models:
    // three parallel bit-level coders, all trained on the full conversation
    // history. loopEncode trial-encodes with all three and picks the smallest.
    //
    // Bit0 (order-0, 255 ctx) is NOT stored — it's the mathematical marginal
    // of BitM over prevBit. in the membrane's priming regime (512B per loopStep),
    // BitM dominates Bit0: same convergence, strictly more information.

    // ratchet step counter. monotonically increasing.
    step:    number;
}

// initialize the loop from a 65536-byte shared block.
// both parties call this with the same block and get identical LoopStates.
// sync — no KDF calls, all derivation is from the block itself.
export function loopInit(sharedBlock: Uint8Array): LoopState {
    if (sharedBlock.length !== B16) throw new Error(`loopInit: expected ${B16} bytes, got ${sharedBlock.length}`);

    // sharedBlock is AES-CTR keystream from the DH secret (full entropy). Derive the chain
    // and the coder-priming from DISJOINT, domain-separated regions: bytes [0,32) are the
    // chain key (already a full 256-bit key), bytes [32,544) prime the coder model. this
    // replaces the old 16D Möbius residual XOR into the chain, which diffused ~10x weaker
    // than a hash and added zero entropy over block[0:32] (bench-kizuna-ablation.ts). disjoint
    // regions decorrelate the chain from the priming bytes without an extra mixing step.
    const primeData = sharedBlock.subarray(32, 544);

    // BitM: 512 contexts × 2, Laplace prior = 1
    const countsBitM = new Uint32Array(1024);
    for (let i = 0; i < 512; i++) { countsBitM[i * 2] = 1; countsBitM[i * 2 + 1] = 1; }
    primeCountsM(countsBitM, primeData);

    // Bit1: 16 × 256 contexts × 2, Laplace prior = 1
    const countsBit1 = new Uint32Array(8192);
    for (let i = 0; i < 4096; i++) { countsBit1[i * 2] = 1; countsBit1[i * 2 + 1] = 1; }
    primeCounts1(countsBit1, primeData);

    // BitX: 16 × 256 contexts × 2, Laplace prior = 1
    const countsBitX = new Uint32Array(8192);
    for (let i = 0; i < 4096; i++) { countsBitX[i * 2] = 1; countsBitX[i * 2 + 1] = 1; }
    primeCountsX(countsBitX, primeData);

    // chain: bytes [0,32) of the shared block — a full 256-bit key, disjoint from primeData.
    const chain = sharedBlock.slice(0, 32);

    return { chain, countsBitM, countsBit1, countsBitX, step: 0 };
}

// advance the loop one step: the ratchet.
// returns the message key for this step and the new loop state.
// both parties call this independently and derive identical results.
export async function loopStep(state: LoopState): Promise<{ next: LoopState; messageKey: Uint8Array }> {
    // history binding: digest the model trajectory BEFORE this step. the counts encode
    // every prior message, so this digest is a function of the full conversation history.
    // any divergence (wrong key-seed, missing/altered prior message) → different digest →
    // ~50%-bit-different messageKey → AES-GCM integrity rejects → zero plaintext recovery.
    const digest = await modelDigest(state);

    // 16D phase: expand chain → 65536-byte block (model-freshening keystream)
    const expanded = await expandChain(state.chain, state.step);

    // derive message key and advance chain, both bound to the model-trajectory digest
    const [messageKey, newChain] = await Promise.all([
        deriveMessageKey(state.chain, digest, state.step),
        advanceChain(state.chain, digest, state.step),
    ]);

    // 0D: overlay counts from expanded block for all three models
    const primeData = expanded.subarray(0, 512);
    const newCountsBitM = state.countsBitM.slice();
    primeCountsM(newCountsBitM, primeData);
    const newCountsBit1 = state.countsBit1.slice();
    primeCounts1(newCountsBit1, primeData);
    const newCountsBitX = state.countsBitX.slice();
    primeCountsX(newCountsBitX, primeData);

    expanded.fill(0);  // wipe keystream after use

    return {
        next: {
            chain: newChain, countsBitM: newCountsBitM,
            countsBit1: newCountsBit1, countsBitX: newCountsBitX,
            step: state.step + 1,
        },
        messageKey,
    };
}

// Large payload threshold: above this, skip arithmetic trial-encoding entirely
// and emit RAW. Binary files (video, audio, already-compressed data) don't
// compress with a byte-level coder anyway, and running two full ArithEncoder
// passes over 100MB+ of data wastes seconds of CPU and hundreds of MB of RAM.
// Train models only on a short prefix so future text messages still benefit.
const LOOP_RAW_THRESHOLD  = 1 * 1024 * 1024; // 1 MB
const LOOP_TRAIN_LIMIT    = 64 * 1024;        // train on at most 64 KB of large payloads

// adaptive compression: trial-encode with all three models, pick the smallest.
// all count arrays evolve as a side effect of trial encoding, so all models
// stay trained on the full conversation history regardless of which one wins.
// mode byte: 0x00=BitM, 0x02=Bit1, 0x03=BitX, 0xFF=RAW.
export function loopEncode(state: LoopState, data: Uint8Array): { encoded: Uint8Array; raw: boolean; next: LoopState } {
    // clone all count arrays — encoding (or priming) mutates them
    const cM = state.countsBitM.slice();
    const c1 = state.countsBit1.slice();
    const cX = state.countsBitX.slice();

    // large payload fast path: binary files won't compress, and trial-encoding
    // them would allocate O(N) memory and burn seconds of CPU for no gain.
    // train only on a prefix so text-message compression quality is preserved.
    // returns raw = true with encoded = data (same reference, zero copy).
    // the caller is responsible for prepending 0xFF when framing.
    if (data.length >= LOOP_RAW_THRESHOLD) {
        const trainSlice = data.subarray(0, LOOP_TRAIN_LIMIT);
        primeCountsM(cM, trainSlice);
        primeCounts1(c1, trainSlice);
        primeCountsX(cX, trainSlice);
        return { encoded: data, raw: true, next: { chain: state.chain.slice(), countsBitM: cM, countsBit1: c1, countsBitX: cX, step: state.step } };
    }

    // ArithEncoder.flush() always produces ≥ 4 bytes (the lo register).
    // for data shorter than that, RAW is guaranteed to win — skip the
    // trial-encode and use the lightweight primeCounts pass instead.
    if (data.length < 5) {
        primeCountsM(cM, data);
        primeCounts1(c1, data);
        primeCountsX(cX, data);
        const out = new Uint8Array(1 + data.length);
        out[0] = 0xFF; out.set(data, 1);
        return { encoded: out, raw: false, next: { chain: state.chain.slice(), countsBitM: cM, countsBit1: c1, countsBitX: cX, step: state.step } };
    }

    // trial-encode with each model (each updates its cloned counts)
    const encM = encodeM(cM, data);
    const enc1 = encode1(c1, data);
    const encX = encodeX(cX, data);

    // pick smallest
    let bestMode: number, bestEncoded: Uint8Array;
    if (enc1.length <= encM.length && enc1.length <= encX.length) {
        bestMode = 0x02; bestEncoded = enc1;
    } else if (encX.length <= encM.length) {
        bestMode = 0x03; bestEncoded = encX;
    } else {
        bestMode = 0x00; bestEncoded = encM;
    }

    // clone chain so the returned state is independent — callers can safely wipe the input
    const next: LoopState = { chain: state.chain.slice(), countsBitM: cM, countsBit1: c1, countsBitX: cX, step: state.step };

    // raw fallback if no coder beats input length
    if (bestEncoded.length >= data.length) {
        const out = new Uint8Array(1 + data.length);
        out[0] = 0xFF; out.set(data, 1);
        return { encoded: out, raw: false, next };
    }

    const out = new Uint8Array(1 + bestEncoded.length);
    out[0] = bestMode; out.set(bestEncoded, 1);
    return { encoded: out, raw: false, next };
}

// mode-directed decompression: read mode byte, decode with the winning model,
// then update the other models via a count-only pass on the decoded plaintext.
// all count arrays evolve identically to the encoder's.
export function loopDecode(state: LoopState, data: Uint8Array, len: number): { decoded: Uint8Array; next: LoopState } {
    const mode    = data[0];
    const payload = data.subarray(1);

    // clone all count arrays
    const cM = state.countsBitM.slice();
    const c1 = state.countsBit1.slice();
    const cX = state.countsBitX.slice();

    let decoded: Uint8Array;
    switch (mode) {
        case 0x00: // BitM won — decode with BitM, train others from plaintext
            decoded = decodeM(cM, payload, len);
            primeCounts1(c1, decoded);
            primeCountsX(cX, decoded);
            break;
        case 0x02: // Bit1 won — decode with Bit1, train others from plaintext
            decoded = decode1(c1, payload, len);
            primeCountsM(cM, decoded);
            primeCountsX(cX, decoded);
            break;
        case 0x03: // BitX won — decode with BitX, train others from plaintext
            decoded = decodeX(cX, payload, len);
            primeCountsM(cM, decoded);
            primeCounts1(c1, decoded);
            break;
        case 0xFF: // RAW fallback — train all from plaintext
            decoded = payload.slice(0, len);
            // Mirror encoder: for large payloads train only on a prefix so
            // both sides' model state stays identical.
            if (decoded.length >= LOOP_RAW_THRESHOLD) {
                const trainSlice = decoded.subarray(0, LOOP_TRAIN_LIMIT);
                primeCountsM(cM, trainSlice);
                primeCounts1(c1, trainSlice);
                primeCountsX(cX, trainSlice);
            } else {
                primeCountsM(cM, decoded);
                primeCounts1(c1, decoded);
                primeCountsX(cX, decoded);
            }
            break;
        default:
            throw new Error(`loopDecode: unknown mode 0x${mode.toString(16)}`);
    }

    return { decoded, next: { chain: state.chain.slice(), countsBitM: cM, countsBit1: c1, countsBitX: cX, step: state.step } };
}

// the canonical training rule, in one place: what a plaintext contributes to the
// three count models. below LOOP_RAW_THRESHOLD the full payload trains; at or above
// it only a LOOP_TRAIN_LIMIT prefix does. loopEncode and loopDecode produce exactly
// this delta on every path (adaptive coding increments the same context cells as
// priming), so a message's count-delta is a pure function of its plaintext. the
// braid leans on that purity: deltas commute, so a set of messages yields the same
// counts in any integration order. mutates counts in place; callers own cloning.
export function loopTrain(counts: ModelCounts, data: Uint8Array): void {
    const slice = data.length >= LOOP_RAW_THRESHOLD ? data.subarray(0, LOOP_TRAIN_LIMIT) : data;
    primeCountsM(counts.countsBitM, slice);
    primeCounts1(counts.countsBit1, slice);
    primeCountsX(counts.countsBitX, slice);
}

// wipe sensitive fields from a loop state.
// call on the old state after loopStep to maintain forward secrecy.
// chain is the cryptographic secret; count arrays hold the statistical
// fingerprint of key material + message history and must also be zeroed.
export function loopWipe(state: LoopState): void {
    state.chain.fill(0);
    state.countsBitM.fill(0);
    state.countsBit1.fill(0);
    state.countsBitX.fill(0);
}

// expand a 32-byte key to 65536 bytes for use as a loopInit seed.
// used once per DH period to generate the shared block for loopInit.
// HKDF(key, 0x00..., 'kizuna-init-v1', 32) → AES-CTR keystream over 65536 zero bytes.
export async function loopExpand(key: Uint8Array): Promise<Uint8Array> {
    const aesKeyBytes = await hkdf(key, ZERO_SALT_32, INFO_INIT, 32);
    const cryptoKey   = await crypto.subtle.importKey(
        "raw", toArrayBuffer(aesKeyBytes), { name: "AES-CTR" }, false, ["encrypt"],
    );
    aesKeyBytes.fill(0);
    const result = await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: new Uint8Array(16), length: 64 },
        cryptoKey,
        new Uint8Array(B16),  // 65536 zero bytes
    );
    return new Uint8Array(result);
}
