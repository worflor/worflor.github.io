/**
 * live-wasm-logos.ts
 *
 * the Whisper Logos Entropy Codec by Woflo / MB
 *
 * at 0D there are no spatial neighbors. the Möbius cross-term collapses to
 * nothing. what remains is pure probability: the running attention map over
 * symbols, updated with every observation.
 *
 * four coders, all adaptive:
 *
 *   Rice       : rank[s] encoded with Rice(k), k adapts every 16 symbols.
 *                fast, simple, ~0.3–1.5 bits/sym above Shannon.
 *
 *   ByteArith  : 256-symbol range coder. near-Shannon for IID sources.
 *                retained for benchmarking; superseded by the bit-level coders.
 *
 *   Bit0 (order-0): 255 binary contexts, one per node of the bit tree (1..255).
 *                MSB-first decomposition. Laplace prior of 2 (not 256), giving
 *                dramatically faster convergence for peaked distributions.
 *
 *   Bit1 (order-1): top 4 bits of the previous byte as context prefix.
 *                16×255 = 4080 binary contexts. captures inter-byte correlations.
 *                beats H0 on UTF-8, audio deltas, and structured binary data.
 *
 * encode0D() tries all three, picks the smallest, prepends a mode byte.
 * raw fallback when nothing wins. output guaranteed ≤ input + 1 byte.
 *
 * ── the duality ──────────────────────────────────────────────────────────
 *
 * 8 binary decisions per byte produces 255 context tree nodes (1..255), the
 * same 255 non-trivial elements of the Boolean lattice Λ*(R⁸) indexed by the
 * 8D Möbius predictor's spatial neighbors. the chain rule over conditional bit
 * probabilities is the probabilistic mirror of spatial inclusion-exclusion:
 * both decompose structure on 2^{0,...,7} into 255 constituent terms.
 *
 * the floor of the tower. no geometry, just attention.
 */

// --- bit I/O ---

class BitWriter {
    private buf: Uint8Array;
    pos = 0;
    constructor(cap: number) { this.buf = new Uint8Array(cap); }
    write(val: number, bits: number): void {
        for (let i = bits - 1; i >= 0; i--) {
            if ((val >> i) & 1) this.buf[this.pos >> 3] |= 1 << (7 - (this.pos & 7));
            this.pos++;
        }
    }
    writeUnary(n: number): void {
        this.pos += n;
        this.buf[this.pos >> 3] |= 1 << (7 - (this.pos & 7));
        this.pos++;
    }
    bytes(): Uint8Array { return this.buf.subarray(0, (this.pos + 7) >> 3); }
}

class BitReader {
    pos = 0;
    constructor(readonly buf: Uint8Array) {}
    read(bits: number): number {
        let val = 0;
        for (let i = bits - 1; i >= 0; i--) {
            if ((this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1) val |= 1 << i;
            this.pos++;
        }
        return val;
    }
    readUnary(): number { let n = 0; while (!this.read(1)) n++; return n; }
}

// --- adaptive attention model ---
//
// dual arrays: order[rank]→symbol, rank[symbol]→rank, both O(1).
// update() bubbles symbol up while strictly greater than predecessor.
// PRIOR=1: Laplace smoothing, no symbol has zero probability.

const ALPHA = 256;
const PRIOR = 1;

class AttentionModel {
    readonly freq: Uint32Array;
    private order: Uint8Array;
    private rank: Uint8Array;

    constructor() {
        this.freq  = new Uint32Array(ALPHA);
        this.order = new Uint8Array(ALPHA);
        this.rank  = new Uint8Array(ALPHA);
        for (let i = 0; i < ALPHA; i++) {
            this.freq[i] = PRIOR; this.order[i] = i; this.rank[i] = i;
        }
    }

    getRank(sym: number): number { return this.rank[sym]; }
    getSymbol(r: number): number { return this.order[r]; }

    update(sym: number): void {
        this.freq[sym]++;
        let r = this.rank[sym];
        while (r > 0 && this.freq[this.order[r - 1]] < this.freq[sym]) {
            const prev = this.order[r - 1];
            this.order[r] = prev;     this.rank[prev] = r;
            this.order[r - 1] = sym;  this.rank[sym]  = r - 1;
            r--;
        }
    }

    // cumulative frequency array in descending-rank order, length ALPHA+1.
    // cum[r] = total freq of symbols at ranks 0..r-1.
    // cum[ALPHA] = total = sum of all freq.
    // symbol at rank r occupies interval [cum[r], cum[r+1]).
    buildCDF(): Uint32Array {
        const cum = new Uint32Array(ALPHA + 1);
        let acc = 0;
        for (let r = 0; r < ALPHA; r++) {
            cum[r] = acc;
            acc += this.freq[this.getSymbol(r)];
        }
        cum[ALPHA] = acc;
        return cum;
    }

    // model's Shannon entropy (reflects convergence quality)
    entropy(): number {
        let total = 0;
        for (let i = 0; i < ALPHA; i++) total += this.freq[i];
        let H = 0;
        for (let i = 0; i < ALPHA; i++) {
            if (this.freq[i] > 0) { const p = this.freq[i] / total; H -= p * Math.log2(p); }
        }
        return H;
    }

    snapshot(n: number): Array<{ sym: number; freq: number; rank: number }> {
        const out: Array<{ sym: number; freq: number; rank: number }> = [];
        for (let i = 0; i < Math.min(n, ALPHA); i++)
            out.push({ sym: this.order[i], freq: this.freq[this.order[i]], rank: i });
        return out;
    }
}

// --- Rice coding for ranks ---

function riceK(mean: number): number {
    if (mean <= 1) return 0;
    let k = 0, m = mean | 0;
    while (m > 1) { m >>= 1; k++; }
    return k;
}

function writeRank(bw: BitWriter, r: number, k: number): void {
    bw.writeUnary(r >> k);
    if (k > 0) bw.write(r & ((1 << k) - 1), k);
}

function readRank(br: BitReader, k: number): number {
    return (br.readUnary() << k) | (k > 0 ? br.read(k) : 0);
}

// --- arithmetic coder (range coding, carry-propagating) ---
//
// standard LZMA-style range coder. range is always ≥ RC_TOP = 16M after
// normalization, guaranteeing step = floor(range/total) ≥ 1 for total ≤ 16M.
// carry propagation: when lo wraps 2^32, the previously buffered byte gets +1.
// cache buffers the last non-0xFF byte; nPend counts trailing 0xFF bytes
// (which become 0x00 on carry). this correctly handles all overflow cases.
//
// encoder and decoder use the same AttentionModel and buildCDF() at each step.
// no model state is transmitted — only the compressed interval bytes.

const RC_TOP = 0x1000000;  // 16M normalization threshold

class ArithEncoder {
    private lo    = 0;
    private range = 0xFFFFFFFF;
    private cache = -1;   // last emitted non-0xFF byte (-1 = none yet)
    private nPend = 0;    // count of trailing 0xFF bytes after cache
    private buf: number[] = [];

    encode(cumLo: number, cumHi: number, total: number): void {
        const step  = Math.floor(this.range / total);
        const newLo = (this.lo + step * cumLo) >>> 0;
        this.range  = cumHi === total
            ? (this.range - step * cumLo) >>> 0
            : (step * (cumHi - cumLo)) >>> 0;
        if (newLo < this.lo) this._carry();  // lo wrapped: carry into buffered byte
        this.lo = newLo;
        while (this.range < RC_TOP) {
            const b = (this.lo >>> 24) & 0xFF;
            if (b !== 0xFF) { this._emitByte(b); } else { this.nPend++; }
            this.lo    = ((this.lo    & 0xFFFFFF) << 8) >>> 0;
            this.range = ( this.range << 8) >>> 0;
        }
    }

    private _carry(): void {
        if (this.cache >= 0) {
            this.buf.push((this.cache + 1) & 0xFF);
            for (let i = 0; i < this.nPend; i++) this.buf.push(0x00);
        } else {
            // carry with no cache: pending 0xFF bytes become 0x00
            // (0xFF + carry = 0x100, emit 0x00, carry propagates out — lost)
            for (let i = 0; i < this.nPend; i++) this.buf.push(0x00);
        }
        this.cache = -1; this.nPend = 0;
    }

    private _emitByte(b: number): void {
        if (this.cache >= 0) {
            this.buf.push(this.cache);
            for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF);
        } else {
            // first non-0xFF byte, but there may be pending 0xFF bytes before it
            for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF);
        }
        this.cache = b; this.nPend = 0;
    }

    flush(): Uint8Array {
        if (this.cache >= 0) {
            this.buf.push(this.cache);
            for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF);
        } else {
            for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF);
        }
        for (let i = 0; i < 4; i++) {
            this.buf.push((this.lo >>> 24) & 0xFF);
            this.lo = ((this.lo & 0xFFFFFF) << 8) >>> 0;
        }
        return new Uint8Array(this.buf);
    }
}

class ArithDecoder {
    private lo    = 0;
    private range = 0xFFFFFFFF;
    private code  = 0;
    private pos   = 0;

    constructor(private data: Uint8Array) {
        for (let i = 0; i < 4; i++)
            this.code = ((this.code << 8) | (data[this.pos++] ?? 0)) >>> 0;
    }

    getCDF(total: number): number {
        const step   = Math.floor(this.range / total);
        const offset = ((this.code - this.lo) >>> 0) / step | 0;
        return Math.min(offset, total - 1);
    }

    advance(cumLo: number, cumHi: number, total: number): void {
        const step = Math.floor(this.range / total);
        this.lo    = (this.lo + step * cumLo) >>> 0;
        this.range = cumHi === total
            ? (this.range - step * cumLo) >>> 0
            : (step * (cumHi - cumLo)) >>> 0;
        while (this.range < RC_TOP) {
            this.lo    = ((this.lo    & 0xFFFFFF) << 8) >>> 0;
            this.range = ( this.range << 8) >>> 0;
            this.code  = ((this.code  & 0xFFFFFF) << 8 | (this.data[this.pos++] ?? 0)) >>> 0;
        }
    }
}

// binary search: find rank r where cum[r] <= offset < cum[r+1]
function searchCDF(cum: Uint32Array, offset: number): number {
    let lo = 0, hi = ALPHA - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
}

// --- Rice encode/decode (window=16 for fast k adaptation) ---

function encode0DRice(data: Uint8Array): Uint8Array {
    const model = new AttentionModel();
    const bw    = new BitWriter(Math.max(data.length * 2 + 128, 256));
    let k = 6, wSum = 0, wCnt = 0;

    for (let i = 0; i < data.length; i++) {
        if (wCnt === 16) { k = riceK((wSum / 16) | 0); wSum = 0; wCnt = 0; }
        const r = model.getRank(data[i]);
        writeRank(bw, r, k);
        model.update(data[i]);
        wSum += r; wCnt++;
    }
    return bw.bytes();
}

function decode0DRice(data: Uint8Array, len: number): Uint8Array {
    const model = new AttentionModel();
    const br    = new BitReader(data);
    const out   = new Uint8Array(len);
    let k = 6, wSum = 0, wCnt = 0;

    for (let i = 0; i < len; i++) {
        if (wCnt === 16) { k = riceK((wSum / 16) | 0); wSum = 0; wCnt = 0; }
        const r = readRank(br, k);
        out[i] = model.getSymbol(r);
        model.update(out[i]);
        wSum += r; wCnt++;
    }
    return out;
}

// --- Arithmetic encode/decode ---

export function encode0DArith(data: Uint8Array): Uint8Array {
    const model = new AttentionModel();
    const enc   = new ArithEncoder();
    for (const sym of data) {
        const cum = model.buildCDF();
        const r   = model.getRank(sym);
        enc.encode(cum[r], cum[r + 1], cum[ALPHA]);
        model.update(sym);
    }
    return enc.flush();
}

export function decode0DArith(data: Uint8Array, len: number): Uint8Array {
    const model = new AttentionModel();
    const dec   = new ArithDecoder(data);
    const out   = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        const cum    = model.buildCDF();
        const offset = dec.getCDF(cum[ALPHA]);
        const r      = searchCDF(cum, offset);
        out[i]       = model.getSymbol(r);
        dec.advance(cum[r], cum[r + 1], cum[ALPHA]);
        model.update(out[i]);
    }
    return out;
}

// --- bit-level context model (255 binary contexts) ---
//
// each byte is decomposed MSB-first into 8 binary decisions.
// context index starts at 1 (root), then ctx = (ctx << 1) | bit.
// contexts 1..255 form a complete binary tree of depth 8.
//
// these 255 contexts are the Boolean lattice 2^{0,...,7}, the same
// algebraic structure as the 255 non-trivial elements of the exterior
// algebra Λ*(R^8) that define the 8D Möbius predictor's neighbors.
//
// each context has count0, count1 with Laplace prior = 1.
// total per context starts at 2, not 256 — this is where the convergence
// speed comes from. the model learns each bit position's conditional
// probability independently.

class BitContextModel {
    private counts: Uint32Array;  // 256 contexts × 2 (count0, count1)

    constructor() {
        this.counts = new Uint32Array(512);
        for (let i = 0; i < 256; i++) {
            this.counts[i * 2]     = 1;  // count0
            this.counts[i * 2 + 1] = 1;  // count1
        }
    }

    encodeByte(enc: ArithEncoder, byte: number): void {
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit   = (byte >> k) & 1;
            const c0    = this.counts[ctx * 2];
            const c1    = this.counts[ctx * 2 + 1];
            const total = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            this.counts[ctx * 2 + bit]++;
            ctx = (ctx << 1) | bit;
        }
    }

    decodeByte(dec: ArithDecoder): number {
        let ctx = 1, byte = 0;
        for (let k = 7; k >= 0; k--) {
            const c0    = this.counts[ctx * 2];
            const c1    = this.counts[ctx * 2 + 1];
            const total = c0 + c1;
            const offset = dec.getCDF(total);
            const bit    = offset >= c0 ? 1 : 0;
            if (bit === 0) dec.advance(0, c0, total);
            else           dec.advance(c0, total, total);
            this.counts[ctx * 2 + bit]++;
            byte = (byte << 1) | bit;
            ctx  = (ctx << 1) | bit;
        }
        return byte;
    }

    // model entropy across all 256 leaf contexts (weighted by usage)
    entropy(): number {
        let totalBits = 0, totalWeight = 0;
        // leaf contexts are at depth 8: indices 256..511 in a full tree,
        // but our tree uses indices 1..255 for internal nodes.
        // entropy is best measured at each internal context node.
        for (let ctx = 1; ctx < 256; ctx++) {
            const c0 = this.counts[ctx * 2];
            const c1 = this.counts[ctx * 2 + 1];
            const t  = c0 + c1;
            if (t <= 2) continue;  // only Laplace prior, no real data
            const p0 = c0 / t, p1 = c1 / t;
            const w  = t - 2;  // weight = actual observations through this node
            let h = 0;
            if (p0 > 0) h -= p0 * Math.log2(p0);
            if (p1 > 0) h -= p1 * Math.log2(p1);
            totalBits   += w * h;
            totalWeight += w;
        }
        // totalWeight should equal 8 * n (8 bit decisions per byte, n bytes seen)
        return totalWeight > 0 ? totalBits / (totalWeight / 8) : 8;
    }
}

// --- Bit-level Arithmetic encode/decode (order-0) ---

export function encode0DBit(data: Uint8Array): Uint8Array {
    const model = new BitContextModel();
    const enc   = new ArithEncoder();
    for (const sym of data) model.encodeByte(enc, sym);
    return enc.flush();
}

export function decode0DBit(data: Uint8Array, len: number): Uint8Array {
    const model = new BitContextModel();
    const dec   = new ArithDecoder(data);
    const out   = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = model.decodeByte(dec);
    return out;
}

// --- order-1 bit context model ---
//
// the previous byte is mixed into the context for inter-byte correlations.
// full order-1 would need 256×255 = 65,280 contexts — too many for short data.
// instead, use the top ORDER1_BITS bits of the previous byte as context prefix.
//
// context index = (prevHighBits << 8) | bitTreeNode
// with ORDER1_BITS=4: 16 × 255 = 4,080 contexts. each has count0, count1.
// this captures the most significant inter-byte structure while limiting
// the number of contexts to a learnable amount.

const ORDER1_BITS = 4;
const ORDER1_SLOTS = 1 << ORDER1_BITS;

class BitContextModelO1 {
    private counts: Uint32Array;  // (ORDER1_SLOTS × 256) × 2

    constructor() {
        const n = ORDER1_SLOTS * 256 * 2;
        this.counts = new Uint32Array(n);
        // Laplace prior: count0=1, count1=1 for all contexts
        for (let i = 0; i < ORDER1_SLOTS * 256; i++) {
            this.counts[i * 2]     = 1;
            this.counts[i * 2 + 1] = 1;
        }
    }

    encodeByte(enc: ArithEncoder, byte: number, prev: number): void {
        const slot = prev >>> (8 - ORDER1_BITS);  // top bits of previous byte
        const base = slot * 256;
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit   = (byte >> k) & 1;
            const idx   = (base + ctx) * 2;
            const c0    = this.counts[idx];
            const c1    = this.counts[idx + 1];
            const total = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            this.counts[idx + bit]++;
            ctx = (ctx << 1) | bit;
        }
    }

    decodeByte(dec: ArithDecoder, prev: number): number {
        const slot = prev >>> (8 - ORDER1_BITS);
        const base = slot * 256;
        let ctx = 1, byte = 0;
        for (let k = 7; k >= 0; k--) {
            const idx    = (base + ctx) * 2;
            const c0     = this.counts[idx];
            const c1     = this.counts[idx + 1];
            const total  = c0 + c1;
            const offset = dec.getCDF(total);
            const bit    = offset >= c0 ? 1 : 0;
            if (bit === 0) dec.advance(0, c0, total);
            else           dec.advance(c0, total, total);
            this.counts[idx + bit]++;
            byte = (byte << 1) | bit;
            ctx  = (ctx << 1) | bit;
        }
        return byte;
    }
}

// --- Order-1 Bit-level encode/decode ---

export function encode0DBitO1(data: Uint8Array): Uint8Array {
    const model = new BitContextModelO1();
    const enc   = new ArithEncoder();
    let prev = 0;
    for (const sym of data) {
        model.encodeByte(enc, sym, prev);
        prev = sym;
    }
    return enc.flush();
}

export function decode0DBitO1(data: Uint8Array, len: number): Uint8Array {
    const model = new BitContextModelO1();
    const dec   = new ArithDecoder(data);
    const out   = new Uint8Array(len);
    let prev = 0;
    for (let i = 0; i < len; i++) {
        out[i] = model.decodeByte(dec, prev);
        prev = out[i];
    }
    return out;
}

// --- Möbius bit context model (the pipe) ---
//
// the insight: each byte is 8 bits. consecutive bytes form 8 PARALLEL binary
// streams (one per bit position). the 1D Möbius predictor for a binary stream
// is simply: condition on the previous value.
//
// so for bit position k of the current byte, we condition on:
//   1. the partial byte decoded so far (bits 7..k+1) — intra-byte context (0D)
//   2. bit k of the previous byte — inter-byte 1D Möbius predictor
//
// this is the pipe working: 0D (bit tree) × 1D (temporal) = 2D per bit.
// the 2D Möbius for binary: P = L + A - D becomes conditioning on (prevBit, ctx).
//
// 512 contexts total (2 × 256): half the size of Bit1 (4080) but more targeted.
// each context captures the strongest inter-byte correlation for that bit position.

class BitContextModelM {
    private counts: Uint32Array;  // 512 contexts × 2

    constructor() {
        this.counts = new Uint32Array(1024);
        for (let i = 0; i < 512; i++) {
            this.counts[i * 2]     = 1;
            this.counts[i * 2 + 1] = 1;
        }
    }

    encodeByte(enc: ArithEncoder, byte: number, prev: number): void {
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit     = (byte >> k) & 1;
            const prevBit = (prev >> k) & 1;
            const idx     = (prevBit * 256 + ctx) * 2;
            const c0      = this.counts[idx];
            const c1      = this.counts[idx + 1];
            const total   = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            this.counts[idx + bit]++;
            ctx = (ctx << 1) | bit;
        }
    }

    decodeByte(dec: ArithDecoder, prev: number): number {
        let ctx = 1, byte = 0;
        for (let k = 7; k >= 0; k--) {
            const prevBit = (prev >> k) & 1;
            const idx     = (prevBit * 256 + ctx) * 2;
            const c0      = this.counts[idx];
            const c1      = this.counts[idx + 1];
            const total   = c0 + c1;
            const offset  = dec.getCDF(total);
            const bit     = offset >= c0 ? 1 : 0;
            if (bit === 0) dec.advance(0, c0, total);
            else           dec.advance(c0, total, total);
            this.counts[idx + bit]++;
            byte = (byte << 1) | bit;
            ctx  = (ctx << 1) | bit;
        }
        return byte;
    }
}

// --- Möbius Bit-level encode/decode ---

export function encode0DBitM(data: Uint8Array): Uint8Array {
    const model = new BitContextModelM();
    const enc   = new ArithEncoder();
    let prev = 0;
    for (const sym of data) {
        model.encodeByte(enc, sym, prev);
        prev = sym;
    }
    return enc.flush();
}

export function decode0DBitM(data: Uint8Array, len: number): Uint8Array {
    const model = new BitContextModelM();
    const dec   = new ArithDecoder(data);
    const out   = new Uint8Array(len);
    let prev = 0;
    for (let i = 0; i < len; i++) {
        out[i] = model.decodeByte(dec, prev);
        prev = out[i];
    }
    return out;
}

// --- Möbius order-2: conditions bit k on same-bit in BOTH the prev and prev-prev byte ---
// captures AR(2) patterns in bit space: oscillating signs (audio PCM), correlated residuals.
// slot = (pb1 << 1) | pb2: 4-tap history per bit position → 4×256 tree contexts.
// 4 × 256 × 2 = 2048 Uint32 (vs 1024 for BitM).

class BitContextModelM2 {
    private counts: Uint32Array;  // (4 × 256) × 2 = 2048

    constructor() {
        this.counts = new Uint32Array(2048);
        for (let i = 0; i < 1024; i++) {
            this.counts[i * 2]     = 1;
            this.counts[i * 2 + 1] = 1;
        }
    }

    encodeByte(enc: ArithEncoder, byte: number, prev1: number, prev2: number): void {
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit    = (byte  >> k) & 1;
            const pb1    = (prev1 >> k) & 1;
            const pb2    = (prev2 >> k) & 1;
            const slot   = (pb1 << 1) | pb2;  // 0..3: (p1_bit, p2_bit) history
            const idx    = (slot * 256 + ctx) * 2;
            const c0     = this.counts[idx];
            const c1     = this.counts[idx + 1];
            const total  = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            this.counts[idx + bit]++;
            ctx = (ctx << 1) | bit;
        }
    }

    decodeByte(dec: ArithDecoder, prev1: number, prev2: number): number {
        let ctx = 1, byte = 0;
        for (let k = 7; k >= 0; k--) {
            const pb1    = (prev1 >> k) & 1;
            const pb2    = (prev2 >> k) & 1;
            const slot   = (pb1 << 1) | pb2;
            const idx    = (slot * 256 + ctx) * 2;
            const c0     = this.counts[idx];
            const c1     = this.counts[idx + 1];
            const total  = c0 + c1;
            const offset = dec.getCDF(total);
            const bit    = offset >= c0 ? 1 : 0;
            if (bit === 0) dec.advance(0, c0, total);
            else           dec.advance(c0, total, total);
            this.counts[idx + bit]++;
            byte = (byte << 1) | bit;
            ctx  = (ctx << 1) | bit;
        }
        return byte;
    }
}

export function encode0DBitM2(data: Uint8Array): Uint8Array {
    const model = new BitContextModelM2();
    const enc   = new ArithEncoder();
    let prev1 = 0, prev2 = 0;
    for (const sym of data) {
        model.encodeByte(enc, sym, prev1, prev2);
        prev2 = prev1; prev1 = sym;
    }
    return enc.flush();
}

export function decode0DBitM2(data: Uint8Array, len: number): Uint8Array {
    const model = new BitContextModelM2();
    const dec   = new ArithDecoder(data);
    const out   = new Uint8Array(len);
    let prev1 = 0, prev2 = 0;
    for (let i = 0; i < len; i++) {
        out[i] = model.decodeByte(dec, prev1, prev2);
        prev2 = prev1; prev1 = out[i];
    }
    return out;
}

// --- primary encode0D / decode0D ---
//
// tries all coders, picks the smallest, prepends a 1-byte mode flag.
// header byte: 0x00=Rice, 0x01=Bit0, 0x02=Bit1, 0x03=BitM (Möbius), 0x04=BitM2 (order-2), 0xFF=raw.
// guarantees output ≤ input + 1 byte.

export function encode0D(data: Uint8Array): Uint8Array {
    if (data.length === 0) return new Uint8Array(0);

    const candidates: Array<{ mode: number; encoded: Uint8Array }> = [
        { mode: 0x00, encoded: encode0DRice(data) },
        { mode: 0x01, encoded: encode0DBit(data) },
        { mode: 0x02, encoded: encode0DBitO1(data) },
        { mode: 0x03, encoded: encode0DBitM(data) },
        { mode: 0x04, encoded: encode0DBitM2(data) },
    ];

    // find smallest
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
        if (candidates[i].encoded.length < best.encoded.length) best = candidates[i];
    }

    // raw fallback if best is still >= input
    if (best.encoded.length >= data.length) {
        const out = new Uint8Array(1 + data.length);
        out[0] = 0xFF; out.set(data, 1);
        return out;
    }

    const out = new Uint8Array(1 + best.encoded.length);
    out[0] = best.mode; out.set(best.encoded, 1);
    return out;
}

export function decode0D(data: Uint8Array, len: number): Uint8Array {
    if (data.length === 0 || len === 0) return new Uint8Array(len);
    const mode = data[0];
    const payload = data.subarray(1);
    switch (mode) {
        case 0xFF: return data.slice(1);
        case 0x00: return decode0DRice(payload, len);
        case 0x01: return decode0DBit(payload, len);
        case 0x02: return decode0DBitO1(payload, len);
        case 0x03: return decode0DBitM(payload, len);
        case 0x04: return decode0DBitM2(payload, len);
        default:   return decode0DRice(payload, len);  // fallback
    }
}

// --- profiler: bits/sym + k + model entropy per 16-symbol window ---

interface WindowStat { pos: number; bitsPerSym: number; k: number; modelH: number; }

function profileStream(data: Uint8Array): WindowStat[] {
    const model  = new AttentionModel();
    const stats: WindowStat[] = [];
    let k = 6, wSum = 0, wBits = 0, wCnt = 0, wPos = 0;

    for (let i = 0; i < data.length; i++) {
        if (wCnt === 16) {
            stats.push({ pos: wPos, bitsPerSym: wBits / 16, k, modelH: model.entropy() });
            k = riceK((wSum / 16) | 0); wSum = 0; wBits = 0; wCnt = 0; wPos = i;
        }
        const r = model.getRank(data[i]);
        wBits += (r >> k) + 1 + k;  // unary(q) + 1 stop + k remainder bits
        model.update(data[i]);
        wSum += r; wCnt++;
    }
    if (wCnt > 0)
        stats.push({ pos: wPos, bitsPerSym: wBits / wCnt, k, modelH: model.entropy() });
    return stats;
}

// --- test utilities ---

function idealEntropy(data: Uint8Array): number {
    if (data.length === 0) return 0;
    const counts = new Uint32Array(256);
    for (const b of data) counts[b]++;
    let H = 0;
    for (let i = 0; i < 256; i++) {
        if (counts[i] > 0) { const p = counts[i] / data.length; H -= p * Math.log2(p); }
    }
    return H;
}

function makeRandom(n: number, seed = 42): Uint8Array {
    const data = new Uint8Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) {
        s = (s * 1664525 + 1013904223) | 0;
        data[i] = (s >>> 24) & 0xFF;
    }
    return data;
}

function makeZipf(n: number, alpha = 1.0, seed = 42): Uint8Array {
    const cdf = new Float64Array(ALPHA);
    let norm = 0;
    for (let k = 1; k <= ALPHA; k++) norm += Math.pow(k, -alpha);
    let acc = 0;
    for (let k = 0; k < ALPHA; k++) { acc += Math.pow(k + 1, -alpha) / norm; cdf[k] = acc; }
    const data = new Uint8Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) {
        s = (s * 1664525 + 1013904223) | 0;
        const u = ((s >>> 1) & 0x7FFFFFFF) / 0x7FFFFFFF;
        let k = 0;
        while (k < 255 && cdf[k] < u) k++;
        data[i] = k;
    }
    return data;
}

// roundTrip verifies all coders and shows bits/sym comparison
function roundTrip(label: string, data: Uint8Array): boolean {
    if (data.length === 0) { console.log(`[${label.padEnd(28)}] empty`); return true; }

    // individual coders
    const bitEnc   = encode0DBit(data);
    const bitDec   = decode0DBit(bitEnc, data.length);
    const bit1Enc  = encode0DBitO1(data);
    const bit1Dec  = decode0DBitO1(bit1Enc, data.length);
    const bitMEnc  = encode0DBitM(data);
    const bitMDec  = decode0DBitM(bitMEnc, data.length);

    // adaptive picker (encode0D tries Rice, Bit0, Bit1, BitM, raw)
    const adaptEnc = encode0D(data);
    const adaptDec = decode0D(adaptEnc, data.length);

    let bErrs = 0, b1Errs = 0, bmErrs = 0, adErrs = 0;
    for (let i = 0; i < data.length; i++) {
        if (bitDec[i]   !== data[i]) bErrs++;
        if (bit1Dec[i]  !== data[i]) b1Errs++;
        if (bitMDec[i]  !== data[i]) bmErrs++;
        if (adaptDec[i] !== data[i]) adErrs++;
    }

    const H      = idealEntropy(data);
    const bBps   = (bitEnc.length   * 8) / data.length;
    const b1Bps  = (bit1Enc.length  * 8) / data.length;
    const bmBps  = (bitMEnc.length  * 8) / data.length;
    const adBps  = (adaptEnc.length * 8) / data.length;
    const bSt    = bErrs  === 0 ? '✓' : `✗${bErrs}`;
    const b1St   = b1Errs === 0 ? '✓' : `✗${b1Errs}`;
    const bmSt   = bmErrs === 0 ? '✓' : `✗${bmErrs}`;
    const adSt   = adErrs === 0 ? '✓' : `✗${adErrs}`;

    const modes  = ['Rice', 'Bit0', 'Bit1', 'BitM'];
    const modeIdx = adaptEnc[0] === 0xFF ? -1 : adaptEnc[0];
    const modeName = modeIdx === -1 ? 'RAW' : (modes[modeIdx] ?? '???');

    console.log(
        `[${label.padEnd(28)}]` +
        ` Bit0 ${bBps.toFixed(2).padStart(5)}${bSt}` +
        ` | Bit1 ${b1Bps.toFixed(2).padStart(5)}${b1St}` +
        ` | BitM ${bmBps.toFixed(2).padStart(5)}${bmSt}` +
        ` | best ${adBps.toFixed(2).padStart(5)}${adSt} ${modeName.padEnd(4)}` +
        ` | H ${H.toFixed(2).padStart(5)}`
    );
    return bErrs === 0 && b1Errs === 0 && bmErrs === 0 && adErrs === 0;
}

function printConvergence(label: string, data: Uint8Array): void {
    const H     = idealEntropy(data);
    const stats = profileStream(data);
    // subsample to at most 16 rows
    const step  = Math.max(1, Math.ceil(stats.length / 16));
    console.log(`\n=== convergence: ${label} | global H=${H.toFixed(2)} ===`);
    console.log('   pos | Rice b/s | k | model-H | bar (max=9)');
    for (let i = 0; i < stats.length; i += step) {
        const { pos, bitsPerSym, k, modelH } = stats[i];
        const filled = Math.min(9, Math.round(bitsPerSym));
        const bar    = '█'.repeat(filled) + '░'.repeat(9 - filled);
        const mark   = pos === 0 ? '' : '';
        console.log(
            `  ${pos.toString().padStart(5)} | ${bitsPerSym.toFixed(2).padStart(8)}` +
            ` | ${k} | ${modelH.toFixed(2).padStart(7)} | ${bar} ← ideal ${H.toFixed(2)}${mark}`
        );
    }
}

function printAttentionMap(label: string, data: Uint8Array, topN = 8): void {
    const model = new AttentionModel();
    for (const sym of data) model.update(sym);
    const snap    = model.snapshot(topN);
    const maxFreq = snap[0]?.freq ?? 1;
    console.log(`\n=== attention map: ${label} ===`);
    for (const { sym, freq, rank } of snap) {
        const bar = '█'.repeat(Math.max(1, Math.round(freq * 24 / maxFreq)));
        const ch  = sym >= 32 && sym < 127 ? String.fromCharCode(sym) : '·';
        console.log(`  ${rank.toString().padStart(2)} | ${sym.toString().padStart(3)} '${ch}' | ${freq.toString().padStart(6)} | ${bar}`);
    }
    console.log(`   model entropy: ${model.entropy().toFixed(3)} bits/sym`);
}

// --- stress tests ---

function runStressTests(): void {
    const te = new TextEncoder();
    let pass = 0, fail = 0;

    console.log('=== Whisper Logos — 0D Adaptive Entropy Encoder ===\n');
    console.log('Bit0: 255-ctx order-0 | Bit1: order-1 (4-bit prefix) | BitM: Möbius (per-bit 1D)');
    console.log('best = adaptive picker (Rice, Bit0, Bit1, BitM, raw). H = ideal Shannon.\n');

    const run = (label: string, data: Uint8Array) => {
        const ok = roundTrip(label, data); ok ? pass++ : fail++;
    };

    // edge cases
    run('single byte 0x42',         new Uint8Array([0x42]));
    run('two diff bytes',           new Uint8Array([0x41, 0x42]));
    run('all zeros 256B',           new Uint8Array(256).fill(0));
    run('all 0xFF 256B',            new Uint8Array(256).fill(0xFF));

    // repeated / structured
    const alt = new Uint8Array(1024); for (let i = 0; i < 1024; i++) alt[i] = i & 1;
    run('alternating 0/1 1KB',      alt);
    run('single sym repeated 1KB',  new Uint8Array(1024).fill(0xAB));

    // ASCII text
    run('Hello World 13B',          te.encode('Hello, World!'));
    const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
        'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
        'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris ' +
        'nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in ' +
        'reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla ' +
        'pariatur. Excepteur sint occaecat cupidatat non proident, sunt in ' +
        'culpa qui officia deserunt mollit anim id est laborum.';
    run('Lorem ipsum 445B',         te.encode(lorem));
    run('Lorem ipsum ×4 1.8KB',     te.encode(lorem.repeat(4)));
    run('Lorem ipsum ×16 7KB',      te.encode(lorem.repeat(16)));

    // UTF-8
    run('emoji ×10',                te.encode('🔥💧🌿⚡🪐✨🎵🎲🌀🔮🧬🌊🍃🌙'.repeat(10)));
    run('Japanese ×20',             te.encode('あいうえおかきくけこさしすせそたちつてと'.repeat(20)));
    run('Cyrillic ×20',             te.encode('Привет мир! Как дела? '.repeat(20)));

    // distributions
    run('uniform random 1KB',       makeRandom(1024));
    run('uniform random 4KB',       makeRandom(4096));
    run('uniform random 16KB',      makeRandom(16384));
    run('Zipf α=0.5 1KB',           makeZipf(1024, 0.5));
    run('Zipf α=1.0 1KB',           makeZipf(1024, 1.0));
    run('Zipf α=2.0 1KB',           makeZipf(1024, 2.0));
    run('Zipf α=1.0 16KB',          makeZipf(16384, 1.0));
    run('Zipf α=2.0 16KB',          makeZipf(16384, 2.0));

    // structured binary
    const grad = new Uint8Array(1024); for (let i = 0; i < 1024; i++) grad[i] = i & 0xFF;
    run('linear gradient 1KB',      grad);
    const pcm = new Uint8Array(2048); let s = 999;
    for (let i = 0; i < 1024; i++) {
        s = (s * 1664525 + 1013904223) | 0;
        const v = ((Math.sin(i * 0.1) * 0.8 + (((s >>> 24) / 255) - 0.5) * 0.2) * 32767) | 0;
        pcm[i * 2] = v & 0xFF; pcm[i * 2 + 1] = (v >> 8) & 0xFF;
    }
    run('PCM audio bytes 2KB',      pcm);

    // simulated nD residuals: the downward pipe
    // after a good Möbius predictor, residuals are peaked at 0 with Laplace-like tails.
    // zigzag maps signed → unsigned: 0→0, -1→1, 1→2, -2→3, ...
    // this is what the bit-level coder would replace Rice for in the nD codecs.
    console.log('\n--- nD residual simulation (the downward pipe) ---');
    const zigzag = (v: number) => (v << 1) ^ (v >> 31);
    const makeResiduals = (n: number, sigma: number, seed = 42) => {
        const data = new Uint8Array(n);
        let s = seed;
        for (let i = 0; i < n; i++) {
            // Laplace distribution: mostly 0s, exponential tails
            s = (s * 1664525 + 1013904223) | 0;
            const u = ((s >>> 1) & 0x7FFFFFFF) / 0x7FFFFFFF - 0.5;
            const v = -sigma * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
            data[i] = zigzag(Math.round(v)) & 0xFF;
        }
        return data;
    };
    // 90% zeros: like a good predictor (σ=0.1)
    run('residuals σ=0.1 4KB',      makeResiduals(4096, 0.1));
    // moderate residuals: decent predictor (σ=1)
    run('residuals σ=1.0 4KB',      makeResiduals(4096, 1.0));
    // sloppy predictor (σ=5)
    run('residuals σ=5.0 4KB',      makeResiduals(4096, 5.0));
    // correlated residuals: smooth field → adjacent residuals are similar
    const corrResid = new Uint8Array(4096);
    { let s = 42, prev = 0;
      for (let i = 0; i < 4096; i++) {
        s = (s * 1664525 + 1013904223) | 0;
        prev = Math.round(prev * 0.8 + ((s >>> 24) / 255 - 0.5) * 2);
        corrResid[i] = zigzag(prev) & 0xFF;
      }
    }
    run('correlated residuals 4KB', corrResid);

    // concentrated distributions: where bit-level should dominate
    console.log('\n--- concentrated distributions (bit-level advantage) ---');
    run('all zeros 1KB',              new Uint8Array(1024).fill(0));
    run('all zeros 4KB',              new Uint8Array(4096).fill(0));
    const twoSym = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) twoSym[i] = i % 7 === 0 ? 1 : 0;  // ~85% zeros
    run('2-sym biased 4KB',          twoSym);
    run('Zipf α=3.0 4KB',            makeZipf(4096, 3.0));

    console.log(`\nresult: ${pass} passed, ${fail} failed`);

    // convergence curves: shows how quickly each stream's model converges
    printConvergence('Lorem ipsum ×4 1.8KB', te.encode(lorem.repeat(4)));
    printConvergence('Zipf α=1.0 16KB',      makeZipf(16384, 1.0));
    printConvergence('uniform random 4KB',   makeRandom(4096));

    // attention maps: what the model learned to focus on
    printAttentionMap('Lorem ipsum ×4',  te.encode(lorem.repeat(4)), 10);
    printAttentionMap('Zipf α=2.0 16KB', makeZipf(16384, 2.0), 8);

    // --- the duality: 255 binary contexts = 255 Möbius neighbors ---
    console.log('\n=== the duality: 255 contexts ↔ 255 neighbors ===');
    console.log('');
    console.log('bit-level context tree has 255 nodes (1..255).');
    console.log('8D Möbius predictor has 2^8-1 = 255 non-trivial neighbors.');
    console.log('both index the Boolean lattice 2^{0,...,7} = Λ*(R^8).');
    console.log('');
    console.log('context tree node i at depth d corresponds to:');
    console.log('  a (d)-form in Λ^d(R^8) — a d-dimensional inclusion-exclusion term.');
    console.log('  root (d=0) = scalar, leaves (d=8) = the volume 8-form.');
    console.log('');
    console.log('the chain rule P(byte) = P(b7)·P(b6|b7)·...·P(b0|b7...b1)');
    console.log('mirrors Möbius inclusion-exclusion: both decompose a joint');
    console.log('distribution over 2^n outcomes into 2^n-1 conditional terms.');

    // convergence comparison
    const zeros256 = new Uint8Array(256).fill(0);
    const byteArithBps = (encode0DArith(zeros256).length * 8) / 256;
    const bitArithBps  = (encode0DBit(zeros256).length * 8) / 256;
    const adaptBps     = (encode0D(zeros256).length * 8) / 256;
    console.log('');
    console.log(`all zeros 256B:  byte-arith = ${byteArithBps.toFixed(3)} bits/sym`);
    console.log(`                 bit-arith  = ${bitArithBps.toFixed(3)} bits/sym  (${(byteArithBps / bitArithBps).toFixed(1)}× better)`);
    console.log(`                 adaptive   = ${adaptBps.toFixed(3)} bits/sym`);
    console.log('');
    console.log('the 256-symbol model wastes mass on 255 ghost symbols (prior dilution).');
    console.log('the binary model has 1 ghost outcome per context — 128× less dilution.');

    // show where order-1 beats H0 (inter-byte correlations)
    const jap = te.encode('あいうえおかきくけこさしすせそたちつてと'.repeat(20));
    const japH0   = idealEntropy(jap);
    const japBit0 = (encode0DBit(jap).length * 8) / jap.length;
    const japBit1 = (encode0DBitO1(jap).length * 8) / jap.length;
    console.log('');
    console.log(`Japanese (${jap.length}B): H0=${japH0.toFixed(2)}, Bit0=${japBit0.toFixed(2)}, Bit1=${japBit1.toFixed(2)}`);
    console.log(`  order-1 beats H0 by ${(japH0 - japBit1).toFixed(2)} bits/sym — capturing UTF-8 byte correlations.`);
    console.log('  this is the inter-byte structure that H0 cannot see.');
}

function isDirectScriptExecution(fileBaseName: string): boolean {
    const normalize = (value: string): string => value.replace(/\\/g, "/").toLowerCase();

    if (typeof process !== "undefined" && typeof process.argv?.[1] === "string") {
        const entry = normalize(process.argv[1]);
        if (entry.endsWith(`/${fileBaseName}.ts`) || entry.endsWith(`/${fileBaseName}.js`)) {
            return true;
        }
    }

    const maybeBun = (globalThis as { Bun?: { main?: string } }).Bun;
    if (typeof maybeBun?.main === "string") {
        const entry = normalize(maybeBun.main);
        return entry.endsWith(`/${fileBaseName}.ts`) || entry.endsWith(`/${fileBaseName}.js`);
    }

    return false;
}

if (isDirectScriptExecution("live-wasm-logos")) {
    runStressTests();
}
