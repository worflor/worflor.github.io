/**
 * live-loop.ts
 *
 * Whisper Loop — production runtime.
 *
 * replaces the placeholder XOR KDFs in test-loop.ts with real
 * HKDF-SHA256 and AES-CTR operations via WebCrypto. see test-loop.ts
 * for the full algorithm documentation and test spec.
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
 *   two parallel bit-level coders compete per message.
 *   BitM (Möbius per-bit, 512 ctx) — general purpose temporal.
 *   Bit1 (order-1 4-bit prefix, 4080 ctx) — inter-byte structure (UTF-8, structured data).
 *   Bit0 (order-0, 255 ctx) is NOT maintained separately — it's the mathematical
 *   marginal of BitM over prevBit, dominated in the membrane's priming regime.
 *   mode byte: 0x00=BitM, 0x02=Bit1, 0xFF=RAW.
 */

import { hkdf, TE } from "./live-crypto";
import { toArrayBuffer } from "./wasm";

// --- constants ---

const B16 = 65536;

const PARITY16 = new Uint8Array(B16);
for (let mask = 1; mask < B16; mask++) PARITY16[mask] = PARITY16[mask >> 1] ^ (mask & 1);

// pre-encoded info strings (avoids per-call TextEncoder allocations)
const INFO_EXPAND  = TE.encode("kizuna-expand-v1");
const INFO_MSG     = TE.encode("kizuna-msg-v1");
const INFO_CHAIN   = TE.encode("kizuna-chain-v1");
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

// --- 16D Möbius predictor ---

function predAnti16D(block: Uint8Array): number {
    let P = 0;
    for (let mask = 1; mask < B16; mask++) P += PARITY16[mask] ? block[mask] : -block[mask];
    return P;
}

// --- count priming ---

// prime a BitContextModelM counts array with bytes from data (Möbius per-bit, 512 contexts).
function primeCountsM(counts: Uint32Array, data: Uint8Array): void {
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
function primeCounts1(counts: Uint32Array, data: Uint8Array): void {
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

// --- arithmetic coder (same as live-wasm-logos.ts) ---

const RC_TOP = 0x1000000;

class ArithEncoder {
    private lo    = 0;
    private range = 0xFFFFFFFF;
    private cache = -1;
    private nPend = 0;
    private buf: number[] = [];

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
        if (this.cache >= 0) { this.buf.push((this.cache + 1) & 0xFF); for (let i = 0; i < this.nPend; i++) this.buf.push(0x00); }
        else { for (let i = 0; i < this.nPend; i++) this.buf.push(0x00); }
        this.cache = -1; this.nPend = 0;
    }
    private _emit(b: number): void {
        if (this.cache >= 0) { this.buf.push(this.cache); for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF); }
        else { for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF); }
        this.cache = b; this.nPend = 0;
    }
    flush(): Uint8Array {
        if (this.cache >= 0) { this.buf.push(this.cache); for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF); }
        else { for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF); }
        for (let i = 0; i < 4; i++) { this.buf.push((this.lo >>> 24) & 0xFF); this.lo = ((this.lo & 0xFFFFFF) << 8) >>> 0; }
        return new Uint8Array(this.buf);
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
// HKDF(chain, le32(residual), 'kizuna-msg-v1' || le32(step), 32).
async function deriveMessageKey(chain: Uint8Array, residual: number, step: number): Promise<Uint8Array> {
    return hkdf(chain, le32(residual), concatU8(INFO_MSG, le32(step)), 32);
}

// advances the 32-byte chain key.
// HKDF(chain, le32(residual), 'kizuna-chain-v1' || le32(step), 32).
async function advanceChain(chain: Uint8Array, residual: number, step: number): Promise<Uint8Array> {
    return hkdf(chain, le32(residual), concatU8(INFO_CHAIN, le32(step)), 32);
}

// --- loop state ---

export interface LoopState {
    // cryptographic root. all other fields derive from this + message history.
    chain:   Uint8Array;      // 32 bytes

    // adaptive 0D attention models: two parallel bit-level coders.
    // both stay trained on the full conversation history.
    // loopEncode trial-encodes with both and picks the smallest.
    //
    // Bit0 (order-0, 255 ctx) is NOT stored — it's the mathematical marginal
    // of BitM over prevBit. in the membrane's priming regime (512B per loopStep),
    // BitM dominates Bit0: same convergence, strictly more information.
    countsBitM:  Uint32Array;  // 1024 uint32 — Möbius per-bit (512 ctx × 2)
    countsBit1:  Uint32Array;  // 8192 uint32 — order-1, 4-bit prefix (16 × 256 ctx × 2)

    // ratchet step counter. monotonically increasing.
    step:    number;
}

// initialize the loop from a 65536-byte shared block.
// both parties call this with the same block and get identical LoopStates.
// sync — no KDF calls, all derivation is from the block itself.
export function loopInit(sharedBlock: Uint8Array): LoopState {
    if (sharedBlock.length !== B16) throw new Error(`loopInit: expected ${B16} bytes, got ${sharedBlock.length}`);

    // 16D: compute Möbius residual of the shared block (mixes all 65536 bytes into chain)
    const pred     = predAnti16D(sharedBlock);
    const residual = (sharedBlock[0] - Math.round(pred)) | 0;

    const primeData = sharedBlock.subarray(0, 512);

    // BitM: 512 contexts × 2, Laplace prior = 1
    const countsBitM = new Uint32Array(1024);
    for (let i = 0; i < 512; i++) { countsBitM[i * 2] = 1; countsBitM[i * 2 + 1] = 1; }
    primeCountsM(countsBitM, primeData);

    // Bit1: 16 × 256 contexts × 2, Laplace prior = 1
    const countsBit1 = new Uint32Array(8192);
    for (let i = 0; i < 4096; i++) { countsBit1[i * 2] = 1; countsBit1[i * 2 + 1] = 1; }
    primeCounts1(countsBit1, primeData);

    // chain: first 32 bytes of shared block mixed with 16D residual
    const chain = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        chain[i] = sharedBlock[i] ^ ((residual >>> ((i & 3) * 8)) & 0xFF);

    return { chain, countsBitM, countsBit1, step: 0 };
}

// advance the loop one step: the ratchet.
// returns the message key for this step and the new loop state.
// both parties call this independently and derive identical results.
export async function loopStep(state: LoopState): Promise<{ next: LoopState; messageKey: Uint8Array }> {
    // 16D phase: expand chain → 65536-byte block → Möbius residual
    const expanded = await expandChain(state.chain, state.step);
    const pred     = predAnti16D(expanded);
    const residual = (expanded[0] - Math.round(pred)) | 0;

    // derive message key and advance chain in parallel (independent inputs)
    const [messageKey, newChain] = await Promise.all([
        deriveMessageKey(state.chain, residual, state.step),
        advanceChain(state.chain, residual, state.step),
    ]);

    // 0D: overlay counts from expanded block for both models
    const primeData = expanded.subarray(0, 512);
    const newCountsBitM = state.countsBitM.slice();
    primeCountsM(newCountsBitM, primeData);
    const newCountsBit1 = state.countsBit1.slice();
    primeCounts1(newCountsBit1, primeData);

    expanded.fill(0);  // wipe keystream after use

    return {
        next: {
            chain: newChain, countsBitM: newCountsBitM,
            countsBit1: newCountsBit1, step: state.step + 1,
        },
        messageKey,
    };
}

// adaptive compression: trial-encode with both models, pick the smallest.
// both count arrays evolve as a side effect of trial encoding, so both models
// stay trained on the full conversation history regardless of which one wins.
// mode byte: 0x00=BitM, 0x02=Bit1, 0xFF=RAW.
export function loopEncode(state: LoopState, data: Uint8Array): { encoded: Uint8Array; next: LoopState } {
    // clone both count arrays — encoding (or priming) mutates them
    const cM = state.countsBitM.slice();
    const c1 = state.countsBit1.slice();

    // ArithEncoder.flush() always produces ≥ 4 bytes (the lo register).
    // for data shorter than that, RAW is guaranteed to win — skip the 36KB
    // trial-encode and use the lightweight primeCounts pass instead.
    if (data.length < 5) {
        primeCountsM(cM, data);
        primeCounts1(c1, data);
        const out = new Uint8Array(1 + data.length);
        out[0] = 0xFF; out.set(data, 1);
        return { encoded: out, next: { ...state, countsBitM: cM, countsBit1: c1 } };
    }

    // trial-encode with each model (each updates its cloned counts)
    const encM = encodeM(cM, data);
    const enc1 = encode1(c1, data);

    // pick smallest
    let bestMode: number, bestEncoded: Uint8Array;
    if (enc1.length < encM.length) {
        bestMode = 0x02; bestEncoded = enc1;
    } else {
        bestMode = 0x00; bestEncoded = encM;
    }

    const next: LoopState = { ...state, countsBitM: cM, countsBit1: c1 };

    // raw fallback if no coder beats input length
    if (bestEncoded.length >= data.length) {
        const out = new Uint8Array(1 + data.length);
        out[0] = 0xFF; out.set(data, 1);
        return { encoded: out, next };
    }

    const out = new Uint8Array(1 + bestEncoded.length);
    out[0] = bestMode; out.set(bestEncoded, 1);
    return { encoded: out, next };
}

// mode-directed decompression: read mode byte, decode with the winning model,
// then update the other model via a count-only pass on the decoded plaintext.
// both count arrays evolve identically to the encoder's.
export function loopDecode(state: LoopState, data: Uint8Array, len: number): { decoded: Uint8Array; next: LoopState } {
    const mode    = data[0];
    const payload = data.subarray(1);

    // clone both count arrays
    const cM = state.countsBitM.slice();
    const c1 = state.countsBit1.slice();

    let decoded: Uint8Array;
    switch (mode) {
        case 0x00: // BitM won — decode with BitM, train Bit1 from plaintext
            decoded = decodeM(cM, payload, len);
            primeCounts1(c1, decoded);
            break;
        case 0x02: // Bit1 won — decode with Bit1, train BitM from plaintext
            decoded = decode1(c1, payload, len);
            primeCountsM(cM, decoded);
            break;
        case 0xFF: // RAW fallback — train both from plaintext
            decoded = payload.slice(0, len);
            primeCountsM(cM, decoded);
            primeCounts1(c1, decoded);
            break;
        default:
            throw new Error(`loopDecode: unknown mode 0x${mode.toString(16)}`);
    }

    return { decoded, next: { ...state, countsBitM: cM, countsBit1: c1 } };
}

// wipe sensitive fields from a loop state.
// call on the old state after loopStep to maintain forward secrecy.
// chain is the cryptographic secret; count arrays hold the statistical
// fingerprint of key material + message history and must also be zeroed.
export function loopWipe(state: LoopState): void {
    state.chain.fill(0);
    state.countsBitM.fill(0);
    state.countsBit1.fill(0);
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
