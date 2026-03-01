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

// prime a BitContextModelM counts array with bytes from data.
function primeCounts(counts: Uint32Array, data: Uint8Array): void {
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
    chain:   Uint8Array;   // 32 bytes

    // 0D attention model: BitContextModelM counts (512 context pairs).
    // initialized from 16D key material, grows with each message.
    counts:  Uint32Array;  // 1024 uint32

    // 8D spatial context: the current octonion block (65536 bytes).
    // evolves by XOR with each new 16D expansion.
    block8D: Uint8Array;   // 65536 bytes

    // ratchet step counter. monotonically increasing.
    step:    number;
}

// initialize the loop from a 65536-byte shared block.
// both parties call this with the same block and get identical LoopStates.
// sync — no KDF calls, all derivation is from the block itself.
export function loopInit(sharedBlock: Uint8Array): LoopState {
    if (sharedBlock.length !== B16) throw new Error(`loopInit: expected ${B16} bytes, got ${sharedBlock.length}`);

    // 16D: compute Möbius residual of the shared block
    const pred     = predAnti16D(sharedBlock);
    const residual = (sharedBlock[0] - Math.round(pred)) | 0;

    // 0D: prime counts from first 512 bytes of shared block
    const counts = new Uint32Array(1024);
    for (let i = 0; i < 512; i++) { counts[i * 2] = 1; counts[i * 2 + 1] = 1; }
    primeCounts(counts, sharedBlock.subarray(0, 512));

    // chain: first 32 bytes of shared block mixed with 16D residual
    const chain = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        chain[i] = sharedBlock[i] ^ ((residual >>> ((i & 3) * 8)) & 0xFF);

    // 8D: the shared block itself
    return { chain, counts, block8D: sharedBlock.slice(), step: 0 };
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

    // 0D: overlay counts from expanded block
    const newCounts = state.counts.slice();
    primeCounts(newCounts, expanded.subarray(0, 512));

    // 8D: evolve block by XOR with new expanded block
    const newBlock8D = new Uint8Array(B16);
    for (let i = 0; i < B16; i++) newBlock8D[i] = state.block8D[i] ^ expanded[i];

    expanded.fill(0);  // wipe keystream after use

    return {
        next: { chain: newChain, counts: newCounts, block8D: newBlock8D, step: state.step + 1 },
        messageKey,
    };
}

// compress data using the current 0D model (BitContextModelM).
// counts evolve as encoding proceeds — the model learns from the message.
// the returned `next` state has counts updated by this message.
export function loopEncode(state: LoopState, data: Uint8Array): { encoded: Uint8Array; next: LoopState } {
    const counts = state.counts.slice();
    const enc    = new ArithEncoder();
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
    return { encoded: enc.flush(), next: { ...state, counts } };
}

// decompress data using the current 0D model — identical traversal to loopEncode.
// counts evolve identically: encode and decode process the same bits in the same order.
export function loopDecode(state: LoopState, data: Uint8Array, len: number): { decoded: Uint8Array; next: LoopState } {
    const counts = state.counts.slice();
    const dec    = new ArithDecoder(data);
    const out    = new Uint8Array(len);
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
    return { decoded: out, next: { ...state, counts } };
}

// wipe sensitive fields from a loop state.
// call on the old state after loopStep to maintain forward secrecy.
export function loopWipe(state: LoopState): void {
    state.chain.fill(0);
    state.block8D.fill(0);
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
